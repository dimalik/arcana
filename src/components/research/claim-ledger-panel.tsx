"use client";

import { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  FileText,
  FlaskConical,
  Loader2,
  Microscope,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { cn } from "@/lib/utils";

type ClaimStatus = "DRAFT" | "SUPPORTED" | "CONTESTED" | "REPRODUCED" | "RETRACTED";
type ClaimConfidence = "PRELIMINARY" | "MODERATE" | "STRONG";
type ClaimFilter = "ALL" | ClaimStatus;
type SignalTone = "neutral" | "info" | "success" | "warning" | "danger";

interface ClaimMemory {
  id: string;
  category: string;
  status: string;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
}

interface ClaimEvidence {
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

interface ClaimAssessment {
  id: string;
  actorRole: "reviewer" | "reproducer" | "user" | "system";
  verdict: Exclude<ClaimStatus, "DRAFT">;
  confidence: ClaimConfidence | null;
  notes: string | null;
  metadata: string | null;
  createdAt: string;
  task: { id: string; role: string; status: string } | null;
}

interface ClaimRecord {
  id: string;
  statement: string;
  summary: string | null;
  type: string;
  status: ClaimStatus;
  confidence: ClaimConfidence;
  createdBy: string;
  createdFrom: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  result: { id: string; scriptName: string; verdict: string | null; metrics: string | null } | null;
  hypothesis: { id: string; statement: string; status: string } | null;
  task: { id: string; role: string; status: string } | null;
  memories: ClaimMemory[];
  assessments: ClaimAssessment[];
  evidence: ClaimEvidence[];
}

interface ClaimCoordinatorQueueItem {
  stepId: string;
  coordinatorKey: string;
  type: "claim_needs_evidence" | "claim_review_required" | "claim_reproduction_required" | "claim_experiment_required" | "claim_memory_ready";
  status: "PROPOSED" | "APPROVED" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";
  title: string;
  description: string | null;
  claimId: string | null;
  claimStatement: string | null;
  claimStatus: ClaimStatus | null;
  claimConfidence: ClaimConfidence | null;
  experimentReason: string | null;
  taskRole: "reviewer" | "reproducer" | null;
  taskId: string | null;
  taskStatus: string | null;
  blocking: boolean;
  priority: number | null;
}

interface ClaimLedgerPanelProps {
  projectId: string;
  onRefresh?: () => void;
}

const FILTERS: ClaimFilter[] = ["ALL", "SUPPORTED", "REPRODUCED", "CONTESTED", "DRAFT", "RETRACTED"];
const PROMOTION_CATEGORIES = [
  "general",
  "code_pattern",
  "performance",
  "debugging",
  "dataset",
  "environment",
  "package",
] as const;

const STATUS_META: Record<ClaimStatus, { label: string; badge: string; dot: string; tone: string }> = {
  DRAFT: {
    label: "Draft",
    badge: "border-border bg-muted/60 text-muted-foreground",
    dot: "bg-muted-foreground/40",
    tone: "text-muted-foreground",
  },
  SUPPORTED: {
    label: "Supported",
    badge: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
    tone: "text-emerald-600 dark:text-emerald-300",
  },
  CONTESTED: {
    label: "Contested",
    badge: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
    tone: "text-amber-600 dark:text-amber-300",
  },
  REPRODUCED: {
    label: "Reproduced",
    badge: "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    dot: "bg-blue-500",
    tone: "text-blue-600 dark:text-blue-300",
  },
  RETRACTED: {
    label: "Retracted",
    badge: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
    dot: "bg-red-500",
    tone: "text-red-600 dark:text-red-300",
  },
};

const SIGNAL_META: Record<SignalTone, { pill: string; rail: string; text: string }> = {
  neutral: {
    pill: "border-border/60 bg-muted/40 text-muted-foreground",
    rail: "bg-border/70",
    text: "text-muted-foreground",
  },
  info: {
    pill: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    rail: "bg-sky-500/70",
    text: "text-sky-700 dark:text-sky-300",
  },
  success: {
    pill: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    rail: "bg-emerald-500/70",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  warning: {
    pill: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    rail: "bg-amber-500/70",
    text: "text-amber-700 dark:text-amber-300",
  },
  danger: {
    pill: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
    rail: "bg-red-500/70",
    text: "text-red-700 dark:text-red-300",
  },
};

/**
 * Restore newlines in markdown that was flattened to a single line.
 * Claims are often stored without newlines, which breaks block-level
 * markdown parsing (headings, lists, numbered items).
 */
function restoreMarkdownBlocks(text: string): string {
  return text
    // newline before headings (## , ### , etc.)
    .replace(/(?<!\n)(#{1,6}\s)/g, "\n\n$1")
    // newline before numbered list items (1. **Bold or 1. Capital)
    .replace(/(?<!\n)(\d+\.\s(?:\*\*|[A-Z]))/g, "\n\n$1")
    // newline before unordered list items: " - X" where X is a capital letter or **bold
    // (inline hyphens like "Style-SFT" have no space before the dash, so they won't match)
    .replace(/ (- (?:[A-Z*]))/g, "\n$1")
    // trim leading whitespace
    .replace(/^\n+/, "")
    .trim();
}

function formatWhen(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function truncate(text: string, max = 160) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function humanizeScriptName(scriptName: string) {
  const base = scriptName
    .replace(/^.*\//, "")
    .replace(/\.[^.]+$/, "")
    .replace(/^exp_?\d+_?/i, "")
    .replace(/^poc_?\d+_?/i, "")
    .replace(/[_-]+/g, " ")
    .trim();

  if (!base) return scriptName;
  return base
    .split(/\s+/)
    .map((token) => {
      if (/^ppl$/i.test(token)) return "PPL";
      if (/^dpo$/i.test(token)) return "DPO";
      if (/^grpo$/i.test(token)) return "GRPO";
      if (/^rl$/i.test(token)) return "RL";
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(" ");
}

function scrubMarkdown(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function claimHeadline(statement: string) {
  const cleaned = scrubMarkdown(statement);
  return cleaned.split("\n").map((line) => line.trim()).find(Boolean) || cleaned;
}

function isProvenanceEvidence(evidence: ClaimEvidence) {
  return evidence.kind === "remote_job";
}

function epistemicEvidence(claim: ClaimRecord) {
  return claim.evidence.filter((evidence) => !isProvenanceEvidence(evidence));
}

function provenanceEvidence(claim: ClaimRecord) {
  return claim.evidence.filter((evidence) => isProvenanceEvidence(evidence));
}

function claimSupportCount(claim: ClaimRecord) {
  return epistemicEvidence(claim).filter((evidence) => evidence.supports).length;
}

function claimRebuttalCount(claim: ClaimRecord) {
  return epistemicEvidence(claim).filter((evidence) => !evidence.supports).length;
}

function claimSummaryText(claim: ClaimRecord) {
  const summary = claim.summary ? scrubMarkdown(claim.summary) : "";
  if (summary) return summary;
  const cleaned = scrubMarkdown(claim.statement);
  const lines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return "";
  return lines.slice(1).join(" ");
}

function defaultPromotionCategory(claim: ClaimRecord | null) {
  if (!claim) return "general";
  if (claim.type === "risk") return "debugging";
  if (claim.type === "methodological") return "code_pattern";
  if (claim.type === "comparison") return "performance";
  return "general";
}

function evidenceLabel(evidence: ClaimEvidence) {
  if (evidence.paper) return evidence.paper.year ? `${evidence.paper.title} (${evidence.paper.year})` : evidence.paper.title;
  if (evidence.result) return `Experiment result: ${humanizeScriptName(evidence.result.scriptName)}`;
  if (evidence.hypothesis) return `Hypothesis: ${truncate(scrubMarkdown(evidence.hypothesis.statement), 90)}`;
  if (evidence.artifact) return `Artifact: ${evidence.artifact.filename}`;
  if (evidence.logEntry) return `Log entry: ${evidence.logEntry.type}`;
  if (evidence.task) return `${evidence.task.role} task`;
  if (evidence.remoteJob) return `Remote job: ${truncate(evidence.remoteJob.command, 90)}`;
  return evidence.kind.replace(/_/g, " ");
}

function kindIcon(kind: string): LucideIcon {
  switch (kind) {
    case "paper":
      return FileText;
    case "experiment_result":
      return FlaskConical;
    case "agent_task":
      return ShieldCheck;
    case "remote_job":
      return Microscope;
    case "log_entry":
      return AlertTriangle;
    default:
      return Sparkles;
  }
}

function statusCount(claims: ClaimRecord[], status: ClaimStatus) {
  return claims.filter((claim) => claim.status === status).length;
}

function claimHasReview(claim: ClaimRecord) {
  return claim.assessments.some((assessment) => assessment.actorRole === "reviewer" || assessment.actorRole === "reproducer");
}

function hasApprovedMemory(claim: ClaimRecord) {
  return claim.memories.some((memory) => memory.status === "APPROVED");
}

function hasCandidateMemory(claim: ClaimRecord) {
  return claim.memories.some((memory) => memory.status === "CANDIDATE");
}

function claimSignal(claim: ClaimRecord): {
  icon: LucideIcon;
  label: string;
  detail: string;
  tone: SignalTone;
} {
  const hasReview = claimHasReview(claim);

  if (claim.status === "RETRACTED") {
    return {
      icon: ShieldAlert,
      label: "Retired claim",
      detail: "Keep it for auditability, but do not let it steer the active plan.",
      tone: "danger",
    };
  }

  if (hasApprovedMemory(claim)) {
    return {
      icon: Brain,
      label: "Approved memory",
      detail: "This claim has already been promoted into durable process memory.",
      tone: "neutral",
    };
  }

  if (hasCandidateMemory(claim)) {
    return {
      icon: Brain,
      label: "Candidate memory",
      detail: "A claim-backed lesson exists, but it has not been approved as durable memory yet.",
      tone: "neutral",
    };
  }

  if (epistemicEvidence(claim).length === 0) {
    return {
      icon: FileText,
      label: "Needs evidence",
      detail: "Attach a run, paper, task, or log entry before treating this as durable output.",
      tone: "warning",
    };
  }

  if (claim.status === "DRAFT") {
    return {
      icon: AlertTriangle,
      label: "Needs verdict",
      detail: "Mark it supported, contested, or reproduced once the evidence is interpretable.",
      tone: "warning",
    };
  }

  if (claim.status === "CONTESTED") {
    return {
      icon: ShieldAlert,
      label: "Resolve objections",
      detail: "The ledger has explicit pushback on this claim and it should remain in dispute.",
      tone: "danger",
    };
  }

  if (claim.status === "SUPPORTED" && !hasReview) {
    return {
      icon: ShieldCheck,
      label: "Send to review",
      detail: "Evidence exists, but the claim still needs adversarial review or reproduction.",
      tone: "info",
    };
  }

  if (claim.status === "SUPPORTED") {
    return {
      icon: CheckCircle2,
      label: "Strong candidate",
      detail: "This finding is strong enough for reproduction or memory promotion.",
      tone: "success",
    };
  }

  return {
    icon: Microscope,
    label: "Ready for memory",
    detail: "This is the strongest state in the ledger and can be promoted when appropriate.",
    tone: "success",
  };
}

function queueItemMeta(item: ClaimCoordinatorQueueItem): {
  icon: LucideIcon;
  label: string;
  tone: SignalTone;
} {
  switch (item.type) {
    case "claim_needs_evidence":
      return { icon: FileText, label: "Needs evidence", tone: "warning" };
    case "claim_review_required":
      return { icon: ShieldCheck, label: "Needs review", tone: "info" };
    case "claim_reproduction_required":
      return { icon: Microscope, label: "Needs reproduction", tone: "info" };
    case "claim_experiment_required":
      return { icon: FlaskConical, label: "Needs experiment", tone: "warning" };
    case "claim_memory_ready":
      return { icon: Brain, label: "Ready for memory", tone: "success" };
    default:
      return { icon: Sparkles, label: "Queue item", tone: "neutral" };
  }
}

function assessmentTone(verdict: Exclude<ClaimStatus, "DRAFT">): SignalTone {
  if (verdict === "SUPPORTED") return "success";
  if (verdict === "REPRODUCED") return "info";
  if (verdict === "CONTESTED") return "warning";
  return "danger";
}

function assessmentLabel(assessment: ClaimAssessment) {
  if (assessment.actorRole === "reproducer") return "Reproducer";
  if (assessment.actorRole === "reviewer") return "Reviewer";
  if (assessment.actorRole === "system") return "System";
  return "User";
}

function memoryActionLabel(claim: ClaimRecord) {
  if (hasApprovedMemory(claim)) return "Refresh approved";
  if (claim.status === "REPRODUCED") return "Approve memory";
  if (hasCandidateMemory(claim)) return "Refresh candidate";
  return "Create candidate";
}

/* ── Component ─────────────────────────────────────────────────────── */

export function ClaimLedgerPanel({ projectId, onRefresh }: ClaimLedgerPanelProps) {
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [queue, setQueue] = useState<ClaimCoordinatorQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClaimFilter>("ALL");
  const [query, setQuery] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [promotionCategory, setPromotionCategory] = useState<string>("general");
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    let cancelled = false;

    async function loadClaims() {
      setLoading(true);
      try {
        const response = await fetch(`/api/research/${projectId}/claims`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to load claims");
        if (cancelled) return;
        startTransition(() => {
          setClaims(Array.isArray(data) ? data : Array.isArray(data.claims) ? data.claims : []);
          setQueue(Array.isArray(data?.queue) ? data.queue : []);
        });
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load claims";
          toast.error(message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadClaims();
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshNonce]);

  const filteredClaims = useMemo(() => {
    const loweredQuery = deferredQuery.trim().toLowerCase();
    return claims.filter((claim) => {
      if (filter !== "ALL" && claim.status !== filter) return false;
      if (!loweredQuery) return true;
      const haystack = [
        claim.statement,
        claim.summary || "",
        claim.type,
        claim.notes || "",
        claim.result?.scriptName || "",
        claim.hypothesis?.statement || "",
        ...claim.assessments.map((assessment) => `${assessment.actorRole} ${assessment.verdict} ${assessment.notes || ""}`),
        ...claim.evidence.map((evidence) => `${evidenceLabel(evidence)} ${evidence.rationale || ""} ${evidence.excerpt || ""}`),
      ].join(" ").toLowerCase();
      return haystack.includes(loweredQuery);
    });
  }, [claims, deferredQuery, filter]);

  useEffect(() => {
    if (claims.length === 0) {
      setSelectedClaimId(null);
    }
  }, [claims]);

  useEffect(() => {
    if (filteredClaims.length === 0) return;
    if (!selectedClaimId || !filteredClaims.some((claim) => claim.id === selectedClaimId)) {
      const queuedClaimId = queue
        .map((item) => item.claimId)
        .find((claimId): claimId is string => Boolean(claimId) && filteredClaims.some((claim) => claim.id === claimId));
      setSelectedClaimId(queuedClaimId || filteredClaims[0].id);
    }
  }, [filteredClaims, queue, selectedClaimId]);

  const selectedClaim = filteredClaims.find((claim) => claim.id === selectedClaimId)
    || claims.find((claim) => claim.id === selectedClaimId)
    || null;
  const selectedClaimEvidence = selectedClaim ? epistemicEvidence(selectedClaim) : [];
  const selectedClaimProvenance = selectedClaim ? provenanceEvidence(selectedClaim) : [];

  useEffect(() => {
    setPromotionCategory(defaultPromotionCategory(selectedClaim));
  }, [selectedClaim]);

  const counts = useMemo(() => ({
    supported: statusCount(claims, "SUPPORTED"),
    reproduced: statusCount(claims, "REPRODUCED"),
    contested: statusCount(claims, "CONTESTED"),
    blockingQueue: queue.filter((item) => item.blocking).length,
    attention: Math.max(
      queue.filter((item) => item.blocking).length,
      claims.filter((claim) => {
        const tone = claimSignal(claim).tone;
        return tone === "info" || tone === "warning" || tone === "danger";
      }).length,
    ),
  }), [claims, queue]);

  async function mutateClaim(
    claimId: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) {
    setPendingAction(claimId);
    try {
      const response = await fetch(`/api/research/${projectId}/claims`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: claimId, ...body }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Claim update failed");
      toast.success(successMessage);
      setRefreshNonce((value) => value + 1);
      onRefresh?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Claim update failed";
      toast.error(message);
    } finally {
      setPendingAction(null);
    }
  }

  const totalClaims = claims.length;
  const showQueue = totalClaims > 1;

  /* ── Render ────────────────────────────────────────────────────── */

  return (
    <div className="space-y-3">
      {/* ── Header ── */}
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Claims Ledger</h3>
          {totalClaims > 0 && (
            <span className="text-[11px] text-muted-foreground/50">{totalClaims} total</span>
          )}
        </div>
        {totalClaims === 0 ? (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground/60">
            Tracks what the project believes once results land.
          </p>
        ) : (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {counts.supported > 0 && (
              <span className={STATUS_META.SUPPORTED.tone}>{counts.supported} supported</span>
            )}
            {counts.reproduced > 0 && (
              <span className={STATUS_META.REPRODUCED.tone}>{counts.reproduced} reproduced</span>
            )}
            {counts.contested > 0 && (
              <span className={STATUS_META.CONTESTED.tone}>{counts.contested} contested</span>
            )}
            {counts.blockingQueue > 0 && (
              <span className="text-sky-700 dark:text-sky-300">{counts.blockingQueue} queued checks</span>
            )}
            {counts.attention > 0 && (
              <span className="text-amber-600 dark:text-amber-300">{counts.attention} need attention</span>
            )}
          </div>
        )}
      </div>

      {queue.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Coordinator Queue</p>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                Deterministic checks that block phase advancement until the strongest claims are evidenced, reviewed, or reproduced.
              </p>
            </div>
            <span className="shrink-0 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {queue.filter((item) => item.blocking).length} blocking
            </span>
          </div>

          <div className="mt-3 space-y-1.5">
            {queue.map((item) => {
              const meta = queueItemMeta(item);
              const Icon = meta.icon;
              const selected = item.claimId && item.claimId === selectedClaim?.id;
              return (
                <button
                  key={item.stepId}
                  onClick={() => item.claimId && setSelectedClaimId(item.claimId)}
                  className={cn(
                    "w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                    selected ? "border-foreground/20 bg-background" : "border-border/50 bg-background/60 hover:bg-background",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <div className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border", SIGNAL_META[meta.tone].pill)}>
                      <Icon className="h-3 w-3" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-medium leading-snug text-foreground">{item.title}</p>
                        <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/50">
                          {item.status.toLowerCase()}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
                        {item.claimStatement ? truncate(claimHeadline(item.claimStatement), 96) : item.description || meta.label}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/50">
                        <span>{meta.label}</span>
                        {item.taskRole && <span>{item.taskRole}</span>}
                        {item.taskStatus && <span>{item.taskStatus.toLowerCase()}</span>}
                        {item.claimStatus && <span>{item.claimStatus.toLowerCase()}</span>}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Search + filters ── */}
      {totalClaims > 1 && (
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/40" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search claims..."
              className="h-8 w-full rounded-md border border-border/60 bg-background pl-8 pr-3 text-xs outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-foreground/20"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((status) => {
              const label = status === "ALL" ? "All" : STATUS_META[status].label;
              const count = status === "ALL" ? totalClaims : statusCount(claims, status);
              if (status !== "ALL" && count === 0) return null;
              return (
                <button
                  key={status}
                  onClick={() => setFilter(status)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
                    filter === status
                      ? "bg-foreground text-background"
                      : "bg-muted/50 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                  <span className={cn(
                    "text-[10px]",
                    filter === status ? "text-background/60" : "text-muted-foreground/40",
                  )}>{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Loading / empty ── */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading claims...
        </div>
      ) : filteredClaims.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Sparkles className="h-4 w-4 text-muted-foreground/30" />
          <p className="text-sm font-medium text-foreground">
            {totalClaims === 0 ? "No claims yet" : "No claims match"}
          </p>
          <p className="max-w-xs text-[11px] leading-5 text-muted-foreground/60">
            {totalClaims === 0
              ? "Run an experiment or record a finding to get started."
              : "Try a broader search or switch filters."}
          </p>
        </div>
      ) : (
        <>
          {/* ── Claim queue ── */}
          {showQueue && (
            <div className="overflow-hidden rounded-lg border border-border/60">
              <div className="divide-y divide-border/30">
                {filteredClaims.map((claim) => {
                  const signal = claimSignal(claim);
                  const SignalIcon = signal.icon;
                  const selected = claim.id === selectedClaim?.id;
                  return (
                    <button
                      key={claim.id}
                      onClick={() => setSelectedClaimId(claim.id)}
                      className={cn(
                        "relative w-full px-3 py-2.5 text-left transition-colors",
                        selected ? "bg-muted/40" : "hover:bg-muted/20",
                      )}
                    >
                      {selected && (
                        <span className={cn("absolute inset-y-0 left-0 w-0.5", SIGNAL_META[signal.tone].rail)} />
                      )}
                      <div className="flex items-center gap-2">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_META[claim.status].dot)} />
                        <p className="min-w-0 flex-1 truncate text-sm font-medium leading-snug">
                          {truncate(claimHeadline(claim.statement), 80)}
                        </p>
                        <span className={cn(
                          "inline-flex shrink-0 items-center gap-1 text-[10px]",
                          SIGNAL_META[signal.tone].text,
                        )}>
                          <SignalIcon className="h-2.5 w-2.5" />
                          {signal.label}
                        </span>
                      </div>
                      <div className="mt-1 flex gap-2.5 pl-3.5 text-[10px] text-muted-foreground/50">
                        <span>{STATUS_META[claim.status].label}</span>
                        <span>{claimSupportCount(claim)} support · {claimRebuttalCount(claim)} rebuttal</span>
                        <span>{claim.confidence.toLowerCase()}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Selected claim detail ── */}
          {selectedClaim && (() => {
            const signal = claimSignal(selectedClaim);
            const SignalIcon = signal.icon;

            return (
              <div className="space-y-3">
                {/* Header + signal + stats */}
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="flex flex-wrap gap-1.5">
                    <span className={cn(
                      "rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                      STATUS_META[selectedClaim.status].badge,
                    )}>
                      {STATUS_META[selectedClaim.status].label}
                    </span>
                    <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {selectedClaim.confidence.toLowerCase()}
                    </span>
                    <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {selectedClaim.type.replace(/_/g, " ")}
                    </span>
                    {hasApprovedMemory(selectedClaim) && (
                      <span className="rounded-md border border-slate-500/25 bg-slate-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 dark:text-slate-300">
                        approved memory
                      </span>
                    )}
                    {!hasApprovedMemory(selectedClaim) && hasCandidateMemory(selectedClaim) && (
                      <span className="rounded-md border border-slate-500/25 bg-slate-500/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 dark:text-slate-300">
                        candidate memory
                      </span>
                    )}
                  </div>

                  <div className="mt-2.5 prose prose-sm prose-neutral dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_p]:text-sm [&_p]:leading-relaxed [&_p]:my-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_li]:text-sm [&_code]:text-xs [&_pre]:text-xs [&_pre]:my-2 [&_strong]:text-foreground">
                    <MarkdownRenderer content={restoreMarkdownBlocks(selectedClaim.statement)} />
                  </div>
                  {selectedClaim.summary && (
                    <div className="mt-2 prose prose-sm prose-neutral dark:prose-invert max-w-none text-muted-foreground [&>*:first-child]:mt-0 [&_p]:text-[13px] [&_p]:leading-relaxed [&_p]:my-1 [&_li]:text-[13px]">
                      <MarkdownRenderer content={restoreMarkdownBlocks(selectedClaim.summary)} />
                    </div>
                  )}

                  {/* Signal callout */}
                  <div className="mt-3 flex items-start gap-2 rounded-md border border-border/40 bg-muted/15 px-2.5 py-2">
                    <SignalIcon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", SIGNAL_META[signal.tone].text)} />
                    <div className="min-w-0">
                      <p className={cn("text-xs font-medium", SIGNAL_META[signal.tone].text)}>{signal.label}</p>
                      <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{signal.detail}</p>
                    </div>
                  </div>

                  {/* Compact stats row */}
                  <div className="mt-3 flex gap-4 text-[11px]">
                    <div>
                      <span className="text-muted-foreground/50">Support </span>
                      <span className={cn(
                        "font-medium",
                        claimSupportCount(selectedClaim) > 0 ? "text-emerald-600 dark:text-emerald-300" : "text-foreground",
                      )}>{claimSupportCount(selectedClaim)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground/50">Rebuttal </span>
                      <span className={cn(
                        "font-medium",
                        claimRebuttalCount(selectedClaim) > 0 ? "text-amber-600 dark:text-amber-300" : "text-foreground",
                      )}>{claimRebuttalCount(selectedClaim)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground/50">Evidence </span>
                      <span className="font-medium text-foreground">{selectedClaim.evidence.length}</span>
                    </div>
                    <span className="ml-auto text-muted-foreground/40">{formatWhen(selectedClaim.updatedAt)}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="rounded-lg border border-border/60 p-3">
                  <p className="mb-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Decide</p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => mutateClaim(selectedClaim.id, { status: "SUPPORTED", createdBy: "user" }, "Claim marked supported.")}
                      disabled={pendingAction === selectedClaim.id}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-2 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-300"
                    >
                      {pendingAction === selectedClaim.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <CheckCircle2 className="h-3 w-3" />}
                      Support
                    </button>
                    <button
                      onClick={() => mutateClaim(selectedClaim.id, { status: "CONTESTED", createdBy: "user" }, "Claim marked contested.")}
                      disabled={pendingAction === selectedClaim.id}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-2 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-300"
                    >
                      {pendingAction === selectedClaim.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <ShieldAlert className="h-3 w-3" />}
                      Contest
                    </button>
                    <button
                      onClick={() => mutateClaim(selectedClaim.id, { status: "REPRODUCED", createdBy: "user" }, "Claim marked reproduced.")}
                      disabled={pendingAction === selectedClaim.id}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-blue-500/25 bg-blue-500/10 px-2 py-2 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/20 disabled:opacity-50 dark:text-blue-300"
                    >
                      {pendingAction === selectedClaim.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Microscope className="h-3 w-3" />}
                      Reproduced
                    </button>
                  </div>

                  {/* Promote to memory */}
                  <div className="mt-2.5 flex items-center gap-2">
                    <select
                      value={promotionCategory}
                      onChange={(event) => setPromotionCategory(event.target.value)}
                      className="h-8 flex-1 rounded-md border border-border/60 bg-background px-2 text-xs outline-none transition-colors focus:border-foreground/20"
                    >
                      {PROMOTION_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {category.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => mutateClaim(
                        selectedClaim.id,
                        { action: "promote", category: promotionCategory },
                        selectedClaim.status === "REPRODUCED"
                          ? "Memory approved."
                          : hasCandidateMemory(selectedClaim)
                            ? "Candidate memory refreshed."
                            : "Candidate memory created.",
                      )}
                      disabled={pendingAction === selectedClaim.id || selectedClaim.status === "DRAFT"}
                      className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pendingAction === selectedClaim.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Brain className="h-3 w-3" />}
                      {memoryActionLabel(selectedClaim)}
                    </button>
                  </div>
                  {selectedClaim.status === "DRAFT" && (
                    <p className="mt-1.5 text-[10px] text-muted-foreground/50">
                      Draft claims must be supported or reproduced before promotion.
                    </p>
                  )}
                  {selectedClaim.status !== "DRAFT" && selectedClaim.status !== "REPRODUCED" && (
                    <p className="mt-1.5 text-[10px] text-muted-foreground/50">
                      Supported claims create candidate memory first. Approving durable memory is an explicit action.
                    </p>
                  )}
                </div>

                {/* Assessment history */}
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="mb-2.5 flex items-center justify-between">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Assessments</p>
                    <span className="text-[10px] text-muted-foreground/40">
                      {selectedClaim.assessments.length} row{selectedClaim.assessments.length === 1 ? "" : "s"}
                    </span>
                  </div>

                  {selectedClaim.assessments.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border/50 px-3 py-4 text-center text-xs text-muted-foreground/50">
                      No structured assessments yet.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {selectedClaim.assessments.map((assessment) => {
                        const tone = assessmentTone(assessment.verdict);
                        return (
                          <div
                            key={assessment.id}
                            className="relative overflow-hidden rounded-md border border-border/50 bg-muted/5 p-3"
                          >
                            <span className={cn("absolute inset-y-0 left-0 w-0.5", SIGNAL_META[tone].rail)} />
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className={cn(
                                    "rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                                    SIGNAL_META[tone].pill,
                                  )}>
                                    {assessmentLabel(assessment)}
                                  </span>
                                  <span className={cn(
                                    "rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                                    STATUS_META[assessment.verdict].badge,
                                  )}>
                                    {STATUS_META[assessment.verdict].label}
                                  </span>
                                  {assessment.confidence && (
                                    <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                      {assessment.confidence.toLowerCase()}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1 text-[10px] text-muted-foreground/50">
                                  {formatWhen(assessment.createdAt)}
                                  {assessment.task ? ` · ${assessment.task.role} task ${assessment.task.status.toLowerCase()}` : ""}
                                </p>
                                {assessment.notes && (
                                  <div className="mt-2 prose prose-sm prose-neutral dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:my-1 [&_li]:text-xs">
                                    <MarkdownRenderer content={restoreMarkdownBlocks(assessment.notes)} />
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Evidence */}
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="mb-2.5 flex items-center justify-between">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Evidence</p>
                    <span className="text-[10px] text-muted-foreground/40">
                      {selectedClaimEvidence.length} row{selectedClaimEvidence.length === 1 ? "" : "s"}
                    </span>
                  </div>

                  {selectedClaimEvidence.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border/50 px-3 py-4 text-center text-xs text-muted-foreground/50">
                      No evidence attached yet.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {selectedClaimEvidence.map((evidence) => {
                        const Icon = kindIcon(evidence.kind);
                        return (
                          <div
                            key={evidence.id}
                            className="relative overflow-hidden rounded-md border border-border/50 bg-muted/5 p-3"
                          >
                            <span className={cn(
                              "absolute inset-y-0 left-0 w-0.5",
                              evidence.supports ? "bg-emerald-500/60" : "bg-amber-500/60",
                            )} />
                            <div className="flex items-start gap-2.5">
                              <div className={cn(
                                "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
                                evidence.supports
                                  ? "border-emerald-500/20 bg-emerald-500/10"
                                  : "border-amber-500/20 bg-amber-500/10",
                              )}>
                                <Icon className={cn(
                                  "h-3 w-3",
                                  evidence.supports ? "text-emerald-600 dark:text-emerald-300" : "text-amber-600 dark:text-amber-300",
                                )} />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start justify-between gap-2">
                                  <p className="text-xs font-medium leading-snug text-foreground">
                                    {evidenceLabel(evidence)}
                                  </p>
                                  <span className={cn(
                                    "shrink-0 text-[9px] font-medium uppercase tracking-wide",
                                    evidence.supports
                                      ? "text-emerald-600 dark:text-emerald-300"
                                      : "text-amber-600 dark:text-amber-300",
                                  )}>
                                    {evidence.supports ? "supports" : "rebuts"}
                                  </span>
                                </div>
                                <p className="mt-0.5 text-[10px] text-muted-foreground/50">
                                  {evidence.kind.replace(/_/g, " ")} · {evidence.strength.toLowerCase()} · {formatWhen(evidence.createdAt)}
                                </p>

                                {evidence.rationale && (
                                  <div className="mt-2 prose prose-sm prose-neutral dark:prose-invert max-w-none text-foreground/80 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:my-1 [&_li]:text-xs [&_li]:my-0 [&_ul]:my-1 [&_ol]:my-1 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_strong]:text-foreground">
                                    <MarkdownRenderer content={restoreMarkdownBlocks(evidence.rationale)} />
                                  </div>
                                )}

                                {evidence.excerpt && (
                                  <div className="mt-2 rounded-md border border-border/40 bg-background px-2.5 py-2 prose prose-sm prose-neutral dark:prose-invert max-w-none text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:my-1 [&_li]:text-xs [&_li]:my-0 [&_strong]:text-foreground/70">
                                    <MarkdownRenderer content={restoreMarkdownBlocks(evidence.excerpt)} />
                                  </div>
                                )}

                                {evidence.locator && (
                                  <p className="mt-1.5 text-[10px] text-muted-foreground/50">
                                    Locator: {evidence.locator}
                                  </p>
                                )}

                                {evidence.artifact?.keyTakeaway && (
                                  <p className="mt-1 text-[10px] text-muted-foreground/50">
                                    Takeaway: {evidence.artifact.keyTakeaway}
                                  </p>
                                )}

                                {evidence.logEntry && (
                                  <p className="mt-1 text-[10px] leading-5 text-muted-foreground/50">
                                    {truncate(evidence.logEntry.content, 180)}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {selectedClaimProvenance.length > 0 && (
                  <div className="rounded-lg border border-border/60 p-3">
                    <div className="mb-2.5 flex items-center justify-between">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Provenance</p>
                      <span className="text-[10px] text-muted-foreground/40">
                        {selectedClaimProvenance.length} row{selectedClaimProvenance.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {selectedClaimProvenance.map((evidence) => {
                        const Icon = kindIcon(evidence.kind);
                        return (
                          <div
                            key={evidence.id}
                            className="relative overflow-hidden rounded-md border border-border/50 bg-muted/5 p-3"
                          >
                            <span className="absolute inset-y-0 left-0 w-0.5 bg-border/70" />
                            <div className="flex items-start gap-2.5">
                              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40">
                                <Icon className="h-3 w-3 text-muted-foreground" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start justify-between gap-2">
                                  <p className="text-xs font-medium leading-snug text-foreground">
                                    {evidenceLabel(evidence)}
                                  </p>
                                  <span className="shrink-0 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60">
                                    provenance
                                  </span>
                                </div>
                                <p className="mt-0.5 text-[10px] text-muted-foreground/50">
                                  {evidence.kind.replace(/_/g, " ")} · {formatWhen(evidence.createdAt)}
                                </p>
                                {evidence.rationale && (
                                  <div className="mt-2 prose prose-sm prose-neutral dark:prose-invert max-w-none text-foreground/80 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:my-1">
                                    <MarkdownRenderer content={restoreMarkdownBlocks(evidence.rationale)} />
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Context */}
                <div className="rounded-lg border border-border/60 p-3">
                  <p className="mb-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Context</p>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="shrink-0 text-muted-foreground/50">Result</span>
                      <span className="truncate text-right text-foreground">
                        {selectedClaim.result
                          ? humanizeScriptName(selectedClaim.result.scriptName)
                          : <span className="text-muted-foreground/25">&mdash;</span>}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="shrink-0 text-muted-foreground/50">Hypothesis</span>
                      <span className="truncate text-right text-foreground">
                        {selectedClaim.hypothesis
                          ? truncate(scrubMarkdown(selectedClaim.hypothesis.statement), 80)
                          : <span className="text-muted-foreground/25">&mdash;</span>}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="shrink-0 text-muted-foreground/50">Task</span>
                      <span className="text-right text-foreground">
                        {selectedClaim.task
                          ? `${selectedClaim.task.role} · ${selectedClaim.task.status.toLowerCase()}`
                          : <span className="text-muted-foreground/25">&mdash;</span>}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="shrink-0 text-muted-foreground/50">Created</span>
                      <span className="text-right text-muted-foreground">
                        {formatWhen(selectedClaim.createdAt)} by {selectedClaim.createdBy}
                      </span>
                    </div>
                    {selectedClaim.createdFrom && (
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="shrink-0 text-muted-foreground/50">Source</span>
                        <span className="text-right text-muted-foreground">{selectedClaim.createdFrom}</span>
                      </div>
                    )}
                  </div>

                  {selectedClaim.notes && (
                    <div className="mt-3 rounded-md border border-border/40 bg-muted/10 p-2.5">
                      <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/50">Notes</p>
                      <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:my-1 [&_li]:text-xs [&_strong]:text-foreground">
                        <MarkdownRenderer content={restoreMarkdownBlocks(selectedClaim.notes)} />
                      </div>
                    </div>
                  )}

                  {selectedClaim.memories.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      {selectedClaim.memories.map((memory) => (
                        <div key={memory.id} className="flex items-center gap-2 text-[11px]">
                          <Brain className="h-3 w-3 text-muted-foreground/30" />
                          <span className="text-muted-foreground">{memory.category.replace(/_/g, " ")}</span>
                          <span className="text-muted-foreground/40">{memory.status.toLowerCase()}</span>
                          {typeof memory.confidence === "number" && (
                            <span className="text-muted-foreground/40">· {memory.confidence.toFixed(2)}</span>
                          )}
                          <div className="ml-auto flex items-center gap-1">
                            {memory.status !== "APPROVED" && (
                              <button
                                onClick={() => mutateClaim(
                                  selectedClaim.id,
                                  { action: "memory_status", memoryId: memory.id, memoryStatus: "APPROVED" },
                                  "Memory approved.",
                                )}
                                disabled={pendingAction === selectedClaim.id}
                                className="rounded-md border border-border/60 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                              >
                                Approve
                              </button>
                            )}
                            {memory.status !== "STALE" && (
                              <button
                                onClick={() => mutateClaim(
                                  selectedClaim.id,
                                  { action: "memory_status", memoryId: memory.id, memoryStatus: "STALE" },
                                  "Memory marked stale.",
                                )}
                                disabled={pendingAction === selectedClaim.id}
                                className="rounded-md border border-border/60 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                              >
                                Mark stale
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
