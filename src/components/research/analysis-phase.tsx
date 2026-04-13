"use client";

import { useState } from "react";
import {
  Loader2, Sparkles, Lightbulb, CheckCircle2, XCircle,
  RefreshCw, ChevronDown, FlaskConical, TrendingUp,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { useStepActions } from "./use-step-actions";

interface Step {
  id: string;
  type: string;
  status: string;
  title: string;
  description: string | null;
  output: string | null;
}

interface Hypothesis {
  id: string;
  statement: string;
  status: string;
  evidence: string | null;
}

interface AnalysisPhaseProps {
  projectId: string;
  steps: Step[];
  hypotheses: Hypothesis[];
  onRefresh: () => void;
}

function parseOutput(output: string | null) {
  if (!output) return null;
  try { return JSON.parse(output); } catch { return null; }
}

/** Extract the first experiment/number from text for sorting (e.g., "Experiment 14b" → 14) */
function extractSortKey(text: string): number {
  const m = text.match(/(?:exp(?:eriment)?)\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : Infinity;
}

function sortByExperimentNumber<T extends { content: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => extractSortKey(a.content) - extractSortKey(b.content));
}

const STATUS_STYLE: Record<string, { icon: typeof CheckCircle2; color: string; bg: string }> = {
  SUPPORTED: { icon: CheckCircle2, color: "text-emerald-500", bg: "border-emerald-500/20 bg-emerald-500/5" },
  REFUTED: { icon: XCircle, color: "text-red-500", bg: "border-red-500/20 bg-red-500/5" },
  TESTING: { icon: FlaskConical, color: "text-blue-500", bg: "border-blue-500/20 bg-blue-500/5" },
  REVISED: { icon: RefreshCw, color: "text-purple-500", bg: "border-purple-500/20 bg-purple-500/5" },
  PROPOSED: { icon: Lightbulb, color: "text-amber-500", bg: "border-amber-500/20 bg-amber-500/5" },
};

export function AnalysisPhase({ projectId, steps, hypotheses, onRefresh }: AnalysisPhaseProps) {
  const {
    loadingStep, autoRunning, handleAutoRun,
  } = useStepActions(projectId, onRefresh);

  const runningSteps = steps.filter((s) => s.status === "RUNNING");

  // Extract notebook-style analysis notes from analyze_results steps
  const notebookEntries: { id: string; content: string; type: string; hypothesisId?: string; status?: string; evidence?: string }[] = [];
  for (const step of steps) {
    if (step.status !== "COMPLETED") continue;
    const out = parseOutput(step.output);
    if (!out) continue;

    if (out.finding) {
      notebookEntries.push({
        id: step.id,
        content: out.finding,
        type: out.type || "finding",
      });
    } else if (out.hypothesisId) {
      notebookEntries.push({
        id: step.id,
        content: step.title,
        type: "hypothesis_update",
        hypothesisId: out.hypothesisId,
        status: out.status,
        evidence: out.evidence,
      });
    }
  }

  // Separate hypothesis updates from notebook observations, sorted by experiment number
  const hypothesisUpdates = notebookEntries.filter((f) => f.type === "hypothesis_update");
  const generalNotebookEntries = notebookEntries.filter((f) => f.type !== "hypothesis_update");
  const breakthroughs = sortByExperimentNumber(generalNotebookEntries.filter((f) => f.type === "breakthrough"));
  const notebookObservations = sortByExperimentNumber(generalNotebookEntries.filter((f) => f.type !== "breakthrough"));

  // Hypotheses with resolved evidence
  const resolvedHypotheses = hypotheses.filter((h) => h.status === "SUPPORTED" || h.status === "REFUTED");
  const activeHypotheses = hypotheses.filter((h) => h.status === "TESTING" || h.status === "PROPOSED");

  return (
    <div className="space-y-4 pr-2">
      {/* Running indicator */}
      {runningSteps.length > 0 && (
        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
          <span className="text-xs">Analysis in progress...</span>
        </div>
      )}

      {/* Breakthroughs — prominent */}
      {breakthroughs.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-amber-500 mb-2 flex items-center gap-1.5">
            <TrendingUp className="h-3 w-3" />
            Breakthroughs
          </h3>
          <div className="space-y-1.5">
            {breakthroughs.map((f) => (
              <div key={f.id} className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5">
                <MarkdownRenderer content={f.content} className="text-xs leading-relaxed [&_p]:mb-1 [&_table]:text-[10px]" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hypothesis Verdicts */}
      {(resolvedHypotheses.length > 0 || hypothesisUpdates.length > 0) && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">Hypothesis Results</h3>
          <div className="space-y-1.5">
            {resolvedHypotheses.map((h) => {
              const style = STATUS_STYLE[h.status] || STATUS_STYLE.PROPOSED;
              const Icon = style.icon;
              const evidence = (() => {
                try { return h.evidence ? JSON.parse(h.evidence) : []; } catch { return []; }
              })() as { summary: string; supports: boolean }[];

              return <HypothesisCard key={h.id} hypothesis={h} style={style} Icon={Icon} evidence={evidence} />;
            })}
          </div>
        </div>
      )}

      {/* Active hypotheses awaiting evidence */}
      {activeHypotheses.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">Awaiting Evidence</h3>
          <div className="space-y-1">
            {activeHypotheses.map((h) => {
              const style = STATUS_STYLE[h.status] || STATUS_STYLE.PROPOSED;
              const Icon = style.icon;
              return (
                <div key={h.id} className="flex items-start gap-2 py-1">
                  <Icon className={`h-3 w-3 mt-0.5 shrink-0 ${style.color}`} />
                  <div>
                    <p className="text-[11px]">{h.statement}</p>
                    <span className="text-[9px] text-muted-foreground">{h.status.toLowerCase()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Notebook observations */}
      {notebookObservations.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">Notebook Observations</h3>
          <div className="space-y-1">
            {notebookObservations.map((f) => (
              <div key={f.id} className="flex items-start gap-2 py-1">
                <Lightbulb className="h-3 w-3 mt-1 text-muted-foreground shrink-0" />
                <MarkdownRenderer content={f.content} className="text-[11px] text-foreground/80 leading-relaxed [&_p]:mb-1 [&_table]:text-[10px] flex-1 min-w-0" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {notebookEntries.length === 0 && resolvedHypotheses.length === 0 && activeHypotheses.length === 0 && runningSteps.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-4 text-center">
          <p className="text-xs text-muted-foreground">
            Complete experiments first, then analyze results here.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Hypothesis Result Card ──────────────────────────────

function HypothesisCard({
  hypothesis,
  style,
  Icon,
  evidence,
}: {
  hypothesis: { id: string; statement: string; status: string };
  style: { color: string; bg: string };
  Icon: typeof CheckCircle2;
  evidence: { summary: string; supports: boolean }[];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`rounded-md border p-2.5 ${style.bg}`}>
      <button onClick={() => setExpanded(!expanded)} className="flex items-start gap-2 w-full text-left">
        <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${style.color}`} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium">{hypothesis.statement}</p>
          <span className={`text-[10px] ${style.color}`}>{hypothesis.status.toLowerCase()}</span>
        </div>
        {evidence.length > 0 && (
          <ChevronDown className={`h-3 w-3 text-muted-foreground/50 mt-1 transition-transform ${expanded ? "rotate-180" : ""}`} />
        )}
      </button>
      {expanded && evidence.length > 0 && (
        <div className="mt-2 ml-5 space-y-0.5 border-t border-border/50 pt-1.5">
          {evidence.map((e, i) => (
            <div key={i} className={`text-[10px] ${e.supports ? "text-emerald-500" : "text-red-400"}`}>
              <span className="font-bold mr-1">{e.supports ? "+" : "−"}</span>
              <MarkdownRenderer content={e.summary} className="inline [&_p]:inline [&_p]:mb-0" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
