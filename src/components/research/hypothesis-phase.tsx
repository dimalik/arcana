"use client";

import { useState } from "react";
import { Loader2, Plus, Sparkles } from "lucide-react";
import { HypothesisCard } from "./hypothesis-card";
import { StepCard } from "./step-card";
import { useStepActions } from "./use-step-actions";
import { toast } from "sonner";

interface Hypothesis {
  id: string;
  statement: string;
  rationale: string | null;
  status: string;
  evidence: string | null;
  parent?: { id: string; statement: string } | null;
  children?: { id: string; statement: string; status: string }[];
}

interface Step {
  id: string;
  type: string;
  status: string;
  title: string;
  description: string | null;
  output: string | null;
}

interface HypothesisPhaseProps {
  projectId: string;
  hypotheses: Hypothesis[];
  steps: Step[];
  onRefresh: () => void;
}

export function HypothesisPhase({ projectId, hypotheses, steps, onRefresh }: HypothesisPhaseProps) {
  const {
    loadingStep, autoRunning, handleAutoRun, handleSkip,
    handleRestore, handleExecute, handleContinueNext,
  } = useStepActions(projectId, onRefresh);
  const [adding, setAdding] = useState(false);
  const [newStatement, setNewStatement] = useState("");
  const [newRationale, setNewRationale] = useState("");

  const handleAdd = async () => {
    if (!newStatement.trim()) return;
    try {
      await fetch(`/api/research/${projectId}/hypotheses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statement: newStatement.trim(), rationale: newRationale.trim() || null }),
      });
      setNewStatement("");
      setNewRationale("");
      setAdding(false);
      onRefresh();
      toast.success("Hypothesis added");
    } catch {
      toast.error("Failed to add hypothesis");
    }
  };

  const handleUpdateStatus = async (id: string, status: string) => {
    try {
      await fetch(`/api/research/${projectId}/hypotheses/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      onRefresh();
    } catch {
      toast.error("Failed to update hypothesis");
    }
  };

  const handleEdit = async (id: string, statement: string, rationale: string) => {
    try {
      await fetch(`/api/research/${projectId}/hypotheses/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statement, rationale }),
      });
      onRefresh();
    } catch {
      toast.error("Failed to update hypothesis");
    }
  };

  const runningSteps = steps.filter((s) => s.status === "RUNNING");
  const pendingSteps = steps.filter((s) => s.status === "PROPOSED" || s.status === "APPROVED");
  const completedSteps = steps.filter((s) => s.status === "COMPLETED");
  const failedSteps = steps.filter((s) => s.status === "FAILED");

  return (
    <div className="space-y-4 pr-2">
      {/* Action bar */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleAutoRun}
          disabled={autoRunning || runningSteps.length > 0}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {autoRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {runningSteps.length > 0 ? "Generating hypotheses..." : "Generate hypotheses"}
        </button>
        <button
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="h-3 w-3" />
          Add manually
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

      {/* Completed steps — earlier compact, latest with actions */}
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

      {/* Pending steps (skip the first if "Continue" covers it) */}
      {pendingSteps.slice(completedSteps.length > 0 ? 1 : 0).map((step) => (
        <StepCard key={step.id} step={step} onSkip={handleSkip} onExecute={handleExecute} loading={loadingStep === step.id} />
      ))}

      {/* Add form */}
      {adding && (
        <div className="rounded-md border border-border p-3 space-y-2">
          <textarea
            value={newStatement}
            onChange={(e) => setNewStatement(e.target.value)}
            placeholder="Hypothesis statement..."
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            rows={2}
            autoFocus
          />
          <textarea
            value={newRationale}
            onChange={(e) => setNewRationale(e.target.value)}
            placeholder="Rationale (optional)..."
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            rows={2}
          />
          <div className="flex gap-1.5">
            <button
              onClick={handleAdd}
              disabled={!newStatement.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-3 py-1 text-[11px] hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              Add
            </button>
            <button
              onClick={() => { setAdding(false); setNewStatement(""); setNewRationale(""); }}
              className="text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Hypothesis cards */}
      {hypotheses.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            Hypotheses ({hypotheses.length})
          </h3>
          {hypotheses.map((h) => (
            <HypothesisCard
              key={h.id}
              hypothesis={h}
              onUpdateStatus={handleUpdateStatus}
              onEdit={handleEdit}
            />
          ))}
        </div>
      ) : !adding && runningSteps.length === 0 && pendingSteps.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-4 text-center">
          <p className="text-xs text-muted-foreground">No hypotheses yet. Use the buttons above to add or generate them.</p>
        </div>
      )}
    </div>
  );
}
