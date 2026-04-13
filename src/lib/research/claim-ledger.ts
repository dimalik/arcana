import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const CLAIM_STATUSES = ["DRAFT", "SUPPORTED", "CONTESTED", "REPRODUCED", "RETRACTED"] as const;
export const CLAIM_CONFIDENCE = ["PRELIMINARY", "MODERATE", "STRONG"] as const;
export const CLAIM_FINDING_TYPES = ["finding", "comparison", "hypothesis_assessment", "methodological", "reproduction"] as const;
export const CLAIM_ASSESSMENT_ROLES = ["reviewer", "reproducer", "user", "system"] as const;
export const MEMORY_STATUSES = ["CANDIDATE", "APPROVED", "STALE", "REJECTED"] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type ClaimConfidence = (typeof CLAIM_CONFIDENCE)[number];
export type FindingClaimType = (typeof CLAIM_FINDING_TYPES)[number];
export type ClaimAssessmentRole = (typeof CLAIM_ASSESSMENT_ROLES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
type ClaimAssessmentVerdict = Exclude<ClaimStatus, "DRAFT">;
type ClaimLedgerTx = Prisma.TransactionClient;
type ClaimLedgerDb = ClaimLedgerTx | typeof prisma;

export function isProvenanceOnlyClaimEvidenceKind(kind: string) {
  return kind === "remote_job";
}

export function isEpistemicClaimEvidenceKind(kind: string) {
  return !isProvenanceOnlyClaimEvidenceKind(kind);
}

export interface ClaimEvidenceInput {
  kind: "experiment_result" | "artifact" | "paper" | "hypothesis" | "log_entry" | "agent_task" | "remote_job";
  supports?: boolean;
  strength?: "DIRECT" | "INDIRECT" | "CONTEXT" | "REBUTTAL";
  rationale?: string;
  excerpt?: string;
  locator?: string;
  paperId?: string;
  hypothesisId?: string;
  resultId?: string;
  artifactId?: string;
  logEntryId?: string;
  taskId?: string;
  remoteJobId?: string;
}

export interface CreateClaimInput {
  projectId: string;
  statement: string;
  summary?: string | null;
  type: "finding" | "comparison" | "hypothesis_assessment" | "methodological" | "risk" | "reproduction";
  status?: ClaimStatus;
  confidence?: ClaimConfidence;
  createdBy?: "agent" | "reviewer" | "reproducer" | "user" | "system";
  createdFrom?: string | null;
  notes?: string | null;
  hypothesisId?: string | null;
  resultId?: string | null;
  taskId?: string | null;
  evidence?: ClaimEvidenceInput[];
}

export interface ReviewClaimInput {
  claimId: string;
  status: ClaimAssessmentVerdict;
  confidence?: ClaimConfidence;
  notes?: string | null;
  createdBy?: ClaimAssessmentRole;
  taskId?: string | null;
  metadata?: string | null;
  evidence?: ClaimEvidenceInput[];
}

const MAX_CLAIM_STATEMENT_LENGTH = 320;
const CLAIM_STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "because", "been", "but", "by", "can", "comparable",
  "cost", "did", "do", "does", "establishing", "establishes", "for", "from", "genuine", "has", "have",
  "if", "in", "into", "is", "it", "its", "just", "maintaining", "meaning", "means", "model", "must",
  "no", "not", "of", "on", "only", "or", "our", "over", "per", "primarily", "produce", "produced",
  "produces", "proof", "proving", "results", "same", "semantic", "set", "sets", "show", "shows", "so",
  "strong", "than", "that", "the", "their", "there", "these", "this", "to", "using", "via", "was", "we",
  "what", "while", "with",
]);
const CLAIM_TOKEN_SYNONYMS: Record<string, string> = {
  ppl: "perplexity",
  ppl40: "threshold40",
  ppl60: "threshold60",
  asr40: "threshold40",
  asr60: "threshold60",
  misclassify: "falsepositive",
  misclassifies: "falsepositive",
  misclassified: "falsepositive",
  falsepositive: "falsepositive",
  falsepositives: "falsepositive",
  detector: "detection",
  detect: "detection",
  detectable: "detection",
  baseline: "baseline",
  baselines: "baseline",
  zeroshot: "zero_shot",
  zero: "zero",
  shot: "shot",
  qwen25: "qwen",
  qwen25b: "qwen",
  qwen25b0: "qwen",
  paraphrase: "paraphrase",
  paraphrases: "paraphrase",
  hallucinations: "hallucination",
  random: "randomness",
  randomly: "randomness",
  longer: "length",
  shorter: "length",
  wordcount: "length",
  words: "length",
  dominated: "dominate",
  dominates: "dominate",
  easier: "easydetect",
  easy: "easydetect",
  detectability: "easydetect",
};
const CLAIM_TYPE_PRIORITY: Record<CreateClaimInput["type"], number> = {
  reproduction: 6,
  comparison: 5,
  hypothesis_assessment: 4,
  methodological: 3,
  finding: 2,
  risk: 1,
};
const CLAIM_STATUS_PRIORITY: Record<ClaimStatus, number> = {
  RETRACTED: 0,
  DRAFT: 1,
  SUPPORTED: 2,
  CONTESTED: 3,
  REPRODUCED: 4,
};
const CLAIM_CONFIDENCE_PRIORITY: Record<ClaimConfidence, number> = {
  PRELIMINARY: 1,
  MODERATE: 2,
  STRONG: 3,
};

function memoryConfidenceForClaim(confidence: ClaimConfidence) {
  if (confidence === "STRONG") return 0.9;
  if (confidence === "MODERATE") return 0.7;
  return 0.5;
}

function targetMemoryStatusForClaimStatus(status: ClaimStatus): MemoryStatus {
  return status === "REPRODUCED" ? "APPROVED" : "CANDIDATE";
}

function refreshedMemoryStatus(current: string, target: MemoryStatus): MemoryStatus {
  if (target === "APPROVED") return "APPROVED";
  if (current === "APPROVED") return "APPROVED";
  return "CANDIDATE";
}

function assessmentMetadataString(input: string | null | undefined, fallback: Record<string, unknown>) {
  if (input && input.trim()) return input;
  return JSON.stringify(fallback);
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1");
}

