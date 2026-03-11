"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, X, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";

interface SynthesisSection {
  id: string;
  sectionType: string;
  title: string;
  content: string;
  sortOrder: number;
}

interface SynthesisTheme {
  id: string;
  label: string;
  description: string;
}

interface SessionData {
  id: string;
  title: string;
  status: string;
  phase: string | null;
  progress: number;
  paperCount: number;
  plan: { themes: SynthesisTheme[] } | null;
  sections: SynthesisSection[];
  error: string | null;
}

interface SynthesisProgressProps {
  sessionId: string;
  onComplete: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Waiting to start...",
  PLANNING: "Analyzing corpus",
  MAPPING: "Extracting paper digests",
  GRAPHING: "Building citation graph",
  EXPANDING: "Expanding corpus",
  REDUCING: "Writing synthesis sections",
  COMPOSING: "Composing final output",
  GUIDING: "Expert guidance session",
};

export function SynthesisProgress({ sessionId, onComplete }: SynthesisProgressProps) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState(false);

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/synthesis/${sessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      setSession(data);

      if (["COMPLETED", "FAILED", "CANCELLED", "GUIDING"].includes(data.status)) {
        onComplete();
      }
    } catch {
      // Ignore fetch errors during polling
    }
  }, [sessionId, onComplete]);

  useEffect(() => {
    fetchSession();
    const interval = setInterval(fetchSession, 3000);
    return () => clearInterval(interval);
  }, [fetchSession]);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      const res = await fetch(`/api/synthesis/${sessionId}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Synthesis cancelled");
      }
    } catch {
      toast.error("Failed to cancel");
    } finally {
      setCancelling(false);
    }
  };

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!session) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const percent = Math.round(session.progress * 100);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold">{session.title}</h2>
        <p className="text-sm text-muted-foreground">
          {session.paperCount} papers
        </p>
      </div>

      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {session.phase || STATUS_LABELS[session.status] || session.status}
          </span>
          <span className="text-muted-foreground">{percent}%</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* Plan preview - theme chips */}
      {session.plan?.themes && session.plan.themes.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Identified themes
          </p>
          <div className="flex gap-1.5 flex-wrap">
            {session.plan.themes.map((t) => (
              <Badge key={t.id} variant="secondary" className="text-xs">
                {t.label}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Completed sections (collapsible cards) */}
      {session.sections.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Completed sections ({session.sections.length})
          </p>
          {session.sections.map((sec) => {
            const isExpanded = expandedSections.has(sec.id);
            return (
              <Card key={sec.id}>
                <button
                  onClick={() => toggleSection(sec.id)}
                  className="w-full text-left px-4 py-3 flex items-center justify-between"
                >
                  <span className="text-sm font-medium">{sec.title}</span>
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
                {isExpanded && (
                  <CardContent className="pt-0 pb-4">
                    <div className="prose prose-sm dark:prose-invert max-w-none text-sm text-muted-foreground whitespace-pre-wrap">
                      {sec.content.slice(0, 500)}
                      {sec.content.length > 500 && "..."}
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Cancel button */}
      <Button
        variant="outline"
        onClick={handleCancel}
        disabled={cancelling}
        className="w-full"
      >
        {cancelling ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <X className="mr-2 h-4 w-4" />
        )}
        Cancel Synthesis
      </Button>
    </div>
  );
}
