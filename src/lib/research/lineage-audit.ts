import { prisma } from "@/lib/prisma";
import {
  claimHasReviewAssessment,
  getClaimLedger,
  humanizeExperimentLabel,
  isEpistemicClaimEvidenceKind,
} from "./claim-ledger";
import { listClaimCoordinatorQueue, type ClaimCoordinatorQueueItem } from "./claim-coordinator";

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

function truncate(text: string, max = 140) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function headline(text: string | null | undefined, fallback: string) {
  const cleaned = scrubMarkdown(text);
  if (!cleaned) return fallback;
  return cleaned.split("\n").map((line) => line.trim()).find(Boolean) || fallback;
}

function parseMetricMap(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed)
      .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
      .map(([key, value]) => [key, value as number] as const);
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

function formatMetricValue(value: number) {
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 100) return value.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1) return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return value.toPrecision(2);
}

function summarizeMetricMap(
  values: Record<string, number> | null | undefined,
  { signed = false, limit = 2 }: { signed?: boolean; limit?: number } = {},
) {
  if (!values) return "";
  const entries = Object.entries(values)
    .filter(([, value]) => Number.isFinite(value))
    .sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]));

  if (entries.length === 0) return "";

  const visible = entries.slice(0, limit).map(([key, value]) => {
    const prefix = signed && value > 0 ? "+" : "";
    return `${key} ${prefix}${formatMetricValue(value)}`;
  });
  if (entries.length > limit) visible.push(`+${entries.length - limit} more`);
  return visible.join(", ");
}

function claimHasReview(claim: Awaited<ReturnType<typeof getClaimLedger>>[number]) {
  return claimHasReviewAssessment(claim);
}

