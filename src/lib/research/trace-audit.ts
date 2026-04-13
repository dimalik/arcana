import { prisma } from "@/lib/prisma";
import { listAgentTraceEvents } from "./agent-trace";

export type TracePostmortemCategory =
  | "agent_reasoning"
  | "validator_miss"
  | "execution_control_plane"
  | "script_runtime"
  | "host_environment";

export type TracePostmortemSeverity = "high" | "medium" | "low";

export interface TraceAuditEventRecord {
  id: string;
  runId: string;
  sessionNumber: number;
  sequence: number;
  eventType: string;
  stepNumber: number | null;
  toolName: string | null;
  toolCallId: string | null;
  content: string | null;
  args: unknown | null;
  result: unknown | null;
  activity: unknown | null;
  metadata: unknown | null;
  createdAt: string;
}

export interface TraceAuditSessionSummary {
  runId: string;
  sessionNumbers: number[];
  startedAt: string;
  updatedAt: string;
  endedAt: string;
  eventCount: number;
  thinkingCount: number;
  toolCallCount: number;
  blockedCount: number;
  errorCount: number;
  status: "running" | "completed" | "errored" | "blocked";
  tools: string[];
  lastEventType: string;
  lastEventPreview: string | null;
  categories: TracePostmortemCategory[];
}

export interface TraceAuditPostmortem {
  id: string;
  source: "trace_session" | "experiment_run";
  category: TracePostmortemCategory;
  severity: TracePostmortemSeverity;
  title: string;
  summary: string;
  shouldHaveBlockedEarlier: boolean;
  boundary: string;
  recommendedAction: string;
  linkedTraceRunId: string | null;
  linkedExperimentRunId: string | null;
  linkedRemoteJobId: string | null;
  createdAt: string;
  evidence: string[];
}

export interface TraceAuditOverview {
  sessions: number;
  events: number;
  blockedEvents: number;
  toolCalls: number;
  errors: number;
  activeRuns: number;
  failedRuns: number;
  postmortems: number;
  categories: Array<{
    category: TracePostmortemCategory;
    count: number;
  }>;
}

export interface ProjectTraceAudit {
  project: {
    id: string;
    title: string;
    status: string;
    currentPhase: string;
  };
  overview: TraceAuditOverview;
  sessions: TraceAuditSessionSummary[];
  postmortems: TraceAuditPostmortem[];
  total: number;
  returned: number;
  events: TraceAuditEventRecord[];
}

const BLOCKED_PREFIX = /^BLOCKED\b/i;

const REASONING_PATTERNS: RegExp[] = [
  /execute_remote does not accept inline python/i,
  /execute_remote is only for running python experiment scripts/i,
  /execute_remote only accepts commands in the form/i,
  /infrastructure probe scripts are not valid research scripts/i,
  /do not submit another script/i,
  /same code must change before rerun/i,
];

