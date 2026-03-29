"use client";

import { useState } from "react";
import {
  Loader2, Sparkles, ArrowRight, CheckCircle, FileCode,
  FlaskConical, Lightbulb, BookOpen, TrendingUp, XCircle,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { useStepActions } from "./use-step-actions";
import { toast } from "sonner";

interface Step {
  id: string;
  type: string;
  status: string;
  title: string;
  description: string | null;
  output: string | null;
}

interface Iteration {
  id: string;
  number: number;
  goal: string;
  status: string;
  reflection: string | null;
}

interface ReflectionPhaseProps {
  projectId: string;
  steps: Step[];
  currentIteration: Iteration | null;
  previousIterations: Iteration[];
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

export function ReflectionPhase({ projectId, steps, currentIteration, previousIterations, onRefresh }: ReflectionPhaseProps) {
  const { autoRunning, handleAutoRun } = useStepActions(projectId, onRefresh);
  const [reflection, setReflection] = useState(currentIteration?.reflection || "");
  const [nextGoal, setNextGoal] = useState("");
  const [startingNext, setStartingNext] = useState(false);
  const [completing, setCompleting] = useState(false);

  const runningSteps = steps.filter((s) => s.status === "RUNNING");

  const handleStartNext = async () => {
    if (!nextGoal.trim()) {
      toast.error("Please set a goal for the next iteration");
      return;
    }
    setStartingNext(true);
    try {
      await fetch(`/api/research/${projectId}/iterations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: nextGoal.trim(),
          reflection: reflection.trim() || null,
          startPhase: "literature",
        }),
      });
      toast.success("Next iteration started");
      onRefresh();
    } catch {
      toast.error("Failed to start next iteration");
    } finally {
      setStartingNext(false);
    }
  };

  const handleComplete = async () => {
    setCompleting(true);
    try {
      if (currentIteration) {
        await fetch(`/api/research/${projectId}/iterations`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            iterationId: currentIteration.id,
            reflection: reflection.trim() || null,
            status: "COMPLETED",
          }),
        });
      }
      await fetch(`/api/research/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "COMPLETED" }),
      });
      toast.success("Project completed");
      onRefresh();
    } catch {
      toast.error("Failed to complete project");
    } finally {
      setCompleting(false);
    }
  };

  // Build iteration summary from steps
  const completedSteps = steps.filter((s) => s.status === "COMPLETED");
  const failedSteps = steps.filter((s) => s.status === "FAILED");

  const papersFound = completedSteps
    .filter((s) => s.type === "search_papers")
    .reduce((sum, s) => sum + (parseOutput(s.output)?.imported || 0), 0);

  const codeWritten = completedSteps.filter((s) => s.type === "generate_code");
  const experimentsRun = completedSteps.filter((s) => s.type === "run_experiment");
  const experimentsFailed = failedSteps.filter((s) => s.type === "run_experiment");
  const hypothesesFormed = completedSteps.filter((s) => s.type === "formulate_hypothesis");

  const findings = sortByExperimentNumber(
    completedSteps
      .filter((s) => s.type === "analyze_results")
      .map((s) => {
        const out = parseOutput(s.output);
        return {
          content: out?.finding || s.title,
          type: out?.type || "finding",
          status: out?.status,
        };
      }),
  );

  const breakthroughs = sortByExperimentNumber(findings.filter((f) => f.type === "breakthrough"));
  const hypothesisResults = sortByExperimentNumber(findings.filter((f) => f.status));

  return (
    <div className="space-y-4 pr-2">
      {/* Running indicator */}
      {runningSteps.length > 0 && (
        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
          <span className="text-xs">Generating reflection...</span>
        </div>
      )}

      {/* Iteration Summary */}
      {completedSteps.length > 0 && (
        <div className="rounded-md border border-border p-3">
          <h3 className="text-xs font-medium mb-2">
            Iteration #{currentIteration?.number || 1} Summary
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {papersFound > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <BookOpen className="h-3 w-3 text-blue-400" />
                {papersFound} papers found
              </div>
            )}
            {hypothesesFormed.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Lightbulb className="h-3 w-3 text-amber-400" />
                {hypothesesFormed.length} hypotheses formed
              </div>
            )}
            {codeWritten.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <FileCode className="h-3 w-3 text-purple-400" />
                {codeWritten.length} scripts written
              </div>
            )}
            {experimentsRun.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <FlaskConical className="h-3 w-3 text-emerald-400" />
                {experimentsRun.length} experiments run
              </div>
            )}
            {experimentsFailed.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <XCircle className="h-3 w-3 text-destructive" />
                {experimentsFailed.length} experiments failed
              </div>
            )}
            {findings.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <TrendingUp className="h-3 w-3 text-cyan-400" />
                {findings.length} findings recorded
              </div>
            )}
          </div>

          {/* Key outcomes */}
          {(breakthroughs.length > 0 || hypothesisResults.length > 0) && (
            <div className="mt-3 pt-2 border-t border-border/50 space-y-1">
              <p className="text-[10px] font-medium text-muted-foreground">Key Outcomes</p>
              {breakthroughs.map((f, i) => (
                <div key={`b-${i}`} className="flex items-start gap-1.5 text-[11px]">
                  <TrendingUp className="h-3 w-3 text-amber-500 mt-1 shrink-0" />
                  <MarkdownRenderer content={f.content} className="flex-1 min-w-0 [&_p]:mb-1 [&_table]:text-[10px]" />
                </div>
              ))}
              {hypothesisResults.map((f, i) => (
                <div key={`h-${i}`} className="flex items-start gap-1.5 text-[11px]">
                  {f.status === "SUPPORTED"
                    ? <CheckCircle className="h-3 w-3 text-emerald-500 mt-1 shrink-0" />
                    : <XCircle className="h-3 w-3 text-red-500 mt-1 shrink-0" />
                  }
                  <MarkdownRenderer content={f.content} className="flex-1 min-w-0 [&_p]:mb-1 [&_table]:text-[10px]" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Iteration reflection */}
      <div>
        <h3 className="text-xs font-medium text-muted-foreground mb-1.5">
          Reflection
        </h3>
        <textarea
          value={reflection}
          onChange={(e) => setReflection(e.target.value)}
          placeholder="What was learned? What worked? What didn't?"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring resize-none"
          rows={4}
        />
      </div>

      {/* Next iteration */}
      <div className="rounded-md border border-border p-3 space-y-2">
        <h3 className="text-xs font-medium">Next Iteration</h3>
        <input
          value={nextGoal}
          onChange={(e) => setNextGoal(e.target.value)}
          placeholder="Goal for the next iteration..."
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={handleStartNext}
            disabled={startingNext || !nextGoal.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {startingNext ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />}
            Start Next Iteration
          </button>
          <button
            onClick={handleComplete}
            disabled={completing}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted transition-colors disabled:opacity-50"
          >
            {completing ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
            Complete Project
          </button>
        </div>
      </div>

      {/* Previous iterations */}
      {previousIterations.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">Previous Iterations</h3>
          <div className="space-y-2">
            {previousIterations.map((iter) => (
              <div key={iter.id} className="rounded-md border border-border/50 bg-muted/30 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">#{iter.number}: {iter.goal}</span>
                  <span className="text-[10px] text-muted-foreground">{iter.status.toLowerCase()}</span>
                </div>
                {iter.reflection && (
                  <MarkdownRenderer content={iter.reflection} className="text-[11px] text-muted-foreground mt-1 [&_p]:mb-1" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
