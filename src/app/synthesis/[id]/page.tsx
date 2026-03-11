"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft, RefreshCw, AlertTriangle } from "lucide-react";
import { SynthesisProgress } from "@/components/synthesis/synthesis-progress";
import { SynthesisOutput } from "@/components/synthesis/synthesis-output";
import { SynthesisGuide } from "@/components/synthesis/synthesis-guide";
import type { SynthesisPlan } from "@/lib/synthesis/types";

interface SessionData {
  id: string;
  title: string;
  description: string | null;
  status: string;
  mode: string;
  phase: string | null;
  progress: number;
  paperCount: number;
  plan: SynthesisPlan | null;
  guidanceMessages: { role: string; content: string; timestamp?: string }[] | null;
  guidance: unknown;
  output: string | null;
  vizData: unknown;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  sections: {
    id: string;
    sectionType: string;
    title: string;
    content: string;
    sortOrder: number;
    citations: string | null;
  }[];
  papers: {
    paperId: string;
    paper: {
      id: string;
      title: string;
      year: number | null;
      authors: string | null;
    };
  }[];
}

export default function SynthesisDetailPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.id as string;

  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/synthesis/${sessionId}`);
      if (!res.ok) {
        setLoading(false);
        return;
      }
      const data = await res.json();
      setSession(data);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="max-w-3xl mx-auto py-12 text-center">
        <p className="text-muted-foreground">Synthesis session not found.</p>
        <Button variant="ghost" className="mt-4" onClick={() => router.push("/synthesis")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to Synthesis
        </Button>
      </div>
    );
  }

  const isRunning = ["PENDING", "PLANNING", "MAPPING", "GRAPHING", "EXPANDING", "REDUCING", "COMPOSING"].includes(session.status);
  const isGuiding = session.status === "GUIDING";
  const isFailed = session.status === "FAILED";
  const isCancelled = session.status === "CANCELLED";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Back navigation */}
      <Button variant="ghost" size="sm" onClick={() => router.push("/synthesis")}>
        <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
        All Syntheses
      </Button>

      {isRunning ? (
        <SynthesisProgress sessionId={sessionId} onComplete={fetchSession} />
      ) : isGuiding ? (
        <SynthesisGuide
          sessionId={sessionId}
          title={session.title}
          plan={session.plan}
          existingMessages={session.guidanceMessages}
          onProceed={fetchSession}
        />
      ) : isFailed || isCancelled ? (
        <div className="space-y-4">
          <Card>
            <CardContent className="py-8 text-center space-y-3">
              <AlertTriangle className="h-8 w-8 mx-auto text-destructive" />
              <h2 className="text-lg font-semibold">
                Synthesis {isFailed ? "Failed" : "Cancelled"}
              </h2>
              {session.error && (
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  {session.error}
                </p>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  // Retry: create a new session with the same papers
                  const paperIds = session.papers.map((p) => p.paperId);
                  fetch("/api/synthesis", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      paperIds,
                      title: session.title,
                    }),
                  })
                    .then((r) => r.json())
                    .then((data) => {
                      if (data.id) router.push(`/synthesis/${data.id}`);
                    });
                }}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Retry
              </Button>
            </CardContent>
          </Card>

          {/* Still show any completed sections */}
          {session.sections.length > 0 && (
            <SynthesisOutput
              sessionId={session.id}
              title={session.title}
              description={session.description}
              paperCount={session.paperCount}
              sections={session.sections}
              papers={session.papers}
              vizData={session.vizData as import("@/lib/synthesis/types").VizData | null}
              output={session.output}
              createdAt={session.createdAt}
              onRefresh={fetchSession}
            />
          )}
        </div>
      ) : (
        <SynthesisOutput
          sessionId={session.id}
          title={session.title}
          description={session.description}
          paperCount={session.paperCount}
          sections={session.sections}
          papers={session.papers}
          vizData={session.vizData as import("@/lib/synthesis/types").VizData | null}
          output={session.output}
          createdAt={session.createdAt}
          onRefresh={fetchSession}
        />
      )}
    </div>
  );
}
