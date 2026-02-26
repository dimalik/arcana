"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PaperPicker } from "@/components/discovery/paper-picker";
import {
  Compass,
  Loader2,
  Trash2,
  ChevronRight,
} from "lucide-react";

interface PaperOption {
  id: string;
  title: string;
  year: number | null;
}

interface Session {
  id: string;
  title: string | null;
  status: string;
  depth: number;
  totalFound: number;
  createdAt: string;
  seedPapers: { id: string; title: string }[];
  proposalCount: number;
  importedCount: number;
  pendingCount: number;
}

export default function DiscoveryPage() {
  const router = useRouter();
  const [selectedPapers, setSelectedPapers] = useState<PaperOption[]>([]);
  const [running, setRunning] = useState(false);
  const [progressMessage, setProgressMessage] = useState("");
  const [found, setFound] = useState(0);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/discovery");
      const data = await res.json();
      setSessions(data);
    } catch {
      // ignore
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const startDiscovery = async () => {
    if (selectedPapers.length === 0) return;
    setRunning(true);
    setFound(0);
    setProgressMessage("Starting discovery...");

    try {
      const res = await fetch("/api/discovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paperIds: selectedPapers.map((p) => p.id),
        }),
      });

      if (!res.ok || !res.body) {
        setRunning(false);
        setProgressMessage("Failed to start discovery.");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sessionId = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "session") {
              sessionId = event.sessionId;
            } else if (event.type === "progress") {
              setProgressMessage(event.checking);
              setFound(event.found);
            } else if (event.type === "done") {
              setFound(event.totalFound);
              setProgressMessage(
                `Done! Found ${event.totalFound} papers.`
              );
            } else if (event.type === "error") {
              setProgressMessage(`Error: ${event.message}`);
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      setRunning(false);
      setSelectedPapers([]);
      fetchSessions();

      // Navigate to session detail if we got a session ID
      if (sessionId) {
        router.push(`/discovery/${sessionId}`);
      }
    } catch {
      setRunning(false);
      setProgressMessage("Discovery failed.");
    }
  };

  const deleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this discovery session?")) return;

    await fetch(`/api/discovery/${sessionId}`, { method: "DELETE" });
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Paper Discovery</h1>
        <p className="text-muted-foreground">
          Find related papers by following citation chains from your library.
        </p>
      </div>

      {/* New Discovery */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">New Discovery</CardTitle>
          <CardDescription>
            Select seed papers from your library. The discovery agent will follow
            their citation chains to find related work.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <PaperPicker
            selected={selectedPapers}
            onChange={setSelectedPapers}
          />

          <div className="flex items-center gap-3">
            <Button
              onClick={startDiscovery}
              disabled={selectedPapers.length === 0 || running}
            >
              {running ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Discovering...
                </>
              ) : (
                <>
                  <Compass className="mr-2 h-4 w-4" />
                  Discover Related Papers
                </>
              )}
            </Button>

            {running && (
              <div className="flex-1 text-sm text-muted-foreground">
                <span className="font-medium">{found}</span> papers found
                {progressMessage && (
                  <>
                    {" "}
                    &middot;{" "}
                    <span className="truncate">{progressMessage}</span>
                  </>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Session List */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Past Discoveries</h2>

        {loadingSessions ? (
          <div className="text-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
            Loading sessions...
          </div>
        ) : sessions.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No discovery sessions yet. Select seed papers above to get
              started.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {sessions.map((session) => (
              <Card
                key={session.id}
                className="cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => router.push(`/discovery/${session.id}`)}
              >
                <CardContent className="flex items-center gap-3 py-3 px-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">
                        {session.title || "Untitled Session"}
                      </span>
                      <SessionStatusBadge status={session.status} />
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {session.seedPapers.length} seed paper
                      {session.seedPapers.length !== 1 ? "s" : ""} &middot;{" "}
                      {session.proposalCount} found &middot;{" "}
                      {session.importedCount} imported &middot;{" "}
                      {session.pendingCount} pending &middot;{" "}
                      {new Date(session.createdAt).toLocaleDateString()}
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={(e) => deleteSession(session.id, e)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionStatusBadge({ status }: { status: string }) {
  const variants: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
    RUNNING: { label: "Running", variant: "default" },
    COMPLETED: { label: "Completed", variant: "secondary" },
    FAILED: { label: "Failed", variant: "destructive" },
    CANCELLED: { label: "Cancelled", variant: "outline" },
  };

  const info = variants[status] || variants.COMPLETED;
  return (
    <Badge variant={info.variant} className="text-xs">
      {info.label}
    </Badge>
  );
}
