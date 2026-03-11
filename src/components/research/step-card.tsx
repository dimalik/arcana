"use client";

import { useState } from "react";
import {
  Loader2, Check, X, SkipForward, Undo2, ChevronDown, ChevronRight,
  BrainCircuit, AlertCircle, Play, SearchCheck, ArrowRight, Server,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

interface StepCardProps {
  step: {
    id: string;
    type: string;
    status: string;
    title: string;
    description: string | null;
    output: string | null;
  };
  onSkip?: (stepId: string) => void;
  onExecute?: (stepId: string) => void;
  onRestore?: (stepId: string) => void;
  onContinue?: () => void;
  onSearchMore?: () => void;
  onDeploy?: () => void;
  loading?: boolean;
  compact?: boolean;
  /** Whether this is the last completed step (shows actions) */
  isLatestCompleted?: boolean;
  /** Whether there's a next step to continue to */
  hasNextStep?: boolean;
  nextStepTitle?: string;
}

export function StepCard({
  step, onSkip, onExecute, onRestore, onContinue, onSearchMore, onDeploy,
  loading, compact, isLatestCompleted, hasNextStep, nextStepTitle,
}: StepCardProps) {
  const [expanded, setExpanded] = useState(false);

  const parsedOutput = (() => {
    if (!step.output) return null;
    try { return JSON.parse(step.output); } catch { return null; }
  })();

  const hasAnalysis = parsedOutput?.analysis;

  // Build a short summary for completed steps
  const completionSummary = (() => {
    if (!parsedOutput) return null;
    if (step.type === "search_papers") {
      const n = parsedOutput.imported || parsedOutput.paperIds?.length || 0;
      return `${n} paper${n !== 1 ? "s" : ""} found`;
    }
    if (step.type === "discover_papers") {
      return `${parsedOutput.totalFound || 0} papers discovered`;
    }
    if (step.type === "formulate_hypothesis") {
      return "Hypothesis recorded";
    }
    if (step.type === "run_experiment") {
      const host = parsedOutput.host;
      return host ? `Ran on ${host}` : "Ran locally";
    }
    if (step.type === "analyze_results") {
      return parsedOutput.type === "breakthrough" ? "Breakthrough" : "Finding recorded";
    }
    if (parsedOutput.hypothesesCreated) {
      return `${parsedOutput.hypothesesCreated} hypotheses generated`;
    }
    if (hasAnalysis) return "Analysis ready";
    return null;
  })();

  // ── Compact completed step (not the latest) ──
  if (compact || (step.status === "COMPLETED" && !isLatestCompleted && !expanded)) {
    return (
      <div className="flex items-center gap-2 py-1 group">
        <Check className="h-3 w-3 text-emerald-500 shrink-0" />
        <span className="text-[11px] text-muted-foreground flex-1 truncate">{step.title}</span>
        {completionSummary && (
          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 shrink-0">
            {completionSummary}
          </span>
        )}
        {hasAnalysis && (
          <button
            onClick={() => setExpanded(true)}
            className="text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors opacity-0 group-hover:opacity-100 shrink-0"
          >
            show
          </button>
        )}
      </div>
    );
  }

  // ── Latest completed step — show results + actions ──
  if (step.status === "COMPLETED" && (isLatestCompleted || expanded)) {
    return (
      <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {expanded && !isLatestCompleted && (
              <button onClick={() => setExpanded(false)} className="text-muted-foreground hover:text-foreground">
                <ChevronDown className="h-3 w-3" />
              </button>
            )}
            <Check className="h-3 w-3 text-emerald-500" />
            <h4 className="text-xs font-medium">{step.title}</h4>
            {completionSummary && (
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400">{completionSummary}</span>
            )}
          </div>
          {isLatestCompleted && hasAnalysis && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              show details
            </button>
          )}
          {expanded && (
            <button
              onClick={() => setExpanded(false)}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              hide
            </button>
          )}
        </div>

        {/* Expanded output */}
        {expanded && step.output && (
          <div className="rounded bg-background/50 p-2 text-[11px] text-muted-foreground overflow-auto max-h-96">
            {hasAnalysis ? (
              <MarkdownRenderer content={parsedOutput.analysis} className="leading-relaxed [&_p]:mb-1.5 [&_table]:text-[10px]" />
            ) : parsedOutput?.error ? (
              <p className="text-destructive">{parsedOutput.error}</p>
            ) : (
              <pre className="whitespace-pre-wrap">{JSON.stringify(parsedOutput, null, 2)}</pre>
            )}
          </div>
        )}

        {/* Actions for latest completed step */}
        {isLatestCompleted && (
          <div className="flex items-center gap-2 pt-1">
            {/* Step-specific actions */}
            {(step.type === "search_papers" || step.type === "discover_papers") && onSearchMore && (
              <button
                onClick={onSearchMore}
                disabled={loading}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              >
                <SearchCheck className="h-3 w-3" />
                Search more papers
              </button>
            )}
            {step.type === "generate_code" && onDeploy && (
              <button
                onClick={onDeploy}
                disabled={loading}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              >
                <Server className="h-3 w-3" />
                Run on remote
              </button>
            )}

            {/* Continue to next step */}
            {hasNextStep && onContinue && (
              <button
                onClick={onContinue}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1 text-[11px] hover:bg-primary/90 transition-colors disabled:opacity-50 ml-auto"
              >
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />}
                Continue{nextStepTitle ? `: ${nextStepTitle}` : ""}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Running step ──
  if (step.status === "RUNNING") {
    return (
      <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 animate-in fade-in">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
            <h4 className="text-xs font-medium">{step.title}</h4>
            <span className="text-[10px] text-blue-400">Running...</span>
          </div>
          <button
            onClick={() => onRestore?.(step.id)}
            disabled={loading}
            className="inline-flex h-6 items-center gap-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted px-1.5 text-[10px] transition-colors"
            title="Cancel and reset"
          >
            <X className="h-3 w-3" />
            Cancel
          </button>
        </div>
        {step.description && (
          <p className="text-[11px] text-muted-foreground mt-1">{step.description}</p>
        )}
      </div>
    );
  }

  // ── Failed step ──
  if (step.status === "FAILED") {
    const errorMsg = parsedOutput?.error || null;
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            <h4 className="text-xs font-medium">{step.title}</h4>
            <span className="text-[10px] text-destructive">Failed</span>
          </div>
          <button
            onClick={() => onRestore?.(step.id)}
            disabled={loading}
            className="inline-flex h-6 items-center gap-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted px-1.5 text-[10px] transition-colors"
          >
            <Undo2 className="h-3 w-3" />
            Retry
          </button>
        </div>
        {errorMsg && (
          <p className="text-[10px] text-destructive/80 mt-1">{errorMsg}</p>
        )}
      </div>
    );
  }

  // ── Skipped step ──
  if (step.status === "SKIPPED") {
    return (
      <div className="flex items-center gap-2 py-1 group text-muted-foreground/50">
        <SkipForward className="h-3 w-3 shrink-0" />
        <span className="text-[11px] flex-1 truncate line-through">{step.title}</span>
        <button
          onClick={() => onRestore?.(step.id)}
          disabled={loading}
          className="text-[10px] hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
        >
          undo
        </button>
      </div>
    );
  }

  // ── PROPOSED or APPROVED — waiting to run ──
  return (
    <div className="rounded-md border border-border/50 bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
          <h4 className="text-xs font-medium">{step.title}</h4>
          <span className="text-[10px] text-muted-foreground">
            {step.status === "APPROVED" ? "Queued" : "Up next"}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {onExecute && (
            <button
              onClick={() => onExecute(step.id)}
              disabled={loading}
              className="inline-flex h-6 items-center gap-1 rounded-md bg-primary text-primary-foreground px-2 text-[11px] hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Run
            </button>
          )}
          <button
            onClick={() => onSkip?.(step.id)}
            disabled={loading}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted transition-colors"
            title="Skip"
          >
            <SkipForward className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {step.description && (
        <p className="text-[11px] text-muted-foreground mt-0.5">{step.description}</p>
      )}
    </div>
  );
}