function normalizeNarrative(text: string): string {
  return stripInlineMarkdown(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeStatement(statement: string): string {
  return normalizeNarrative(statement).replace(/\s+/g, " ").trim();
}

function normalizeClaimSemanticText(text: string): string {
  return normalizeStatement(text)
    .toLowerCase()
    .replace(/cnn\s*\/\s*dailymail/g, "cnn_dailymail")
    .replace(/zero[\s-]*shot/g, "zero_shot")
    .replace(/t\s*=\s*([0-9.]+)/g, "temperature_$1")
    .replace(/asr\s*@\s*ppl\s*40/g, "threshold40")
    .replace(/asr\s*@\s*40/g, "threshold40")
    .replace(/asr\s*@\s*ppl\s*60/g, "threshold60")
    .replace(/asr\s*@\s*60/g, "threshold60")
    .replace(/false positive rate/g, "falsepositive")
    .replace(/false positive/g, "falsepositive")
    .replace(/qwen2\.?5(?:-[0-9.]+b)?/g, "qwen")
    .replace(/gpt-?2/g, "gpt2");
}

function normalizeClaimToken(token: string): string {
  let normalized = token.toLowerCase().replace(/^[^a-z0-9_.]+|[^a-z0-9_.]+$/g, "");
  if (!normalized) return "";
  normalized = CLAIM_TOKEN_SYNONYMS[normalized] || normalized;
  if (normalized.endsWith("ies") && normalized.length > 5) {
    normalized = `${normalized.slice(0, -3)}y`;
  } else if (normalized.endsWith("ing") && normalized.length > 6) {
    normalized = normalized.slice(0, -3);
  } else if (normalized.endsWith("ed") && normalized.length > 5) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith("s") && normalized.length > 4 && !normalized.endsWith("ss")) {
    normalized = normalized.slice(0, -1);
  }
  return CLAIM_TOKEN_SYNONYMS[normalized] || normalized;
}

function claimSemanticTokens(text: string) {
  const normalized = normalizeClaimSemanticText(text);
  return normalized
    .split(/[^a-z0-9_.]+/)
    .map(normalizeClaimToken)
    .filter((token) =>
      token
      && !CLAIM_STOPWORDS.has(token)
      && !/^v?\d+(?:\.\d+)?$/.test(token)
      && token.length >= 3
    );
}

function claimNumericTokens(text: string) {
  return Array.from(new Set(
    normalizeClaimSemanticText(text)
      .match(/\b\d+(?:\.\d+)?\b/g) || [],
  ));
}

function uniqueClaimTokens(text: string) {
  return Array.from(new Set(claimSemanticTokens(text)));
}

function tokenOverlapRatio(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const shared = left.filter((token) => rightSet.has(token));
  return shared.length / Math.min(left.length, right.length);
}

function tokenJaccard(left: string[], right: string[]) {
  if (left.length === 0 && right.length === 0) return 1;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of Array.from(leftSet)) {
    if (rightSet.has(token)) shared += 1;
  }
  const union = new Set([...Array.from(leftSet), ...Array.from(rightSet)]).size;
  return union === 0 ? 0 : shared / union;
}

function claimsAreNearDuplicates(params: {
  left: { statement: string; resultId?: string | null; hypothesisId?: string | null; createdFrom?: string | null };
  right: { statement: string; resultId?: string | null; hypothesisId?: string | null; createdFrom?: string | null };
}) {
  const leftExact = dedupeKey(params.left.statement);
  const rightExact = dedupeKey(params.right.statement);
  if (leftExact && leftExact === rightExact) return true;

  const leftTokens = uniqueClaimTokens(params.left.statement);
  const rightTokens = uniqueClaimTokens(params.right.statement);
  const overlap = tokenOverlapRatio(leftTokens, rightTokens);
  const jaccard = tokenJaccard(leftTokens, rightTokens);
  const numberOverlap = tokenOverlapRatio(claimNumericTokens(params.left.statement), claimNumericTokens(params.right.statement));
  const sameAnchor = Boolean(
    (params.left.resultId && params.left.resultId === params.right.resultId)
    || (params.left.hypothesisId && params.left.hypothesisId === params.right.hypothesisId),
  );
  const resultDerivedPair = sameAnchor
    && (params.left.createdFrom === "record_result" || params.right.createdFrom === "record_result");

  if (resultDerivedPair) return true;
  if (sameAnchor && overlap >= 0.45) return true;
  if (overlap >= 0.74) return true;
  if (overlap >= 0.58 && jaccard >= 0.4) return true;
  if (overlap >= 0.5 && numberOverlap >= 0.5 && jaccard >= 0.34) return true;
  return false;
}

function sentenceCount(text: string): number {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .length;
}