type HypothesisRecord = {
  id: string;
  statement: string;
  status: string;
  theme: string | null;
  rationale: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type RunRecord = {
  id: string;
  hypothesisId: string | null;
  state: string;
  attemptCount: number;
  lastErrorClass: string | null;
  lastErrorReason: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  requestedHost: { alias: string; gpuType: string | null } | null;
  remoteJobs: Array<{
    id: string;
    status: string;
    command: string;
    hypothesisId: string | null;
    createdAt: Date;
    completedAt: Date | null;
    host: { alias: string; gpuType: string | null };
  }>;
};

type ResultRecord = {
  id: string;
  jobId: string | null;
  hypothesisId: string | null;
  branchId: string | null;
  scriptName: string;
  condition: string | null;
  metrics: string | null;
  comparison: string | null;
  verdict: string | null;
  createdAt: Date;
  branch: { name: string; status: string } | null;
  artifacts: Array<{
    id: string;
    type: string;
    filename: string;
    path: string;
    keyTakeaway: string | null;
  }>;
};

interface LineageTrack {
  id: string;
  anchorType: "hypothesis" | "result" | "claim" | "run";
  label: string;
  updatedAt: string;
  hypothesis: HypothesisRecord | null;
  runs: RunRecord[];
  results: Array<ResultRecord & { runId: string | null; metricSummary: string; comparisonSummary: string }>;
  claims: Array<Awaited<ReturnType<typeof getClaimLedger>>[number] & { hasReview: boolean }>;
  memories: Array<Awaited<ReturnType<typeof getClaimLedger>>[number]["memories"][number] & { claimId: string; claimStatement: string }>;
  queue: ClaimCoordinatorQueueItem[];
  gaps: string[];
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

function trackLabel(anchorType: LineageTrack["anchorType"], payload: {
  hypothesis?: HypothesisRecord | null;
  result?: ResultRecord | null;
  claim?: Awaited<ReturnType<typeof getClaimLedger>>[number] | null;
  run?: RunRecord | null;
}) {
  if (anchorType === "hypothesis" && payload.hypothesis) {
    return headline(payload.hypothesis.statement, "Untitled hypothesis");
  }
  if (anchorType === "result" && payload.result) {
    const label = humanizeExperimentLabel(payload.result.scriptName);
    return payload.result.condition ? `${label} · ${payload.result.condition}` : label;
  }
  if (anchorType === "run" && payload.run) {
    const host = payload.run.requestedHost?.alias || payload.run.remoteJobs[0]?.host.alias;
    if (!host) return `Experiment run ${payload.run.id.slice(0, 8)}`;
    if (payload.run.state === "RUNNING") return `Running on ${host}`;
    if (payload.run.state === "BLOCKED") return `Blocked on ${host}`;
    if (payload.run.state === "CANCELLED") return `Cancelled on ${host}`;
    return `Queued on ${host}`;
  }
  if (payload.claim) {
    return headline(payload.claim.statement, "Untitled claim");
  }
  return "Audit trail";
}

function isRunOnlyNoiseTrack(track: LineageTrack) {
  if (track.anchorType !== "run") return false;
  if (track.results.length > 0 || track.claims.length > 0 || track.memories.length > 0 || track.queue.length > 0) {
    return false;
  }
  if (track.runs.length === 0) return false;
  return track.runs.every((run) => run.state === "BLOCKED" || run.state === "CANCELLED");
}

export async function getProjectLineage(projectId: string) {
  const [project, hypotheses, runs, results, claims, queue] = await Promise.all([
    prisma.researchProject.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        title: true,
        status: true,
        currentPhase: true,
        methodology: true,
      },
    }),
    prisma.researchHypothesis.findMany({
      where: { projectId },
      select: {
        id: true,
        statement: true,
        status: true,
        theme: true,
        rationale: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    }),
    prisma.experimentRun.findMany({
      where: { projectId },
      select: {
        id: true,
        hypothesisId: true,
        state: true,
        attemptCount: true,
        lastErrorClass: true,
        lastErrorReason: true,
        queuedAt: true,
        startedAt: true,
        completedAt: true,
        requestedHost: { select: { alias: true, gpuType: true } },
        remoteJobs: {
          select: {
            id: true,
            status: true,
            command: true,
            hypothesisId: true,
            createdAt: true,
            completedAt: true,
            host: { select: { alias: true, gpuType: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: [{ queuedAt: "desc" }, { createdAt: "desc" }],
    }),
    prisma.experimentResult.findMany({
      where: { projectId },
      select: {
        id: true,
        jobId: true,
        hypothesisId: true,
        branchId: true,
        scriptName: true,
        condition: true,
        metrics: true,
        comparison: true,
        verdict: true,
        createdAt: true,
        branch: { select: { name: true, status: true } },
        artifacts: {
          select: {
            id: true,
            type: true,
            filename: true,
            path: true,
            keyTakeaway: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: [{ createdAt: "desc" }],
    }),
    getClaimLedger(projectId),
    listClaimCoordinatorQueue(projectId, { activeOnly: true }),
  ]);

  if (!project) throw new Error("Project not found");

  const hypothesisById = new Map(hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
  const resultById = new Map(results.map((result) => [result.id, result]));
  const resultByJobId = new Map(results.filter((result) => result.jobId).map((result) => [result.jobId as string, result]));
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));

  const trackById = new Map<string, LineageTrack>();

  function ensureTrack(
    id: string,
    anchorType: LineageTrack["anchorType"],
    payload: {
      hypothesis?: HypothesisRecord | null;
      result?: ResultRecord | null;
      claim?: Awaited<ReturnType<typeof getClaimLedger>>[number] | null;
      run?: RunRecord | null;
    } = {},
  ) {
    const existing = trackById.get(id);
    if (existing) return existing;
    const track: LineageTrack = {
      id,
      anchorType,
      label: trackLabel(anchorType, payload),
      updatedAt: new Date(0).toISOString(),
      hypothesis: payload.hypothesis || null,
      runs: [],
      results: [],
      claims: [],
      memories: [],
      queue: [],
      gaps: [],
      stats: {
        blocking: 0,
        results: 0,
        claims: 0,
        memories: 0,
        reproduced: 0,
        contested: 0,
        reviewed: 0,
        directEvidence: 0,
      },
    };
    trackById.set(id, track);
    return track;
  }

  function touch(track: LineageTrack, timestamp: Date | string | null | undefined) {
    if (!timestamp) return;
    const nextMs = new Date(timestamp).getTime();
    const currentMs = new Date(track.updatedAt).getTime();
    if (Number.isFinite(nextMs) && nextMs > currentMs) {
      track.updatedAt = new Date(nextMs).toISOString();
    }
  }

  function claimTrackKey(claim: Awaited<ReturnType<typeof getClaimLedger>>[number]) {
    if (claim.hypothesis?.id) return `hypothesis:${claim.hypothesis.id}`;
    if (claim.result?.id) return `result:${claim.result.id}`;
    return `claim:${claim.id}`;
  }

  function runTrackKey(run: RunRecord) {
    if (run.hypothesisId) return `hypothesis:${run.hypothesisId}`;
    const linkedResult = run.remoteJobs.map((job) => resultByJobId.get(job.id)).find(Boolean);
    if (linkedResult?.hypothesisId) return `hypothesis:${linkedResult.hypothesisId}`;
    if (linkedResult) return `result:${linkedResult.id}`;
    return `run:${run.id}`;
  }

  for (const hypothesis of hypotheses) {
    const track = ensureTrack(`hypothesis:${hypothesis.id}`, "hypothesis", { hypothesis });
    touch(track, hypothesis.updatedAt);
  }

  for (const result of results) {
    const trackId = result.hypothesisId ? `hypothesis:${result.hypothesisId}` : `result:${result.id}`;
    const track = ensureTrack(trackId, result.hypothesisId ? "hypothesis" : "result", {
      hypothesis: result.hypothesisId ? hypothesisById.get(result.hypothesisId) || null : null,
      result,
    });
    const linkedRun = result.jobId
      ? runs.find((run) => run.remoteJobs.some((job) => job.id === result.jobId)) || null
      : null;
    if (!track.results.some((item) => item.id === result.id)) {
      track.results.push({
        ...result,
        runId: linkedRun?.id || null,
        metricSummary: summarizeMetricMap(parseMetricMap(result.metrics)),
        comparisonSummary: summarizeMetricMap(parseMetricMap(result.comparison), { signed: true }),
      });
    }
    touch(track, result.createdAt);
  }

  for (const run of runs) {
    const trackId = runTrackKey(run);
    const track = ensureTrack(trackId, trackId.startsWith("hypothesis:") ? "hypothesis" : trackId.startsWith("result:") ? "result" : "run", {
      hypothesis: trackId.startsWith("hypothesis:") ? hypothesisById.get(trackId.slice("hypothesis:".length)) || null : null,
      result: trackId.startsWith("result:") ? resultById.get(trackId.slice("result:".length)) || null : null,
      run,
    });
    if (!track.runs.some((item) => item.id === run.id)) {
      track.runs.push(run);
    }
    touch(track, run.completedAt || run.startedAt || run.queuedAt);
  }

  for (const claim of claims) {
    const trackId = claimTrackKey(claim);
    const track = ensureTrack(trackId, trackId.startsWith("hypothesis:") ? "hypothesis" : trackId.startsWith("result:") ? "result" : "claim", {
      hypothesis: claim.hypothesis?.id ? hypothesisById.get(claim.hypothesis.id) || null : null,
      result: claim.result?.id ? resultById.get(claim.result.id) || null : null,
      claim,
    });
    if (!track.claims.some((item) => item.id === claim.id)) {
      track.claims.push({ ...claim, hasReview: claimHasReview(claim) });
    }
    for (const memory of claim.memories) {
      if (!track.memories.some((item) => item.id === memory.id)) {
        track.memories.push({
          ...memory,
          claimId: claim.id,
          claimStatement: claim.statement,
        });
      }
    }
    touch(track, claim.updatedAt);
  }

  for (const item of queue) {
    if (!item.claimId) continue;
    const claim = claimById.get(item.claimId);
    if (!claim) continue;
    const track = ensureTrack(claimTrackKey(claim), claim.hypothesis?.id ? "hypothesis" : claim.result?.id ? "result" : "claim", {
      hypothesis: claim.hypothesis?.id ? hypothesisById.get(claim.hypothesis.id) || null : null,
      result: claim.result?.id ? resultById.get(claim.result.id) || null : null,
      claim,
    });
    if (!track.queue.some((existing) => existing.stepId === item.stepId)) {
      track.queue.push(item);
    }
  }

  const tracks = Array.from(trackById.values())
  .filter((track) => !isRunOnlyNoiseTrack(track))
  .map((track) => {
    track.runs.sort((left, right) => new Date(right.queuedAt).getTime() - new Date(left.queuedAt).getTime());
    track.results.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    track.claims.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    track.memories.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    track.queue.sort((left, right) => (right.priority || 0) - (left.priority || 0));

    const resultIds = new Set(track.results.map((result) => result.id));
    const blocking = track.queue.filter((item) => item.blocking).length;
    const contested = track.claims.filter((claim) => claim.status === "CONTESTED").length;
    const reproduced = track.claims.filter((claim) => claim.status === "REPRODUCED").length;
    const reviewed = track.claims.filter((claim) => claim.hasReview).length;
    const directEvidence = track.claims.filter((claim) =>
      claim.evidence.some((evidence) => evidence.kind === "experiment_result" && evidence.supports)
    ).length;
    const supportedWithoutReview = track.claims.filter((claim) => claim.status === "SUPPORTED" && !claim.hasReview).length;
    const claimsWithoutEvidence = track.claims.filter((claim) => claim.evidence.filter((evidence) => isEpistemicClaimEvidenceKind(evidence.kind)).length === 0).length;
    const unclaimedResults = track.results.filter((result) => !track.claims.some((claim) => claim.result?.id === result.id)).length;

    const gaps: string[] = [];
    if (blocking > 0) gaps.push(`${blocking} blocking coordinator obligation${blocking === 1 ? "" : "s"}`);
    if (claimsWithoutEvidence > 0) gaps.push(`${claimsWithoutEvidence} claim${claimsWithoutEvidence === 1 ? "" : "s"} still need evidence`);
    if (supportedWithoutReview > 0) gaps.push(`${supportedWithoutReview} supported claim${supportedWithoutReview === 1 ? "" : "s"} still need review`);
    if (contested > 0) gaps.push(`${contested} contested claim${contested === 1 ? "" : "s"} need resolution`);
    if (unclaimedResults > 0) gaps.push(`${unclaimedResults} experiment result${unclaimedResults === 1 ? "" : "s"} are not tied to a claim`);

    const latestTimestamp = [
      track.hypothesis?.updatedAt ? new Date(track.hypothesis.updatedAt).getTime() : 0,
      ...track.runs.map((run) => new Date(run.completedAt || run.startedAt || run.queuedAt).getTime()),
      ...track.results.map((result) => new Date(result.createdAt).getTime()),
      ...track.claims.map((claim) => new Date(claim.updatedAt).getTime()),
      ...track.memories.map((memory) => new Date(memory.updatedAt).getTime()),
    ].reduce((best, value) => Math.max(best, value), 0);

    const primaryClaim = track.claims[0];
    const primaryResult = track.results[0];
    const label = primaryClaim
      ? headline(primaryClaim.statement, track.label)
      : track.anchorType === "result" && primaryResult
        ? primaryResult.condition
          ? `${humanizeExperimentLabel(primaryResult.scriptName)} · ${primaryResult.condition}`
          : humanizeExperimentLabel(primaryResult.scriptName)
        : track.label;

    return {
      ...track,
      label,
      updatedAt: new Date(latestTimestamp || Date.now()).toISOString(),
      gaps,
      stats: {
        blocking,
        results: track.results.length,
        claims: track.claims.length,
        memories: track.memories.length,
        reproduced,
        contested,
        reviewed,
        directEvidence,
      },
      results: track.results.map((result) => ({
        ...result,
        artifacts: result.artifacts,
      })),
      claims: track.claims.map((claim) => ({
        ...claim,
        evidenceSummary: {
          support: claim.evidence.filter((evidence) => isEpistemicClaimEvidenceKind(evidence.kind) && evidence.supports).length,
          rebuttal: claim.evidence.filter((evidence) => isEpistemicClaimEvidenceKind(evidence.kind) && !evidence.supports).length,
        },
      })),
      unclaimedResultIds: Array.from(resultIds).filter((resultId) => !track.claims.some((claim) => claim.result?.id === resultId)),
    };
  }).sort((left, right) => {
    if (right.stats.blocking !== left.stats.blocking) return right.stats.blocking - left.stats.blocking;
    if (right.queue.length !== left.queue.length) return right.queue.length - left.queue.length;
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });

  const distinctMemoryIds = new Set<string>();
  for (const track of tracks) {
    for (const memory of track.memories) distinctMemoryIds.add(memory.id);
  }

  return {
    project,
    overview: {
      hypotheses: hypotheses.length,
      runs: runs.length,
      results: results.length,
      claims: claims.length,
      memories: distinctMemoryIds.size,
      queue: queue.length,
      blocking: queue.filter((item) => item.blocking).length,
      tracks: tracks.length,
    },
    tracks: tracks.map((track) => ({
      ...track,
      label: truncate(track.label, 160),
      queue: track.queue,
      gaps: track.gaps.slice(0, 4),
    })),
  };
}
