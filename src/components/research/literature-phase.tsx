"use client";

import { useEffect } from "react";
import Link from "next/link";
import { FileText, Search, Loader2, Sparkles } from "lucide-react";
import { StepCard } from "./step-card";
import { useStepActions } from "./use-step-actions";

interface Paper {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  summary: string | null;
  processingStatus: string | null;
}

interface Step {
  id: string;
  type: string;
  status: string;
  title: string;
  description: string | null;
  output: string | null;
}

interface LiteraturePhaseProps {
  projectId: string;
  papers: Paper[];
  steps: Step[];
  onRefresh: () => void;
}

const PROCESSING_LABELS: Record<string, string> = {
  PENDING: "Queued",
  DOWNLOADING: "Downloading PDF",
  EXTRACTING_TEXT: "Extracting text",
  SUMMARIZING: "Generating summary",
  COMPLETED: "",
  FAILED: "Processing failed",
};

export function LiteraturePhase({ projectId, papers, steps, onRefresh }: LiteraturePhaseProps) {
  const {
    loadingStep, autoRunning, handleAutoRun, handleSkip,
    handleRestore, handleExecute, handleContinueNext, handleSearchMore,
  } = useStepActions(projectId, onRefresh);

  // Auto-poll while any paper is still processing
  const processingCount = papers.filter(
    (p) => p.processingStatus && !["COMPLETED", "FAILED"].includes(p.processingStatus)
  ).length;

  useEffect(() => {
    if (processingCount === 0) return;
    const interval = setInterval(onRefresh, 4000);
    return () => clearInterval(interval);
  }, [processingCount, onRefresh]);

  const runningSteps = steps.filter((s) => s.status === "RUNNING");
  const pendingSteps = steps.filter((s) => s.status === "PROPOSED" || s.status === "APPROVED");
  const completedSteps = steps.filter((s) => s.status === "COMPLETED");
  const failedSteps = steps.filter((s) => s.status === "FAILED");
  const skippedSteps = steps.filter((s) => s.status === "SKIPPED");

  // Find the latest completed step and the next pending step
  const latestCompleted = completedSteps[completedSteps.length - 1];
  const nextPending = pendingSteps[0];

  return (
    <div className="space-y-4 pr-2">
      {/* Action bar */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleAutoRun}
          disabled={autoRunning || runningSteps.length > 0}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {autoRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {runningSteps.length > 0 ? "Working..." : "What should I do next?"}
        </button>
      </div>

      {/* Running steps — prominent */}
      {runningSteps.map((step) => (
        <StepCard key={step.id} step={step} onRestore={handleRestore} loading={loadingStep === step.id} />
      ))}

      {/* Failed steps */}
      {failedSteps.map((step) => (
        <StepCard key={step.id} step={step} onRestore={handleRestore} loading={loadingStep === step.id} />
      ))}

      {/* Completed steps — earlier ones compact, latest one expanded with actions */}
      {completedSteps.length > 0 && (
        <div className="space-y-1">
          {completedSteps.length > 1 && (
            <div className="border-l-2 border-emerald-500/20 pl-3 space-y-0.5 mb-2">
              <p className="text-[10px] text-muted-foreground/60 mb-1">Earlier steps</p>
              {completedSteps.slice(0, -1).map((step) => (
                <StepCard key={step.id} step={step} compact />
              ))}
            </div>
          )}
          {latestCompleted && (
            <StepCard
              key={latestCompleted.id}
              step={latestCompleted}
              isLatestCompleted
              hasNextStep={!!nextPending}
              nextStepTitle={nextPending?.title}
              onContinue={nextPending ? () => handleContinueNext(nextPending.id) : undefined}
              onSearchMore={handleSearchMore}
              loading={!!loadingStep}
            />
          )}
        </div>
      )}

      {/* Pending steps (only show if no completed step with "Continue" covers it) */}
      {pendingSteps.slice(latestCompleted ? 1 : 0).map((step) => (
        <StepCard key={step.id} step={step} onSkip={handleSkip} onExecute={handleExecute} loading={loadingStep === step.id} />
      ))}

      {/* Skipped steps */}
      {skippedSteps.length > 0 && (
        <div className="space-y-0.5">
          {skippedSteps.map((step) => (
            <StepCard key={step.id} step={step} onRestore={handleRestore} loading={loadingStep === step.id} />
          ))}
        </div>
      )}

      {/* Papers list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            Project Papers ({papers.length})
          </h3>
        </div>

        {/* Processing banner */}
        {processingCount > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 mb-2">
            <Loader2 className="h-3 w-3 animate-spin text-blue-500 shrink-0" />
            <span className="text-[11px] text-blue-400">
              Processing {processingCount} paper{processingCount !== 1 ? "s" : ""} — downloading PDFs, extracting text, generating summaries...
            </span>
          </div>
        )}

        {papers.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center">
            <Search className="h-4 w-4 mx-auto text-muted-foreground/50 mb-1" />
            <p className="text-xs text-muted-foreground">No papers yet. Steps above will discover related papers automatically.</p>
          </div>
        ) : (
          <div className="space-y-1">
            {papers.map((p) => {
              const isProcessing = p.processingStatus && !["COMPLETED", "FAILED"].includes(p.processingStatus);
              const isFailed = p.processingStatus === "FAILED";
              const statusLabel = PROCESSING_LABELS[p.processingStatus || ""] || p.processingStatus;

              return (
                <Link
                  key={p.id}
                  href={`/papers/${p.id}`}
                  className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors group"
                >
                  {isProcessing ? (
                    <Loader2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-500 animate-spin" />
                  ) : (
                    <FileText className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${isFailed ? "text-destructive/50" : "text-muted-foreground/50"}`} />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs group-hover:underline">{p.title}</p>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
                      {p.year && <span>{p.year}</span>}
                      {p.authors && (
                        <span className="truncate">
                          {(() => { try { return JSON.parse(p.authors).slice(0, 2).join(", "); } catch { return p.authors; } })()}
                        </span>
                      )}
                      {isProcessing && statusLabel && (
                        <span className="text-blue-400 flex items-center gap-1">
                          <span className="inline-block w-1 h-1 rounded-full bg-blue-400 animate-pulse" />
                          {statusLabel}
                        </span>
                      )}
                      {isFailed && (
                        <span className="text-destructive/70">{statusLabel}</span>
                      )}
                    </div>
                    {p.summary && (
                      <p className="text-[10px] text-muted-foreground/60 line-clamp-1 mt-0.5">{p.summary}</p>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
