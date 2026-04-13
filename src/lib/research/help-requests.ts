import { readdir } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";

export type HelpRequestCategory = "package" | "api_key" | "env_issue" | "user_input" | "general";
export type HelpRequestResolutionPolicy = "manual" | "system" | "executor";

export interface HelpRequestMetadata {
  category?: HelpRequestCategory;
  title?: string;
  suggestion?: string;
  resolved?: boolean;
  resolvedAt?: string;
  resolution?: string;
  resolutionPolicy?: HelpRequestResolutionPolicy;
  requiresUserAction?: boolean;
  issueType?: string;
  issueKey?: string;
  jobId?: string;
  hostAlias?: string;
  remoteDir?: string;
  supersededBy?: string;
  [key: string]: unknown;
}

const ACTIVE_RUN_STATES = new Set(["QUEUED", "STARTING", "RUNNING"]);
const ACTIVE_REMOTE_JOB_STATUSES = new Set(["QUEUED", "SYNCING", "RUNNING"]);
const ACTIVE_RUN_STATE_VALUES = ["QUEUED", "STARTING", "RUNNING"] as const;

function parseMetadata(raw: string | null | undefined): HelpRequestMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HelpRequestMetadata;
    }
  } catch {
    // ignore
  }
  return {};
}

function serializeMetadata(metadata: HelpRequestMetadata): string {
  return JSON.stringify(metadata);
}

function extractJobId(text: string): string | null {
  const full = text.match(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i);
  if (full) return full[0];
  const short = text.match(/\b[a-f0-9]{8}\b/i);
  return short ? short[0] : null;
}

function canonicalJobKey(jobId: string | null | undefined) {
  if (!jobId) return null;
  return jobId.slice(0, 8);
}

function extractHostAlias(text: string): string | null {
  const match = text.match(/\bon\s+([A-Za-z0-9._-]+)/);
  return match ? match[1] : null;
}

function extractRemoteDir(text: string): string | null {
  const match = text.match(/(~\/experiments\/[A-Za-z0-9._/-]+)/);
  return match ? match[1] : null;
}

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function fallbackIssueKey(category: HelpRequestCategory, title: string) {
  return `${category}:${normalizeWhitespace(title).toLowerCase().slice(0, 120)}`;
}

function classifyHelpRequest(input: {
  category: HelpRequestCategory;
  title: string;
  detail: string;
  suggestion?: string;
  existing?: HelpRequestMetadata;
}) {
  const title = input.title;
  const detail = input.detail;
  const haystack = `${title}\n${detail}\n${input.suggestion || ""}`;
  const existing = input.existing || {};
  const category = input.category;
  const lower = haystack.toLowerCase();
  const jobId = typeof existing.jobId === "string" ? existing.jobId : extractJobId(haystack);
  const jobKey = canonicalJobKey(jobId);
  const hostAlias = typeof existing.hostAlias === "string" ? existing.hostAlias : extractHostAlias(haystack);
  const remoteDir = typeof existing.remoteDir === "string" ? existing.remoteDir : extractRemoteDir(haystack);

  let issueType = typeof existing.issueType === "string" ? existing.issueType : undefined;
  let resolutionPolicy: HelpRequestResolutionPolicy = existing.resolutionPolicy === "system" || existing.resolutionPolicy === "executor"
    ? existing.resolutionPolicy
    : "manual";
  let requiresUserAction = existing.requiresUserAction;

  if (!issueType && category === "env_issue") {
    if (/31 python scripts|script limit|too many scripts|cannot write files|cannot modify or create scripts/i.test(haystack)) {
      issueType = "script_limit";
      resolutionPolicy = "system";
      requiresUserAction = false;
    } else if (/stale lock|workspace locked|workspace busy|zombie job|ghost job|stuck job|blocking workspace|blocking all experiments|kill stuck job/i.test(haystack)) {
      issueType = "workspace_lock";
      resolutionPolicy = "executor";
      requiresUserAction = false;
    } else if (/oom|out of memory|cuda out of memory/i.test(haystack)) {
      issueType = "oom";
      resolutionPolicy = "system";
      requiresUserAction = false;
    }
  }

  if (!issueType && category === "package") {
    issueType = "package_missing";
    resolutionPolicy = "manual";
    requiresUserAction = true;
  }

  if (!issueType && category === "api_key") {
    issueType = "api_key";
    resolutionPolicy = "manual";
    requiresUserAction = true;
  }

  if (!issueType && category === "user_input") {
    issueType = "user_input";
    resolutionPolicy = "manual";
    requiresUserAction = true;
  }

  if (!issueType) issueType = "general";
  if (requiresUserAction == null) {
    requiresUserAction = category === "package" || category === "api_key" || category === "user_input";
  }

  let issueKey = typeof existing.issueKey === "string" ? existing.issueKey : undefined;
  if (!issueKey) {
    switch (issueType) {
      case "script_limit":
        issueKey = "env_issue:script_limit";
        break;
      case "workspace_lock":
        issueKey = `env_issue:workspace_lock:${jobKey || hostAlias || remoteDir || "project"}`;
        break;
      case "oom":
        issueKey = `env_issue:oom:${jobKey || hostAlias || "project"}`;
        break;
      case "package_missing":
        issueKey = `package:${hostAlias || "project"}:${normalizeWhitespace(title).toLowerCase()}`;
        break;
      case "api_key":
        issueKey = `api_key:${normalizeWhitespace(title).toLowerCase()}`;
        break;
      case "user_input":
        issueKey = `user_input:${normalizeWhitespace(title).toLowerCase()}`;
        break;
      default:
        issueKey = fallbackIssueKey(category, title);
    }
  }

  return {
    issueType,
    resolutionPolicy,
    requiresUserAction,
    issueKey,
    jobId,
    hostAlias,
    remoteDir,
  };
}

