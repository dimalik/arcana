"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Search,
  Code,
  ShieldCheck,
  Square,
  Loader2,
  Bot,
  RotateCcw,
  Send,
  History,
  ChevronDown,
  FolderOpen,
  Beaker,
  FlaskConical,
  BarChart3,
  TestTube,
  Database,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentMessage } from "./agent-message";
import type { AgentSessionData } from "@/lib/agent/types";

interface Props {
  paperId: string;
}

const ACTIONS = [
  {
    id: "deep-analysis",
    label: "Deep Analysis",
    description: "Web-enriched multi-step analysis",
    icon: Search,
  },
  {
    id: "fact-check",
    label: "Fact Check",
    description: "Verify claims against sources",
    icon: ShieldCheck,
  },
] as const;

const POLL_INTERVAL = 3000;

const ALL_LABELS: Record<string, string> = {
  "deep-analysis": "Deep Analysis",
  "fact-check": "Fact Check",
  "generate-code": "Replicate Paper",
};

function getActionLabel(templateId: string | null): string {
  if (!templateId) return "Agent";
  return ALL_LABELS[templateId] || "Agent";
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    PENDING: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    RUNNING: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    COMPLETED: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    FAILED: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    CANCELLED: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${colors[status] || colors.CANCELLED}`}>
      {status}
    </span>
  );
}

export function AgentActions({ paperId }: Props) {
  const [session, setSession] = useState<AgentSessionData | null>(null);
  const [sessions, setSessions] = useState<AgentSessionData[]>([]);
  const [customPrompt, setCustomPrompt] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showCodeOptions, setShowCodeOptions] = useState(false);
  const [attachPath, setAttachPath] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isActive = session?.status === "PENDING" || session?.status === "RUNNING";
  const hasOutput = session && session.events.length > 0;

  // Scroll to bottom on new events
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [session?.events.length]);

  // Fetch session data
  const fetchSession = useCallback(
    async (sessionId?: string) => {
      try {
        const url = sessionId
          ? `/api/papers/${paperId}/agent?sessionId=${sessionId}`
          : `/api/papers/${paperId}/agent`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data: AgentSessionData | null = await res.json();
        if (data) {
          setSession(data);
        }
      } catch {
        // ignore
      }
    },
    [paperId]
  );

  // Fetch all sessions for history
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`/api/papers/${paperId}/agent?all=true`);
      if (!res.ok) return;
      const data: AgentSessionData[] = await res.json();
      setSessions(data);
    } catch {
      // ignore
    }
  }, [paperId]);

  // On mount: fetch latest session
  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // Polling while active
  useEffect(() => {
    if (!isActive || !session) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    pollRef.current = setInterval(() => {
      fetchSession(session.id);
    }, POLL_INTERVAL);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [isActive, session?.id, fetchSession]);

  // Refresh history when it opens
  useEffect(() => {
    if (showHistory) fetchSessions();
  }, [showHistory, fetchSessions]);

  const startAgent = useCallback(
    async (templateId?: string, prompt?: string, options?: { attachPath?: string }) => {
      setStarting(true);
      try {
        const body: Record<string, unknown> = {};
        if (templateId) body.templateId = templateId;
        if (prompt) body.customPrompt = prompt;
        if (options) body.options = options;

        const res = await fetch(`/api/papers/${paperId}/agent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await res.json();

        if (!res.ok) {
          // If 409, there's an existing session — show it
          if (res.status === 409 && data.sessionId) {
            fetchSession(data.sessionId);
          } else {
            setSession({
              id: "",
              paperId,
              templateId: templateId ?? null,
              customPrompt: prompt ?? null,
              mode: "analyze",
              status: "FAILED",
              events: [{ type: "error", message: data.error || "Failed to start" }],
              costUsd: null,
              durationMs: null,
              turns: null,
              error: data.error,
              startedAt: null,
              completedAt: null,
              createdAt: new Date().toISOString(),
            });
          }
          return;
        }

        // Start polling the new session
        setSession({
          id: data.sessionId,
          paperId,
          templateId: templateId ?? null,
          customPrompt: prompt ?? null,
          mode: "analyze",
          status: "PENDING",
          events: [],
          costUsd: null,
          durationMs: null,
          turns: null,
          error: null,
          startedAt: null,
          completedAt: null,
          createdAt: new Date().toISOString(),
        });
      } catch (err: unknown) {
        setSession({
          id: "",
          paperId,
          templateId: templateId ?? null,
          customPrompt: prompt ?? null,
          mode: "analyze",
          status: "FAILED",
          events: [
            {
              type: "error",
              message: err instanceof Error ? err.message : "Failed to start agent",
            },
          ],
          costUsd: null,
          durationMs: null,
          turns: null,
          error: null,
          startedAt: null,
          completedAt: null,
          createdAt: new Date().toISOString(),
        });
      } finally {
        setStarting(false);
      }
    },
    [paperId, fetchSession]
  );

  const handleStop = async () => {
    if (!session?.id) return;
    try {
      await fetch(`/api/papers/${paperId}/agent?sessionId=${session.id}`, {
        method: "DELETE",
      });
      fetchSession(session.id);
    } catch {
      // ignore
    }
  };

  const handleClear = () => {
    setSession(null);
    setShowHistory(false);
  };

  const handleCustomSubmit = () => {
    const prompt = customPrompt.trim();
    if (!prompt || isActive || starting) return;
    setCustomPrompt("");
    startAgent(undefined, prompt);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleCustomSubmit();
    }
  };

  const handleViewSession = (s: AgentSessionData) => {
    setSession(s);
    setShowHistory(false);
  };

  const busy = isActive || starting;

  const handleGenerateCode = () => {
    const opts = attachPath.trim() ? { attachPath: attachPath.trim() } : undefined;
    setShowCodeOptions(false);
    startAgent("generate-code", undefined, opts);
  };

  return (
    <div className="space-y-3">
      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        {ACTIONS.map((action) => {
          const Icon = action.icon;
          const isRunning =
            busy && session?.templateId === action.id;
          return (
            <Button
              key={action.id}
              variant="outline"
              size="sm"
              onClick={() => startAgent(action.id)}
              disabled={busy}
              className={isRunning ? "border-primary" : ""}
            >
              {isRunning ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Icon className="mr-1.5 h-3.5 w-3.5" />
              )}
              {action.label}
            </Button>
          );
        })}
        {/* Generate Code button */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowCodeOptions((v) => !v)}
          disabled={busy}
          className={`${
            busy && session?.templateId === "generate-code" ? "border-primary" : ""
          } ${showCodeOptions ? "bg-accent" : ""}`}
        >
          {busy && session?.templateId === "generate-code" ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Beaker className="mr-1.5 h-3.5 w-3.5" />
          )}
          Replicate Paper
        </Button>
        {isActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleStop}
            className="text-destructive hover:text-destructive"
          >
            <Square className="mr-1 h-3 w-3" />
            Stop
          </Button>
        )}
        {hasOutput && !isActive && (
          <Button variant="ghost" size="sm" onClick={handleClear}>
            <RotateCcw className="mr-1 h-3 w-3" />
            Clear
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowHistory((h) => !h)}
          className="ml-auto"
        >
          <History className="mr-1 h-3 w-3" />
          History
          <ChevronDown
            className={`ml-1 h-3 w-3 transition-transform ${showHistory ? "rotate-180" : ""}`}
          />
        </Button>
      </div>

      {/* Replicate Paper dialog */}
      <Dialog open={showCodeOptions} onOpenChange={setShowCodeOptions}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="h-4.5 w-4.5" />
              Replicate Paper
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5 pt-2">
            {/* What's included */}
            <div className="grid grid-cols-2 gap-2.5">
              {[
                { icon: Code, label: "Full implementation", desc: "Core methods & pipeline" },
                { icon: Database, label: "Datasets", desc: "Public data or realistic mocks" },
                { icon: TestTube, label: "Test suite", desc: "Unit + integration tests" },
                { icon: BarChart3, label: "Figures", desc: "Recreates paper visuals" },
              ].map((item) => (
                <div
                  key={item.label}
                  className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5"
                >
                  <div className="rounded-md bg-primary/10 p-1.5 mt-0.5">
                    <item.icon className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium leading-none">{item.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Attach to codebase */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-1.5">
                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                Integrate into existing project
                <span className="text-xs font-normal text-muted-foreground">(optional)</span>
              </label>
              <input
                type="text"
                value={attachPath}
                onChange={(e) => setAttachPath(e.target.value)}
                placeholder="/path/to/your/project"
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {attachPath.trim() && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Check className="h-3 w-3 text-green-500" />
                  Code will be adapted to your project&apos;s structure and conventions
                </p>
              )}
            </div>

            {/* Action button */}
            <Button onClick={handleGenerateCode} className="w-full">
              <FlaskConical className="mr-2 h-4 w-4" />
              {attachPath.trim() ? "Generate & Integrate" : "Generate Standalone Code"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Custom prompt */}
      {!hasOutput && !isActive && (
        <div className="flex gap-2">
          <Textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Or ask the agent something custom..."
            disabled={busy}
            rows={2}
            className="min-h-[52px] resize-none text-sm"
          />
          <Button
            onClick={handleCustomSubmit}
            disabled={busy || !customPrompt.trim()}
            size="icon"
            variant="outline"
            className="h-[52px] w-10 shrink-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Session history dropdown */}
      {showHistory && (
        <Card>
          <CardContent className="p-3 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Past sessions
            </p>
            {sessions.length === 0 && (
              <p className="text-xs text-muted-foreground">No sessions yet.</p>
            )}
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => handleViewSession(s)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50 transition-colors ${
                  session?.id === s.id ? "bg-muted/50" : ""
                }`}
              >
                <span className="truncate font-medium">
                  {getActionLabel(s.templateId)}
                </span>
                <StatusBadge status={s.status} />
                <span className="ml-auto text-muted-foreground whitespace-nowrap">
                  {new Date(s.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Session output */}
      {(hasOutput || isActive) && (
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center gap-2 border-b px-4 py-2">
              <Bot className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">
                {getActionLabel(session?.templateId ?? null)}
              </span>
              {session && <StatusBadge status={session.status} />}
              {isActive && (
                <Loader2 className="ml-auto h-3 w-3 animate-spin text-muted-foreground" />
              )}
              {session?.status === "COMPLETED" && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  Complete
                </span>
              )}
            </div>
            <div
              ref={scrollRef}
              className="max-h-[600px] overflow-y-auto space-y-3 p-4"
            >
              {session?.events.map((event, i) => (
                <AgentMessage key={i} event={event} />
              ))}
              {isActive && !session?.events.some((e) => e.type === "text") && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Agent is working...
                </div>
              )}
              {session?.status === "FAILED" && session.error && session.events.length === 0 && (
                <div className="text-sm text-destructive">{session.error}</div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