function claimStatementIssue(statement: string): string | null {
  const raw = statement.trim();
  if (!raw) return "Claim statement is required.";
  if (/```/.test(raw)) return "Claims must be plain text, not code blocks.";
  if (/^\s*#{1,6}\s+/m.test(raw)) return "Claims must be atomic plain text, not markdown headings.";
  if (/^\s*(?:[-*+•]|\d+\.)\s+/m.test(raw)) return "Claims must be atomic plain text, not bullet lists.";

  const normalized = normalizeStatement(raw);
  if (!normalized) return "Claim statement is required.";
  if (normalized.length > MAX_CLAIM_STATEMENT_LENGTH) {
    return `Claims must stay concise and atomic. Move extra detail into summary or notes (max ${MAX_CLAIM_STATEMENT_LENGTH} characters).`;
  }
  if (normalized.includes("\n")) {
    return "Claims must be a single atomic statement, not multiple paragraphs.";
  }
  if (sentenceCount(normalized) > 2) {
    return "Claims must be atomic. Split multi-part summaries into separate claims.";
  }
  return null;
}

function formatMetricValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 100) return value.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1) return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return value.toPrecision(2);
}

function summarizeMetricMap(
  values: Record<string, number> | null | undefined,
  { signed = false, limit = 2 }: { signed?: boolean; limit?: number } = {},
): string {
  if (!values) return "";
  const entries = Object.entries(values)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  if (entries.length === 0) return "";

  const visible = entries.slice(0, limit).map(([key, value]) => `${key} ${signed && value > 0 ? "+" : ""}${formatMetricValue(value)}`);
  if (entries.length > limit) visible.push(`+${entries.length - limit} more`);
  return visible.join(", ");
}

export function humanizeExperimentLabel(scriptName: string) {
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

export function buildImportedResultAssertion(params: {
  scriptName: string;
  condition?: string | null;
  metrics: Record<string, number>;
}) {
  const metricSummary = summarizeMetricMap(params.metrics, { limit: 3 });
  const label = humanizeExperimentLabel(params.scriptName);
  if (params.condition && metricSummary) {
    return normalizeStatement(`Condition "${params.condition}" reached ${metricSummary} in ${label}.`);
  }
  if (metricSummary) {
    return normalizeStatement(`${label} recorded ${metricSummary}.`);
  }
  if (params.condition) {
    return normalizeStatement(`${label} completed condition "${params.condition}".`);
  }
  return normalizeStatement(`${label} produced a structured result.`);
}

export function buildExperimentClaimStatement(params: {
  scriptName: string;
  verdict: "better" | "worse" | "inconclusive" | "error";
  metrics: Record<string, number>;
  comparison?: Record<string, number> | null;
  condition?: string | null;
}) {
  const metricSummary = summarizeMetricMap(params.metrics);
  const deltaSummary = summarizeMetricMap(params.comparison || null, { signed: true });
  const label = humanizeExperimentLabel(params.scriptName);

  if (params.verdict === "error") {
    return normalizeStatement(`${label} failed before producing a valid result.`);
  }
  if (params.verdict === "better") {
    if (params.condition && metricSummary) return normalizeStatement(`Condition "${params.condition}" in ${label} improved over the baseline (${metricSummary}${deltaSummary ? `; ${deltaSummary}` : ""}).`);
    if (deltaSummary) return normalizeStatement(`${label} improved over the baseline (${deltaSummary}).`);
    if (metricSummary) return normalizeStatement(`${label} produced a positive result (${metricSummary}).`);
    return normalizeStatement(`${label} produced a positive result.`);
  }
  if (params.verdict === "worse") {
    if (params.condition && metricSummary) return normalizeStatement(`Condition "${params.condition}" in ${label} underperformed (${metricSummary}${deltaSummary ? `; ${deltaSummary}` : ""}).`);
    if (deltaSummary) return normalizeStatement(`${label} underperformed the baseline (${deltaSummary}).`);
    if (metricSummary) return normalizeStatement(`${label} produced a weaker result (${metricSummary}).`);
    return normalizeStatement(`${label} produced a weaker result than expected.`);
  }
  if (params.condition && metricSummary) return normalizeStatement(`Condition "${params.condition}" in ${label} produced ${metricSummary}.`);
  if (metricSummary) return normalizeStatement(`${label} produced inconclusive evidence (${metricSummary}).`);
  return normalizeStatement(`${label} produced inconclusive evidence.`);
}

export function isMalformedNotebookClaimStatement(statement: string): boolean {
  return claimStatementIssue(statement) !== null;
}

export async function repairMalformedNotebookClaims(projectId: string) {
  const malformedClaims = await prisma.researchClaim.findMany({
    where: {
      projectId,
      createdFrom: "log_finding",
    },
    include: {
      evidence: { select: { kind: true } },
      _count: { select: { memories: true, insights: true } },
    },
  });

  let repaired = 0;
  let skipped = 0;

  for (const claim of malformedClaims) {
    if (!isMalformedNotebookClaimStatement(claim.statement)) continue;

    const safeToDelete = claim.status === "DRAFT"
      && claim._count.memories === 0
      && claim._count.insights === 0
      && claim.evidence.every((evidence) => evidence.kind === "log_entry" || evidence.kind === "paper");

    if (!safeToDelete) {
      skipped += 1;
      continue;
    }

    await prisma.researchClaim.delete({ where: { id: claim.id } });
    repaired += 1;
  }

  return { repaired, skipped };
}

export async function repairFailureReflectionClaims(projectId: string) {
  const legacyClaims = await prisma.researchClaim.findMany({
    where: {
      projectId,
      createdFrom: "reflect_on_failure",
    },
    include: {
      evidence: { select: { kind: true } },
      _count: { select: { memories: true, insights: true } },
    },
  });

  let repaired = 0;
  let retracted = 0;
  let skipped = 0;

  for (const claim of legacyClaims) {
    const operationalFailureClaim = claim.type === "risk"
      && claim.evidence.length > 0
      && claim.evidence.every((evidence) => evidence.kind === "log_entry" || evidence.kind === "remote_job");

    if (!operationalFailureClaim) {
      skipped += 1;
      continue;
    }

    const safeToDelete = claim._count.memories === 0 && claim._count.insights === 0;
    if (safeToDelete) {
      await prisma.researchClaim.delete({ where: { id: claim.id } });
      repaired += 1;
      continue;
    }

    await prisma.researchClaim.update({
      where: { id: claim.id },
      data: {
        status: "RETRACTED",
        notes: claim.notes
          ? `${claim.notes}\n\nRetracted automatically: operational failure reflections are not valid ledger claims.`
          : "Retracted automatically: operational failure reflections are not valid ledger claims.",
      },
    });
    await syncClaimMemoryLifecycle(claim.id, "RETRACTED");
    retracted += 1;
  }

  return { repaired, retracted, skipped };
}

function normalizeAssessmentActorRole(role: string | null | undefined, createdFrom?: string | null): ClaimAssessmentRole | null {
  if (role === "reviewer" || role === "reproducer" || role === "user" || role === "system") return role;
  if (createdFrom === "reproduce_claim") return "reproducer";
  if (createdFrom === "review_claim") return "user";
  return null;
}

export async function repairLegacyClaimAssessments(projectId: string) {
  const claims = await prisma.researchClaim.findMany({
    where: {
      projectId,
      status: { in: ["SUPPORTED", "CONTESTED", "REPRODUCED", "RETRACTED"] },
      assessments: { none: {} },
    },
    include: {
      task: { select: { id: true, role: true, status: true } },
      evidence: {
        select: {
          kind: true,
          taskId: true,
          task: { select: { id: true, role: true, status: true } },
        },
      },
    },
  });

  let repairedClaims = 0;
  let createdAssessments = 0;
  let skipped = 0;

  for (const claim of claims) {
    const candidates = new Map<string, { actorRole: ClaimAssessmentRole; taskId: string | null; metadata: string }>();

    const createdFromAssessmentRole = normalizeAssessmentActorRole(claim.createdBy, claim.createdFrom);
    if (
      createdFromAssessmentRole
      && (claim.createdFrom === "review_claim" || claim.createdFrom === "reproduce_claim" || claim.createdBy === "reviewer" || claim.createdBy === "reproducer")
    ) {
      const key = `${createdFromAssessmentRole}:claim`;
      candidates.set(key, {
        actorRole: createdFromAssessmentRole,
        taskId: null,
        metadata: JSON.stringify({ source: "legacy_claim_fields" }),
      });
    }

    if (claim.task && claim.task.status === "COMPLETED" && (claim.task.role === "reviewer" || claim.task.role === "reproducer")) {
      const key = `${claim.task.role}:${claim.task.id}`;
      candidates.set(key, {
        actorRole: claim.task.role,
        taskId: claim.task.id,
        metadata: JSON.stringify({ source: "legacy_claim_task" }),
      });
    }

    for (const evidence of claim.evidence) {
      if (
        evidence.kind !== "agent_task"
        || !evidence.task
        || evidence.task.status !== "COMPLETED"
        || (evidence.task.role !== "reviewer" && evidence.task.role !== "reproducer")
      ) {
        continue;
      }

      const key = `${evidence.task.role}:${evidence.task.id}`;
      candidates.set(key, {
        actorRole: evidence.task.role,
        taskId: evidence.task.id,
        metadata: JSON.stringify({ source: "legacy_agent_task_evidence" }),
      });
    }

    const rows = Array.from(candidates.values());
    if (rows.length === 0) {
      skipped += 1;
      continue;
    }

    await prisma.claimAssessment.createMany({
      data: rows.map((row) => ({
        claimId: claim.id,
        taskId: row.taskId,
        actorRole: row.actorRole,
        verdict: claim.status,
        confidence: claim.confidence,
        notes: claim.notes || null,
        metadata: row.metadata,
      })),
    });
    repairedClaims += 1;
    createdAssessments += rows.length;
  }

  return { repairedClaims, createdAssessments, skipped };
}

type ClaimAssessmentLike = {
  actorRole: string;
  verdict: string;
};

type ClaimReviewLike = {
  assessments: ClaimAssessmentLike[];
};

export function claimHasAssessmentFromRole(claim: ClaimReviewLike, role: "reviewer" | "reproducer") {
  return claim.assessments.some((assessment) => assessment.actorRole === role);
}

export function claimHasReviewAssessment(claim: ClaimReviewLike) {
  return claimHasAssessmentFromRole(claim, "reviewer") || claimHasAssessmentFromRole(claim, "reproducer");
}

async function syncClaimMemoryLifecycleTx(tx: ClaimLedgerTx, claimId: string, claimStatus: ClaimStatus) {
  if (claimStatus === "CONTESTED" || claimStatus === "RETRACTED") {
    await tx.agentMemory.updateMany({
      where: {
        sourceClaimId: claimId,
        status: { in: ["CANDIDATE", "APPROVED"] },
      },
      data: {
        status: "STALE",
      },
    });
    return;
  }

  if (claimStatus === "REPRODUCED") {
    await tx.agentMemory.updateMany({
      where: {
        sourceClaimId: claimId,
        status: "CANDIDATE",
      },
      data: {
        status: "APPROVED",
        lastValidatedAt: new Date(),
      },
    });
  }
}

export async function syncClaimMemoryLifecycle(claimId: string, claimStatus: ClaimStatus) {
  await prisma.$transaction(async (tx) => {
    await syncClaimMemoryLifecycleTx(tx, claimId, claimStatus);
  });
}

function prepareClaimStatement(statement: string): string {
  const issue = claimStatementIssue(statement);
  if (issue) throw new Error(issue);
  return normalizeStatement(statement);
}

function dedupeKey(text: string): string {
  return normalizeStatement(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function loadClaimsForConsolidation(projectId: string) {
  return prisma.researchClaim.findMany({
    where: {
      projectId,
      status: { not: "RETRACTED" },
    },
    include: {
      evidence: {
        orderBy: { createdAt: "asc" },
      },
      result: {
        select: { id: true, verdict: true },
      },
      hypothesis: {
        select: { id: true },
      },
      task: {
        select: { id: true, role: true, status: true },
      },
      assessments: {
        select: { id: true, actorRole: true, verdict: true, createdAt: true },
      },
      memories: {
        select: { id: true, userId: true, lesson: true, category: true, sourceClaimId: true },
      },
      insights: {
        select: { id: true, sourceClaimId: true, learning: true },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
}

type ConsolidationClaim = Awaited<ReturnType<typeof loadClaimsForConsolidation>>[number];

function claimRepresentativeScore(claim: ConsolidationClaim) {
  let score = 0;
  if (claim.createdFrom === "record_claim") score += 80;
  if (claim.createdFrom === "update_hypothesis") score += 70;
  if (claim.createdFrom === "record_result") score -= 40;
  score += CLAIM_STATUS_PRIORITY[claim.status as ClaimStatus] * 30;
  score += CLAIM_CONFIDENCE_PRIORITY[claim.confidence as ClaimConfidence] * 10;
  score += claim.evidence.length * 8;
  score += claim.assessments.length * 12;
  score += claim.memories.length * 40;
  score += claim.insights.length * 25;
  if (claim.resultId) score += 10;
  if (claim.hypothesisId) score += 8;
  if (claim.taskId) score += 4;
  score += Math.min(claim.statement.length, MAX_CLAIM_STATEMENT_LENGTH) / 10;
  return score;
}

function claimTypeForFamily(claims: ConsolidationClaim[]): CreateClaimInput["type"] {
  return claims.reduce((best, claim) =>
    CLAIM_TYPE_PRIORITY[claim.type as CreateClaimInput["type"]] > CLAIM_TYPE_PRIORITY[best]
      ? claim.type as CreateClaimInput["type"]
      : best,
  claims[0].type as CreateClaimInput["type"]);
}

function strongestClaimStatus(claims: ConsolidationClaim[]): ClaimStatus {
  if (claims.some((claim) => claim.status === "REPRODUCED")) return "REPRODUCED";
  if (claims.some((claim) => claim.status === "CONTESTED")) return "CONTESTED";
  if (claims.some((claim) => claim.status === "SUPPORTED")) return "SUPPORTED";
  if (claims.some((claim) => claim.status === "DRAFT")) return "DRAFT";
  return "RETRACTED";
}

function strongestClaimConfidence(claims: ConsolidationClaim[]): ClaimConfidence {
  if (claims.some((claim) => claim.confidence === "STRONG")) return "STRONG";
  if (claims.some((claim) => claim.confidence === "MODERATE")) return "MODERATE";
  return "PRELIMINARY";
}

function strongestCreatedBy(claims: ConsolidationClaim[]): CreateClaimInput["createdBy"] {
  if (claims.some((claim) => claim.createdBy === "reproducer")) return "reproducer";
  if (claims.some((claim) => claim.createdBy === "reviewer")) return "reviewer";
  if (claims.some((claim) => claim.createdBy === "user")) return "user";
  if (claims.some((claim) => claim.createdBy === "system")) return "system";
  return "agent";
}

function mergeClaimNotes(claims: ConsolidationClaim[], canonicalId: string) {
  const alternativeStatements = claims
    .filter((claim) => claim.id !== canonicalId)
    .map((claim) => claim.statement)
    .filter(Boolean)
    .filter((statement, index, values) => values.indexOf(statement) === index)
    .slice(0, 3);
  if (alternativeStatements.length === 0) return null;
  return `Canonicalized duplicate claims. Alternative phrasings:\n- ${alternativeStatements.join("\n- ")}`;
}

function existingClaimPreferenceScore(claim: {
  status: string;
  confidence: string;
  type: string;
  createdBy: string;
  createdFrom: string | null;
  evidenceCount?: number;
}) {
  let score = 0;
  score += CLAIM_STATUS_PRIORITY[(claim.status as ClaimStatus) || "DRAFT"] * 100;
  score += CLAIM_CONFIDENCE_PRIORITY[(claim.confidence as ClaimConfidence) || "PRELIMINARY"] * 20;
  score += CLAIM_TYPE_PRIORITY[(claim.type as CreateClaimInput["type"]) || "finding"] * 10;
  if (claim.createdBy === "user") score += 8;
  if (claim.createdBy === "reviewer" || claim.createdBy === "reproducer") score += 12;
  if (claim.createdFrom === "record_claim") score += 6;
  score += (claim.evidenceCount || 0) * 2;
  return score;
}

function evidenceEquivalenceKey(evidence: {
  kind: string;
  supports: boolean;
  strength: string;
  resultId: string | null;
  artifactId: string | null;
  paperId: string | null;
  hypothesisId: string | null;
  logEntryId: string | null;
  taskId: string | null;
  remoteJobId: string | null;
}) {
  return [
    evidence.kind,
    evidence.supports ? "1" : "0",
    evidence.strength,
    evidence.resultId || "",
    evidence.artifactId || "",
    evidence.paperId || "",
    evidence.hypothesisId || "",
    evidence.logEntryId || "",
    evidence.taskId || "",
    evidence.remoteJobId || "",
  ].join("|");
}

function shouldRetireDerivedResultClaim(claim: ConsolidationClaim) {
  if (!claim.resultId) return false;
  if (!["record_result", "auto_import_manifest", "auto_import_stdout_summary"].includes(claim.createdFrom || "")) return false;
  if (claim.memories.length > 0 || claim.insights.length > 0 || claim.assessments.length > 0) return false;
  return claim.evidence.every((evidence) =>
    evidence.kind === "experiment_result" || evidence.kind === "remote_job"
  );
}

export async function repairDerivedResultClaims(projectId: string) {
  const claims = await loadClaimsForConsolidation(projectId);
  const candidates = claims.filter(shouldRetireDerivedResultClaim);
  let retracted = 0;
  let skipped = 0;

  for (const claim of candidates) {
    await prisma.researchClaim.update({
      where: { id: claim.id },
      data: {
        status: "RETRACTED",
        notes: claim.notes
          ? `${claim.notes}\n\nRetired automatically: experiment results are raw observations, not canonical claims.`
          : "Retired automatically: experiment results are raw observations, not canonical claims.",
      },
    });
    await syncClaimMemoryLifecycle(claim.id, "RETRACTED");
    retracted += 1;
  }

  skipped = claims.length - candidates.length;
  return { retracted, skipped };
}

export async function repairDuplicateClaims(projectId: string) {
  const claims = await loadClaimsForConsolidation(projectId);
  if (claims.length < 2) return { canonicalized: 0, retracted: 0, families: 0, skipped: claims.length };

  const visited = new Set<string>();
  let families = 0;
  let canonicalized = 0;
  let retracted = 0;

  for (const claim of claims) {
    if (visited.has(claim.id)) continue;
    const family: ConsolidationClaim[] = [];
    const queue = [claim];
    visited.add(claim.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      family.push(current);

      for (const candidate of claims) {
        if (visited.has(candidate.id) || candidate.id === current.id) continue;
        if (claimsAreNearDuplicates({ left: current, right: candidate })) {
          visited.add(candidate.id);
          queue.push(candidate);
        }
      }
    }

    if (family.length < 2) continue;
    families += 1;

    const canonical = family.slice().sort((left, right) => claimRepresentativeScore(right) - claimRepresentativeScore(left))[0];
    const duplicates = family.filter((member) => member.id !== canonical.id);
    if (duplicates.length === 0) continue;

    await prisma.$transaction(async (tx) => {
      const canonicalEvidence = new Map(canonical.evidence.map((evidence) => [evidenceEquivalenceKey(evidence), evidence.id]));
      for (const duplicate of duplicates) {
        for (const evidence of duplicate.evidence) {
          const key = evidenceEquivalenceKey(evidence);
          if (canonicalEvidence.has(key)) {
            await tx.claimEvidence.delete({ where: { id: evidence.id } });
            continue;
          }
          await tx.claimEvidence.update({
            where: { id: evidence.id },
            data: { claimId: canonical.id },
          });
          canonicalEvidence.set(key, evidence.id);
        }

        if (duplicate.memories.length > 0) {
          await tx.agentMemory.updateMany({
            where: { sourceClaimId: duplicate.id },
            data: { sourceClaimId: canonical.id },
          });
        }
        if (duplicate.assessments.length > 0) {
          await tx.claimAssessment.updateMany({
            where: { claimId: duplicate.id },
            data: { claimId: canonical.id },
          });
        }
        if (duplicate.insights.length > 0) {
          await tx.insight.updateMany({
            where: { sourceClaimId: duplicate.id },
            data: { sourceClaimId: canonical.id },
          });
        }

        await tx.researchClaim.update({
          where: { id: duplicate.id },
          data: {
            status: "RETRACTED",
            notes: duplicate.notes
              ? `${duplicate.notes}\n\nMerged into canonical claim ${canonical.id}.`
              : `Merged into canonical claim ${canonical.id}.`,
          },
        });
      }

      const mergedNotes = mergeClaimNotes(family, canonical.id);
      const preferredSummary = canonical.summary
        || duplicates.map((duplicate) => duplicate.summary).find(Boolean)
        || null;
      const preferredResultId = canonical.resultId
        || duplicates.map((duplicate) => duplicate.resultId).find(Boolean)
        || null;
      const preferredHypothesisId = canonical.hypothesisId
        || duplicates.map((duplicate) => duplicate.hypothesisId).find(Boolean)
        || null;
      const preferredTaskId = canonical.taskId
        || duplicates.map((duplicate) => duplicate.taskId).find(Boolean)
        || null;

      await tx.researchClaim.update({
        where: { id: canonical.id },
        data: {
          type: claimTypeForFamily(family),
          status: strongestClaimStatus(family),
          confidence: strongestClaimConfidence(family),
          createdBy: strongestCreatedBy(family),
          summary: preferredSummary,
          resultId: preferredResultId,
          hypothesisId: preferredHypothesisId,
          taskId: preferredTaskId,
          notes: mergedNotes
            ? canonical.notes
              ? `${canonical.notes}\n\n${mergedNotes}`
              : mergedNotes
            : canonical.notes,
        },
      });
      await syncClaimMemoryLifecycleTx(tx, canonical.id, strongestClaimStatus(family));
    });

    canonicalized += 1;
    retracted += duplicates.length;
  }

  return {
    canonicalized,
    retracted,
    families,
    skipped: Math.max(0, claims.length - canonicalized - retracted),
  };
}

export async function createClaim(input: CreateClaimInput, db?: ClaimLedgerDb) {
  const statement = prepareClaimStatement(input.statement);
  const client = db || prisma;

  const recent = await client.researchClaim.findMany({
    where: {
      projectId: input.projectId,
      status: { not: "RETRACTED" },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      evidence: {
        select: {
          id: true,
          kind: true,
          supports: true,
          strength: true,
          resultId: true,
          artifactId: true,
          paperId: true,
          hypothesisId: true,
          logEntryId: true,
          taskId: true,
          remoteJobId: true,
        },
      },
    },
  });
  const existing = recent.find((claim: (typeof recent)[number]) => claimsAreNearDuplicates({
    left: {
      statement: claim.statement,
      resultId: claim.resultId,
      hypothesisId: claim.hypothesisId,
      createdFrom: claim.createdFrom,
    },
    right: {
      statement,
      resultId: input.resultId || null,
      hypothesisId: input.hypothesisId || null,
      createdFrom: input.createdFrom || null,
    },
  }));
  if (existing) {
    const incomingStatus = input.status || "DRAFT";
    const incomingConfidence = input.confidence || "PRELIMINARY";
    const shouldReplaceStatement = existingClaimPreferenceScore({
      status: incomingStatus,
      confidence: incomingConfidence,
      type: input.type,
      createdBy: input.createdBy || "agent",
      createdFrom: input.createdFrom || null,
      evidenceCount: input.evidence?.length || 0,
    }) > existingClaimPreferenceScore({
      status: existing.status,
      confidence: existing.confidence,
      type: existing.type,
      createdBy: existing.createdBy,
      createdFrom: existing.createdFrom,
      evidenceCount: existing.evidence.length,
    });
    const existingEvidence = new Set(existing.evidence.map((evidence: (typeof existing.evidence)[number]) => evidenceEquivalenceKey(evidence)));
    if (input.evidence && input.evidence.length > 0) {
      const newEvidence = input.evidence.filter((evidence) => !existingEvidence.has(evidenceEquivalenceKey({
        kind: evidence.kind,
        supports: evidence.supports !== false,
        strength: evidence.strength || "DIRECT",
        resultId: evidence.resultId || null,
        artifactId: evidence.artifactId || null,
        paperId: evidence.paperId || null,
        hypothesisId: evidence.hypothesisId || null,
        logEntryId: evidence.logEntryId || null,
        taskId: evidence.taskId || null,
        remoteJobId: evidence.remoteJobId || null,
      })));
      if (newEvidence.length > 0) {
        await client.claimEvidence.createMany({
          data: newEvidence.map((evidence) => ({
            claimId: existing.id,
            kind: evidence.kind,
            supports: evidence.supports !== false,
            strength: evidence.strength || "DIRECT",
            rationale: evidence.rationale || null,
            excerpt: evidence.excerpt || null,
            locator: evidence.locator || null,
            paperId: evidence.paperId || null,
            hypothesisId: evidence.hypothesisId || null,
            resultId: evidence.resultId || null,
            artifactId: evidence.artifactId || null,
            logEntryId: evidence.logEntryId || null,
            taskId: evidence.taskId || null,
            remoteJobId: evidence.remoteJobId || null,
          })),
        });
      }
    }
    await client.researchClaim.update({
      where: { id: existing.id },
      data: {
        statement: shouldReplaceStatement ? statement : undefined,
        type: CLAIM_TYPE_PRIORITY[input.type] > CLAIM_TYPE_PRIORITY[existing.type as CreateClaimInput["type"]]
          ? input.type
          : undefined,
        status: CLAIM_STATUS_PRIORITY[incomingStatus] > CLAIM_STATUS_PRIORITY[existing.status as ClaimStatus]
          ? incomingStatus
          : undefined,
        confidence: CLAIM_CONFIDENCE_PRIORITY[incomingConfidence] > CLAIM_CONFIDENCE_PRIORITY[existing.confidence as ClaimConfidence]
          ? incomingConfidence
          : undefined,
        summary: shouldReplaceStatement
          ? input.summary || existing.summary || undefined
          : existing.summary || input.summary || undefined,
        notes: existing.notes || input.notes || undefined,
        resultId: existing.resultId || input.resultId || undefined,
        hypothesisId: existing.hypothesisId || input.hypothesisId || undefined,
        taskId: existing.taskId || input.taskId || undefined,
      },
    });
    return existing.id;
  }

  const createClaimTx = async (tx: ClaimLedgerDb) => {
    const claim = await tx.researchClaim.create({
      data: {
        projectId: input.projectId,
        statement,
        summary: input.summary || null,
        type: input.type,
        status: input.status || "DRAFT",
        confidence: input.confidence || "PRELIMINARY",
        createdBy: input.createdBy || "agent",
        createdFrom: input.createdFrom || null,
        notes: input.notes || null,
        hypothesisId: input.hypothesisId || null,
        resultId: input.resultId || null,
        taskId: input.taskId || null,
      },
    });

    if (input.evidence && input.evidence.length > 0) {
      await tx.claimEvidence.createMany({
        data: input.evidence.map((evidence) => ({
          claimId: claim.id,
          kind: evidence.kind,
          supports: evidence.supports !== false,
          strength: evidence.strength || "DIRECT",
          rationale: evidence.rationale || null,
          excerpt: evidence.excerpt || null,
          locator: evidence.locator || null,
          paperId: evidence.paperId || null,
          hypothesisId: evidence.hypothesisId || null,
          resultId: evidence.resultId || null,
          artifactId: evidence.artifactId || null,
          logEntryId: evidence.logEntryId || null,
          taskId: evidence.taskId || null,
          remoteJobId: evidence.remoteJobId || null,
        })),
      });
    }

    return claim;
  };

  const created = db
    ? await createClaimTx(client)
    : await prisma.$transaction(async (tx) => createClaimTx(tx));

  return created.id;
}

export async function attachClaimEvidence(claimId: string, evidence: ClaimEvidenceInput) {
  return prisma.claimEvidence.create({
    data: {
      claimId,
      kind: evidence.kind,
      supports: evidence.supports !== false,
      strength: evidence.strength || "DIRECT",
      rationale: evidence.rationale || null,
      excerpt: evidence.excerpt || null,
      locator: evidence.locator || null,
      paperId: evidence.paperId || null,
      hypothesisId: evidence.hypothesisId || null,
      resultId: evidence.resultId || null,
      artifactId: evidence.artifactId || null,
      logEntryId: evidence.logEntryId || null,
      taskId: evidence.taskId || null,
      remoteJobId: evidence.remoteJobId || null,
    },
  });
}

export async function repairResultBackedClaimProvenance(projectId: string) {
  const claims = await prisma.researchClaim.findMany({
    where: { projectId },
    include: {
      result: { select: { id: true, jobId: true } },
      evidence: { select: { id: true, kind: true, resultId: true, remoteJobId: true } },
    },
  });

  let removed = 0;
  let skipped = 0;

  for (const claim of claims) {
    const hasExperimentEvidence = claim.evidence.some((evidence) => evidence.kind === "experiment_result");
    if (!claim.result || !hasExperimentEvidence) continue;

    const redundantRemoteEvidence = claim.evidence.filter((evidence) =>
      evidence.kind === "remote_job"
      && (!claim.result?.jobId || evidence.remoteJobId === claim.result.jobId)
    );

    if (redundantRemoteEvidence.length === 0) {
      skipped += 1;
      continue;
    }

    await prisma.claimEvidence.deleteMany({
      where: { id: { in: redundantRemoteEvidence.map((evidence) => evidence.id) } },
    });
    removed += redundantRemoteEvidence.length;
  }

  return { removed, skipped };
}

export async function reviewClaim(input: ReviewClaimInput) {
  return prisma.$transaction(async (tx) => {
    const actorRole = input.createdBy || "system";
    const taskId = input.taskId || input.evidence?.find((evidence) => evidence.taskId)?.taskId || null;
    const updated = await tx.researchClaim.update({
      where: { id: input.claimId },
      data: {
        status: input.status,
        confidence: input.confidence || undefined,
        createdBy: actorRole,
        createdFrom: actorRole === "reproducer" ? "reproduce_claim" : "review_claim",
        notes: input.notes || undefined,
      },
    });

    await tx.claimAssessment.create({
      data: {
        claimId: input.claimId,
        taskId,
        actorRole,
        verdict: input.status,
        confidence: input.confidence || updated.confidence,
        notes: input.notes || null,
        metadata: assessmentMetadataString(input.metadata, {
          source: actorRole === "reproducer" ? "reproduce_claim" : "review_claim",
          taskId,
        }),
      },
    });

    if (input.evidence && input.evidence.length > 0) {
      await tx.claimEvidence.createMany({
        data: input.evidence.map((evidence) => ({
          claimId: input.claimId,
          kind: evidence.kind,
          supports: evidence.supports !== false,
          strength: evidence.strength || "DIRECT",
          rationale: evidence.rationale || null,
          excerpt: evidence.excerpt || null,
          locator: evidence.locator || null,
          paperId: evidence.paperId || null,
          hypothesisId: evidence.hypothesisId || null,
          resultId: evidence.resultId || null,
          artifactId: evidence.artifactId || null,
          logEntryId: evidence.logEntryId || null,
          taskId: evidence.taskId || null,
          remoteJobId: evidence.remoteJobId || null,
        })),
      });
    }

    await syncClaimMemoryLifecycleTx(tx, input.claimId, input.status);

    return updated;
  });
}

export async function getClaimLedger(projectId: string, options?: { includeRetracted?: boolean }) {
  return prisma.researchClaim.findMany({
    where: {
      projectId,
      ...(options?.includeRetracted ? {} : { status: { not: "RETRACTED" } }),
    },
    include: {
      result: { select: { id: true, scriptName: true, verdict: true, metrics: true } },
      hypothesis: { select: { id: true, statement: true, status: true } },
      task: { select: { id: true, role: true, status: true } },
      assessments: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          actorRole: true,
          verdict: true,
          confidence: true,
          notes: true,
          metadata: true,
          createdAt: true,
          task: { select: { id: true, role: true, status: true } },
        },
      },
      memories: {
        select: {
          id: true,
          category: true,
          status: true,
          confidence: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
      },
      evidence: {
        orderBy: { createdAt: "asc" },
        include: {
          result: { select: { id: true, scriptName: true } },
          artifact: { select: { id: true, filename: true, keyTakeaway: true } },
          paper: { select: { id: true, title: true, year: true } },
          logEntry: { select: { id: true, type: true, content: true } },
          task: { select: { id: true, role: true, status: true } },
          remoteJob: { select: { id: true, command: true, status: true } },
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
}

export async function promoteClaimToMemory(params: {
  claimId: string;
  userId: string;
  category: string;
  lesson?: string;
  context?: string | null;
  projectId?: string | null;
}) {
  const claim = await prisma.researchClaim.findUnique({
    where: { id: params.claimId },
    include: {
      task: { select: { id: true, role: true, status: true } },
      assessments: {
        select: {
          id: true,
          actorRole: true,
          verdict: true,
          confidence: true,
          createdAt: true,
          task: { select: { id: true, role: true, status: true } },
        },
        orderBy: { createdAt: "desc" },
      },
      evidence: {
        include: {
          task: { select: { id: true, role: true, status: true } },
        },
      },
      project: { select: { id: true } },
    },
  });
  if (!claim) throw new Error("Claim not found.");
  if (!["SUPPORTED", "REPRODUCED"].includes(claim.status)) {
    throw new Error(`Only SUPPORTED or REPRODUCED claims can be promoted. Current status: ${claim.status}.`);
  }
  if (claim.evidence.length === 0) {
    throw new Error("Claims need at least one evidence row before promotion.");
  }
  const hasReviewerAssessment = claimHasReviewAssessment(claim);
  if (claim.status === "SUPPORTED" && !hasReviewerAssessment) {
    throw new Error("Supported claims need a completed reviewer or reproducer assessment before promotion.");
  }

  const lesson = normalizeStatement(params.lesson || claim.statement);
  if (!lesson) throw new Error("Lesson is required.");
  const targetStatus = targetMemoryStatusForClaimStatus(claim.status as ClaimStatus);
  const nextConfidence = memoryConfidenceForClaim(claim.confidence as ClaimConfidence);

  const existing = await prisma.agentMemory.findFirst({
    where: {
      userId: params.userId,
      sourceClaimId: claim.id,
    },
  });

  if (existing) {
    return prisma.agentMemory.update({
      where: { id: existing.id },
      data: {
        category: params.category,
        lesson,
        context: params.context || claim.summary || claim.notes || null,
        projectId: params.projectId || claim.project.id,
        sourceClaimId: claim.id,
        status: refreshedMemoryStatus(existing.status, targetStatus),
        confidence: nextConfidence,
        lastValidatedAt: targetStatus === "APPROVED" ? new Date() : existing.lastValidatedAt,
      },
    });
  }

  return prisma.agentMemory.create({
    data: {
      userId: params.userId,
      category: params.category,
      lesson,
      context: params.context || claim.summary || claim.notes || null,
      projectId: params.projectId || claim.project.id,
      sourceClaimId: claim.id,
      status: targetStatus,
      confidence: nextConfidence,
      lastValidatedAt: targetStatus === "APPROVED" ? new Date() : null,
    },
  });
}

export async function transitionClaimMemory(params: {
  memoryId: string;
  userId: string;
  status: "APPROVED" | "STALE" | "REJECTED" | "CANDIDATE";
}) {
  const memory = await prisma.agentMemory.findFirst({
    where: { id: params.memoryId, userId: params.userId },
    include: {
      sourceClaim: {
        include: {
          assessments: {
            select: { actorRole: true, verdict: true },
          },
        },
      },
    },
  });
  if (!memory) throw new Error("Memory not found.");

  if (params.status === "APPROVED" && memory.sourceClaim) {
    const claim = memory.sourceClaim;
    const reviewed = claimHasReviewAssessment(claim);
    const explicitlyApprovable = claim.status === "REPRODUCED"
      || (claim.status === "SUPPORTED" && reviewed);
    if (!explicitlyApprovable) {
      throw new Error("Only reproduced claims or explicitly reviewed supported claims can become approved memory.");
    }
  }

  if (params.status === "CANDIDATE" && memory.sourceClaim) {
    if (!["SUPPORTED", "REPRODUCED"].includes(memory.sourceClaim.status)) {
      throw new Error("Only supported or reproduced claims can stay in candidate memory.");
    }
  }

  return prisma.agentMemory.update({
    where: { id: params.memoryId },
    data: {
      status: params.status,
      lastValidatedAt: params.status === "APPROVED" ? new Date() : memory.lastValidatedAt,
    },
  });
}

export function formatClaimLedger(
  claims: Awaited<ReturnType<typeof getClaimLedger>>,
): string {
  if (claims.length === 0) return "No claims recorded yet.";
  return claims.slice(0, 12).map((claim, index) => {
    const epistemicEvidence = claim.evidence.filter((e) => isEpistemicClaimEvidenceKind(e.kind));
    const evidence = epistemicEvidence.length === 0
      ? "no evidence"
      : `${epistemicEvidence.filter((e) => e.supports).length} supporting / ${epistemicEvidence.filter((e) => !e.supports).length} rebuttal`;
    return `${index + 1}. [${claim.status}/${claim.confidence}] ${claim.statement}\n   Type=${claim.type} | Evidence=${evidence}`;
  }).join("\n\n");
}