async function resolveJobReference(projectId: string, jobRef: string | null | undefined) {
  if (!jobRef) return null;
  const exact = await prisma.remoteJob.findFirst({
    where: { projectId, id: jobRef },
    select: { id: true, status: true, runId: true, remoteDir: true, hostId: true },
  });
  if (exact) return exact;
  if (!/^[a-f0-9]{8}$/i.test(jobRef)) return null;
  return prisma.remoteJob.findFirst({
    where: { projectId, id: { startsWith: jobRef } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, runId: true, remoteDir: true, hostId: true },
  });
}

async function isWorkspaceIssueResolved(projectId: string, metadata: HelpRequestMetadata) {
  const job = await resolveJobReference(projectId, typeof metadata.jobId === "string" ? metadata.jobId : null);
  if (job) {
    const leaseFilters: Array<Record<string, unknown>> = [];
    if (job.runId) leaseFilters.push({ runId: job.runId });
    if (!job.runId && ACTIVE_REMOTE_JOB_STATUSES.has(job.status) && job.remoteDir) {
      leaseFilters.push({ leaseKey: { contains: job.remoteDir } });
    }
    const [activeRun, activeAttempt, activeLease] = await Promise.all([
      job.runId
        ? prisma.experimentRun.findFirst({
            where: { id: job.runId, state: { in: [...ACTIVE_RUN_STATE_VALUES] } },
            select: { id: true },
          })
        : Promise.resolve(null),
      job.runId
        ? prisma.experimentAttempt.findFirst({
            where: { runId: job.runId, state: { in: ["STARTING", "RUNNING"] } },
            select: { id: true },
          })
        : Promise.resolve(null),
      leaseFilters.length > 0
        ? prisma.executorLease.findFirst({
            where: {
              projectId,
              OR: leaseFilters,
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    return !activeRun && !activeAttempt && !activeLease
      && !ACTIVE_REMOTE_JOB_STATUSES.has(job.status);
  }

  const remoteDir = typeof metadata.remoteDir === "string" ? metadata.remoteDir : null;
  const hostAlias = typeof metadata.hostAlias === "string" ? metadata.hostAlias : null;
  const leaseFilters: Array<Record<string, unknown>> = [];
  if (remoteDir) leaseFilters.push({ leaseKey: { contains: remoteDir } });
  if (hostAlias) leaseFilters.push({ metadata: { contains: hostAlias } });
  const activeLease = leaseFilters.length > 0
    ? await prisma.executorLease.findFirst({
        where: {
          projectId,
          OR: leaseFilters,
        },
        select: { id: true },
      })
    : null;
  return !activeLease;
}

async function shouldAutoResolveIssue(projectId: string, metadata: HelpRequestMetadata) {
  switch (metadata.issueType) {
    case "script_limit":
      return true;
    case "workspace_lock":
      return isWorkspaceIssueResolved(projectId, metadata);
    default:
      return false;
  }
}

export async function createOrUpdateHelpRequest(params: {
  projectId: string;
  category: HelpRequestCategory;
  title: string;
  detail: string;
  suggestion?: string;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  const baseMetadata = params.metadata ? { ...params.metadata } as HelpRequestMetadata : {};
  const classified = classifyHelpRequest({
    category: params.category,
    title: params.title,
    detail: params.detail,
    suggestion: params.suggestion,
    existing: baseMetadata,
  });
  const metadata: HelpRequestMetadata = {
    ...baseMetadata,
    category: params.category,
    title: params.title,
    suggestion: params.suggestion,
    resolved: false,
    detectedAt: baseMetadata.detectedAt || now,
    lastObservedAt: now,
    issueType: classified.issueType,
    issueKey: classified.issueKey,
    resolutionPolicy: classified.resolutionPolicy,
    requiresUserAction: classified.requiresUserAction,
    ...(classified.jobId ? { jobId: classified.jobId } : {}),
    ...(classified.hostAlias ? { hostAlias: classified.hostAlias } : {}),
    ...(classified.remoteDir ? { remoteDir: classified.remoteDir } : {}),
  };

  const existing = metadata.issueKey
    ? await prisma.researchLogEntry.findFirst({
        where: {
          projectId: params.projectId,
          type: "help_request",
          metadata: { contains: `"issueKey":"${metadata.issueKey}"` },
        },
        orderBy: { createdAt: "desc" },
      })
    : null;

  if (existing) {
    return prisma.researchLogEntry.update({
      where: { id: existing.id },
      data: {
        content: params.detail,
        metadata: serializeMetadata(metadata),
      },
    });
  }

  return prisma.researchLogEntry.create({
    data: {
      projectId: params.projectId,
      type: "help_request",
      content: params.detail,
      metadata: serializeMetadata(metadata),
    },
  });
}

function projectOutputDir(project: { id: string; title: string; outputFolder: string | null }) {
  if (project.outputFolder) return project.outputFolder;
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return path.join(process.cwd(), "output", "research", `${slug}-${project.id.slice(0, 8)}`);
}

export async function refreshProjectHelpRequests(projectId: string) {
  const [project, entries] = await Promise.all([
    prisma.researchProject.findUnique({
      where: { id: projectId },
      select: { id: true, title: true, outputFolder: true },
    }),
    prisma.researchLogEntry.findMany({
      where: { projectId, type: "help_request" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  if (!project || entries.length === 0) return { updated: 0, resolved: 0, deduped: 0 };

  const normalized = entries.map((entry) => {
    const parsed = parseMetadata(entry.metadata);
    const category = (parsed.category as HelpRequestCategory | undefined) || "general";
    const title = typeof parsed.title === "string" && parsed.title.trim().length > 0
      ? parsed.title
      : entry.content.slice(0, 80);
    const classified = classifyHelpRequest({
      category,
      title,
      detail: entry.content,
      suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion : undefined,
      existing: parsed,
    });
    const metadata: HelpRequestMetadata = {
      ...parsed,
      category,
      title,
      suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion : undefined,
      issueType: classified.issueType,
      issueKey: classified.issueKey,
      resolutionPolicy: classified.resolutionPolicy,
      requiresUserAction: classified.requiresUserAction,
      ...(classified.jobId ? { jobId: classified.jobId } : {}),
      ...(classified.hostAlias ? { hostAlias: classified.hostAlias } : {}),
      ...(classified.remoteDir ? { remoteDir: classified.remoteDir } : {}),
    };
    return { entry, metadata };
  });

  let updated = 0;
  let resolved = 0;
  let deduped = 0;
  const latestOpenByKey = new Map<string, string>();
  for (const { entry, metadata } of normalized) {
    if (!metadata.issueKey || metadata.resolved) continue;
    if (!latestOpenByKey.has(metadata.issueKey)) {
      latestOpenByKey.set(metadata.issueKey, entry.id);
    }
  }

  for (const { entry, metadata } of normalized) {
    let nextMetadata = { ...metadata };
    if (metadata.issueKey && !metadata.resolved) {
      const canonicalId = latestOpenByKey.get(metadata.issueKey);
      if (canonicalId && canonicalId !== entry.id) {
        nextMetadata = {
          ...nextMetadata,
          resolved: true,
          resolvedAt: nextMetadata.resolvedAt || new Date().toISOString(),
          resolution: "superseded_duplicate",
          supersededBy: canonicalId,
        };
        deduped += 1;
      }
    }

    if (!nextMetadata.resolved && await shouldAutoResolveIssue(projectId, nextMetadata)) {
      nextMetadata = {
        ...nextMetadata,
        resolved: true,
        resolvedAt: new Date().toISOString(),
        resolution: nextMetadata.issueType === "script_limit" ? "system_can_self_manage" : "executor_state_cleared",
      };
      resolved += 1;
    }

    const currentSerialized = serializeMetadata(parseMetadata(entry.metadata));
    const nextSerialized = serializeMetadata(nextMetadata);
    if (currentSerialized !== nextSerialized) {
      await prisma.researchLogEntry.update({
        where: { id: entry.id },
        data: { metadata: nextSerialized },
      });
      updated += 1;
    }
  }

  const outputDir = projectOutputDir(project);
  try {
    const files = await readdir(outputDir);
    const pyCount = files.filter((file) => file.endsWith(".py")).length;
    if (pyCount <= 30) {
      const staleScriptLimitEntries = entries.filter((entry) => {
        const meta = parseMetadata(entry.metadata);
        return meta.issueType === "script_limit" && !meta.resolved;
      });
      for (const entry of staleScriptLimitEntries) {
        const meta = {
          ...parseMetadata(entry.metadata),
          resolved: true,
          resolvedAt: new Date().toISOString(),
          resolution: "script_budget_cleared",
        };
        await prisma.researchLogEntry.update({
          where: { id: entry.id },
          data: { metadata: serializeMetadata(meta) },
        });
        updated += 1;
        resolved += 1;
      }
    }
  } catch {
    // Directory may not exist yet.
  }

  return { updated, resolved, deduped };
}

export function parseHelpRequestMetadata(raw: string | null | undefined) {
  return parseMetadata(raw);
}

export function isUserActionableHelpRequest(metadata: HelpRequestMetadata | null | undefined) {
  if (!metadata) return true;
  return metadata.requiresUserAction !== false && metadata.resolved !== true;
}
