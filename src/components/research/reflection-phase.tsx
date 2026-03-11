"use client";

import { useState } from "react";
import { Loader2, Sparkles, ArrowRight, CheckCircle } from "lucide-react";
import { StepCard } from "./step-card";
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

export function ReflectionPhase({ projectId, steps, currentIteration, previousIterations, onRefresh }: ReflectionPhaseProps) {
  const {
    loadingStep, autoRunning, handleAutoRun, handleSkip,
    handleRestore, handleExecute, handleContinueNext,
  } = useStepActions(projectId, onRefresh);
  const [reflection, setReflection] = useState(currentIteration?.reflection || "");
  const [nextGoal, setNextGoal] = useState("");
  const [startingNext, setStartingNext] = useState(false);
  const [completing, setCompleting] = useState(false);

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

  const runningSteps = steps.filter((s) => s.status === "RUNNING");
  const pendingSteps = steps.filter((s) => s.status === "PROPOSED" || s.status === "APPROVED");
  const completedSteps = steps.filter((s) => s.status === "COMPLETED");
  const failedSteps = steps.filter((s) => s.status === "FAILED");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={handleAutoRun}
          disabled={autoRunning || runningSteps.length > 0}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {autoRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {runningSteps.length > 0 ? "Reflecting..." : "What should I do next?"}
        </button>
      </div>

      {/* Running steps */}
      {runningSteps.map((step) => (
        <StepCard key={step.id} step={step} onRestore={handleRestore} loading={loadingStep === step.id} />
      ))}

      {/* Failed steps */}
      {failedSteps.map((step) => (
        <StepCard key={step.id} step={step} onRestore={handleRestore} loading={loadingStep === step.id} />
      ))}

      {/* Completed steps — latest with actions */}
      {completedSteps.length > 0 && (
        <div className="space-y-1">
          {completedSteps.length > 1 && (
            <div className="border-l-2 border-emerald-500/20 pl-3 space-y-0.5 mb-2">
              {completedSteps.slice(0, -1).map((step) => (
                <StepCard key={step.id} step={step} compact />
              ))}
            </div>
          )}
          {(() => {
            const latest = completedSteps[completedSteps.length - 1];
            const next = pendingSteps[0];
            return (
              <StepCard
                key={latest.id}
                step={latest}
                isLatestCompleted
                hasNextStep={!!next}
                nextStepTitle={next?.title}
                onContinue={next ? () => handleContinueNext(next.id) : undefined}
                loading={!!loadingStep}
              />
            );
          })()}
        </div>
      )}

      {/* Pending steps */}
      {pendingSteps.slice(completedSteps.length > 0 ? 1 : 0).map((step) => (
        <StepCard key={step.id} step={step} onSkip={handleSkip} onExecute={handleExecute} loading={loadingStep === step.id} />
      ))}

      {/* Iteration reflection */}
      <div>
        <h3 className="text-xs font-medium text-muted-foreground mb-1.5">
          Iteration #{currentIteration?.number || 1} Reflection
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
                  <span className="text-[10px] text-muted-foreground">{iter.status}</span>
                </div>
                {iter.reflection && (
                  <p className="text-[11px] text-muted-foreground mt-1">{iter.reflection}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
