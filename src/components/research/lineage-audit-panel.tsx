"use client";

import { startTransition, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  FlaskConical,
  Link2,
  Loader2,
  Microscope,
  Search,
  Shield,
  ShieldAlert,
  Sparkles,
  Target,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { cn } from "@/lib/utils";

interface LineageOverview {
  hypotheses: number;
  runs: number;
  results: number;
  claims: number;
  memories: number;
  queue: number;
  blocking: number;
  tracks: number;
}

interface LineageHypothesis {
  id: string;
  statement: string;
  status: string;
  theme: string | null;
  rationale: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LineageRun {
  id: string;
  hypothesisId: string | null;
  state: string;
  attemptCount: number;
  lastErrorClass: string | null;
  lastErrorReason: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  requestedHost: { alias: string; gpuType: string | null } | null;
  remoteJobs: Array<{
    id: string;
    status: string;
    command: string;
    hypothesisId: string | null;
    createdAt: string;
    completedAt: string | null;
    host: { alias: string; gpuType: string | null };
  }>;
}

interface LineageResult {
  id: string;
  jobId: string | null;
  hypothesisId: string | null;
  branchId: string | null;
  scriptName: string;
  metrics: string | null;
  comparison: string | null;
  verdict: string | null;
  createdAt: string;
  branch: { name: string; status: string } | null;
  artifacts: Array<{
    id: string;
    type: string;
    filename: string;
    path: string;
    keyTakeaway: string | null;
  }>;
  runId: string | null;
  metricSummary: string;
  comparisonSummary: string;
}

interface LineageEvidence {
  id: string;
  kind: string;
  supports: boolean;
  strength: string;
  rationale: string | null;
  excerpt: string | null;
  locator: string | null;
  createdAt: string;
  paper: { id: string; title: string; year: number | null } | null;
  hypothesis: { id: string; statement: string; status: string } | null;
  result: { id: string; scriptName: string } | null;
  artifact: { id: string; filename: string; keyTakeaway: string | null } | null;
  logEntry: { id: string; type: string; content: string } | null;
  task: { id: string; role: string; status: string } | null;
  remoteJob: { id: string; command: string; status: string } | null;
}

interface LineageMemory {
  id: string;
  category: string;
  status: string;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
  claimId: string;
  claimStatement: string;
}

interface ClaimNode {
  id: string;
  statement: string;
  summary: string | null;
  type: string;
  status: "DRAFT" | "SUPPORTED" | "CONTESTED" | "REPRODUCED" | "RETRACTED";
  confidence: "PRELIMINARY" | "MODERATE" | "STRONG";
  createdBy: string;
  createdFrom: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  hasReview: boolean;
  evidenceSummary: { support: number; rebuttal: number };
  result: { id: string; scriptName: string; verdict: string | null; metrics: string | null } | null;
  hypothesis: { id: string; statement: string; status: string } | null;
  task: { id: string; role: string; status: string } | null;
  memories: Array<{ id: string; category: string; status: string; confidence: number | null; createdAt: string; updatedAt: string }>;
  evidence: LineageEvidence[];
}

interface QueueItem {
  stepId: string;
  coordinatorKey: string;
  type: "claim_needs_evidence" | "claim_review_required" | "claim_reproduction_required" | "claim_experiment_required" | "claim_memory_ready";
  status: "PROPOSED" | "APPROVED" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";
  title: string;
  description: string | null;
  claimId: string | null;
  claimStatement: string | null;
  claimStatus: string | null;
  claimConfidence: string | null;
  experimentReason: string | null;
  taskRole: "reviewer" | "reproducer" | null;
  taskId: string | null;
  taskStatus: string | null;
  blocking: boolean;
  priority: number | null;
}

interface LineageTrack {
  id: string;
  anchorType: "hypothesis" | "result" | "claim" | "run";
  label: string;
  updatedAt: string;
  hypothesis: LineageHypothesis | null;
  runs: LineageRun[];
  results: LineageResult[];
  claims: ClaimNode[];
  memories: LineageMemory[];
  queue: QueueItem[];
  gaps: string[];
  unclaimedResultIds: string[];
  stats: {
    blocking: number;
    results: number;
    claims: number;
    memories: number;
    reproduced: number;
    contested: number;
    reviewed: number;
    directEvidence: number;
  };
}

interface LineageResponse {
  project: {
    id: string;
    title: string;
    status: string;
    currentPhase: string;
    methodology: string | null;
  };
  overview: LineageOverview;
  tracks: LineageTrack[];
}

interface LineageAuditPanelProps {
  projectId: string;
}

const STATUS_META: Record<ClaimNode["status"], { pill: string; text: string }> = {
  DRAFT: {
    pill: "border-border/70 bg-muted/40 text-muted-foreground",
    text: "Draft",
  },
  SUPPORTED: {
    pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    text: "Supported",
  },
  CONTESTED: {
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    text: "Contested",
  },
  REPRODUCED: {
    pill: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    text: "Reproduced",
  },
  RETRACTED: {
    pill: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    text: "Retracted",
  },
};

const PROSE_SM = "prose prose-sm prose-neutral dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_p]:text-xs [&_p]:leading-relaxed [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_li]:text-xs [&_code]:text-[11px] [&_pre]:text-[11px] [&_pre]:my-1.5 [&_strong]:text-foreground";

function restoreMarkdownBlocks(text: string): string {
  return text
    .replace(/(?<!\n)(#{1,6}\s)/g, "\n\n$1")
    .replace(/(?<!\n)(\d+\.\s(?:\*\*|[A-Z]))/g, "\n\n$1")
    .replace(/ (- (?:[A-Z*]))/g, "\n$1")
    .replace(/^\n+/, "")
    .trim();
}

function stripInlineMarkdown(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1");
}

function scrubMarkdown(text: string | null | undefined) {
  return stripInlineMarkdown(text || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function truncate(text: string, max = 120) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function headline(text: string) {
  const cleaned = scrubMarkdown(text);
  return cleaned.split("\n").map((line) => line.trim()).find(Boolean) || cleaned;
}

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function anchorLabel(anchorType: LineageTrack["anchorType"]) {
  if (anchorType === "hypothesis") return "Hypothesis chain";
  if (anchorType === "result") return "Result chain";
  if (anchorType === "run") return "Run chain";
  return "Claim chain";
}

function anchorIcon(anchorType: LineageTrack["anchorType"]): LucideIcon {
  if (anchorType === "hypothesis") return Target;
  if (anchorType === "result") return FlaskConical;
  if (anchorType === "run") return Microscope;
  return Shield;
}

function evidenceLabel(evidence: LineageEvidence) {
  if (evidence.paper) return evidence.paper.year ? `${evidence.paper.title} (${evidence.paper.year})` : evidence.paper.title;
  if (evidence.result) return `Experiment result: ${evidence.result.scriptName}`;
  if (evidence.hypothesis) return `Hypothesis: ${truncate(scrubMarkdown(evidence.hypothesis.statement), 84)}`;
  if (evidence.artifact) return `Artifact: ${evidence.artifact.filename}`;
  if (evidence.logEntry) return `Notebook ${evidence.logEntry.type}`;
  if (evidence.task) return `${evidence.task.role} task`;
  if (evidence.remoteJob) return `Remote job: ${truncate(evidence.remoteJob.command, 84)}`;
  return evidence.kind.replace(/_/g, " ");
}

function trackSearchText(track: LineageTrack) {
  return [
    track.label,
    track.hypothesis?.statement,
    ...track.results.map((result) => result.scriptName),
    ...track.claims.map((claim) => claim.statement),
    ...track.memories.map((memory) => memory.claimStatement),
    ...track.gaps,
  ].filter(Boolean).join("\n").toLowerCase();
}

function queueTone(item: QueueItem) {
  if (item.blocking) return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (item.type === "claim_memory_ready") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return "border-border/70 bg-muted/40 text-muted-foreground";
}

function focusSignal(track: LineageTrack) {
  const hasApprovedMemory = track.memories.some((memory) => memory.status === "APPROVED");
  const hasCandidateMemory = track.memories.some((memory) => memory.status === "CANDIDATE");
  if (track.stats.blocking > 0) {
    return {
      icon: AlertTriangle,
      title: "Waiting on this chain",
      detail: track.gaps[0] || "Resolve the blocking credibility work before advancing the project.",
      tone: "warning",
    };
  }
  if (track.stats.contested > 0) {
    return {
      icon: ShieldAlert,
      title: "Evidence in dispute",
      detail: track.gaps[0] || "One or more claims remain contested and need a decisive follow-up.",
      tone: "danger",
    };
  }
  if (hasApprovedMemory) {
    return {
      icon: Brain,
      title: "Durable memory exists",
      detail: "This chain already has promoted memory attached to it.",
      tone: "success",
    };
  }
  if (hasCandidateMemory) {
    return {
      icon: Brain,
      title: "Candidate memory exists",
      detail: "This chain has claim-backed memory, but it has not been approved as durable yet.",
      tone: "neutral",
    };
  }
  return {
    icon: CheckCircle2,
    title: "Trail is in shape",
    detail: "This chain has enough structure to inspect without guessing.",
    tone: "neutral",
  };
}

function nodeTone(kind: "hypothesis" | "run" | "result" | "claim" | "memory") {
  if (kind === "hypothesis") return "border-sky-500/20 bg-sky-500/5";
  if (kind === "run") return "border-indigo-500/20 bg-indigo-500/5";
  if (kind === "result") return "border-emerald-500/20 bg-emerald-500/5";
  if (kind === "claim") return "border-amber-500/20 bg-amber-500/5";
  return "border-border/70 bg-muted/35";
}

function NodeShell({
  icon: Icon,
  title,
  meta,
  kind,
  children,
}: {
  icon: LucideIcon;
  title: string;
  meta?: string;
  kind: "hypothesis" | "run" | "result" | "claim" | "memory";
  children?: ReactNode;
}) {
  return (
    <div className="relative pl-8">
      <div className={cn("absolute left-0 top-0 flex h-6 w-6 items-center justify-center rounded-md border", nodeTone(kind))}>
        <Icon className="h-3 w-3" />
      </div>
      <div className="rounded-lg border border-border/60 bg-background p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 className="text-xs font-semibold leading-snug text-foreground">{title}</h4>
            {meta && <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/50">{meta}</p>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── Component ─────────────────────────────────────────────────────── */

export function LineageAuditPanel({ projectId }: LineageAuditPanelProps) {
  const [data, setData] = useState<LineageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/research/${projectId}/lineage`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(typeof body?.error === "string" ? body.error : "Failed to load lineage");
        }
        return body as LineageResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setSelectedTrackId((current) => current && body.tracks.some((track) => track.id === current) ? current : body.tracks[0]?.id || null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load lineage");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const tracks = data?.tracks || [];
  const filteredTracks = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    if (!needle) return tracks;
    return tracks.filter((track) => trackSearchText(track).includes(needle));
  }, [tracks, deferredQuery]);

  useEffect(() => {
    if (filteredTracks.length === 0) {
      setSelectedTrackId(null);
      return;
    }
    if (!selectedTrackId || !filteredTracks.some((track) => track.id === selectedTrackId)) {
      setSelectedTrackId(filteredTracks[0].id);
    }
  }, [filteredTracks, selectedTrackId]);

  const selectedTrack = useMemo(
    () => filteredTracks.find((track) => track.id === selectedTrackId) || filteredTracks[0] || null,
    [filteredTracks, selectedTrackId],
  );

  const focus = selectedTrack ? focusSignal(selectedTrack) : null;
  const ov = data?.overview;

  /* ── Render ────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Building audit trail…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
        <p className="text-xs font-medium text-red-700 dark:text-red-300">Lineage unavailable</p>
        <p className="mt-1 text-xs text-red-600/80 dark:text-red-300/80">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* ── Header ── */}
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Audit Trail</h3>
          {ov && (
            <span className="text-[11px] text-muted-foreground/50">{ov.tracks} chain{ov.tracks === 1 ? "" : "s"}</span>
          )}
        </div>
        {ov && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{ov.hypotheses} hypothes{ov.hypotheses === 1 ? "is" : "es"}</span>
            <span>{ov.results} result{ov.results === 1 ? "" : "s"}</span>
            <span>{ov.claims} claim{ov.claims === 1 ? "" : "s"}</span>
            <span>{ov.memories} memor{ov.memories === 1 ? "y" : "ies"}</span>
            {ov.blocking > 0 && (
              <span className="text-amber-600 dark:text-amber-300">{ov.blocking} blocking</span>
            )}
          </div>
        )}
      </div>

      {/* ── Search ── */}
      {tracks.length > 1 && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/40" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chains..."
            className="h-8 w-full rounded-md border border-border/60 bg-background pl-8 pr-3 text-xs outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-foreground/20"
          />
        </div>
      )}

      {/* ── Track selector ── */}
      {filteredTracks.length === 0 && !selectedTrack ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Sparkles className="h-4 w-4 text-muted-foreground/30" />
          <p className="text-sm font-medium text-foreground">
            {tracks.length === 0 ? "No auditable chain yet" : "No chains match"}
          </p>
          <p className="max-w-xs text-[11px] leading-5 text-muted-foreground/60">
            {tracks.length === 0
              ? "Once the project records hypotheses, results, or claims, they appear here."
              : "Try a claim phrase, script name, or hypothesis theme."}
          </p>
        </div>
      ) : (
        <>
          {filteredTracks.length > 1 && (
            <div className="overflow-hidden rounded-lg border border-border/60">
              <div className="divide-y divide-border/30">
                {filteredTracks.map((track) => {
                  const Icon = anchorIcon(track.anchorType);
                  const selected = track.id === selectedTrack?.id;
                  return (
                    <button
                      key={track.id}
                      type="button"
                      onClick={() => startTransition(() => setSelectedTrackId(track.id))}
                      className={cn(
                        "relative w-full px-3 py-2.5 text-left transition-colors",
                        selected ? "bg-muted/40" : "hover:bg-muted/20",
                      )}
                    >
                      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-foreground/30" />}
                      <div className="flex items-center gap-2">
                        <div className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-md border", nodeTone(track.anchorType))}>
                          <Icon className="h-2.5 w-2.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium leading-snug">{track.label}</p>
                        </div>
                        {track.stats.blocking > 0 && (
                          <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-300">
                            {track.stats.blocking} blocking
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex gap-2.5 pl-7 text-[10px] text-muted-foreground/50">
                        <span>{anchorLabel(track.anchorType)}</span>
                        <span>{track.stats.results}r · {track.stats.claims}c · {track.stats.memories}m</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Selected chain detail ── */}
          {selectedTrack && focus && (
            <div className="space-y-3">
              {/* Chain header + focus signal */}
              <div className="rounded-lg border border-border/60 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground/50">{anchorLabel(selectedTrack.anchorType)}</p>
                    <h3 className="mt-1 text-sm font-semibold leading-snug text-foreground">{selectedTrack.label}</h3>
                  </div>
                  <span className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                    focus.tone === "warning" && "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                    focus.tone === "danger" && "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
                    focus.tone === "success" && "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                    focus.tone === "neutral" && "border-border/60 bg-muted/40 text-muted-foreground",
                  )}>
                    <focus.icon className="h-2.5 w-2.5" />
                    {focus.title}
                  </span>
                </div>

                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{focus.detail}</p>

                <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground/50">
                  <span>{selectedTrack.stats.reviewed}/{selectedTrack.stats.claims} reviewed</span>
                  <span>{selectedTrack.stats.directEvidence} evidence</span>
                  {selectedTrack.stats.reproduced > 0 && (
                    <span className="text-sky-600 dark:text-sky-300">{selectedTrack.stats.reproduced} reproduced</span>
                  )}
                  {selectedTrack.stats.contested > 0 && (
                    <span className="text-red-600 dark:text-red-300">{selectedTrack.stats.contested} contested</span>
                  )}
                </div>
              </div>

              {/* Coordinator queue */}
              {selectedTrack.queue.length > 0 && (
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="mb-2.5 flex items-center justify-between">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Queue</p>
                    <span className="text-[10px] text-muted-foreground/40">{selectedTrack.queue.length} open</span>
                  </div>
                  <div className="space-y-1.5">
                    {selectedTrack.queue.map((item) => (
                      <div key={item.stepId} className="flex items-start justify-between gap-2 rounded-md border border-border/50 bg-muted/5 p-2.5">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-foreground">{item.title}</p>
                          {item.description && <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{item.description}</p>}
                        </div>
                        <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium", queueTone(item))}>
                          {item.blocking ? "Blocking" : item.status.toLowerCase()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Node chain */}
              <div className="rounded-lg border border-border/60 p-3">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Chain</p>
                <div className="space-y-3">
                  {selectedTrack.hypothesis && (
                    <NodeShell
                      icon={Target}
                      kind="hypothesis"
                      title={headline(selectedTrack.hypothesis.statement)}
                      meta={`${selectedTrack.hypothesis.status.toLowerCase()}${selectedTrack.hypothesis.theme ? ` · ${selectedTrack.hypothesis.theme}` : ""}`}
                    >
                      {selectedTrack.hypothesis.rationale && (
                        <div className={cn("mt-2", PROSE_SM)}>
                          <MarkdownRenderer content={restoreMarkdownBlocks(selectedTrack.hypothesis.rationale)} />
                        </div>
                      )}
                    </NodeShell>
                  )}

                  {selectedTrack.runs.map((run) => (
                    <NodeShell
                      key={run.id}
                      icon={Microscope}
                      kind="run"
                      title={run.requestedHost?.alias || run.remoteJobs[0]?.host.alias || `Run ${run.id.slice(0, 8)}`}
                      meta={`${run.state.toLowerCase()} · ${formatWhen(run.queuedAt)}`}
                    >
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground/50">
                        <span>{run.attemptCount} attempt{run.attemptCount === 1 ? "" : "s"}</span>
                        {run.requestedHost?.gpuType && <span>· {run.requestedHost.gpuType}</span>}
                      </div>
                      {run.lastErrorReason && (
                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{truncate(run.lastErrorReason, 180)}</p>
                      )}
                      {run.remoteJobs.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {run.remoteJobs.slice(0, 3).map((job) => (
                            <div key={job.id} className="rounded-md border border-border/50 bg-muted/10 px-2.5 py-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[11px] font-medium text-foreground">{job.host.alias}</p>
                                <p className="text-[10px] uppercase tracking-wide text-muted-foreground/50">{job.status}</p>
                              </div>
                              <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground/60">{truncate(job.command, 90)}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </NodeShell>
                  ))}

                  {selectedTrack.results.map((result) => (
                    <NodeShell
                      key={result.id}
                      icon={FlaskConical}
                      kind="result"
                      title={result.scriptName}
                      meta={`${result.verdict || "unknown"} · ${formatWhen(result.createdAt)}`}
                    >
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {result.metricSummary && (
                          <span className="rounded-md border border-emerald-500/20 bg-emerald-500/8 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                            {result.metricSummary}
                          </span>
                        )}
                        {result.comparisonSummary && (
                          <span className="rounded-md border border-sky-500/20 bg-sky-500/8 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                            {result.comparisonSummary}
                          </span>
                        )}
                        {result.branch && (
                          <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {result.branch.name}
                          </span>
                        )}
                      </div>
                      {result.artifacts.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {result.artifacts.slice(0, 3).map((artifact) => (
                            <div key={artifact.id} className="rounded-md border border-border/50 bg-muted/10 px-2.5 py-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[11px] font-medium text-foreground">{artifact.filename}</p>
                                <p className="text-[10px] uppercase tracking-wide text-muted-foreground/50">{artifact.type}</p>
                              </div>
                              {artifact.keyTakeaway && (
                                <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground/60">{truncate(artifact.keyTakeaway, 100)}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </NodeShell>
                  ))}

                  {selectedTrack.claims.map((claim) => (
                    <NodeShell
                      key={claim.id}
                      icon={Shield}
                      kind="claim"
                      title={headline(claim.statement)}
                      meta={`${claim.type.replace(/_/g, " ")} · ${formatWhen(claim.updatedAt)}`}
                    >
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-medium", STATUS_META[claim.status].pill)}>
                          {STATUS_META[claim.status].text}
                        </span>
                        <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {claim.confidence.toLowerCase()}
                        </span>
                        <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {claim.evidenceSummary.support}↑ {claim.evidenceSummary.rebuttal}↓
                        </span>
                        {claim.hasReview && (
                          <span className="rounded-md border border-sky-500/20 bg-sky-500/8 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                            reviewed
                          </span>
                        )}
                      </div>
                      {claim.summary && (
                        <div className={cn("mt-2", PROSE_SM)}>
                          <MarkdownRenderer content={restoreMarkdownBlocks(claim.summary)} />
                        </div>
                      )}
                      {claim.notes && (
                        <div className={cn("mt-2 text-muted-foreground", PROSE_SM)}>
                          <MarkdownRenderer content={restoreMarkdownBlocks(claim.notes)} />
                        </div>
                      )}
                      {claim.evidence.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {claim.evidence.slice(0, 4).map((evidence) => (
                            <div key={evidence.id} className="rounded-md border border-border/50 bg-muted/10 px-2.5 py-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[11px] font-medium text-foreground">{evidenceLabel(evidence)}</p>
                                <span className={cn(
                                  "text-[9px] font-medium uppercase tracking-wide",
                                  evidence.supports
                                    ? "text-emerald-600 dark:text-emerald-300"
                                    : "text-red-600 dark:text-red-300",
                                )}>
                                  {evidence.supports ? "supports" : "rebuts"}
                                </span>
                              </div>
                              {(evidence.rationale || evidence.excerpt) && (
                                <div className={cn("mt-1 text-muted-foreground", PROSE_SM)}>
                                  <MarkdownRenderer content={restoreMarkdownBlocks(evidence.rationale || evidence.excerpt || "")} />
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </NodeShell>
                  ))}

                  {selectedTrack.memories.map((memory) => (
                    <NodeShell
                      key={memory.id}
                      icon={Brain}
                      kind="memory"
                      title={memory.category.replace(/_/g, " ")}
                      meta={`${memory.status.toLowerCase()} · ${formatWhen(memory.updatedAt)}`}
                    >
                      <div className={cn("mt-2 text-muted-foreground", PROSE_SM)}>
                        <MarkdownRenderer content={restoreMarkdownBlocks(memory.claimStatement)} />
                      </div>
                    </NodeShell>
                  ))}
                </div>
              </div>

              {/* Audit gaps */}
              {selectedTrack.gaps.length > 0 && (
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="mb-2.5 flex items-center gap-1.5">
                    <Link2 className="h-3 w-3 text-muted-foreground/40" />
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Gaps</p>
                  </div>
                  <div className="space-y-1.5">
                    {selectedTrack.gaps.map((gap) => (
                      <p key={gap} className="rounded-md border border-border/50 bg-muted/10 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
                        {gap}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
