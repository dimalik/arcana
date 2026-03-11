"use client";

import { Loader2, Sparkles } from "lucide-react";
import { StepCard } from "./step-card";
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

export function AnalysisPhase({ projectId, steps, hypotheses, onRefresh }: AnalysisPhaseProps) {
  const {
    loadingStep, autoRunning, handleAutoRun, handleSkip,
    handleRestore, handleExecute, handleContinueNext,
  } = useStepActions(projectId, onRefresh);

  const runningSteps = steps.filter((s) => s.status === "RUNNING");
  const pendingSteps = steps.filter((s) => s.status === "PROPOSED" || s.status === "APPROVED");
  const completedSteps = steps.filter((s) => s.status === "COMPLETED");
  const failedSteps = steps.filter((s) => s.status === "FAILED");
  const testingHypotheses = hypotheses.filter((h) => h.status === "TESTING" || h.status === "PROPOSED");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={handleAutoRun}
          disabled={autoRunning || runningSteps.length > 0}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {autoRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {runningSteps.length > 0 ? "Analyzing..." : "Analyze results"}
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

      {/* Hypothesis evidence summary */}
      {testingHypotheses.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">Hypothesis Evidence</h3>
          <div className="space-y-2">
            {testingHypotheses.map((h) => {
              const evidence = (() => {
                try { return h.evidence ? JSON.parse(h.evidence) : []; } catch { return []; }
              })() as { summary: string; supports: boolean }[];
              return (
                <div key={h.id} className="rounded-md border border-border p-2.5">
                  <p className="text-xs font-medium">{h.statement}</p>
                  <span className="text-[10px] text-muted-foreground">[{h.status}]</span>
                  {evidence.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {evidence.map((e, i) => (
                        <p key={i} className={`text-[10px] ${e.supports ? "text-emerald-500" : "text-red-400"}`}>
                          {e.supports ? "+" : "-"} {e.summary}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {steps.length === 0 && testingHypotheses.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-4 text-center">
          <p className="text-xs text-muted-foreground">
            Complete experiments first, then analyze results here.
          </p>
        </div>
      )}
    </div>
  );
}