const CONTROL_PLANE_PATTERNS: RegExp[] = [
  /workspace busy/i,
  /workspace lock/i,
  /stale lock/i,
  /stale job/i,
  /ghost job/i,
  /zombie job/i,
  /lease/i,
  /sync failed/i,
  /rsync/i,
  /job .* not found/i,
  /check_job returns? ["']?not found/i,
];

const HOST_ENVIRONMENT_PATTERNS: RegExp[] = [
  /could not resolve hostname/i,
  /permission denied/i,
  /no such identity/i,
  /pip install/i,
  /conda/i,
  /no module named/i,
  /modulenotfounderror/i,
  /api key/i,
  /ssh:/i,
  /requirements?/i,
  /out of memory/i,
  /\boom\b/i,
  /killed by the os/i,
];

const VALIDATOR_MISS_PATTERNS: RegExp[] = [
  /syntaxerror/i,
  /attributeerror/i,
  /nameerror/i,
  /typeerror/i,
  /importerror/i,
  /unexpected keyword argument/i,
  /has no attribute/i,
  /total_mem/i,
];

function parseJson(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeText(...parts: Array<string | null | undefined>) {
  return parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n")
    .trim();
}

function truncate(text: string | null | undefined, max = 220): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function matchesAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function summarizeEvent(event: TraceAuditEventRecord) {
  if (event.content?.trim()) return truncate(event.content);
  if (event.toolName) return truncate(`${event.toolName}${event.args ? ` ${JSON.stringify(event.args)}` : ""}`);
  return null;
}

function deriveSessionStatus(events: TraceAuditEventRecord[]): TraceAuditSessionSummary["status"] {
  const last = events[events.length - 1];
  if (!last) return "completed";
  if (last.eventType === "done") return "completed";
  if (last.eventType === "error") return "errored";
  if (events.some((event) => BLOCKED_PREFIX.test(event.content || ""))) return "blocked";
  return "running";
}

function buildPostmortem(params: Omit<TraceAuditPostmortem, "id">): TraceAuditPostmortem {
  const slug = [
    params.source,
    params.category,
    params.linkedTraceRunId || "trace-none",
    params.linkedExperimentRunId || "run-none",
    params.linkedRemoteJobId || "job-none",
    params.title,
  ]
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-");
  return { id: slug, ...params };
}

function classifyTraceSession(events: TraceAuditEventRecord[]): TraceAuditPostmortem[] {
  if (events.length === 0) return [];
  const runId = events[0].runId;
  const createdAt = events[events.length - 1].createdAt;
  const blocked = events.filter((event) => BLOCKED_PREFIX.test(event.content || ""));
  const combinedBlocked = blocked.map((event) => event.content || "").join("\n");
  const postmortems: TraceAuditPostmortem[] = [];

  if (blocked.some((event) => matchesAny(event.content || "", REASONING_PATTERNS))) {
    const evidence = blocked
      .filter((event) => matchesAny(event.content || "", REASONING_PATTERNS))
      .slice(0, 3)
      .map((event) => truncate(event.content, 180) || "Blocked tool call");
    postmortems.push(buildPostmortem({
      source: "trace_session",
      category: "agent_reasoning",
      severity: blocked.length >= 2 ? "high" : "medium",
      title: "Agent attempted prohibited tool patterns",
      summary: "The agent used disallowed remote probe or shell patterns instead of the constrained research tools.",
      shouldHaveBlockedEarlier: true,
      boundary: "tool policy",
      recommendedAction: "Tighten tool instructions and keep prohibited remote probe commands as hard blocks in the execution layer.",
      linkedTraceRunId: runId,
      linkedExperimentRunId: null,
      linkedRemoteJobId: null,
      createdAt,
      evidence,
    }));
  }

  const workspaceBusyCount = blocked.filter((event) => /workspace busy|remote workspace .* occupied/i.test(event.content || "")).length;
  if (workspaceBusyCount >= 2) {
    postmortems.push(buildPostmortem({
      source: "trace_session",
      category: "agent_reasoning",
      severity: "high",
      title: "Agent retried submission while the workspace was already blocked",
      summary: "The trace shows repeated submission attempts after the control plane had already reported the workspace as busy.",
      shouldHaveBlockedEarlier: true,
      boundary: "submission policy",
      recommendedAction: "After a workspace-busy block, the only allowed follow-ups should be state inspection, cancellation, or waiting. No additional submission attempts should be planned.",
      linkedTraceRunId: runId,
      linkedExperimentRunId: null,
      linkedRemoteJobId: null,
      createdAt,
      evidence: [truncate(combinedBlocked, 220) || "Workspace busy blocks recorded in trace."],
    }));
  }

  const errorText = normalizeText(
    ...events
      .filter((event) => event.eventType === "error")
      .map((event) => event.content),
  );
  if (errorText && /timed out after .* minutes/i.test(errorText)) {
    postmortems.push(buildPostmortem({
      source: "trace_session",
      category: "execution_control_plane",
      severity: "medium",
      title: "Agent session timed out before converging",
      summary: "The agent session itself timed out, which usually points to a control-plane or tool-lifecycle problem rather than a completed research step.",
      shouldHaveBlockedEarlier: true,
      boundary: "agent runtime supervision",
      recommendedAction: "Inspect the last tool call in the trace and shorten or fence long-running operations so sessions do not stall silently.",
      linkedTraceRunId: runId,
      linkedExperimentRunId: null,
      linkedRemoteJobId: null,
      createdAt,
      evidence: [truncate(errorText, 220) || "Session timeout event."],
    }));
  }

  return postmortems;
}

function classifyRunFailure(run: {
  id: string;
  state: string;
  lastErrorClass: string | null;
  lastErrorReason: string | null;
  queuedAt: Date;
  requestedHost: { alias: string; gpuType: string | null } | null;
  attempts: Array<{
    id: string;
    errorClass: string | null;
    errorReason: string | null;
    stderrTail: string | null;
    stdoutTail: string | null;
    state: string;
    completedAt: Date | null;
  }>;
  remoteJobs: Array<{
    id: string;
    status: string;
    stderr: string | null;
    stdout: string | null;
    exitCode: number | null;
    command: string;
    completedAt: Date | null;
    host: { alias: string; gpuType: string | null } | null;
  }>;
}): TraceAuditPostmortem | null {
  const latestAttempt = run.attempts[0] || null;
  const latestJob = run.remoteJobs[0] || null;
  const context = normalizeText(
    run.lastErrorClass,
    run.lastErrorReason,
    latestAttempt?.errorClass,
    latestAttempt?.errorReason,
    latestAttempt?.stderrTail,
    latestAttempt?.stdoutTail,
    latestJob?.stderr,
    latestJob?.stdout,
  );
  const lower = context.toLowerCase();
  if (!context) return null;

  let category: TracePostmortemCategory = "script_runtime";
  let title = "Runtime failure reached execution";
  let summary = "The run failed after submission and should be inspected as a script/runtime issue.";
  let shouldHaveBlockedEarlier = false;
  let boundary = "runtime";
  let recommendedAction = "Inspect the stderr/stdout tail, tighten the script, and rerun only after the failure mode is understood.";

  if (matchesAny(lower, CONTROL_PLANE_PATTERNS)) {
    category = "execution_control_plane";
    title = "Execution control-plane failure";
    summary = "The failure points to workspace locking, stale job state, sync, or lifecycle reconciliation rather than the experiment logic itself.";
    shouldHaveBlockedEarlier = true;
    boundary = "execution control plane";
    recommendedAction = "Repair the run/lease/job reconciliation path so stale or missing remote state is cleared automatically before new submissions.";
  } else if (matchesAny(lower, HOST_ENVIRONMENT_PATTERNS)) {
    category = "host_environment";
    title = "Host or environment failure";
    summary = "The run failed because the remote host or environment was not ready, not because the research script produced a scientific result.";
    shouldHaveBlockedEarlier = true;
    boundary = "environment validation";
    recommendedAction = "Move this class of issue into environment validation or host health checks before remote submission.";
  } else if (matchesAny(lower, VALIDATOR_MISS_PATTERNS) || /code_error/i.test(run.lastErrorClass || "") || /code_error/i.test(latestAttempt?.errorClass || "")) {
    category = "validator_miss";
    title = "Validator miss: trivial code error reached runtime";
    summary = "A static or semantic code defect made it onto the remote host instead of being stopped by preflight or static analysis.";
    shouldHaveBlockedEarlier = true;
    boundary = "semantic validation";
    recommendedAction = "Strengthen local and remote static validation so attribute, import, and API-shape errors are blocked before GPU submission.";
  }

  return buildPostmortem({
    source: "experiment_run",
    category,
    severity: shouldHaveBlockedEarlier ? "high" : "medium",
    title,
    summary,
    shouldHaveBlockedEarlier,
    boundary,
    recommendedAction,
    linkedTraceRunId: null,
    linkedExperimentRunId: run.id,
    linkedRemoteJobId: latestJob?.id || null,
    createdAt: (latestJob?.completedAt || latestAttempt?.completedAt || run.queuedAt).toISOString(),
    evidence: [
      ...(run.requestedHost?.alias ? [`Host: ${run.requestedHost.alias}${run.requestedHost.gpuType ? ` (${run.requestedHost.gpuType})` : ""}`] : []),
      ...(latestJob?.command ? [`Command: ${truncate(latestJob.command, 180)}`] : []),
      ...(context ? [truncate(context, 240) || context] : []),
    ],
  });
}

export async function getProjectTraceAudit(params: {
  projectId: string;
  limit?: number;
  runId?: string | null;
}): Promise<ProjectTraceAudit> {
  const limit = Math.max(1, Math.min(params.limit ?? 300, 1000));
  const project = await prisma.researchProject.findUnique({
    where: { id: params.projectId },
    select: {
      id: true,
      title: true,
      status: true,
      currentPhase: true,
    },
  });
  if (!project) {
    throw new Error(`Project not found: ${params.projectId}`);
  }

  const [eventsDesc, total, runs] = await Promise.all([
    listAgentTraceEvents({ projectId: params.projectId, runId: params.runId || undefined, limit }),
    prisma.agentTraceEvent.count({
      where: {
        projectId: params.projectId,
        ...(params.runId ? { runId: params.runId } : {}),
      },
    }),
    prisma.experimentRun.findMany({
      where: {
        projectId: params.projectId,
        OR: [
          { state: { in: ["FAILED", "BLOCKED", "CANCELLED"] } },
          { lastErrorReason: { not: null } },
          { attempts: { some: { OR: [{ errorReason: { not: null } }, { errorClass: { not: null } }] } } },
          { remoteJobs: { some: { status: { in: ["FAILED", "CANCELLED"] } } } },
        ],
      },
      include: {
        requestedHost: {
          select: { alias: true, gpuType: true },
        },
        attempts: {
          orderBy: [{ startedAt: "desc" }],
          take: 3,
          select: {
            id: true,
            errorClass: true,
            errorReason: true,
            stderrTail: true,
            stdoutTail: true,
            state: true,
            completedAt: true,
          },
        },
        remoteJobs: {
          orderBy: [{ createdAt: "desc" }],
          take: 3,
          select: {
            id: true,
            status: true,
            stderr: true,
            stdout: true,
            exitCode: true,
            command: true,
            completedAt: true,
            host: { select: { alias: true, gpuType: true } },
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }],
      take: 24,
    }),
  ]);

  const events = eventsDesc
    .slice()
    .reverse()
    .map<TraceAuditEventRecord>((event) => ({
      id: event.id,
      runId: event.runId,
      sessionNumber: event.sessionNumber,
      sequence: event.sequence,
      eventType: event.eventType,
      stepNumber: event.stepNumber,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      content: event.content,
      args: parseJson(event.argsJson),
      result: parseJson(event.resultJson),
      activity: parseJson(event.activityJson),
      metadata: parseJson(event.metadata),
      createdAt: event.createdAt.toISOString(),
    }));

  const sessionMap = new Map<string, TraceAuditEventRecord[]>();
  for (const event of events) {
    const group = sessionMap.get(event.runId) || [];
    group.push(event);
    sessionMap.set(event.runId, group);
  }

  const sessionPostmortems = Array.from(sessionMap.values()).flatMap((group) => classifyTraceSession(group));
  const runPostmortems = runs
    .map((run) => classifyRunFailure(run))
    .filter((item): item is TraceAuditPostmortem => Boolean(item));

  const postmortemById = new Map<string, TraceAuditPostmortem>();
  for (const postmortem of [...runPostmortems, ...sessionPostmortems]) {
    if (!postmortemById.has(postmortem.id)) {
      postmortemById.set(postmortem.id, postmortem);
    }
  }
  const postmortems = Array.from(postmortemById.values()).sort((a, b) => {
    const severityRank = { high: 0, medium: 1, low: 2 } as const;
    const rankDiff = severityRank[a.severity] - severityRank[b.severity];
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const sessions = Array.from(sessionMap.entries())
    .map<TraceAuditSessionSummary>(([runId, group]) => {
      const tools = Array.from(new Set(group.map((event) => event.toolName).filter((tool): tool is string => Boolean(tool))));
      const categories = Array.from(new Set(postmortems
        .filter((item) => item.linkedTraceRunId === runId)
        .map((item) => item.category)));
      const last = group[group.length - 1];
      return {
        runId,
        sessionNumbers: Array.from(new Set(group.map((event) => event.sessionNumber))).sort((a, b) => a - b),
        startedAt: group[0].createdAt,
        updatedAt: last.createdAt,
        endedAt: last.createdAt,
        eventCount: group.length,
        thinkingCount: group.filter((event) => event.eventType === "thinking").length,
        toolCallCount: group.filter((event) => event.eventType === "tool_call").length,
        blockedCount: group.filter((event) => BLOCKED_PREFIX.test(event.content || "")).length,
        errorCount: group.filter((event) => event.eventType === "error").length,
        status: deriveSessionStatus(group),
        tools,
        lastEventType: last.eventType,
        lastEventPreview: summarizeEvent(last),
        categories,
      };
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const overview: TraceAuditOverview = {
    sessions: sessions.length,
    events: total,
    blockedEvents: events.filter((event) => BLOCKED_PREFIX.test(event.content || "")).length,
    toolCalls: events.filter((event) => event.eventType === "tool_call").length,
    errors: events.filter((event) => event.eventType === "error").length,
    activeRuns: runs.filter((run) => run.state === "RUNNING" || run.state === "STARTING" || run.state === "QUEUED").length,
    failedRuns: runs.filter((run) => run.state === "FAILED" || run.state === "BLOCKED" || run.state === "CANCELLED").length,
    postmortems: postmortems.length,
    categories: (["agent_reasoning", "validator_miss", "execution_control_plane", "script_runtime", "host_environment"] as const)
      .map((category) => ({
        category,
        count: postmortems.filter((item) => item.category === category).length,
      }))
      .filter((item) => item.count > 0),
  };

  return {
    project,
    overview,
    sessions,
    postmortems,
    total,
    returned: events.length,
    events,
  };
}
