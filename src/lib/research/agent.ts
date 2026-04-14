/**
 * Research Agent — autonomous research loop with tools.
 *
 * Like Claude Code but for research: searches papers, reads them,
 * writes experiment code, runs it (locally or remotely), analyzes
 * results, and iterates.
 */

import { streamText, generateText, generateObject, stepCountIs, tool } from "ai";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getModel, getToolLoopModel } from "@/lib/llm/provider";
import { getDefaultModel, getModelForTier } from "@/lib/llm/auto-process";
import { setLlmContext } from "@/lib/llm/provider";
import { prisma } from "@/lib/prisma";
import { searchAllSources, isFigureOrSupplementDoi } from "@/lib/import/semantic-scholar";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { processingQueue } from "@/lib/processing/queue";
import { submitRemoteJob, probeGpus, probeRuntimeSmoke, quickRemoteCommand, testConnection, analyzeScript, formatDiagnostics, getWorkspaceBaseName } from "./remote-executor";
import { countDefaultResearchHosts, findPreferredRemoteHost, listDefaultResearchHosts } from "./remote-host-policy";
import { routeScript } from "./resource-router";
import { classifyTaskCategory } from "./task-classifier";
import { processQuery, scoreWeighted, scoreText, filterByRelevance } from "./search-utils";
import { getAllResourcePreferences, recordResourceChoice, CONFIDENCE_THRESHOLD } from "./resource-preferences";
import { getWorkspaceState, formatWorkspace, invalidateWorkspace } from "./workspace";
import { createOrUpdateHelpRequest } from "./help-requests";
import {
  getEvaluationProtocol,
  saveEvaluationProtocolTx,
  summarizeEvaluationProtocol,
  validateCommandAgainstEvaluationProtocol,
  validateResultMetricsAgainstEvaluationProtocol,
  type EvaluationProtocol,
} from "./evaluation-protocol";
import { formatSkillCards, queryAntiPatterns, querySkillCards, type SkillQueryMode } from "./insight-skills";
import { getAgentTestFixture, listAgentTestFixtureIds } from "./agent-test-fixtures";
import {
  CLAIM_FINDING_TYPES,
  attachClaimEvidence,
  createClaim,
  formatClaimLedger,
  getClaimLedger,
  promoteClaimToMemory,
  reviewClaim,
} from "./claim-ledger";
import {
  getBlockingClaimCoordinatorQueue,
  reconcileExperimentResultWithClaimCoordinator,
  summarizeBlockingClaimCoordinatorQueue,
  syncClaimCoordinator,
} from "./claim-coordinator";
import {
  buildFailureReflectionMetadata,
  getReflectedFailureJobIds,
} from "./research-data-repair";
import { getNotebookLogType } from "./research-log-policy";
import {
  classifyRemoteFailureRecovery,
  formatRemoteSubmissionFailure,
  getManagedScriptPolicyViolation,
} from "./execution-policy";
import {
  appendAgentTraceEvent,
  shouldPersistAgentTraceEvent,
} from "./agent-trace";
import { evaluateCollectResultsCooldown } from "./collect-results-policy";
import { isPathWithinRoot } from "./path-safety";
import { launchSubAgentTask } from "./sub-agent-launcher";
import { reserveNextResearchStepSortOrder } from "./step-order";
import {
  getExperimentSubmissionConvergenceBarrier,
  getManagedScriptCreationBarrier,
  getManagedScriptDeletionBarrier,
  isManagedExperimentScript,
} from "./experiment-convergence";
import { recoverProjectRemoteResults } from "./result-import";
import {
  resolveExperimentContract,
  type ExperimentGrounding,
  type ExperimentPurpose,
} from "./experiment-contracts";
import {
  computeExperimentSubmissionReadiness,
  formatExperimentSubmissionReadiness,
  getActiveWorkspaceSubmissionGuard,
  resolveExperimentHypothesisLink,
} from "./submission-readiness";
import { getToolsForState } from "./fsm/tool-sets";
import { attemptAutoTransition } from "./fsm/transition-engine";
import { resolveDesignPrerequisites } from "./fsm/design-auto-resolve";
import { validateStep, getStateDirective } from "./fsm/state-validator";
import type { ProjectState } from "./fsm/types";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, readFile, readdir, stat, appendFile, rm } from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

// ── Background PDF download queue (serial to avoid rate limits) ───

interface PdfDownloadItem {
  paperId: string;
  doi: string | null;
  arxivId: string | null;
  openAccessPdfUrl: string | null;
  title: string;
  hasAbstract: boolean;
}

const pdfDownloadQueue: PdfDownloadItem[] = [];
let pdfDownloadRunning = false;

async function drainPdfDownloadQueue() {
  if (pdfDownloadRunning) return;
  pdfDownloadRunning = true;

  while (pdfDownloadQueue.length > 0) {
    const item = pdfDownloadQueue.shift()!;
    try {
      const pdf = await findAndDownloadPdf({
        doi: item.doi,
        arxivId: item.arxivId,
        existingPdfUrl: item.openAccessPdfUrl,
        title: item.title,
      });

      if (pdf) {
        await prisma.paper.update({
          where: { id: item.paperId },
          data: { filePath: pdf.filePath, processingStatus: "EXTRACTING_TEXT" },
        });
        processingQueue.enqueue(item.paperId);
        console.log(`[pdf-queue] Downloaded PDF for ${item.paperId} from ${pdf.source}`);
      } else if (item.hasAbstract) {
        await prisma.paper.update({
          where: { id: item.paperId },
          data: { processingStatus: "NO_PDF" },
        });
        processingQueue.enqueue(item.paperId);
      } else {
        await prisma.paper.update({
          where: { id: item.paperId },
          data: { processingStatus: "NO_PDF" },
        });
      }
    } catch (err) {
      console.warn(`[pdf-queue] Failed for ${item.paperId}:`, (err as Error).message);
      if (item.hasAbstract) {
        processingQueue.enqueue(item.paperId);
      }
      await prisma.paper.update({
        where: { id: item.paperId },
        data: { processingStatus: "NO_PDF" },
      }).catch(() => {});
    }

    // 500ms delay between downloads to respect rate limits
    await new Promise((r) => setTimeout(r, 500));
  }

  pdfDownloadRunning = false;
}

// ── Phase gate infrastructure ────────────────────────────────────
// Legacy phase-restricted tools removed — FSM tool-sets now govern availability.

// checkPhaseGate removed — FSM transition engine handles state advancement.

// ── Helpers ──────────────────────────────────────────────────────

/** Strip invalid Unicode surrogates and control characters that break JSON serialization */
function sanitizeForJson(text: string): string {
  // Remove unpaired surrogates (cause "invalid high surrogate in string" API errors)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\uD800-\uDFFF]|[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

/** Check if a script name is a utility/helper (not an experiment) */
function isUtilityScript(name: string): boolean {
  const n = name.toLowerCase();
  return /^(utils|helpers|config|setup|__init__|constants|common|shared|preprocess|data_loader|eval_utils)\.py$/.test(n)
    || n === "requirements.txt" || n.endsWith("_utils.py") || n.endsWith("_helpers.py");
}

type ProjectRemoteJob = Awaited<ReturnType<typeof prisma.remoteJob.findFirst>>;

async function resolveProjectRemoteJob(projectId: string, jobRef: string) {
  const normalized = jobRef.trim();
  if (!normalized) {
    return { job: null, ambiguous: false, matches: [] as ProjectRemoteJob[] };
  }

  const fullUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(normalized);
  if (fullUuid) {
    const job = await prisma.remoteJob.findFirst({
      where: { projectId, id: normalized },
      include: { host: true },
    });
    return { job, ambiguous: false, matches: job ? [job] : [] };
  }

  const matches = await prisma.remoteJob.findMany({
    where: {
      projectId,
      id: { startsWith: normalized },
    },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { id: true },
  });
  if (matches.length === 1) {
    const job = await prisma.remoteJob.findUnique({
      where: { id: matches[0].id },
      include: { host: true },
    });
    return { job, ambiguous: false, matches: job ? [job] : [] };
  }
  if (matches.length > 1) {
    const detailedMatches = await prisma.remoteJob.findMany({
      where: { id: { in: matches.map((match) => match.id) } },
      orderBy: { createdAt: "desc" },
      include: { host: true },
    });
    return { job: null, ambiguous: true, matches: detailedMatches };
  }
  return { job: null, ambiguous: false, matches: [] as ProjectRemoteJob[] };
}

function formatRemoteJobMatches(matches: Array<{ id: string; command: string; status: string }>) {
  return matches.map((job) => `- ${job.id}: ${job.command.slice(0, 60)} [${job.status}]`).join("\n");
}

async function getFailedCodeResubmissionBarrier(projectId: string, scriptHash: string) {
  const reflectedJobIds = await getReflectedFailureJobIds(projectId);
  if (reflectedJobIds.size === 0) return null;

  const reflectedFailure = await prisma.remoteJob.findFirst({
    where: {
      projectId,
      status: "FAILED",
      scriptHash,
      id: { in: Array.from(reflectedJobIds) },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      command: true,
      completedAt: true,
    },
  });
  if (!reflectedFailure) return null;

  return [
    `BLOCKED — This exact script content already failed in job ${reflectedFailure.id.slice(0, 8)} and has been reflected.`,
    "Change the code before resubmitting. Re-running identical failed code wastes resources and is forbidden.",
    reflectedFailure.command ? `Last failed command: \`${reflectedFailure.command}\`` : "",
  ].filter(Boolean).join("\n");
}

async function getFailedExperimentSubmissionBlock(projectId: string): Promise<string | null> {
  const [failedJobs, addressedSet] = await Promise.all([
    prisma.remoteJob.findMany({
      where: { projectId, status: "FAILED" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        errorClass: true,
        command: true,
      },
    }),
    getReflectedFailureJobIds(projectId),
  ]);

  const pendingResearchFailures = failedJobs.filter((job) => {
    if (addressedSet.has(job.id)) return false;
    return classifyRemoteFailureRecovery(job.errorClass).mode === "reflect";
  });

  if (pendingResearchFailures.length === 0) return null;

  const target = pendingResearchFailures[0];
  return [
    `BLOCKED — ${pendingResearchFailures.length} research failure(s) need reflection before you submit more experiments.`,
    `Call reflect_on_failure for job "${target.id}" first.`,
    "Code errors and operational/resource failures use fix/diagnostic flows instead of this reflection gate.",
  ].join(" ");
}

function processHtml(html: string, url: string): string {
  const isPlainText = url.endsWith(".md") || url.endsWith(".txt") ||
    url.includes("raw.githubusercontent.com");

  let text: string;
  if (isPlainText) {
    text = html;
  } else {
    text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (text.length > 12000) {
    text = text.slice(0, 10000) + "\n\n[...truncated — page is very long...]\n\n" + text.slice(-2000);
  }

  if (text.length < 50) return `Page at ${url} had no readable content.`;
  return `Content from ${url}:\n\n${text}`;
}

function checkProtocolPrimaryMetric(
  metrics: Record<string, number> | null | undefined,
  rawMetrics: Record<string, number> | null | undefined,
  protocol: EvaluationProtocol,
): { ok: boolean; reason?: string } {
  // Defensive fallback: under some Turbopack hot-reload states, newly-added named
  // exports may appear as undefined until a full server restart.
  if (typeof validateResultMetricsAgainstEvaluationProtocol === "function") {
    return validateResultMetricsAgainstEvaluationProtocol(metrics, rawMetrics, protocol);
  }

  const primary = protocol.primaryMetric;
  const inMetrics = !!metrics && Object.prototype.hasOwnProperty.call(metrics, primary);
  const inRaw = !!rawMetrics && Object.prototype.hasOwnProperty.call(rawMetrics, primary);
  if (!inMetrics && !inRaw) {
    return {
      ok: false,
      reason: `Evaluation protocol requires primary metric "${primary}" in metrics (preferred) or raw_metrics.`,
    };
  }
  return { ok: true };
}

// ── Types ────────────────────────────────────────────────────────

export interface AgentEvent {
  type: "text" | "tool_call" | "tool_result" | "tool_progress" | "tool_output" | "step_done" | "thinking" | "error" | "done" | "heartbeat";
  content?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  stepNumber?: number;
  /** Heartbeat metadata — tells client what the server is actually doing */
  activity?: {
    phase: "generating" | "tool_running" | "thinking" | "idle";
    tokens?: number;
    tool?: string;
    stepCount?: number;
    lastEventAgoMs?: number;
  };
}

export interface MockExecutorOptions {
  enabled: boolean;
  mode?: "success" | "failure";
  writeResultFile?: boolean;
}

export interface ResearchAgentRuntimeOptions {
  disableAutoContinue?: boolean;
  mockExecutor?: MockExecutorOptions;
  mockLlmFixtureId?: string;
}

type ResearchTx = Prisma.TransactionClient;

interface RunningAgentState {
  events: AgentEvent[];
  closed: boolean;
  stopRequested: boolean;
  listeners: Set<(event: AgentEvent) => void>;
  startedAt: number;
  activeSessionEpoch: number;
  currentAbortController: AbortController | null;
}

const AGENT_PHASE_ORDER = ["DISCOVERY", "HYPOTHESIS", "EXECUTION", "ANALYSIS", "DECISION"] as const;
const LOW_SIGNAL_SESSION_TOOLS = new Set(["read_file", "list_files", "get_workspace"]);

interface AgentSessionSnapshot {
  status: string;
  phase: string;
  papers: number;
  hypotheses: number;
  claims: number;
  tasks: number;
  remoteJobs: number;
  results: number;
  steps: number;
}

interface AgentSessionStats {
  toolCalls: number;
  lowSignalToolCalls: number;
  toolCallsByName: Map<string, number>;
  toolSignatureCounts: Map<string, number>;
  maxRepeatedLowSignalSignature: number;
}

interface AgentSessionAssessment {
  noDurableProgress: boolean;
  weakStall: boolean;
  strongStall: boolean;
  reason: string;
}

function createAgentSessionStats(): AgentSessionStats {
  return {
    toolCalls: 0,
    lowSignalToolCalls: 0,
    toolCallsByName: new Map(),
    toolSignatureCounts: new Map(),
    maxRepeatedLowSignalSignature: 0,
  };
}

function recordAgentSessionEvent(stats: AgentSessionStats, event: AgentEvent): void {
  if (event.type !== "tool_call" || !event.toolName) return;
  stats.toolCalls += 1;
  stats.toolCallsByName.set(event.toolName, (stats.toolCallsByName.get(event.toolName) || 0) + 1);
  if (!LOW_SIGNAL_SESSION_TOOLS.has(event.toolName)) return;
  stats.lowSignalToolCalls += 1;
  const signature = `${event.toolName}:${JSON.stringify(event.args ?? {})}`;
  const nextCount = (stats.toolSignatureCounts.get(signature) || 0) + 1;
  stats.toolSignatureCounts.set(signature, nextCount);
  if (nextCount > stats.maxRepeatedLowSignalSignature) {
    stats.maxRepeatedLowSignalSignature = nextCount;
  }
}

async function captureAgentSessionSnapshot(projectId: string): Promise<AgentSessionSnapshot> {
  const [
    project,
    papers,
    hypotheses,
    claims,
    tasks,
    remoteJobs,
    results,
    steps,
  ] = await Promise.all([
    prisma.researchProject.findUnique({
      where: { id: projectId },
      select: { status: true, currentPhase: true },
    }),
    prisma.paper.count({
      where: { collections: { some: { collection: { researchProject: { id: projectId } } } } },
    }),
    prisma.researchHypothesis.count({ where: { projectId } }),
    prisma.researchClaim.count({ where: { projectId, status: { not: "RETRACTED" } } }),
    prisma.agentTask.count({ where: { projectId } }),
    prisma.remoteJob.count({ where: { projectId } }),
    prisma.experimentResult.count({ where: { projectId } }),
    prisma.researchStep.count({ where: { iteration: { projectId } } }),
  ]);

  return {
    status: project?.status || "UNKNOWN",
    phase: project?.currentPhase || "DISCOVERY",
    papers,
    hypotheses,
    claims,
    tasks,
    remoteJobs,
    results,
    steps,
  };
}

function phaseOrderIndex(phase: string): number {
  const idx = AGENT_PHASE_ORDER.indexOf(phase as (typeof AGENT_PHASE_ORDER)[number]);
  return idx >= 0 ? idx : -1;
}

function summarizeAgentToolCounts(stats: AgentSessionStats): string {
  const ranked = Array.from(stats.toolCallsByName.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => `${name}=${count}`);
  return ranked.join(", ");
}

function assessAgentSession(
  start: AgentSessionSnapshot,
  end: AgentSessionSnapshot,
  stats: AgentSessionStats,
): AgentSessionAssessment {
  const phaseAdvanced = phaseOrderIndex(end.phase) > phaseOrderIndex(start.phase);
  const noDurableProgress = !phaseAdvanced
    && end.papers <= start.papers
    && end.hypotheses <= start.hypotheses
    && end.claims <= start.claims
    && end.tasks <= start.tasks
    && end.remoteJobs <= start.remoteJobs
    && end.results <= start.results
    && end.steps <= start.steps;

  const lowSignalShare = stats.toolCalls > 0 ? stats.lowSignalToolCalls / stats.toolCalls : 0;
  const strongStall = noDurableProgress
    && stats.toolCalls >= 12
    && stats.lowSignalToolCalls >= 10
    && lowSignalShare >= 0.75
    && stats.maxRepeatedLowSignalSignature >= 5;
  const weakStall = noDurableProgress
    && stats.toolCalls >= 8
    && stats.lowSignalToolCalls >= 6
    && lowSignalShare >= 0.6;

  const progressSummary = phaseAdvanced
    ? `phase advanced ${start.phase} -> ${end.phase}`
    : "no durable project-state change";
  const toolSummary = summarizeAgentToolCounts(stats) || "no tools";
  const reason = `${progressSummary}; tool calls=${stats.toolCalls}; low-signal=${stats.lowSignalToolCalls}; repeated_signature_max=${stats.maxRepeatedLowSignalSignature}; top_tools=${toolSummary}`;

  return {
    noDurableProgress,
    weakStall,
    strongStall,
    reason,
  };
}

async function pauseProjectForAgentStagnation(
  projectId: string,
  sessionNumber: number,
  assessment: AgentSessionAssessment,
): Promise<void> {
  const content = `Agent paused after session ${sessionNumber}: detected repeated low-signal inspection with no durable progress. ${assessment.reason}`;
  await prisma.$transaction(async (tx) => {
    await tx.researchProject.update({
      where: { id: projectId },
      data: { status: "PAUSED" },
    });
    await tx.researchLogEntry.create({
      data: {
        projectId,
        type: "dead_end",
        content: content.slice(0, 1000),
        metadata: JSON.stringify({
          kind: "agent_stagnation_pause",
          sessionNumber,
          assessment: {
            noDurableProgress: assessment.noDurableProgress,
            weakStall: assessment.weakStall,
            strongStall: assessment.strongStall,
            reason: assessment.reason,
          },
        }),
      },
    });
  });
}

class AgentSessionAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSessionAbortError";
  }
}

function isAgentSessionAbort(err: unknown, signal?: AbortSignal): boolean {
  if (err instanceof AgentSessionAbortError) return true;
  if (signal?.aborted && err === signal.reason) return true;
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError"
    || err.name === "AgentSessionAbortError"
    || /session no longer active|session timed out|stop requested/i.test(err.message);
}

function assertAgentSessionActive(
  projectId: string,
  state: RunningAgentState,
  sessionEpoch: number,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new AgentSessionAbortError("Agent session aborted.");
  }
  const current = runningAgents.get(projectId);
  if (!current || current !== state || state.closed || state.activeSessionEpoch !== sessionEpoch) {
    throw new AgentSessionAbortError("Agent session no longer active.");
  }
}

// ── Agent entry point ────────────────────────────────────────────

// Track running agents so we can detect reconnection scenarios
const runningAgents = new Map<string, RunningAgentState>();

/** Check if an agent is currently running for a project */
export function isAgentRunning(projectId: string): boolean {
  const state = runningAgents.get(projectId);
  return !!state && !state.closed;
}

/** Signal a running agent to stop after its current step */
export function requestAgentStop(projectId: string): boolean {
  const state = runningAgents.get(projectId);
  if (state && !state.closed) {
    state.stopRequested = true;
    state.currentAbortController?.abort(new AgentSessionAbortError("Agent stop requested by user."));
    return true;
  }
  return false;
}

/**
 * Start the research agent. The agent runs as a detached background process.
 * Returns an SSE stream that observes the agent's events. If the browser
 * disconnects and reconnects, the new stream picks up from where it left off.
 */
export function startResearchAgent(
  projectId: string,
  userId: string,
  userMessage?: string,
  runtimeOptions?: ResearchAgentRuntimeOptions,
): ReadableStream<Uint8Array> {
  // If agent is already running for this project, return an observer stream
  const existing = runningAgents.get(projectId);
  if (existing && !existing.closed) {
    return createObserverStream(projectId);
  }

  // Create agent state
  const state: RunningAgentState = {
    events: [],
    closed: false,
    stopRequested: false,
    listeners: new Set(),
    startedAt: Date.now(),
    activeSessionEpoch: 0,
    currentAbortController: null,
  };
  runningAgents.set(projectId, state);
  const traceRunId = `${projectId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let traceSessionNumber = 1;
  let traceSequence = 0;
  let traceWriteChain: Promise<void> = Promise.resolve();

  const emit = (event: AgentEvent) => {
    if (state.closed) return;
    state.events.push(event);
    // Fan out to all connected observers
    state.listeners.forEach((listener) => {
      try { listener(event); } catch { /* observer disconnected */ }
    });
  };

  // Heartbeat — keeps observers alive and provides activity metadata
  const activity = {
    phase: "thinking" as "generating" | "tool_running" | "thinking" | "idle",
    tokens: 0,
    tool: undefined as string | undefined,
    stepCount: 0,
    lastEventAt: Date.now(),
  };

  const origEmit = emit;
  const trackedEmit = (event: AgentEvent) => {
    activity.lastEventAt = Date.now();
    if (event.type === "text") {
      activity.phase = "generating";
      activity.tokens += (event.content || "").length;
    } else if (event.type === "tool_call") {
      activity.phase = "tool_running";
      activity.tool = event.toolName;
    } else if (event.type === "tool_result") {
      activity.phase = "thinking";
      activity.tool = undefined;
    } else if (event.type === "step_done") {
      activity.stepCount = event.stepNumber || activity.stepCount + 1;
      activity.phase = "thinking";
    } else if (event.type === "thinking") {
      activity.phase = "thinking";
    }
    origEmit(event);
    if (shouldPersistAgentTraceEvent(event)) {
      const sequence = ++traceSequence;
      traceWriteChain = traceWriteChain
        .then(() =>
          appendAgentTraceEvent({
            projectId,
            runId: traceRunId,
            sessionNumber: traceSessionNumber,
            sequence,
            event,
          }),
        )
        .catch((err) => {
          console.warn("[agent-trace] Persist failed:", err instanceof Error ? err.message : String(err));
        });
    }
  };

  const heartbeat = setInterval(() => {
    if (state.closed) { clearInterval(heartbeat); return; }
    origEmit({
      type: "heartbeat",
      activity: {
        phase: activity.phase,
        tokens: activity.tokens,
        tool: activity.tool,
        stepCount: activity.stepCount,
        lastEventAgoMs: Date.now() - activity.lastEventAt,
      },
    });
  }, 8_000);

  // Run agent in background — completely decoupled from the SSE stream
  // Server-side auto-continue: when the 80-step session ends, restart automatically
  // if the project is still ACTIVE. This means the agent keeps running even if
  // the browser navigates away or the client disconnects.
  console.log(`[research-agent] Starting background agent for project ${projectId}`);
  const runWithAutoContinue = async () => {
    let sessionCount = 0;
    const MAX_SESSIONS = runtimeOptions?.disableAutoContinue ? 1 : 20; // Safety limit to prevent infinite loops

    let consecutiveErrors = 0;
    let consecutiveWeakStalls = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per session
    const SESSION_ABORT_GRACE_MS = 15_000;

    while (sessionCount < MAX_SESSIONS) {
      sessionCount++;
      traceSessionNumber = sessionCount;
      const sessionEpoch = state.activeSessionEpoch + 1;
      state.activeSessionEpoch = sessionEpoch;
      const sessionAbortController = new AbortController();
      state.currentAbortController = sessionAbortController;
      const sessionStats = createAgentSessionStats();
      let sessionBaseline: AgentSessionSnapshot | null = null;
      const sessionEmit = (event: AgentEvent) => {
        if (state.closed) return;
        if (state.activeSessionEpoch !== sessionEpoch) return;
        if (sessionAbortController.signal.aborted) return;
        recordAgentSessionEvent(sessionStats, event);
        trackedEmit(event);
      };
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const runPromise = runAgent(
        projectId,
        userId,
        sessionCount === 1 ? (userMessage || null) : null,
        sessionEmit,
        runtimeOptions,
        {
          state,
          sessionEpoch,
          signal: sessionAbortController.signal,
          setSessionBaseline: (snapshot) => {
            sessionBaseline = snapshot;
          },
        },
      ).then(() => "completed" as const).catch((err) => {
        if (isAgentSessionAbort(err, sessionAbortController.signal)) {
          return "aborted" as const;
        }
        throw err;
      });

      try {
        // FSM: evaluate transitions at session start so the agent begins in the right state
        if (sessionCount === 1) {
          let startTransitions = 0;
          while (startTransitions < 4) {
            const t = await attemptAutoTransition(projectId).catch(() => null);
            if (!t) break;
            startTransitions++;
            trackedEmit({ type: "text", content: `\n[FSM: ${t.from} -> ${t.to}]\n` });
          }
        }
        console.log(`[research-agent] Session ${sessionCount} starting for project ${projectId}`);

        // Race the agent against a timeout — prevents hung sessions from blocking forever
        const sessionResult = await Promise.race([
          runPromise,
          new Promise<"timeout">((resolve) =>
            timeoutHandle = setTimeout(() => {
              sessionAbortController.abort(new AgentSessionAbortError(`Session timed out after ${SESSION_TIMEOUT_MS / 60000} minutes.`));
              resolve("timeout");
            }, SESSION_TIMEOUT_MS)
          ),
        ]);

        if (sessionResult === "timeout") {
          console.warn(`[research-agent] Session ${sessionCount} timed out after ${SESSION_TIMEOUT_MS / 60000}min for project ${projectId}`);
          trackedEmit({ type: "error", content: `Session timed out after ${SESSION_TIMEOUT_MS / 60000} minutes. Auto-continuing with fresh session...` });
          state.activeSessionEpoch = 0;
          state.currentAbortController = null;
          const settled = await Promise.race([
            runPromise.then(() => true).catch(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SESSION_ABORT_GRACE_MS)),
          ]);
          if (!settled) {
            const message = "Timed-out session did not shut down cleanly. Stopping to avoid concurrent sessions on the same project.";
            console.error(`[research-agent] ${message} project=${projectId} session=${sessionCount}`);
            trackedEmit({ type: "error", content: message });
            break;
          }
          continue;
        }

        if (sessionResult === "aborted") {
          if (state.stopRequested) {
            console.log(`[research-agent] Session ${sessionCount} aborted by user for project ${projectId}`);
            trackedEmit({ type: "done", content: "Agent stopped by user." });
            break;
          }
          const message = `Session ${sessionCount} aborted before completion. Stopping to avoid concurrent sessions.`;
          console.warn(`[research-agent] ${message} project=${projectId}`);
          trackedEmit({ type: "error", content: message });
          break;
        }

        console.log(`[research-agent] Session ${sessionCount} completed for project ${projectId}`);
        consecutiveErrors = 0;
        if (sessionBaseline) {
          const sessionEnd = await captureAgentSessionSnapshot(projectId);
          const assessment = assessAgentSession(sessionBaseline, sessionEnd, sessionStats);

          if (assessment.strongStall) {
            const message = `Agent paused: detected a repeated no-progress inspection loop in session ${sessionCount}. ${assessment.reason}`;
            console.warn(`[research-agent] ${message} project=${projectId}`);
            await pauseProjectForAgentStagnation(projectId, sessionCount, assessment);
            trackedEmit({ type: "error", content: message });
            trackedEmit({ type: "done", content: "Agent paused to avoid repeating a no-progress loop." });
            break;
          }

          if (assessment.weakStall) {
            consecutiveWeakStalls += 1;
            if (consecutiveWeakStalls >= 2) {
              const message = `Agent paused: two consecutive sessions made no durable progress and were dominated by low-signal inspection. ${assessment.reason}`;
              console.warn(`[research-agent] ${message} project=${projectId}`);
              await pauseProjectForAgentStagnation(projectId, sessionCount, assessment);
              trackedEmit({ type: "error", content: message });
              trackedEmit({ type: "done", content: "Agent paused to avoid repeating a no-progress loop." });
              break;
            }
          } else {
            consecutiveWeakStalls = 0;
          }
        } else {
          consecutiveWeakStalls = 0;
        }
      } catch (err) {
        consecutiveErrors++;
        const msg = err instanceof Error ? err.message : "Agent error";
        console.error(`[research-agent] Error in session ${sessionCount} for project ${projectId} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, msg);
        trackedEmit({ type: "error", content: msg });

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(`[research-agent] ${MAX_CONSECUTIVE_ERRORS} consecutive errors for project ${projectId}, stopping`);
          break;
        }

        // Wait before retrying — backoff
        trackedEmit({ type: "text", content: `\n\n[Error: ${msg}. Retrying in 10s...]` });
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (state.activeSessionEpoch === sessionEpoch) {
          state.activeSessionEpoch = 0;
        }
        if (state.currentAbortController === sessionAbortController) {
          state.currentAbortController = null;
        }
      }

      // Check if user requested stop or project is no longer ACTIVE
      if (state.stopRequested) {
        console.log(`[research-agent] Stop requested by user for project ${projectId}`);
        trackedEmit({ type: "done", content: "Agent stopped by user." });
        break;
      }

      if (runtimeOptions?.disableAutoContinue) {
        break;
      }

      const project = await prisma.researchProject.findUnique({
        where: { id: projectId },
        select: { status: true },
      });
      if (!project || project.status !== "ACTIVE") {
        console.log(`[research-agent] Project ${projectId} no longer ACTIVE (${project?.status}), stopping`);
        break;
      }

      // FSM: evaluate auto-transitions BETWEEN sessions, not during.
      // This is the only place auto-transitions fire. The agent works uninterrupted
      // within a session; the FSM advances the project state between sessions.
      let transitionChainCount = 0;
      while (transitionChainCount < 4) {
        const transition = await attemptAutoTransition(projectId).catch(() => null);
        if (!transition) break;
        transitionChainCount++;
        trackedEmit({ type: "text", content: `\n[FSM: ${transition.from} -> ${transition.to}]\n` });
        console.log(`[research-agent] FSM transition: ${transition.from} -> ${transition.to} for project ${projectId}`);
      }

      trackedEmit({ type: "done", content: `Session ${sessionCount} complete. Auto-continuing...` });
      // Brief pause between sessions
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    trackedEmit({ type: "done", content: "Agent finished." });
  };

  runWithAutoContinue().finally(async () => {
    await traceWriteChain.catch(() => {});
    clearInterval(heartbeat);
    state.closed = true;
    // Clean up after a delay (allow reconnections to see final events)
    setTimeout(() => runningAgents.delete(projectId), 30_000);
  });

  // Return an observer stream for the initial caller
  return createObserverStream(projectId);
}

/** Create a read-only SSE stream that observes an agent's events */
function createObserverStream(projectId: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let listenerRef: ((event: AgentEvent) => void) | null = null;

  return new ReadableStream({
    start(controller) {
      const state = runningAgents.get(projectId);
      if (!state) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", content: "No agent running." })}\n\n`));
        controller.close();
        return;
      }

      let closed = false;
      const encode = (event: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
          state.listeners.delete(encode);
          listenerRef = null;
        }
      };
      listenerRef = encode;

      // Replay recent events only (avoid flooding on reconnect — last 50 events)
      const replayStart = Math.max(0, state.events.length - 50);
      for (let i = replayStart; i < state.events.length; i++) {
        if (closed) break;
        encode(state.events[i]);
      }

      // If agent already finished, close the stream
      if (state.closed) {
        try { controller.close(); } catch { /* ok */ }
        return;
      }

      // Subscribe to live events
      state.listeners.add(encode);
    },
    cancel() {
      // Observer disconnected — clean up listener, agent continues in background
      if (listenerRef) {
        const state = runningAgents.get(projectId);
        if (state) state.listeners.delete(listenerRef);
        listenerRef = null;
      }
    },
  });
}

// ── Core agent loop ──────────────────────────────────────────────

async function runAgent(
  projectId: string,
  userId: string,
  userMessage: string | null,
  emit: (e: AgentEvent) => void,
  runtimeOptions?: ResearchAgentRuntimeOptions,
  sessionControl?: {
    state: RunningAgentState;
    sessionEpoch: number;
    signal: AbortSignal;
    setSessionBaseline?: (snapshot: AgentSessionSnapshot) => void;
  },
) {
  const assertSessionActive = () => {
    if (!sessionControl) return;
    assertAgentSessionActive(projectId, sessionControl.state, sessionControl.sessionEpoch, sessionControl.signal);
  };

  assertSessionActive();

  // 1. Load project context
  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    include: {
      collection: { include: { papers: { include: { paper: true }, take: 30 } } },
      hypotheses: true,
      log: { orderBy: { createdAt: "desc" }, take: 30, select: { type: true, content: true, metadata: true } },
      iterations: { orderBy: { number: "desc" }, take: 1, include: { steps: true } },
    },
  });
  if (!project) throw new Error("Project not found");
  assertSessionActive();

  // Load oracle hints separately (they may not be in the last 30 log entries)
  const oracleHintEntries = await prisma.researchLogEntry.findMany({
    where: { projectId, metadata: { contains: "oracleHint" } },
    select: { type: true, content: true, metadata: true },
  });
  // Inject into project.log so buildMessages can find them
  for (const hint of oracleHintEntries) {
    if (!project.log.some((l) => l.content === hint.content)) {
      project.log.push(hint);
    }
  }

  // 2. Set up working directory (slug + short project ID to avoid collisions)
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const shortId = projectId.slice(0, 8);
  const workDir = project.outputFolder || path.join(process.cwd(), "output", "research", `${slug}-${shortId}`);
  await mkdir(workDir, { recursive: true });
  assertSessionActive();

  // Persist workDir so API endpoints (log-file, files) can find it
  if (!project.outputFolder) {
    await prisma.researchProject.update({
      where: { id: projectId },
      data: { outputFolder: workDir },
    });
  }
  assertSessionActive();

  // 2b. Recover sub-agent tasks from previous sessions
  if ((prisma as unknown as Record<string, unknown>).agentTask) {
    const zombieThreshold = new Date(Date.now() - 15 * 60 * 1000); // 15min

    // Old zombies (>15min): mark failed
    await prisma.agentTask.updateMany({
      where: {
        projectId,
        status: { in: ["RUNNING", "PENDING"] },
        createdAt: { lt: zombieThreshold },
      },
      data: {
        status: "FAILED",
        error: "Zombie: process died before completion (cleaned up on agent restart)",
        completedAt: new Date(),
      },
    });

    // Recent tasks (<15min) still PENDING or RUNNING: re-launch them
    // These were likely killed by a process restart mid-flight
    const recentOrphans = await prisma.agentTask.findMany({
      where: {
        projectId,
        status: { in: ["RUNNING", "PENDING"] },
        createdAt: { gte: zombieThreshold },
      },
    });
    if (recentOrphans.length > 0) {
      console.log(`[agent] Re-launching ${recentOrphans.length} orphaned sub-agent tasks from previous session`);
      for (const orphan of recentOrphans) {
        // Reset to PENDING so runSubAgent picks it up fresh
        await prisma.agentTask.update({
          where: { id: orphan.id },
          data: { status: "PENDING" },
        });
        void launchSubAgentTask(orphan.id, "agent-orphan-relaunch").catch((err) => {
          console.error(`[agent] Re-launched task ${orphan.id} (${orphan.role}) failed:`, err);
        });
      }
    }
  }
  assertSessionActive();

  // 3. Ensure an active iteration exists
  let iteration = project.iterations[0];
  if (!iteration || iteration.status !== "ACTIVE") {
    iteration = await prisma.researchIteration.create({
      data: {
        projectId,
        number: (iteration?.number || 0) + 1,
        goal: userMessage || "Initial research",
        status: "ACTIVE",
      },
      include: { steps: true },
    });
  }
  assertSessionActive();
  let iterationId = iteration.id;
  let iterationNumber = iteration.number;

  // 3b. Count existing experiments for sequential numbering
  const existingExpSteps = await prisma.researchStep.count({
    where: {
      iteration: { projectId },
      type: "generate_code",
    },
  });
  const experimentCounter = existingExpSteps;
  sessionControl?.setSessionBaseline?.(await captureAgentSessionSnapshot(projectId));

  // 4. Detect remote hosts and probe GPUs (filtered by user resource preferences)
  let resourceSetting: "all" | "local" | string[] = "all";
  let bannedPapers: { title: string; doi?: string | null; arxivId?: string | null }[] = [];
  try {
    const briefParsed = JSON.parse(project.brief);
    if (briefParsed.resources) resourceSetting = briefParsed.resources;
    if (Array.isArray(briefParsed.bannedPapers)) bannedPapers = briefParsed.bannedPapers;
  } catch { /* plain text brief */ }

  const allowSyntheticRemoteHosts = !!runtimeOptions?.mockLlmFixtureId || !!runtimeOptions?.mockExecutor?.enabled;
  const allRemoteHosts = resourceSetting === "local"
    ? []
    : await listDefaultResearchHosts({ take: 5, includeSynthetic: allowSyntheticRemoteHosts });
  const remoteHosts = resourceSetting === "all" || resourceSetting === "local"
    ? allRemoteHosts
    : allRemoteHosts.filter((h) => (resourceSetting as string[]).includes(h.id));

  const skipExternalGpuProbes = !!runtimeOptions?.mockLlmFixtureId || !!runtimeOptions?.mockExecutor?.enabled;
  const gpuInfo = skipExternalGpuProbes
    ? []
    : (await Promise.all(
        remoteHosts.map((h) => probeGpus(h.id).catch(() => null))
      )).filter(Boolean) as NonNullable<Awaited<ReturnType<typeof probeGpus>>>[];

  emit({
    type: "tool_progress",
    toolName: "system",
    content: skipExternalGpuProbes
      ? "Skipping GPU probe in deterministic test mode."
      : gpuInfo.length > 0
        ? `Detected GPUs: ${gpuInfo.map((g) => g.summary).join("; ")}`
        : "No GPU info available",
  });

  // 4b. Load user-defined agent capabilities (defensive — model may not exist if server hasn't restarted after migration)
  let capabilities: { name: string; description: string; instructions: string }[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- model may not exist if migration hasn't run
    capabilities = await (prisma as any).agentCapability.findMany({
      where: { userId, enabled: true },
      select: { name: true, description: true, instructions: true },
    });
  } catch (err) {
    console.warn("[research-agent] Could not load agent capabilities (restart dev server after schema change):", (err as Error).message);
  }

  // 4c. Scan shared utilities directory
  const sharedDir = path.join(process.cwd(), "output", "shared");
  await mkdir(sharedDir, { recursive: true });
  const sharedUtilities: { filename: string; description: string }[] = [];
  try {
    const files = await readdir(sharedDir);
    for (const f of files) {
      if (!f.endsWith(".py")) continue;
      // Read first docstring or comment line as description
      const content = await readFile(path.join(sharedDir, f), "utf-8");
      const docMatch = content.match(/^"""([\s\S]*?)"""/m) || content.match(/^# (.+)/m);
      const desc = docMatch ? docMatch[1].trim().split("\n")[0] : "";
      sharedUtilities.push({ filename: f, description: desc });
    }
  } catch {
    // Directory may not exist yet
  }

  // 5. Read persistent research log (user-editable file)
  const researchLogPath = path.join(workDir, "RESEARCH_LOG.md");
  let researchLog = "";
  try {
    researchLog = await readFile(researchLogPath, "utf-8");
  } catch {
    // First run — create initial file
    const initial = `# Research Log: ${project.title}\n\n*This file is maintained by the research agent and you. Edit it to guide the agent — add notes, papers to consult, directions to explore. The agent reads this at the start of every session.*\n\n---\n\n`;
    await writeFile(researchLogPath, initial, "utf-8");
    researchLog = initial;
  }

  // Check if this is a benchmark project — benchmarks get NO process memories and NO mind palace
  const isBenchmarkProject = bannedPapers.length > 0;

  // 5b. Load process memories (practical learnings from previous experiments)
  // SKIP for benchmarks — they must start with zero prior knowledge
  let processMemories: { id: string; category: string; lesson: string; context: string | null }[] = [];
  if (!isBenchmarkProject) {
    try {
      processMemories = await prisma.agentMemory.findMany({
        where: { userId },
        select: { id: true, category: true, lesson: true, context: true },
        orderBy: { usageCount: "desc" },
        take: 50,
      });
      if (processMemories.length > 0) {
        await prisma.agentMemory.updateMany({
          where: { id: { in: processMemories.map((m) => m.id) } },
          data: { usageCount: { increment: 1 } },
        });
      }
    } catch (err) {
      console.warn("[research-agent] Could not load process memories:", (err as Error).message);
    }
  } else {
    console.log(`[research-agent] Benchmark mode — skipping process memories and Mind Palace`);
  }

  // 5c. Load resource preferences
  let resourcePreferences: { taskCategory: string; preference: string; usageCount: number }[] = [];
  try {
    resourcePreferences = await getAllResourcePreferences(userId);
  } catch (err) {
    console.warn("[research-agent] Could not load resource preferences:", (err as Error).message);
  }

  // 6. Build context
  const papers = project.collection?.papers.map((cp) => cp.paper) || [];
  let systemPrompt = buildSystemPrompt(project, papers, workDir, remoteHosts, resourceSetting, capabilities, gpuInfo, processMemories, resourcePreferences, sharedUtilities, sharedDir);

  // Non-Claude models: replace the massive system prompt with a condensed version
  // The full prompt is ~18K tokens — too much for GPT models to process effectively
  const { provider: modelProvider } = await getModelForTier("reasoning");
  if (!modelProvider.includes("anthropic") && !systemPrompt.includes("[CONDENSED]")) {
    const phase = project.currentPhase || "DISCOVERY";
    const hostInfo = remoteHosts.length > 0
      ? `Remote hosts: ${remoteHosts.map(h => `${h.alias}${h.gpuType ? ` (${h.gpuType})` : ""}`).join(", ")}`
      : "No remote hosts configured — run_experiment handles local execution automatically.";
    systemPrompt = `[CONDENSED] You are an autonomous research agent investigating: "${project.title}".

## How You Work
You operate in a phase-aware system. Current phase: **${phase}**.
The system manages state transitions automatically. \`run_experiment\` / \`execute_remote\` will compute submission readiness and auto-advance when the structural prerequisites are already satisfied.

**Phases:** DISCOVERY → HYPOTHESIS → EXECUTION → ANALYSIS → DECISION
- DISCOVERY: Search papers (search_papers, dispatch_scouts), read them (read_paper), synthesize (dispatch_synthesizer)
- HYPOTHESIS: Formulate hypotheses (log_finding type="hypothesis"), define canonical metrics (define_metrics), get architecture proposals (dispatch_architect), write mechanism design (log_finding type="decision")
- EXECUTION: Write scripts (write_file), delete stale ones (delete_file), run them (execute_remote), diagnose hosts (diagnose_remote_host, validate_environment), monitor/cancel jobs (check_job, cancel_job)
- ANALYSIS: Record results (record_result with canonical metrics + raw_metrics), reflect on research failures (reflect_on_failure), review (dispatch_reviewer, dispatch_reproducer, adversarial_review), update hypotheses (update_hypothesis)
- DECISION: Complete iteration (complete_iteration)

## Rules
1. ALWAYS call tools to make progress. Do NOT just describe what you'll do — DO it.
2. After EVERY completed experiment: call record_result with metrics.
3. After RESEARCH_FAILURE jobs: call reflect_on_failure before changing scientific direction. For CODE_ERROR fix the script; for RESOURCE_ERROR diagnose the host/environment.
4. Use register_approach to track research directions.
5. Script naming: poc_NNN_name.py, exp_NNN_name.py, analysis_NNN_name.py, sweep_NNN_name.py
6. exp_ scripts must be linked to a hypothesis before submission. Pass hypothesis_id when multiple live hypotheses exist; otherwise Arcana auto-attaches the single live hypothesis.

## Environment
Working directory: ${workDir}
${hostInfo}

## Research State
Check RESEARCH_STATE.md (read_file) for current hypotheses, approach tree, and results.
Check RESEARCH_LOG.md for the detailed research narrative.
`;
  }

  // Generate structured research state for context injection
  let researchState = "";
  try {
    const { getResearchStateForContext } = await import("./research-state");
    researchState = await getResearchStateForContext(projectId, workDir);
  } catch {}

  const messages = buildMessages(project, papers, userMessage, researchLog, researchState);

  // 6. Resolve model configuration. In fixture mode we skip live model instantiation.
  const { provider, modelId, proxyConfig } = await getModelForTier("reasoning");
  const usingFixture = !!runtimeOptions?.mockLlmFixtureId;
  let model: Parameters<typeof streamText>[0]["model"] | undefined;
  if (!usingFixture) {
    model = await getToolLoopModel(provider, modelId, proxyConfig);
    setLlmContext("research-agent", userId, { projectId });
  }

  // Helper: create a ResearchStep and advance project phase
  const recordStepPhaseOrder = ["DISCOVERY", "HYPOTHESIS", "EXECUTION", "ANALYSIS", "DECISION"];
  // Legacy advanceProjectPhaseTx removed — FSM transition engine owns all state changes.
  // The phase hint in recordStep is now purely informational metadata, not a state transition trigger.

  const recordStepTx = async (
    tx: ResearchTx,
    type: string,
    title: string,
    status: "COMPLETED" | "FAILED",
    output: unknown,
    phase?: string,
  ) => {
    assertSessionActive();
    const existing = await tx.researchStep.findFirst({
      where: { iterationId, type, title },
      orderBy: { sortOrder: "desc" },
    });
    if (existing) {
      await tx.researchStep.update({
        where: { id: existing.id },
        data: {
          status,
          output: typeof output === "string" ? output : JSON.stringify(output),
          completedAt: new Date(),
        },
      });
    } else {
      const sortOrder = await reserveNextResearchStepSortOrder(tx, iterationId);
      await tx.researchStep.create({
        data: {
          iterationId,
          type,
          title,
          status,
          output: typeof output === "string" ? output : JSON.stringify(output),
          sortOrder,
          completedAt: new Date(),
        },
      });
    }
    // Phase hint is metadata only — FSM transition engine handles state changes via attemptAutoTransition()
  };

  const recordStep = async (
    type: string,
    title: string,
    status: "COMPLETED" | "FAILED",
    output: unknown,
    phase?: string,
  ) => {
    await prisma.$transaction(async (tx) => {
      await recordStepTx(tx, type, title, status, output, phase);
    });
  };

  // 7. Create tools
  const onIterationAdvance = (newId: string, newNumber: number) => {
    iterationId = newId;
    iterationNumber = newNumber;
  };
  const expCounter = { value: experimentCounter };
  const searchCounter = { value: 0 };
  const rawTools = createTools(
    projectId,
    userId,
    workDir,
    emit,
    remoteHosts,
    recordStep,
    recordStepTx,
    { id: iterationId, number: iteration.number },
    sharedDir,
    onIterationAdvance,
    model,
    expCounter,
    searchCounter,
    gpuInfo?.map((g) => ({ alias: g.alias, gpuCount: g.gpuCount })),
    bannedPapers,
    isBenchmarkProject,
    runtimeOptions?.mockExecutor,
    sessionControl ? { signal: sessionControl.signal, assertActive: assertSessionActive } : undefined,
  );

  // Wrap every tool's execute to sanitize return values — prevents invalid Unicode
  // surrogates from entering the LLM message history and causing API errors.
  const tools = Object.fromEntries(
    Object.entries(rawTools).map(([name, t]) => {
      const orig = t as { execute?: (...args: unknown[]) => Promise<unknown> };
      if (!orig.execute) return [name, t];
      return [name, {
        ...t,
        execute: async (...args: unknown[]) => {
          assertSessionActive();
          const result = await orig.execute!(...args);
          assertSessionActive();
          if (typeof result === "string") return sanitizeForJson(result);
          return result;
        },
      }];
    })
  ) as typeof rawTools;

  // FSM: dynamically filter tools based on current state.
  // Re-evaluates on every call because auto-transitions can change state mid-session.
  const getFilteredTools = async () => {
    const proj = await prisma.researchProject.findUnique({
      where: { id: projectId },
      select: { currentPhase: true },
    });
    const state = (proj?.currentPhase || "DISCOVERY") as ProjectState;
    const allowed = new Set(getToolsForState(state));
    return Object.fromEntries(
      Object.entries(tools).filter(([name]) => allowed.has(name))
    ) as typeof tools;
  };
  let fsmFilteredTools = await getFilteredTools();

  // Deterministic test mode: replay a fixed tool-call fixture instead of live LLM generation.
  if (runtimeOptions?.mockLlmFixtureId) {
    const fixture = getAgentTestFixture(runtimeOptions.mockLlmFixtureId);
    if (!fixture) {
      throw new Error(
        `Unknown mock_llm_fixture "${runtimeOptions.mockLlmFixtureId}". ` +
        `Available: ${listAgentTestFixtureIds().join(", ") || "(none)"}`,
      );
    }

    emit({
      type: "text",
      content: `[Fixture mode] Running "${fixture.id}" — ${fixture.description}`,
    });

    let fixtureStep = 0;
    for (const step of fixture.steps) {
      fixtureStep += 1;
      if (step.note) {
        emit({ type: "text", content: step.note });
      }

      for (const call of step.calls) {
        const maybeTool = (tools as Record<string, { execute?: (input: unknown) => Promise<unknown> }>)[call.tool];
        if (!maybeTool?.execute) {
          throw new Error(`Fixture "${fixture.id}" references unknown tool "${call.tool}".`);
        }

        emit({ type: "tool_call", toolName: call.tool, args: call.input });
        const output = await maybeTool.execute(call.input);
        const outputText = typeof output === "string" ? output : JSON.stringify(output);
        const safeOutput = sanitizeForJson(outputText).slice(0, 2000);
        emit({ type: "tool_result", toolName: call.tool, result: safeOutput });

        await prisma.researchLogEntry.create({
          data: {
            projectId,
            type: "agent_suggestion",
            content: `[${call.tool}] ${JSON.stringify(call.input).slice(0, 300)}`,
            metadata: JSON.stringify({ step: fixtureStep, fixture: fixture.id, tool: call.tool }),
          },
        }).catch(() => {});

        if (call.expectContains && call.expectContains.length > 0) {
          for (const expected of call.expectContains) {
            if (!outputText.includes(expected)) {
              throw new Error(
                `Fixture "${fixture.id}" expected output of "${call.tool}" to include "${expected}", ` +
                `but got: ${outputText.slice(0, 300)}`,
              );
            }
          }
        }
      }

      emit({ type: "step_done", stepNumber: fixtureStep });
      emit({
        type: "thinking",
        content: thinkingHint(step.calls.map((c) => ({ toolName: c.tool, input: c.input }))),
      });
    }

    await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "observation",
        content: `Fixture session completed (${fixtureStep} steps): ${fixture.id}`,
      },
    }).catch(() => {});

    emit({ type: "text", content: `[Fixture mode] Completed "${fixture.id}".` });
    return;
  }

  // 6. Stream with tool use
  const MAX_STEPS = 80;
  let stepCount = 0;
  const emittedHints = new Set<string>();

  // Track tool usage for nudges
  let totalExperimentsRun = 0;
  let totalPaperConsultations = 0;
  const LIT_TOOLS = new Set(["search_papers", "read_paper", "search_library", "query_insights"]);
  const EXPERIMENT_TOOLS = new Set(["execute_remote", "run_experiment"]);
  let iterationNudged = false;
  const iterationStepsAtStart = iteration.steps?.length || 0; // total steps already in this iteration

  // Step budget tracking
  const stepBudget = {
    literature: 0,
    design: 0,
    experiment: 0,
    analysis: 0,
    infraDebug: 0,
  };

  emit({ type: "thinking", content: "Analyzing project state and planning next steps..." });

  // Non-Claude models (GPT, etc.) emit text after each tool call, causing
  // the SDK loop to stop after 1 step. We handle this with an outer retry loop.
  const isNonClaude = !modelId.includes("claude");
  // For non-Claude: track if the last step had tool calls (= more work to do)
  let lastStepHadToolCalls = false;

  // Non-Claude models struggle with 40+ tools. Reduce to essential set for the current phase.
  if (isNonClaude) {
    const ESSENTIAL_TOOLS = new Set([
      // Phase management
      "register_approach", "define_metrics", "record_result", "reflect_on_failure",
      "query_results", "view_approach_tree", "record_claim", "attach_claim_evidence", "review_claim",
      "promote_claim_to_memory", "show_claim_ledger",
      // Literature
      "search_papers", "read_paper", "search_library",
      // Hypotheses & findings
      "log_finding", "update_hypothesis", "adversarial_review",
      // Experiment
      "write_file", "delete_file", "run_experiment", "execute_remote", "check_job", "cancel_job", "wait_for_jobs", "validate_environment", "diagnose_remote_host",
      // File management
      "read_file", "list_files", "get_workspace",
      // Sub-agents
      "dispatch_scouts", "dispatch_synthesizer", "dispatch_architect",
      "dispatch_reviewer", "dispatch_reproducer", "collect_results",
      // Iteration
      "complete_iteration",
      // Misc
      "web_search", "request_help",
    ]);
    for (const key of Object.keys(fsmFilteredTools)) {
      if (!ESSENTIAL_TOOLS.has(key)) {
        delete (fsmFilteredTools as Record<string, unknown>)[key];
      }
    }
    console.log(`[agent] Non-Claude model: reduced tools from 43 to ${Object.keys(fsmFilteredTools).length}`);
  }

  if (!model) throw new Error("Model unavailable in live-agent mode.");

  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools: fsmFilteredTools,
    abortSignal: sessionControl?.signal,
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: async ({ text, toolCalls }) => {
      assertSessionActive();
      lastStepHadToolCalls = (toolCalls || []).length > 0;
      stepCount++;

      // Track tool usage patterns for nudges
      let hasNonSearch = false;
      for (const tc of toolCalls || []) {
        if (LIT_TOOLS.has(tc.toolName)) {
          totalPaperConsultations++;
        }
        if (EXPERIMENT_TOOLS.has(tc.toolName)) {
          totalExperimentsRun++;
        }
        if (tc.toolName !== "search_papers") hasNonSearch = true;
      }
      // Reset consecutive search counter when agent does something else
      if (hasNonSearch || (toolCalls || []).length === 0) {
        searchCounter.value = 0;
      }

      // Persist full agent reasoning to research log for inspection
      if (text && text.length > 10) {
        await prisma.researchLogEntry.create({
          data: {
            projectId,
            type: "agent_reasoning",
            content: text,
            metadata: JSON.stringify({ step: stepCount, charCount: text.length }),
          },
        }).catch(() => {});
      }

      for (const tc of toolCalls || []) {
        const inputJson = JSON.stringify(tc.input);
        await prisma.researchLogEntry.create({
          data: {
            projectId,
            type: "agent_tool_call",
            content: `[${tc.toolName}] ${inputJson}`,
            metadata: JSON.stringify({ step: stepCount, tool: tc.toolName, inputSize: inputJson.length }),
          },
        }).catch(() => {});
      }

      // Write full trace to AGENT_TRACE.jsonl for post-hoc inspection
      const traceEntry = {
        step: stepCount,
        timestamp: new Date().toISOString(),
        reasoning: text || null,
        toolCalls: (toolCalls || []).map((tc) => ({
          tool: tc.toolName,
          input: tc.input,
        })),
      };
      appendFile(
        path.join(workDir, "AGENT_TRACE.jsonl"),
        JSON.stringify(traceEntry) + "\n",
      ).catch(() => {});

      emit({ type: "step_done", stepNumber: stepCount });

      // FSM auto-transitions are evaluated at SESSION BOUNDARIES only (see runWithAutoContinue).
      // Mid-session transitions caused rapid EXECUTION->ANALYSIS->DECISION->DESIGN->EXECUTION loops
      // that prevented the agent from staying in a state long enough to do real work.

      // ── Behavioral validator: check agent actions against state expectations ──
      {
        const currentProj = await prisma.researchProject.findUnique({
          where: { id: projectId },
          select: { currentPhase: true },
        }).catch(() => null);
        const currentState = (currentProj?.currentPhase || "DISCOVERY") as ProjectState;
        const toolNames = (toolCalls || []).map((tc) => tc.toolName);
        const validation = validateStep(currentState, toolNames, stepCount);

        for (const v of validation.violations) {
          const msg = `[Validator ${v.severity.toUpperCase()}] ${v.message}`;
          console.warn(msg);
          // Inject corrective message to the agent for errors
          if (v.severity === "error") {
            emit({ type: "text", content: `\n\n[System: ${v.message}]\n\n` });
          }
          // Log to DB for post-hoc analysis
          await prisma.researchLogEntry.create({
            data: {
              projectId,
              type: "fsm_transition",
              content: msg,
              metadata: JSON.stringify({ kind: "validator_violation", severity: v.severity, tool: v.tool, state: currentState, step: stepCount }),
            },
          }).catch(() => {});
        }

        if (validation.stagnationWarning) {
          emit({ type: "text", content: `\n\n[System: ${validation.stagnationWarning}]\n\n` });
        }
      }

      // Internal nudges — logged for debugging but NOT emitted to the user's console.
      // These are already covered by the system prompt; emitting them leaked prompt text to the UI.
      const remaining = MAX_STEPS - stepCount;
      if (remaining === 10 || remaining === 3) {
        // Budget reminders — only log, agent already knows from system prompt
        console.log(`[agent] Step budget: ${remaining} steps remaining (step ${stepCount}/${MAX_STEPS})`);
      }
      // Replan nudge every 20 steps
      if (stepCount % 20 === 0 && stepCount > 0) {
        emit({ type: "text", content: "\n\n[System: You've completed 20 steps since your last plan. Write an updated plan to RESEARCH_LOG.md before continuing.]\n\n" });
      }

      // Check for new oracle hints every step
      try {
        const newHints = await prisma.researchLogEntry.findMany({
          where: { projectId, metadata: { contains: '"oracleHint":true' } },
          select: { content: true },
          orderBy: { createdAt: "desc" },
          take: 3,
        });
        for (const hint of newHints) {
          if (!emittedHints.has(hint.content)) {
            emittedHints.add(hint.content);
            emit({ type: "text", content: `\n\n⚡ **ORACLE HINT (from expert — follow immediately):**\n${hint.content}\n\n**REPLAN NOW** to incorporate this hint.\n\n` });
          }
        }
      } catch { /* non-critical */ }

      // Mandatory sub-agent dispatch reminders
      if (totalExperimentsRun > 0 && totalExperimentsRun % 2 === 0 && stepCount > 5) {
        emit({ type: "text", content: "\n\n[System: You've completed 2+ experiments without an adversarial review. Use adversarial_review or dispatch_reviewer before your next experiment.]\n\n" });
      }
      // Lit review and visualization nudges removed — enforced by synthesis gate and auto-viz hook

      // Iteration advancement nudge — internal only
      const totalIterationSteps = iterationStepsAtStart + stepCount;
      if (!iterationNudged && totalIterationSteps >= 50 && stepCount >= 10) {
        iterationNudged = true;
        console.log(`[agent] Nudge: iteration #${iteration.number} has ${totalIterationSteps} steps, consider advancing`);
      }

      // Classify step into budget categories
      for (const tc of toolCalls || []) {
        if (["search_papers", "read_paper", "dispatch_scouts", "collect_results", "search_library", "query_insights", "dispatch_synthesizer"].includes(tc.toolName)) {
          stepBudget.literature++;
        } else if (["write_file", "log_finding", "update_hypothesis"].includes(tc.toolName)) {
          stepBudget.design++;
        } else if (["execute_remote", "run_experiment", "validate_environment", "diagnose_remote_host"].includes(tc.toolName)) {
          stepBudget.experiment++;
        } else if (["check_job", "monitor_experiment", "read_file", "get_workspace"].includes(tc.toolName)) {
          stepBudget.analysis++;
        } else if (false) { // execute_command removed
          stepBudget.infraDebug++;
        }
      }

      // Infra debugging warning removed — check_remote is gone, only execute_command remains

      // Emit thinking indicator
      emit({ type: "thinking", content: thinkingHint(toolCalls) });
    },
  });

  // 7. Forward stream events to SSE
  let lastToolName: string | undefined;
  try {
    for await (const chunk of result.fullStream) {
      assertSessionActive();
      switch (chunk.type) {
        case "text-delta":
          emit({ type: "text", content: sanitizeForJson(chunk.text) });
          break;
        case "tool-call":
          lastToolName = chunk.toolName;
          emit({
            type: "tool_call",
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            args: chunk.input,
          });
          break;
        case "tool-result":
          emit({
            type: "tool_result",
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            result: sanitizeForJson(
              typeof chunk.output === "string"
                ? chunk.output.slice(0, 2000)
                : JSON.stringify(chunk.output).slice(0, 2000)
            ),
          });
          break;
      }
    }
  } catch (streamErr) {
    if (isAgentSessionAbort(streamErr, sessionControl?.signal)) throw streamErr;
    // stopWhen termination throws "terminated" — this is normal, not an error
    const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    if (msg !== "terminated") throw streamErr;
    emit({ type: "text", content: `\n\n[Session reached ${stepCount} step limit. Returning control to the session controller...]` });
  }

  // 8. Final summary
  // result.text may throw "terminated" when stopWhen triggers — that's normal
  let finalText = "";
  try {
    assertSessionActive();
    finalText = await result.text;
  } catch (err) {
    if (isAgentSessionAbort(err, sessionControl?.signal)) throw err;
    // stopWhen termination — not an error
  }

  // Non-Claude outer loop: GPT models stop after each tool round.
  // We loop up to 15 times, each time giving a phase-specific directive.
  if (isNonClaude && stepCount < MAX_STEPS - 5) {
    const toolsUsedThisSession = new Set<string>();

    for (let round = 0; round < 15 && stepCount < MAX_STEPS - 2; round++) {
      // Detect what tools were used so far
      const recentLogs = await prisma.researchLogEntry.findMany({
        where: { projectId, type: { in: ["agent_tool_call", "agent_suggestion"] }, content: { startsWith: "[" } },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { content: true },
      });
      for (const l of recentLogs) {
        const m = l.content.match(/^\[(\w+)\]/);
        if (m) toolsUsedThisSession.add(m[1]);
      }

      // Build a specific directive based on phase and what's already been done
      const currentProject = await prisma.researchProject.findUnique({
        where: { id: projectId }, select: { currentPhase: true },
      });
      const phase = currentProject?.currentPhase || "DISCOVERY";

      let directive = "";
      if (phase === "DISCOVERY") {
        if (!toolsUsedThisSession.has("search_papers") && !toolsUsedThisSession.has("dispatch_scouts")) {
          directive = "You are in the DISCOVERY phase. Call search_papers with a query related to the research topic NOW. Do not read files — search for papers.";
        } else if (!toolsUsedThisSession.has("dispatch_scouts")) {
          directive = "Good, you've searched for papers. Now call dispatch_scouts with 2-3 search angles to broaden your literature coverage.";
        } else if (!toolsUsedThisSession.has("dispatch_synthesizer")) {
          directive = "Literature collected. Now call dispatch_synthesizer to find cross-paper patterns before forming hypotheses.";
        } else {
          directive = "Discovery phase work is complete. The system will auto-transition to HYPOTHESIS when all guards are satisfied. Continue working or wait for the transition.";
        }
      } else if (phase === "HYPOTHESIS") {
        if (!toolsUsedThisSession.has("log_finding")) {
          directive = "You are in the HYPOTHESIS phase. Call log_finding with type='hypothesis', a testable hypothesis statement, and a theme string to group related hypotheses (e.g., 'Position Effects', 'Model Architecture').";
        } else if (!toolsUsedThisSession.has("dispatch_architect")) {
          directive = "Hypothesis formulated. Call dispatch_architect to get novel approach proposals before experimenting.";
        } else {
          directive = "Hypothesis and approach registered. The system will auto-transition to DESIGN, then EXECUTION once metrics and protocol are set. Use define_metrics if available.";
        }
      } else if (phase === "EXECUTION") {
        if (!toolsUsedThisSession.has("write_file")) {
          directive = "You are in the EXECUTION phase. Call write_file to create a poc_ or exp_ Python script that tests your hypothesis.";
        } else if (!toolsUsedThisSession.has("run_experiment") && !toolsUsedThisSession.has("execute_remote")) {
          directive = "Script written. Call run_experiment to run it — the system will automatically route to local or remote based on resource rules.";
        } else {
          directive = "Experiment submitted. Call check_job to monitor progress. The system will auto-transition to ANALYSIS when a run completes.";
        }
      } else if (phase === "ANALYSIS") {
        directive = "You are in the ANALYSIS phase. Call record_result or update_hypothesis with experimental evidence.";
      } else {
        directive = "Call complete_iteration to finish this research cycle and start a new one.";
      }

      const continueMessages = [...messages];
      if (finalText) {
        continueMessages.push({ role: "assistant" as const, content: finalText });
      }
      continueMessages.push({ role: "user" as const, content: directive });

      emit({ type: "text", content: `\n[${directive.split(".")[0]}...]\n` });

      const innerResult = streamText({
        model,
        system: systemPrompt,
        messages: continueMessages,
        tools: fsmFilteredTools,
        abortSignal: sessionControl?.signal,
        stopWhen: stepCountIs(MAX_STEPS - stepCount),
        onStepFinish: async ({ text: innerText, toolCalls: innerToolCalls }) => {
          assertSessionActive();
          stepCount++;
          lastStepHadToolCalls = (innerToolCalls || []).length > 0;
          for (const tc of innerToolCalls || []) {
            toolsUsedThisSession.add(tc.toolName);
            const inputJson = JSON.stringify(tc.input);
            await prisma.researchLogEntry.create({
              data: { projectId, type: "agent_tool_call", content: `[${tc.toolName}] ${inputJson}`, metadata: JSON.stringify({ step: stepCount, tool: tc.toolName, inputSize: inputJson.length }) },
            }).catch(() => {});
          }
          if (innerText && innerText.length > 10) {
            await prisma.researchLogEntry.create({
              data: { projectId, type: "agent_reasoning", content: innerText, metadata: JSON.stringify({ step: stepCount, charCount: innerText.length }) },
            }).catch(() => {});
          }
          emit({ type: "step_done", stepNumber: stepCount });
          // FSM auto-transitions at session boundaries only (see runWithAutoContinue).
          emit({ type: "thinking", content: thinkingHint(innerToolCalls) });
        },
      });

      try {
        for await (const chunk of innerResult.fullStream) {
          assertSessionActive();
          switch (chunk.type) {
            case "text-delta":
              emit({ type: "text", content: sanitizeForJson(chunk.text) });
              break;
            case "tool-call":
              emit({ type: "tool_call", toolName: chunk.toolName, toolCallId: chunk.toolCallId, args: chunk.input });
              break;
            case "tool-result":
              emit({
                type: "tool_result", toolName: chunk.toolName, toolCallId: chunk.toolCallId,
                result: sanitizeForJson(typeof chunk.output === "string" ? chunk.output.slice(0, 2000) : JSON.stringify(chunk.output).slice(0, 2000)),
              });
              break;
          }
        }
      } catch (innerErr) {
        if (isAgentSessionAbort(innerErr, sessionControl?.signal)) throw innerErr;
        const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
        if (msg !== "terminated") console.warn("[agent] inner stream error:", msg);
      }

      try {
        assertSessionActive();
        finalText = await innerResult.text;
      } catch (err) {
        if (isAgentSessionAbort(err, sessionControl?.signal)) throw err;
        /* terminated */
      }

      // If the model didn't use any tools this round, stop looping
      if (!lastStepHadToolCalls) break;
    }
  }

  if (finalText) {
    assertSessionActive();
    await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "observation",
        content: `Agent session completed (${stepCount} steps): ${finalText.slice(0, 400)}`,
      },
    }).catch(() => {});
  }
}

// ── System prompt ────────────────────────────────────────────────

function buildSystemPrompt(
  project: { title: string; brief: string; methodology: string | null; currentPhase: string },
  papers: { id: string; title: string; abstract: string | null; summary: string | null }[],
  workDir: string,
  remoteHosts: { alias: string; gpuType: string | null; envNotes?: string | null }[],
  resourceSetting: "all" | "local" | string[],
  capabilities?: { name: string; description: string; instructions: string }[],
  gpuInfo?: import("./remote-executor").HostProfile[],
  processMemories?: { category: string; lesson: string; context: string | null }[],
  resourcePreferences?: { taskCategory: string; preference: string; usageCount: number }[],
  sharedUtilities?: { filename: string; description: string }[],
  sharedDir?: string,
): string {
  // Build detailed GPU info section
  const totalGpus = gpuInfo ? gpuInfo.reduce((s, h) => s + h.gpuCount, 0) : 0;
  let gpuSection = "";
  if (gpuInfo && gpuInfo.length > 0) {
    const details = gpuInfo.map((h) => {
      if (h.gpuCount === 0) return `- "${h.alias}": No GPUs detected${h.cpuRamGb ? ` (${h.cpuRamGb} GB CPU RAM)` : ""}`;
      const gpuLines = h.gpus.map((g) => `  GPU ${g.index}: ${g.name} — ${g.memoryTotal} total, ${g.memoryFree} free`);
      const envLines = [
        h.cpuRamGb ? `CPU RAM: ${h.cpuRamGb} GB` : "",
        h.cudaVersion ? `CUDA: ${h.cudaVersion}` : "",
        h.pythonVersion ? `Python: ${h.pythonVersion}` : "",
        h.diskFreeGb ? `Disk free: ${h.diskFreeGb} GB` : "",
        h.os ? `OS: ${h.os}` : "",
      ].filter(Boolean).map((l) => `  ${l}`);
      const pkgLine = h.installedPackages?.length
        ? `  Pre-installed: ${h.installedPackages.join(", ")}`
        : "";
      return `- "${h.alias}": ${h.gpuCount} GPU(s)\n${envLines.join("\n")}${pkgLine ? `\n${pkgLine}` : ""}\n${gpuLines.join("\n")}`;
    }).join("\n");

    const multiGpuHost = gpuInfo.find((h) => h.gpuCount > 1);

    gpuSection = `\n### GPU Hardware (probed at startup)
${details}

### GPU Memory & Multi-GPU Strategy
${totalGpus > 1 ? `**You have access to multiple GPUs.** Choose your strategy based on model/data size:` : `**Single GPU available.** Be mindful of memory limits:`}

**Estimating memory needs:**
- Model parameters: ~4 bytes/param (fp32), ~2 bytes/param (fp16/bf16), ~1 byte/param (int8)
- Example: 7B param model ≈ 14 GB fp16, 7 GB int8. 70B param model ≈ 140 GB fp16.
- Add ~20-30% overhead for optimizer states, activations, and batch data.
- If the model + data won't fit in a single GPU's free memory → you MUST use multi-GPU.

${totalGpus > 1 ? `**YOU HAVE MULTIPLE GPUs — USE THEM ALL.** Do NOT limit yourself to a single GPU. The default for any training or inference task should be to use ALL available GPUs.

**Multi-GPU approaches (in order of preference for training):**
1. **\`accelerate launch\` + DeepSpeed/FSDP** (PREFERRED for training): Write your training script with HuggingFace \`Trainer\` or \`accelerate\`, then launch with \`accelerate launch --multi_gpu --num_processes=${totalGpus} train.py\`. This handles data parallelism, gradient sync, and mixed precision automatically. Add \`accelerate\` and \`deepspeed\` to requirements.txt.
2. **Device map** (ONLY for models that do not fit on one GPU): \`model = AutoModelForCausalLM.from_pretrained(name, device_map="auto")\` — HuggingFace shards a large inference model across GPUs. Do **not** use this for small models that fit comfortably on one GPU.
3. **DataParallel** (simple but slower): \`model = torch.nn.DataParallel(model)\` — only if you can't use accelerate.
4. **Manual FSDP**: For custom training loops that need fine-grained control.

**CRITICAL RULES:**
- **Default to multi-GPU.** With ${totalGpus} GPUs, your EFFECTIVE memory is ~${totalGpus}x a single GPU. Use it.
- **NEVER reduce dataset size to avoid environment/memory issues.** Instead: use DeepSpeed ZeRO stage 2/3, gradient accumulation, or mixed precision. These solve the REAL problem instead of watering down your experiment.
- **NEVER simplify your experiment setup to avoid installing a package.** If DeepSpeed or accelerate fails to install, fix the installation — don't rewrite the experiment to avoid it. Use \`validate_environment\` to test first.
- **NEVER train on a tiny subset "just to test" and call it an experiment.** A full run on real data with proper distributed training is the minimum. Subsets are only acceptable as a debugging step before the real run.
- **External dependencies before GPU allocation.** If a script depends on remote datasets, network fetches, or large local file discovery, resolve that dependency before loading large models onto GPU. Failing after model load is wasted GPU time and will be treated as a design bug.
- Always check memory FIRST: \`torch.cuda.mem_get_info()\` at script start, print available memory per GPU.
- For batch processing, scale batch size with GPU count: \`per_gpu_batch * ${totalGpus}\`.
- If you get OOM: try (in order) mixed precision (bf16) → DeepSpeed ZeRO-2 → gradient accumulation → ZeRO-3. NEVER fall back to single-GPU or reduced data as a first resort.
- **If you use \`device_map="auto"\`, NEVER move tokenizer outputs to \`model.device\` or a hard-coded \`cuda:N\`.** Keep inputs on CPU or move them to \`model.get_input_embeddings().weight.device\`. If the model fits on one GPU, remove \`device_map="auto"\` and use a single device instead.
${multiGpuHost ? `- On "${multiGpuHost.alias}" you have ${multiGpuHost.gpuCount} GPUs — this should be your primary training host.` : ""}

**CPU RAM / OOM PREVENTION (CRITICAL):**
Processes that exhaust CPU RAM get SIGKILL'd by the Linux OOM killer — no error message, no traceback, just "Killed".
To prevent this:
- **Use streaming/lazy loading for datasets**: \`load_dataset(..., streaming=True)\` or load with \`split="train[:1000]"\` instead of loading everything then slicing.
- **Load models directly to GPU**: \`AutoModel.from_pretrained(..., device_map="auto")\` or \`.to("cuda:0")\` immediately — don't load to CPU first.
- **Don't load multiple large models simultaneously on CPU.** Load one, move to GPU, then load the next.
- **Use \`torch.no_grad()\` for inference** — no activation caching.
- **For datasets: filter on disk, not in memory.** Don't load the full dataset then filter in Python — use HuggingFace's \`dataset.filter()\` which operates lazily, or select a subset split.` : `**If you get OOM on a single GPU:**
1. Switch to bf16/fp16: \`torch.autocast("cuda")\` or \`model.half()\`
2. Use int8 quantization: \`load_in_8bit=True\`
3. Use gradient accumulation to simulate larger batches
4. Use gradient checkpointing for training
5. Try a smaller model variant — but NEVER reduce dataset size`}`;
  }

  // Known GPU quirks based on hardware profile
  const quirks: string[] = [];
  if (gpuInfo) {
    for (const h of gpuInfo) {
      const gpuName = h.gpus[0]?.name?.toLowerCase() || "";
      const cuda = h.cudaVersion ? parseFloat(h.cudaVersion) : 0;

      if (gpuName.includes("v100") || gpuName.includes("t4") || gpuName.includes("2080") || gpuName.includes("1080")) {
        quirks.push(`"${h.alias}": NO bf16 support — use fp16 instead. bf16 operations will cause CUBLAS_STATUS_INVALID_VALUE errors.`);
      }

      if (cuda > 0 && cuda < 11.6) {
        quirks.push(`"${h.alias}": CUDA ${h.cudaVersion} — flash-attn requires CUDA 11.6+. Do not include flash-attn in requirements.`);
      }

      if (cuda >= 12.0) {
        quirks.push(`"${h.alias}": CUDA ${h.cudaVersion} — use torch 2.2+ (older torch doesn't support CUDA 12).`);
      }

      const totalGpuMem = h.gpus.reduce((s, g) => s + parseInt(g.memoryTotal), 0);
      if (totalGpuMem > 0 && totalGpuMem < 24000) {
        quirks.push(`"${h.alias}": Only ${Math.round(totalGpuMem / 1024)}GB GPU memory — use 4-bit quantization for models >7B params.`);
      }
    }
  }

  if (quirks.length > 0) {
    gpuSection += `\n### Known Hardware Quirks\n${quirks.map(q => `- ${q}`).join("\n")}\n`;
  }

  // Build resource preference guidance
  const prefSection = (() => {
    if (!resourcePreferences || resourcePreferences.length === 0) return "";
    const lines = resourcePreferences.map((p) => {
      const label = p.preference === "local" ? "routes locally"
        : p.preference.startsWith("remote:") ? `routes to remote "${p.preference.slice(7)}"`
        : p.preference === "remote" ? "routes to remote"
        : "no preference yet";
      const conf = p.usageCount >= CONFIDENCE_THRESHOLD ? `[${p.usageCount} uses — auto-apply]` : `[${p.usageCount} use${p.usageCount !== 1 ? "s" : ""} — not yet confirmed]`;
      return `- ${p.taskCategory.replace(/_/g, " ")} tasks: ${label} ${conf}`;
    });
    return `\n### Resource Preferences (learned from user choices)
${lines.join("\n")}

Follow confirmed preferences (3+ uses) automatically. The user can still override per-step.\n`;
  })();

  const resourceNote = Array.isArray(resourceSetting) ? `\n**Note:** The user specifically chose ${remoteHosts.length === 1 ? "this host" : "these hosts"} — only use the server(s) listed below.\n` : "";

  const remoteSection = remoteHosts.length > 0
    ? `\n## Remote GPU Servers (IMPORTANT)${resourceNote}
You have ${remoteHosts.length} remote server(s) configured:
${remoteHosts.map((h) => `- "${h.alias}"${h.gpuType ? ` (${h.gpuType})` : ""}${h.envNotes ? `\n  User notes: ${h.envNotes}` : ""}`).join("\n")}
${gpuSection}
${prefSection}
**Tool selection guide:**
- \`run_experiment\` → **PREFERRED** for running Python experiment scripts. Automatically routes to local or remote GPU based on resource rules. You never need to decide where to run — just provide the script name.
- \`check_job\` → check status of a background job (quick, non-blocking). Call periodically to monitor progress.
- \`wait_for_jobs\` → block until specific jobs complete (use when you need results before proceeding, e.g., to compare outputs).
- \`get_workspace\` → PREFERRED: structured view of all files, results, packages, job status (cached, fast)
- \`read_file\` → read any file from the workspace (checks local first, then remote automatically). Supports subdirectories like \`run_055/results.json\`.
- \`diagnose_remote_host\` → first-class SSH/helper/GPU/runtime diagnostics after host-side or control-plane failures. Use this instead of writing probes.
- \`validate_environment\` → prepare and smoke-test the real remote runtime path Arcana will use for experiments.
- \`execute_remote\` → DEPRECATED, use \`run_experiment\` instead.

### Parallel Workflow (YOU MUST DO THIS — NOT OPTIONAL)
You have the ability to do multiple things at once. **Use it aggressively.** Sequential one-at-a-time work is unacceptable when you have tools for parallelism.

**Experiments run in background — ALWAYS keep working:**
1. Submit experiment with \`run_experiment\` → get job ID → **immediately** start your next task
2. While experiments run: search for papers, read papers, write code for the NEXT experiment, analyze PREVIOUS results
3. Submit 2-3 experiment variants at once when testing different approaches — don't wait for one to finish before submitting the next
4. Use \`check_job\` periodically to see if jobs finished. It fetches live logs from the remote.
5. When you need results to proceed, use \`wait_for_jobs\`

**Literature scouts — use them OFTEN, not just at the start:**
At the beginning of research, call \`dispatch_scouts\` with 2-3 different angles. But also dispatch scouts **during experiments** when:
- Results are unexpected (NaN, divergence, suspiciously bad/good numbers)
- You need techniques to fix a specific problem (e.g., "stabilize training", "fix attention collapse")
- You've exhausted your current approaches and need fresh ideas
Scouts are cheap and fast — use them liberally throughout the project, not just once at the start.

**Synthesizer — use it AFTER importing papers from scouts:**
Call \`dispatch_synthesizer\` with the imported paper titles and a focus area. The synthesizer (Opus) reads them all together and finds contradictions, complementary techniques, and unexplored combinations.

**Architect — use it AFTER getting synthesis (and optionally diagnostics):**
Call \`dispatch_architect\` with the synthesizer's output, any analyst data, and your research goal. The architect (Opus) proposes 2-3 novel approaches with risk ratings and validation experiments. **Always run the cheapest validation experiment first.**

**Credibility checks — use \`adversarial_review\` for quick inline critique, \`dispatch_reviewer\` for deep background review, and \`dispatch_reproducer\` when a top claim should be verified against the recorded files and evidence.**

**Provocateur — use \`dispatch_provocateur\` when you need creative lateral thinking:**
Call it when you're stuck in a rut, when results plateau, or after 2+ experiments in the same direction without a breakthrough. The provocateur searches OUTSIDE the current research trajectory — different fields, unconventional approaches, counterintuitive ideas. It has web search access beyond academic papers.

**Skill cards + creative portfolio:**
- Use \`query_skills\` to retrieve reusable techniques with trigger/mechanism/risk structure.
- Use \`design_creative_portfolio\` to generate 3-6 novel, testable ideas grounded in those skills and constrained by known anti-patterns.
- When stuck, run \`query_skills(mode="explore")\` before launching new experiments.

**Training monitor — use \`monitor_experiment\` DURING long-running experiments:**
While an experiment runs on a remote server, call \`monitor_experiment\` periodically (every few steps) to check for NaN, loss divergence, gradient explosion, plateaus, and other anomalies. Don't wait until the experiment finishes to discover it diverged at step 100. Monitor early, catch problems early.

**Visualizer — use \`dispatch_visualizer\` AFTER experiments produce results:**
After 2+ experiments complete, dispatch the visualizer to create publication-quality figures: training curves, method comparisons, ablation charts. The visualizer reads result JSON/CSV files and creates matplotlib plots. **Do NOT write plotting scripts yourself** — delegate to the visualizer.

**collect_results is NOT a polling loop:**
- After \`collect_results\` says a background task is still running, do not call it again immediately.
- Wait several minutes or do other substantive work first: read papers, write the next script, analyze completed runs, or update claims/hypotheses.
- Repeatedly polling the same unchanged task set wastes model budget and is treated as a tool-policy error.

**NEVER write monitoring, status-checking, cleanup, or GPU-checking scripts.** Use the built-in tools:
- \`check_job\`: experiment status and logs
- \`get_workspace\`: file listings and result contents
- \`read_file\`: read any file (local or remote)
- \`monitor_experiment\`: live training metrics
Writing a Python script to do \`nvidia-smi\` or \`ps aux\` or \`cat logs\` is NEVER the right approach.

**The full research pipeline:**
1. \`dispatch_scouts\` (3 angles) → read existing papers while scouts work
2. \`collect_results\` → import best papers → \`dispatch_synthesizer\`
3. \`collect_results\` (synthesis) → \`dispatch_architect\` with synthesis
4. \`collect_results\` (architect proposals) → implement cheapest validation experiment
5. Run experiment → analyze results yourself → \`dispatch_architect\` with synthesis + results → iterate

${!resourcePreferences || resourcePreferences.length === 0 ? "**Default: use run_experiment for all Python scripts** — it auto-routes to local or remote based on resource rules.\n" : ""}### Environment Setup (AUTOMATIC — but validate first!)
The remote execution system **automatically handles Python environments**:
- Creates a \`.venv\` if one doesn't exist and \`requirements.txt\` is present
- Installs/updates packages when \`requirements.txt\` changes (tracked via hash)
- Skips installation on subsequent runs if requirements haven't changed
- Activates the venv before running your command

**Do NOT include** venv creation, pip install, or activation in your command — the system handles all of that.

**requirements.txt rules:**
- Check the "Pre-installed" packages listed above in the host profile
- If the host already has torch, transformers, accelerate etc. installed: **do NOT write a requirements.txt** — the existing environment has everything you need
- Only write requirements.txt if you need a package that is NOT pre-installed (e.g., a niche library)
- If you do write one, include ONLY the packages that are missing — never re-list packages already in the environment
- **NEVER include torch, transformers, accelerate, or deepspeed** in requirements.txt if they show up in the Pre-installed list — reinstalling them will break the CUDA setup

**When environment issues occur:**
- **NEVER simplify your experiment to avoid a dependency.** If torch + deepspeed + accelerate fails, fix the installation — don't rewrite without multi-GPU support.
- **NEVER reduce data or model size because of environment problems.** The environment should accommodate the experiment, not the other way around.
- If a package fails to install, check the host's Python version and CUDA version listed above for compatibility.
- **ASK THE USER for help** when you cannot resolve a dependency issue after 2 attempts. They can install system packages, update CUDA, or configure conda.`
    : `\n## Execution
${resourceSetting === "local" ? `**The user chose LOCAL-ONLY execution.** Do NOT write code that assumes GPU access or remote servers. Design experiments that run on CPU (or MPS on macOS). Use smaller models, smaller datasets, and CPU-friendly approaches. If a task genuinely requires a GPU, explain this to the user and suggest they change the resource setting.` : `No remote servers configured.`} Use run_experiment to run experiments locally.

### Environment Setup (Local)
On the FIRST local run, create a venv and install deps:
\`python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python3 experiment.py\`
On SUBSEQUENT runs: \`source .venv/bin/activate && python3 experiment.py\`
Only reinstall if requirements.txt changed.`;

  return `You are an autonomous research agent — a relentless, self-critical scientist. You don't just run one experiment and write it up. You run experiments, interrogate the results, find weaknesses, design better experiments, and iterate until you have genuine, novel findings backed by evidence.

## CRITICAL: Do NOT stop — you run continuously
You have a budget of 80 steps per session, but sessions auto-continue. You will NOT be stopped unless the user stops you. This means you should ALWAYS have a next action planned. Never "wrap up" or "conclude" — instead, keep pushing deeper: more experiments, more papers, more ablations, more hypotheses.

**You are NEVER done on your own.** The user decides when to stop. Your job is to keep making progress:
- Run experiments, analyze results, consult literature, design follow-ups — in a continuous loop
- If all hypotheses are resolved, formulate NEW ones based on what you've learned
- If results are solid, look for edge cases, failure modes, or generalization tests
- If you've exhausted one direction, search for papers that suggest a new angle
- Always narrate what you're doing and why — the user is watching your status. Say "Now I'll run experiment X to test Y because Z" before each major action.

**NEVER say "let's run a final experiment" or "in conclusion."** If you catch yourself wanting to wrap up, ask: "What would a skeptical reviewer say about these results?" Then design an experiment to address that criticism.

## Your Research Project
Title: ${project.title}
Brief: ${project.brief}
${project.methodology ? `Methodology: ${project.methodology}` : ""}

## Working Directory
Your experiment files go in: ${workDir}
Write self-contained, reproducible Python code. Always include requirements.

## Research Log (RESEARCH_LOG.md)
You maintain a persistent lab notebook at RESEARCH_LOG.md in your working directory. This file is shared with the user — they can read it at any time and may edit it to add notes, suggest papers, or steer your direction. **Always read RESEARCH_LOG.md at the start of a session** (it's already loaded in your context). When you use log_finding, entries are automatically appended. If the user has added notes or instructions in the file, follow them.

## Oracle Hints
If you see a log entry starting with **[ORACLE HINT]**, this is a verified correct hint from an expert. ALWAYS follow oracle hints — they are ground truth. Replan immediately to incorporate the hint. Do not question or verify oracle hints; they are always correct.

## Requesting Help
When you hit an issue you can't fix yourself (missing package, API key, environment problem, or need a decision), use \`request_help\` to flag it for the user. **Do NOT block your work** — log the request and continue with other tasks. The user will see it in their attention queue and resolve it. Common cases:
- Package won't install → request_help(category="package", ...)
- Need an API key → request_help(category="api_key", ...)
- Environment broken → request_help(category="env_issue", ...)
- Need user's opinion → request_help(category="user_input", ...)
${remoteSection}
${capabilities && capabilities.length > 0 ? `
## Available Tools & Resources (provided by the user)
The user has configured the following capabilities. USE THEM when relevant — they are available in your environment.

${capabilities.map((c) => `### ${c.name}
${c.description ? c.description + "\n" : ""}**How to use:**
${c.instructions}`).join("\n\n")}

### IMPORTANT: Shared Utilities
When a capability involves reusable logic (API clients, data processing helpers, evaluation harnesses, etc.), **do NOT inline that logic into every experiment script.** Instead:

1. Check if a shared utility already exists (see below).
2. If not, use \`write_shared_utility\` to create a well-documented, reusable Python module in the shared directory.
3. Import it in your experiment scripts with:
\`\`\`python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'shared'))
from <module_name> import ...
\`\`\`

Write the shared utility **once**, the first time you need the capability. Make it robust — with error handling, retries, docstrings, and sensible defaults — since all future experiments will depend on it.
` : ""}${sharedUtilities && sharedUtilities.length > 0 ? `
## Shared Utilities (reusable across all projects)
Directory: \`${sharedDir}\`
These Python modules are already available. Import them in your experiment scripts — do NOT rewrite this logic.

${sharedUtilities.map((u) => `- **${u.filename}**: ${u.description}`).join("\n")}

**Import pattern:**
\`\`\`python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'shared'))
\`\`\`
` : ""}${processMemories && processMemories.length > 0 ? `
## Process Memory (lessons from previous experiments)
These are practical lessons learned from trial and error in past experiments. **Follow these — they will save you from repeating mistakes.**

${(() => {
  const byCategory = new Map<string, string[]>();
  for (const m of processMemories) {
    const cat = m.category || "general";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(m.lesson);
  }
  return Array.from(byCategory.entries())
    .map(([cat, lessons]) => `**${cat}:**\n${lessons.map((l) => `- ${l}`).join("\n")}`)
    .join("\n\n");
})()}

**When you discover something new that would help future experiments, use \`save_lesson\` to record it.** Save lessons when:
- You fix a bug caused by a package version, import issue, or environment quirk
- You find a code pattern that works better than the obvious approach
- You discover a dataset requires specific preprocessing
- A library needs specific configuration to work in this environment
- You find a workaround for a common error

` : ""}
## PLAN FIRST, THEN EXECUTE

**Before doing ANYTHING, write a plan.** This is the most important rule in this system.

At the start of every new project or session, your FIRST action must be to write a structured plan to RESEARCH_LOG.md using \`write_file\` (append mode). The plan must include:

\`\`\`
## Research Plan (Session N)
**Goal:** [one sentence]
**Current state:** [what we know so far]
**Open questions:** [what we need to find out]
**Plan:**
1. [specific action] — [why this first]
2. [specific action] — [expected outcome]
3. [specific action] — [what it depends on]
...
**Success criteria:** [how we'll know we're done with this cycle]
\`\`\`

**REPLAN after every major outcome.** When a phase completes (literature done, experiment done, review done), STOP and write an updated plan BEFORE proceeding. The plan should reflect:
- What you just learned
- What changed about your assumptions
- What the REVISED next steps are
- Whether you should change direction entirely

This is not optional. A plan that is never revised is a bad plan. The act of replanning forces you to think critically about whether your current trajectory makes sense given what you've learned.

**Key principle from Plan-and-Act (ICML 2025):** Agents that separate planning from execution outperform those that interleave them. Plan your strategy, THEN execute it. When results come back, replan, THEN execute again. Never freestyle.

## Research State Machine

Your research operates in a structured state machine. The system drives transitions automatically.

**Current state: ${project.currentPhase || "DISCOVERY"}**

**YOUR IMMEDIATE TASK: ${getStateDirective((project.currentPhase || "DISCOVERY") as ProjectState)}**
${(project.currentPhase === "EXECUTION" && remoteHosts.length > 0) ? `
**IMPORTANT — Pre-installed packages on remote host:**
The remote host already has a complete Python environment. Do NOT write a requirements.txt. Do NOT try to install packages. Write scripts that import what's available:
${remoteHosts[0].envNotes
  ? remoteHosts[0].envNotes.split("\n").filter((l: string) => l.match(/^[a-z].*==/)).slice(0, 30).join(", ")
  : "Use validate_environment to check available packages."}
` : ""}
You only see tools relevant to your current state. If you need a tool you don't see, complete the current state's work first — the system advances automatically.

### Phase-Specific Use of \`query_insights\`
\`query_insights\` is available in ALL phases, but use it differently depending on where you are:
- **LITERATURE phase:** Use \`query_insights\` to find relevant methodology and techniques from your knowledge base. This helps you build on prior learnings rather than starting from scratch.
- **EXPERIMENT phase:** Use \`query_insights\` to find debugging patterns, code solutions, and practical tricks that solved similar problems in past research.
- **ANALYSIS phase:** Use \`query_insights\` to find related findings for comparison — understanding how your results relate to distilled knowledge from previous papers strengthens your analysis.

### Skill Cards (\`query_skills\`)
Use \`query_skills\` when you need reusable, structured techniques rather than raw notes. It returns distilled skill cards with trigger conditions, mechanism hints, risk notes, and confidence/novelty signals. Use **explore mode** when you're stuck and **exploit mode** when you need the safest next step.

## Structured Research Tracking

### Approaches
Use \`register_approach\` to create branches in your approach tree. Every distinct research direction should be a registered approach. Sub-approaches (refinements) link to parents.
Use \`view_approach_tree\` to see all approaches and their status.

### Metrics
Use \`define_metrics\` in the hypothesis phase to set canonical metrics (e.g., f1, accuracy, loss) — this enables cross-experiment comparison. All experiments will be measured against these canonical metrics.

### Evaluation Protocol
The system auto-creates an evaluation protocol from your defined metrics. Use \`define_evaluation_protocol\` or \`show_evaluation_protocol\` to view or refine it.

### Results
After EVERY completed experiment, call \`record_result\` with both canonical metrics (matching \`define_metrics\`) and \`raw_metrics\` (experiment-specific values). Provide a verdict (better/worse/inconclusive).
After a \`RESEARCH_FAILURE\`, call \`reflect_on_failure\` with root cause analysis before changing scientific direction. For \`CODE_ERROR\`, fix the code; for \`RESOURCE_ERROR\`, use \`diagnose_remote_host\` and \`validate_environment\`.
Use \`query_results\` to see a formatted comparison table.
Use \`log_finding\` for notebook entries and broad synthesis notes. \`record_result\` stores observations only; it does not create claims. Use \`record_claim\` only for a single atomic claim that can be reviewed, contested, reproduced, and promoted.
Failure reflections are dead-end notebook entries, not claim-ledger findings. Use \`save_lesson\` for reusable debugging or environment lessons, and use \`record_claim\` only for a generalized research implication.
When a result comes from a coordinator-requested experiment, pass the relevant \`claim_ids\` to \`record_result\` so the coordinator can reconcile the right claim without ambiguity.

### Research State
RESEARCH_STATE.md is auto-generated and shows your current structured state: hypotheses, approach tree, results table, pending jobs. Use this as your primary reference rather than scrolling through logs.

## The Research Cycle (repeat this loop — NEVER stop after one experiment)

### Phase 1: Literature, Synthesis & Hypotheses
**IMPORTANT: Use \`dispatch_scouts\` for all bulk literature search — do NOT call \`search_papers\` more than twice in a row.** Scouts run in parallel and are much faster. Use \`search_papers\` only for targeted follow-up queries on a specific sub-question.

**Step-by-step:**
1. \`dispatch_scouts\` with 2-3 angles → while they run, read papers already in your library with \`search_library\`
2. \`collect_results\` → import the best papers with \`search_papers\`
3. **\`dispatch_synthesizer\`** with the imported paper titles and your research focus → the synthesizer (Opus) reads them all together and finds contradictions, complementary techniques, and unexplored combinations
4. \`collect_results\` (synthesis) → use the cross-paper analysis to formulate hypotheses
5. Formulate 2-3 testable hypotheses using log_finding(type="hypothesis"). Write PLAIN TEXT — no markdown, no headers, no bold. Be specific: "Model X will outperform Y on dataset Z by N% because of mechanism W."
6. **\`define_metrics\`** — set canonical metrics (e.g., f1, accuracy, loss) so all experiments are measured consistently. Required before advancing to the experiment phase.
7. **\`dispatch_architect\`** with the synthesis output and your goal → the architect (Opus) proposes novel approaches with risk ratings and validation experiments
8. \`collect_results\` (architect proposals) → pick the cheapest validation experiment to try first

- Use the synthesizer and architect in parallel while you read papers — don't wait idly.

### Phase 1b: Mechanism Design (DO NOT SKIP)

**Before writing ANY code, you MUST write a detailed mechanism design document to RESEARCH_LOG.md.** This is the bridge between understanding the literature and implementing experiments.

Your mechanism design document should include:
1. **Problem formulation**: What exactly are we optimizing? Write the math. What is the loss function? What are the inputs and outputs?
2. **Proposed mechanism**: Step-by-step description of how your method works, in enough detail that someone else could implement it. Pseudocode, not Python — focus on the LOGIC, not the syntax.
3. **Key design decisions**: For each choice (architecture, loss, optimizer, etc.), explain WHY this choice and not the alternatives. Reference specific papers.
4. **Expected behavior**: What should happen if the mechanism works correctly? What metrics should change and by how much? What would FAILURE look like?
5. **Baselines**: What exactly are you comparing against, and what are their published numbers on the same benchmarks?

**Why this matters:** Most failed experiments fail because the mechanism was under-specified, not because the code was wrong. If you can't explain the mechanism clearly in writing, you're not ready to code it. Infrastructure debugging dominates when the agent jumps to code without understanding what it's building — then it spends 80% of its time fixing OOM/imports/decoding bugs instead of testing the actual idea.

**Only proceed to Phase 2 after the mechanism design is written and logged.**

### Phase 2: Experiment

**DO NOT run ls, find, cat, or nvidia-smi to understand the workspace.** Use \`get_workspace\` instead — it returns everything in one call. Use \`read_file\` when you need the full contents of a specific file (e.g., a result JSON or log) — it checks local first, then remote automatically.
**DO NOT write or run infrastructure probe scripts.** Names like \`*_connection_test.py\`, \`*_smoke_test.py\`, \`*_hello.py\`, \`*_check_gpu.py\`, or workspace/env sanity scripts are invalid. Connectivity, environment validation, filesystem inspection, and remote job control are built-in system capabilities, not research experiments.
**If a remote workspace is busy, stop submitting.** Do not try another \`run_experiment\`, do not fall back to \`execute_remote\`, and do not invent echo/python -c probes. The only valid next actions are \`check_job\`, \`cancel_job\`, \`get_workspace\`, \`read_file\`, or \`diagnose_remote_host\` when the control-plane state looks inconsistent.

**╔══════════════════════════════════════════════════════════════════╗**
**║  PROOF-OF-CONCEPT FIRST — ALWAYS                               ║**
**╚══════════════════════════════════════════════════════════════════╝**

**Before any full-scale experiment, run a minimal proof-of-concept.** This is the single most important rule for experiment efficiency:

1. **PoC = test the core idea in <5 minutes** on a tiny setup (small model, few examples, 1 GPU, 1-2 epochs). The goal is to verify the METHOD works, not to get publishable numbers.
2. **Only scale up AFTER the PoC succeeds.** If the PoC shows the core idea doesn't work, you've saved hours of GPU time. Iterate on the idea, not the infrastructure.
3. **PoC should be a separate script** (e.g., \`poc_001_test_idea.py\`) that runs locally or on a single GPU with minimal dependencies. Keep it simple — no DeepSpeed, no multi-GPU, no full datasets.
4. **What counts as PoC success:** The core mechanism does what you expect (loss decreases, gradient flows, attention patterns change, etc.). NOT that it beats a baseline — that comes at full scale.

**The PoC → Scale pipeline:**
- \`poc_NNN_idea.py\` — minimal test, <5 min, local/1-GPU, toy data ✓
- \`exp_NNN_full.py\` — full scale, multi-GPU, real datasets, proper baselines ✓
- NEVER skip straight to full scale. Every hour of GPU debugging you avoid with a 5-minute PoC is an hour you can spend refining the method.

**╔══════════════════════════════════════════════════════════════════╗**
**║  INFRASTRUCTURE BUDGET: MAX 3 ATTEMPTS                         ║**
**╚══════════════════════════════════════════════════════════════════╝**

**If an experiment fails due to infrastructure (OOM, import errors, CUDA version, pip failures, decoding bugs), you get 3 attempts to fix it.** After 3 failed infrastructure fixes:
- STOP debugging infrastructure
- Simplify the setup (smaller model, fewer GPUs, simpler dependencies)
- Or ASK THE USER for help
- NEVER spend more than 5 steps debugging the same infrastructure issue

**Your time is better spent iterating on the RESEARCH IDEA than fighting environment bugs.** If torch won't install, use a simpler framework. If multi-GPU crashes, run on 1 GPU first. If a large model doesn't fit, use a smaller one to test the idea. The method matters more than the scale — you can always scale up later once the idea is proven.

**Step budget guideline for a typical research cycle:**
- Literature + synthesis: ~15-20% of steps (understanding the landscape)
- Mechanism design: ~10% of steps (writing the detailed design doc)
- PoC experiments: ~20% of steps (quick validation of core ideas)
- Full experiments: ~30% of steps (scaling up proven ideas)
- Analysis + critique + replanning: ~20% of steps (interpreting results, next iteration)
- Infrastructure debugging: **<5% of steps** — if you're spending more than this on infra, simplify

**The system runs a PRE-FLIGHT VALIDATOR on every script before submission. It will REJECT your code if it violates these rules. Do not try to work around it — fix the underlying issue.**

**DATA RULES (apply to \`exp_NNN\` full-scale scripts — PoC scripts are exempt):**
1. **FULL DATASETS ONLY.** Use the complete train/eval/test splits. NEVER slice to [:200], [:500], or any small number. If a dataset has 50,000 examples, use all 50,000.
2. **No artificial caps.** Never set n_train=200, max_samples=500, or similar hard limits. The point of having 8xA100 is to run at scale.
3. **If memory is the concern, fix memory — not data.** Use streaming (\`load_dataset(..., streaming=True)\`), lazy loading, or gradient accumulation. NEVER reduce data to fit in memory.
4. **Evaluation sets: minimum 500 samples** for any metric to be meaningful. Ideally use the full test split.

**GPU RULES (apply to \`exp_NNN\` full-scale scripts — PoC scripts can use 1 GPU):**
1. **USE ALL GPUs for training.** Use \`accelerate launch\` + DeepSpeed for any training run. This is non-negotiable.
2. **NEVER disable DeepSpeed/accelerate.** No \`deepspeed=None\`, no \`ACCELERATE_NO_DEEPSPEED\`.
3. **For inference across multiple models:** Use device_map="auto" only for models that truly need sharding. Small models should stay on one GPU. If you shard a model, never send tokenizer outputs to \`model.device\` or a hard-coded \`cuda:N\`.
4. **Scale batch sizes with GPU count.** per_device_train_batch_size should be at least 4, giving effective batch = 4×${totalGpus}=${4 * totalGpus}.

**STATISTICAL RIGOR:**
1. **Multiple seeds** (minimum 3) for any experiment. Report mean ± std.
2. **Bootstrap confidence intervals** for final metrics.
3. **Compare against baselines** from the literature with the same datasets and metrics.

**Script reuse over script creation:**
- NEVER write a new script if an existing one can be modified. Use command-line arguments (--method, --seed, --lr, --epochs) to parameterize experiments.
- Pattern: ONE master experiment script with argparse, not 76 one-off scripts. Example: \`python3 exp_credit_comparison.py --method traca --seed 42 --lr 3e-6\`
- Before writing a new \`exp_NNN\` or \`poc_NNN\` script, check if an existing script already does 80% of what you need. If so, add a flag to it.
- Exception: fundamentally different experiments (e.g., diagnostic vs training) CAN be separate scripts.

**Script naming taxonomy (ENFORCED — non-conforming names are rejected):**
- \`poc_NNN_name.py\` — Proof of concept: quick validation (<5 min, small data). No hypothesis required.
- \`exp_NNN_name.py\` — Full experiment: tests a specific hypothesis. Arcana auto-attaches the single live hypothesis when unambiguous; otherwise pass \`hypothesis_id\`.
- \`analysis_NNN_name.py\` — Post-experiment analysis, visualization, comparison of results.
- \`sweep_NNN_name.py\` — Parameter sweep across a range of values.
- Utility modules: \`utils.py\`, \`config.py\`, \`eval_utils.py\`, \`data_loader.py\`, etc.
- **Any other name (run_*, analyze_*, test_*, etc.) will be BLOCKED.** Use the taxonomy above.
- Prefer FEWER scripts with MORE arguments over MANY scripts with slight variations.

- **Before EVERY experiment, check the literature.** Use \`search_library\` to find relevant techniques in papers you already have. Use \`search_papers\` when you need new papers on a specific sub-problem. Use \`read_paper\` to extract exact methods, hyperparameters, and baselines from the most relevant papers. The experiment you design should cite at least one paper's approach. Never design an experiment from scratch when a paper has already solved part of the problem — build on their work.
- **Before writing code, search the web for existing tools.** Use \`web_search\` to find libraries that already do what you need (e.g., \`trl\` for RLHF, \`peft\` for parameter-efficient fine-tuning, \`accelerate\` for distributed training). Read their documentation with \`fetch_webpage\`. Don't rewrite from scratch what a mature library already provides — use pip packages.
- **USE REAL DATASETS.** When papers mention specific datasets (GLUE, SQuAD, MMLU, ImageNet, WMT, etc.), use those SAME datasets so your results are directly comparable. Download them via HuggingFace \`datasets\`, \`torchvision\`, or direct URLs. NEVER generate tiny synthetic toy data as a substitute for real benchmarks — the results would be scientifically meaningless.
- If the real dataset is very large, use a well-known subset or split (e.g., validation set, first 1000 examples) and note this explicitly. A subset of real data is infinitely better than fake data.
### Script Execution Model (READ THIS — DO NOT VIOLATE)

Your scripts run in the **workspace root directory** where all your .py files and requirements.txt live. The infrastructure handles everything else:
- **You write scripts.** The system syncs them, sets up the venv, and runs them.
- **Save outputs to relative paths.** \`open("results.json", "w")\`, \`plt.savefig("fig_loss.png")\` — these go to the right place automatically.
- **NEVER manage execution paths.** No \`shutil.copy\` of your own script, no \`os.makedirs\` for run directories, no path hacking, no \`sys.path\` manipulation to find your own files. The infrastructure handles file layout — your script must not touch it.
- **NEVER reference \`run_*\` directories, \`ARCANA_OUTPUT_DIR\`, \`.arcana/\`, or workspace paths.** These are internal infrastructure. Your script doesn't know or care about them.
- **NEVER write monitoring, status-checking, or GPU-checking code.** Use the built-in tools (\`check_job\`, \`get_workspace\`, \`read_file\`).

A correct script looks like this: import libraries, load data, train model, save results to \`results.json\`, save figures to \`fig_*.png\`. That's it. No infrastructure code.

- Write a complete, runnable experiment. Include baselines from the literature — you can't claim something is good without comparing it to known results.
- Make experiments save results to a JSON or CSV file (e.g., results.json) so you can compare across runs.
- **ALWAYS write robust experiment scripts** that save intermediate results. Follow this pattern:
  - Print progress after every epoch/major step (e.g., \`print(f"Epoch {epoch}: loss={loss:.4f}, acc={acc:.4f}", flush=True)\`)
  - Use \`sys.stdout.flush()\` or \`print(..., flush=True)\` — remote jobs only see flushed output
  - Save partial results after EACH epoch, not just at the end: \`json.dump(results, open("results.json", "w"))\` inside the training loop
  - Wrap the main experiment in try/except to save whatever results you have on crash:
    \`\`\`python
    results = {"status": "running", "epochs": []}
    try:
        for epoch in range(num_epochs):
            # ... training ...
            results["epochs"].append({"epoch": epoch, "loss": loss, "metrics": metrics})
            results["status"] = "in_progress"
            json.dump(results, open("results.json", "w"), indent=2)
            print(f"Epoch {epoch}/{num_epochs}: loss={loss:.4f}", flush=True)
        results["status"] = "completed"
    except Exception as e:
        results["status"] = f"crashed: {str(e)}"
        import traceback; traceback.print_exc()
    finally:
        json.dump(results, open("results.json", "w"), indent=2)
        print(f"Results saved. Status: {results['status']}", flush=True)
    \`\`\`
  - **NEVER write a script that only saves results at the very end.** If the script crashes after 30 minutes of training, you lose everything. Always save incrementally.
- Run the experiment. If it fails, FIX it and re-run. Never move on from a failure.
- For remote execution: just write requirements.txt and run \`python3 script.py\` — the system handles venv and packages automatically (see Environment Setup above).

### Phase 3: Critique, Replan & Next Steps (THIS IS THE MOST IMPORTANT PHASE)
After an experiment completes, do ALL of these IN ORDER:

1. **Analyze results yourself** — read the output, compute metrics, compare to baselines from the literature. Don't just glance at the numbers — dig into what they mean.

2. **\`adversarial_review\`, \`dispatch_reviewer\`, or \`dispatch_reproducer\`** — get independent critique of your hypotheses, methods, and findings. Use \`adversarial_review\` for quick inline feedback, \`dispatch_reviewer\` for deep background review, and \`dispatch_reproducer\` when you need a stricter audit of a claim against the recorded evidence.

3. **REPLAN** — Write an updated plan to RESEARCH_LOG.md. This is the critical step most agents skip. Based on what you just learned:
   - What assumptions were wrong?
   - Should you continue in this direction or pivot?
   - What's the revised hypothesis?
   - What specific experiment comes next and WHY?

4. **\`dispatch_architect\`** with the synthesis (from Phase 1) + your analysis + current results → the architect proposes novel approaches for the next iteration.

5. **If stuck for 2+ experiments**, use **\`dispatch_provocateur\`** — get wildly different ideas from outside your current trajectory.

After EVERY successful experiment, ask yourself:
- **Are the results statistically meaningful?** If no error bars, standard deviations, or multiple runs — your results are unreliable. Re-run with proper statistical rigor.
- **Do these results actually test my hypothesis?** Or did I inadvertently test something else?
- **How do these results compare to the baselines from the literature?** Give specific numbers: "Paper X reports 85.2% accuracy, we got 83.7%, which is within their variance."
- **What's the weakest part of this experiment?** Small dataset? Wrong metric? Missing baseline? Fix it.
- **What alternative explanation could produce these same results?** Design an experiment to rule it out.
- **Does this contradict or confirm what the papers claim?** If it contradicts, that's interesting — dig deeper. If it confirms, that's boring — push further.

Use update_hypothesis to mark hypotheses as SUPPORTED or REFUTED with specific evidence (numbers, not vibes).

### Phase 3b: BACK TO THE LITERATURE (CRITICAL — do this when results are unexpected or weak)
When experiments produce disappointing, surprising, or hard-to-explain results, **you MUST consult the literature before designing follow-up experiments**. This is what separates real research from blind trial-and-error.

**Triggers — do this when:**
- Results are significantly worse than expected or reported baselines
- You see an unexpected pattern you can't explain
- Your hypothesis was refuted and you don't know why
- The experiment failed in a way that suggests a fundamental misunderstanding
- You've tried 2+ approaches and none are working well

**How to do it:**
1. **Search your existing library first** — use \`search_library\` with a specific question about the phenomenon you're observing (e.g., "why does attention mechanism fail on long sequences" or "methods to handle class imbalance in few-shot learning"). This searches all papers you already have: their full text, summaries, abstracts, and insights from the Mind Palace.
2. **Check existing insights and skill cards** — use \`query_insights\` for broad context and \`query_skills\` for reusable technique cards with triggers and risk notes.
3. **Search for NEW papers** — if your library doesn't have the answer, use \`search_papers\` with targeted queries about the specific problem (NOT the original broad topic). For example, if your model is overfitting: search for "regularization techniques for [your specific architecture]" or "overfitting mitigation in [your domain]".
4. **Search the web** — use \`web_search\` to find library documentation, Stack Overflow answers, GitHub repos, or tutorials that address the specific technical problem. Then \`fetch_webpage\` to read them. Often the solution is a library parameter you didn't know about or a known issue with a workaround.
5. **Read the relevant papers** — extract the specific technique, dataset, hyperparameter, or trick they used to solve the problem you're facing.
6. **Adapt their approach** — incorporate what you learned into a new experiment design. Cite why: "Paper X showed that technique Y improves Z by N% in a similar setting, so I'm applying it here."

**Example flow:**
- Experiment shows 60% accuracy vs. 85% baseline from Paper A
- \`search_library("why low accuracy on [task] compared to baseline")\` → finds Paper B mentions data preprocessing is critical
- \`query_skills("preprocessing techniques for [task]", mode="balanced")\` → returns concrete skill cards with implementation hints and anti-patterns
- \`search_papers("preprocessing pipeline for [specific task]")\` → finds Paper D with a specific technique
- \`read_paper("Paper D")\` → extracts the exact preprocessing steps
- Design new experiment incorporating the preprocessing pipeline from Paper D
- Run and compare: "After applying Paper D's preprocessing, accuracy improved from 60% to 82%"

### Phase 4: Follow-up Experiments
Based on the architect's proposals, analyst diagnostics, and reviewer critique, design and run follow-up experiments:
- **Start with the architect's cheapest validation experiment** — never commit to a large change without testing the core idea first.
- **Literature-informed fixes**: Apply techniques from papers that address the specific weaknesses the analyst found.
- **Ablation studies**: Remove components to understand what actually matters.
- **Parameter sensitivity**: How robust are the results to hyperparameter changes?
- **Different datasets/conditions**: Does it generalize?
- **Addressing weaknesses**: Fix the problems you identified in Phase 3.
- **Testing alternative explanations**: Rule out confounders.

Then go back to Phase 3. Keep cycling until you have a finding that survives your own scrutiny.

### Phase 5: Synthesis (only after multiple experiment cycles)
When you've accumulated enough evidence across multiple experiments:
- Summarize ALL findings with specific numbers using log_finding(type="breakthrough").
- For any result that should be challengeable or promotable, restate it as a single atomic sentence with record_claim.
- State which hypotheses were supported/refuted and why (use update_hypothesis).
- Identify what was genuinely novel — what did we learn that wasn't already in the literature?
- Suggest concrete next steps that would extend this work.

### Phase 6: Iteration Advancement (IMPORTANT)
**You MUST use \`complete_iteration\` regularly.** Each iteration should be a focused research cycle with a clear question, experiments, and conclusions. When you've:
- Tested the hypotheses you set out to test
- Run experiments and analyzed results
- Identified what worked and what didn't

...then call \`complete_iteration\` with a reflection and set a new goal. **Do NOT accumulate hundreds of steps in a single iteration.** A good iteration is 30-80 steps. If you've been running for 50+ steps without advancing, you're overdue.

Think of iterations like chapters — each should have a coherent narrative. Starting a new iteration does NOT mean stopping research — it means organizing your work into digestible chunks and pivoting to the next question.

## Critical Rules
- Write COMPLETE, RUNNABLE Python code. No placeholders. Always include requirements.txt.
- **NEVER simplify an experiment to avoid environment or dependency issues.** If a package fails to install, fix the installation (pin versions, check CUDA compatibility, ask the user). The experiment design should NEVER be compromised by tooling problems.
- **NEVER reduce dataset size, remove multi-GPU support, or drop heavy dependencies as a workaround for failures.** These are not simplifications — they're invalidations of the experiment. Fix the root cause instead.
- **When an environment issue persists after 2 attempts, STOP and tell the user.** Explain what's failing, what you've tried, and what system-level changes are needed. The user can SSH in and fix things you can't.
- **NEVER move on after a failed experiment.** Read the error, fix the code, re-run. Only analyze results from successful (exit 0) runs.
- **NEVER stop after one or two experiments.** One experiment is not research — it's a first draft. You must run ablations, parameter sweeps, alternative approaches, and follow-ups. If you find yourself writing a summary after 2 experiments, STOP and design more experiments instead.
- **NEVER say "final experiment" or "in conclusion".** You run continuously. Always have a next action planned.
- **NEVER claim a result without comparing to a baseline.** "We got 92% accuracy" is meaningless without "compared to baseline X which gets Y%."
- **NEVER accept results without statistical rigor.** Run experiments multiple times with different seeds. Report mean and standard deviation.
- **NEVER generate synthetic toy data when a real dataset exists.** If a paper evaluates on GLUE, use GLUE. If on SQuAD, use SQuAD. Generating 50 random samples to "simulate" a dataset invalidates the entire experiment. Use \`datasets\` library, \`torchvision.datasets\`, or direct download URLs from the papers.
- **Use \`run_experiment\` for all Python experiment scripts.** It auto-routes to local or remote based on resource rules. You never need to decide where to run. For remote execution, the wrapper handles venv creation, package installation, and activation automatically. Just write a \`requirements.txt\` and provide the script name.
- **run_experiment (remote path) handles EVERYTHING automatically and returns immediately.** The remote wrapper: (1) cds into the experiment directory, (2) creates .venv if needed, (3) installs requirements.txt if changed, (4) activates .venv, (5) runs your command, (6) captures exit code. So just provide the script name, e.g. \`run_experiment(script="experiment.py")\`. After submitting, **keep working** — don't just call check_job in a loop. Do something useful (read papers, write code) and check back later.
- **NEVER use execute_remote or run_experiment for checking files, reading logs, or listing results.** Use read_file or get_workspace for that.
- **NEVER write or run connection tests, smoke tests, hello-world probes, or environment/workspace check scripts.** Those are infrastructure actions, not research actions. Use \`diagnose_remote_host\`, \`validate_environment\`, \`get_workspace\`, \`read_file\`, \`check_job\`, and \`cancel_job\`.
- **When the remote workspace is busy, submission is forbidden.** Do not try another script, a probe, or a legacy \`execute_remote\` command. Inspect or cancel the active job instead.
- **ALWAYS use flush=True in print() and save results incrementally.** Remote jobs buffer stdout — without flushing you won't see progress. Without incremental saves, a crash after training means zero results.
- **Save lessons with save_lesson whenever you fix a non-obvious bug or discover a practical trick.** Future you (and other projects) will benefit. Don't save obvious things — save things that cost you time to figure out.
- Use log_finding liberally: record hypotheses, findings, decisions, and breakthroughs. This is your lab notebook.
- Use update_hypothesis to track evidence for/against each hypothesis as you go.
- **NEVER design a follow-up experiment after failure without consulting literature first.** Use search_library + query_insights before retrying. Blind trial-and-error is not science.
- **Consult papers CONTINUOUSLY, not just at the start.** Every 2-3 experiments, search your library or find new papers to inform your next steps. As results come in, the questions change — your literature review should evolve too. Use \`search_library\` with SPECIFIC questions about your current results (not the original broad topic). If a result surprises you, find a paper that explains why.
- **NEVER wrap up or conclude on your own.** Sessions auto-continue. Always plan your next experiment. The user will stop you when they're satisfied.

## Current Knowledge
${papers.length > 0 ? `Papers in collection (${papers.length}):\n${papers.map((p) => `- "${p.title}"${p.abstract ? `: ${p.abstract.slice(0, 200)}` : ""}${p.summary ? `\n  Summary: ${p.summary.slice(0, 200)}` : ""}`).join("\n")}` : "No papers collected yet."}`;
}

// ── Messages ─────────────────────────────────────────────────────

function buildMessages(
  project: { brief: string; hypotheses: { statement: string; status: string }[]; log: { type: string; content: string; metadata?: string | null }[] },
  papers: { title: string }[],
  userMessage: string | null,
  researchLog?: string,
  researchState?: string,
): { role: "user" | "assistant"; content: string }[] {
  const messages: { role: "user" | "assistant"; content: string }[] = [];

  // Build the initial user message with context
  let context = "";

  // Inject structured research state (primary reference for the agent)
  if (researchState && researchState.trim().length > 50) {
    context += `\n\n## RESEARCH STATE (structured — use as primary reference)\n${researchState}\n`;
  }

  // Inject the persistent research log (user-editable)
  if (researchLog && researchLog.trim().length > 50) {
    // Truncate more aggressively since research state captures the essentials
    const logContent = researchLog.length > 3000
      ? researchLog.slice(0, 2000) + "\n\n[...truncated — read RESEARCH_LOG.md for the full log...]\n\n" + researchLog.slice(-1000)
      : researchLog;
    context += `\n\n## RESEARCH_LOG.md (your persistent lab notebook — READ THIS CAREFULLY)\n${logContent}`;
  }

  if (project.hypotheses.length > 0) {
    context += `\n\nCurrent hypotheses:\n${project.hypotheses.map((h) => `- [${h.status}] ${h.statement}`).join("\n")}`;
  }

  // Surface oracle hints PROMINENTLY — they must never be missed
  const oracleHints = project.log.filter((l) => {
    if (!l.metadata) return false;
    try { return JSON.parse(l.metadata).oracleHint === true; } catch { return false; }
  });
  if (oracleHints.length > 0) {
    context += `\n\n## ⚡ ORACLE HINTS (from an expert — ALWAYS follow these)\n${oracleHints.map((l) => l.content).join("\n")}`;
  }

  // Include recent DB log entries not already in the file
  const recentLog = project.log
    .filter((l) => !["agent_suggestion", "agent_reasoning", "agent_tool_call"].includes(l.type))
    .filter((l) => {
      // Exclude ground truth entries (benchmarks) from agent context
      if (!l.metadata) return true;
      try {
        const meta = JSON.parse(l.metadata);
        return !meta.groundTruth && !meta.oracleHint; // hints shown separately above
      } catch { return true; }
    })
    .slice(0, 10);
  if (recentLog.length > 0) {
    context += `\n\nRecent activity:\n${recentLog.map((l) => `[${l.type}] ${l.content}`).join("\n")}`;
  }

  if (userMessage) {
    messages.push({ role: "user", content: userMessage + context });
  } else {
    let brief = project.brief;
    let briefConstraints = "";
    let briefSubQuestions: string[] = [];
    try {
      const parsed = JSON.parse(project.brief);
      brief = parsed.question || parsed.topic || project.brief;
      if (parsed.constraints) briefConstraints = parsed.constraints;
      if (Array.isArray(parsed.subQuestions) && parsed.subQuestions.length > 0) briefSubQuestions = parsed.subQuestions;
    } catch { /* plain text */ }

    const constraintBlock = briefConstraints ? `\n\nUser constraints/focus: ${briefConstraints}` : "";
    const subQBlock = briefSubQuestions.length > 0 ? `\nSub-questions to address:\n${briefSubQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}` : "";

    const hasWork = papers.length > 0 || project.hypotheses.length > 0;
    const hasPapersNoHypotheses = papers.length > 0 && project.hypotheses.length === 0;
    const allHypothesesResolved = project.hypotheses.length > 0 && project.hypotheses.every((h) => h.status === "SUPPORTED" || h.status === "REFUTED");

    messages.push({
      role: "user",
      content: hasWork
        ? `Continue researching this topic: ${brief}${subQBlock}${constraintBlock}

You already have ${papers.length} papers and prior work.

**FIRST ACTION: Read RESEARCH_LOG.md and write an updated plan.** Review the previous plan, check what was accomplished, and write a revised plan for this session. What changed? What did you learn? What should the next steps be?

Then: Check the existing results files with list_files and read_file before starting new experiments. If experiment code already exists, review it, fix any issues, and re-run. Do NOT re-search for papers you already have.

IMPORTANT: Don't just re-run what failed. Critically examine the results so far. What's missing? What wasn't tested? What would a reviewer criticize? Design follow-up experiments that address these gaps. Your goal is to produce findings that are NOVEL — something not already known from the papers.${hasPapersNoHypotheses ? `

CRITICAL: You have ${papers.length} papers but NO hypotheses yet. Before running any experiments, you MUST formulate 2-3 specific, testable hypotheses using log_finding(type="hypothesis"). Read the papers first if you haven't, extract their key claims and methods, then formulate hypotheses that you can test experimentally.` : ""}${allHypothesesResolved ? `

All current hypotheses have been resolved (supported or refuted). Consider: (1) formulating NEW hypotheses based on what you learned, (2) using complete_iteration to start a new research cycle with a fresh direction, or (3) running deeper experiments on the most interesting findings.` : ""}${context}`
        : `Start researching this topic: ${brief}${subQBlock}${constraintBlock}

YOUR FIRST ACTION: Write a research plan to RESEARCH_LOG.md. Before searching papers, before running experiments — PLAN. Include your goal, initial hypotheses about what might work, what angles to search, and what a successful outcome looks like.

Then follow the research cycle:
1. Execute your plan: search broadly for papers (dispatch_scouts with 2-3 angles)
2. Read the most relevant ones — extract specific methods, datasets, baselines, and numerical results
3. REPLAN: update your plan based on what you found in the literature
4. Formulate 2-3 specific, testable hypotheses
5. Design your first experiment WITH baselines from the literature
6. Run it, then CRITIQUE the results ruthlessly
7. REPLAN: update your plan based on experimental results
8. Run follow-up experiments based on your revised plan
9. Keep iterating — each cycle starts with a plan revision

Do NOT stop after one experiment. A single experiment is a first draft, not a result.${context}`,
    });
  }

  return messages;
}

// ── Thinking hints ──────────────────────────────────────────────

function thinkingHint(toolCalls?: { toolName: string; input: unknown }[]): string {
  if (!toolCalls || toolCalls.length === 0) return "Deciding next step...";
  const last = toolCalls[toolCalls.length - 1];
  switch (last.toolName) {
    case "search_papers":
      return "Analyzing search results and deciding which papers to read...";
    case "remove_paper":
      return "Cleaning up irrelevant papers...";
    case "read_paper":
      return "Processing paper content and extracting key insights...";
    case "write_file":
      return "Reviewing written code and planning next action...";
    case "execute_command": // legacy — tool removed but keep case for old steps
      return "Analyzing command output...";
    case "read_remote_file": // legacy — merged into read_file
      return "Reading remote file...";
    case "run_experiment":
      return "Experiment routed — processing...";
    case "execute_remote":
      return "Job submitted — continuing with other work...";
    case "check_job":
      return "Reviewing job status...";
    case "wait_for_jobs":
      return "Waiting for background jobs to complete...";
    case "log_finding":
      return "Continuing research based on findings...";
    case "search_library":
      return "Analyzing library search results for relevant techniques...";
    case "query_insights":
      return "Reviewing Mind Palace insights for applicable methods...";
    case "query_skills":
      return "Building reusable skill cards from prior literature...";
    case "web_search":
      return "Reviewing web search results...";
    case "fetch_webpage":
      return "Reading webpage content...";
    case "view_figures":
      return "Examining paper figures and tables...";
    case "run_experiment_sweep":
      return "Submitting experiment variants in parallel...";
    case "dispatch_scouts":
      return "Literature scouts are searching in the background...";
    case "dispatch_reviewer":
      return "Adversarial reviewer is analyzing in the background...";
    case "dispatch_reproducer":
      return "Reproducer is verifying claims in the background...";
    // case "dispatch_experimenter": (disabled)
    //   return "Experiment runner is working in the background...";
    case "dispatch_synthesizer":
      return "Synthesizer is analyzing papers in the background...";
    // case "dispatch_analyst": (disabled)
    //   return "Analyst is running diagnostics in the background...";
    case "dispatch_architect":
      return "Architect is designing novel approaches in the background...";
    case "dispatch_provocateur":
      return "Provocateur is thinking laterally in the background...";
    case "design_creative_portfolio":
      return "Designing a creative experiment portfolio...";
    case "monitor_experiment":
      return "Checking experiment health...";
    case "collect_results":
      return "Reviewing sub-agent findings...";
    case "adversarial_review":
      return "Processing adversarial peer review feedback...";
    case "save_lesson":
      return "Saving process lesson for future sessions...";
    case "complete_iteration":
      return "Transitioning to next research iteration...";
    case "update_hypothesis":
      return "Updating hypothesis status with evidence...";
    case "define_evaluation_protocol":
      return "Recording experiment rigor protocol...";
    case "show_evaluation_protocol":
      return "Loading active evaluation protocol...";
    default:
      return "Thinking about next step...";
  }
}

// ── Tools ────────────────────────────────────────────────────────

function createTools(
  projectId: string,
  userId: string,
  workDir: string,
  emit: (e: AgentEvent) => void,
  remoteHosts: { id: string; alias: string; isDefault: boolean }[],
  recordStep: (type: string, title: string, status: "COMPLETED" | "FAILED", output: unknown, phase?: string) => Promise<void>,
  recordStepTx: (tx: ResearchTx, type: string, title: string, status: "COMPLETED" | "FAILED", output: unknown, phase?: string) => Promise<void>,
  currentIteration: { id: string; number: number },
  sharedDir: string,
  onIterationAdvance?: (newId: string, newNumber: number) => void,
  agentModel?: Parameters<typeof streamText>[0]["model"],
  expCounter?: { value: number },
  searchCounter?: { value: number },
  cachedGpuInfo?: { alias: string; gpuCount: number }[],
  bannedPapers?: { title: string; doi?: string | null; arxivId?: string | null }[],
  isBenchmarkProject?: boolean,
  mockExecutor?: MockExecutorOptions,
  sessionControl?: { signal: AbortSignal; assertActive: () => void },
) {
  // Helper: check if a paper is banned (for benchmarks)
  const isBanned = (r: { title: string; doi?: string | null; arxivId?: string | null }) => {
    if (!bannedPapers || bannedPapers.length === 0) return false;
    for (const banned of bannedPapers) {
      if (banned.doi && r.doi && banned.doi === r.doi) return true;
      if (banned.arxivId && r.arxivId && banned.arxivId === r.arxivId) return true;
      // Fuzzy title match — normalize and check containment
      const normBanned = banned.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const normTitle = r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (normBanned.length > 20 && (normTitle.includes(normBanned) || normBanned.includes(normTitle))) return true;
    }
    return false;
  };

  // Track active background job IDs for this session
  const activeJobIds = new Set<string>();
  const allowSyntheticRemoteHosts = !!mockExecutor?.enabled;
  const launchTaskInBackground = (taskId: string, context: string) => {
    void launchSubAgentTask(taskId, context).catch((err) => {
      console.error(`[${context}] Task ${taskId} failed:`, err);
    });
  };
  // Track pyright analysis attempts per script name (prevents infinite fix loops)
  const analysisAttempts = new Map<string, number>();
  const consecutiveSearches = searchCounter || { value: 0 };
  // Failure tracking is DB-backed (survives restarts) — see execute_remote gate
  // Experiment counter for sequential naming (shared with caller via ref object)
  const experimentCount = expCounter || { value: 0 };

  // No shell access — execute_command removed. All operations go through typed tools.

  let committedApproachInner: string | null = null;

  const refreshResearchState = async () => {
    try {
      sessionControl?.assertActive();
      const { generateResearchState } = await import("./research-state");
      await generateResearchState(projectId, workDir);
    } catch {
      // non-fatal
    }
  };

  const syncCredibilityState = async () => {
    try {
      sessionControl?.assertActive();
      await syncClaimCoordinator(projectId, {
        workDir,
        activeIterationId: currentIteration.id,
        autoDispatch: true,
      });
    } catch (err) {
      console.warn("[research-agent] claim coordinator sync failed:", (err as Error).message);
    }
    await refreshResearchState();
  };

  const runDbTransaction = async <T>(operation: (tx: ResearchTx) => Promise<T>): Promise<T> => {
    sessionControl?.assertActive();
    const result = await prisma.$transaction(async (tx) => {
      sessionControl?.assertActive();
      return operation(tx);
    });
    sessionControl?.assertActive();
    return result;
  };

  const normalizeClaimKey = (statement: string) =>
    statement.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const getSelectedRemoteHost = async (hostAlias?: string) =>
    findPreferredRemoteHost({
      alias: hostAlias,
      includeSynthetic: allowSyntheticRemoteHosts,
    });

  // autoAdvanceExperimentPhaseIfNeeded removed — FSM auto-transitions handle this.

  const assessExperimentSubmission = async (params: {
    command: string;
    scriptName: string;
    requireHypothesis: boolean;
    hypothesisId?: string;
    hostId?: string;
    scriptHash?: string;
  }) => {
    const readiness = await computeExperimentSubmissionReadiness({
      projectId,
      command: params.command,
      scriptName: params.scriptName,
      requireHypothesis: params.requireHypothesis,
      hypothesisId: params.hypothesisId,
      hostId: params.hostId,
    });

    const extraIssues: string[] = [];

    if (!isBenchmarkProject) {
      const failureGate = await getFailedExperimentSubmissionBlock(projectId);
      if (failureGate) extraIssues.push(failureGate);
    }

    const convergenceBarrier = await getExperimentSubmissionConvergenceBarrier(projectId, params.scriptName);
    if (convergenceBarrier) extraIssues.push(convergenceBarrier);

    if (params.scriptHash) {
      const failedCodeBarrier = await getFailedCodeResubmissionBarrier(projectId, params.scriptHash);
      if (failedCodeBarrier) extraIssues.push(failedCodeBarrier);

      const [exactFailCount, hashFailCount, totalFails] = await Promise.all([
        prisma.remoteJob.count({
          where: { projectId, status: "FAILED", command: { contains: params.scriptName } },
        }),
        prisma.remoteJob.count({
          where: { projectId, status: "FAILED", scriptHash: params.scriptHash },
        }),
        prisma.remoteJob.count({
          where: { projectId, status: "FAILED" },
        }),
      ]);

      if (exactFailCount >= 2) {
        extraIssues.push(`"${params.scriptName}" has failed ${exactFailCount} times. Rewrite it in place or change the approach before resubmitting.`);
      }
      if (hashFailCount >= 3) {
        extraIssues.push("This exact script content has already failed repeatedly under one or more filenames. Change the code before resubmitting.");
      }
      if (totalFails >= 8) {
        emit({ type: "text", content: `\n\n[System: WARNING — ${totalFails} total experiment failures. Step back and REPLAN before running more experiments.]\n\n` });
      }
    }

    const formatted = formatExperimentSubmissionReadiness(readiness, extraIssues);
    if (formatted) {
      return {
        ok: false as const,
        message: formatted,
      };
    }

    const autoAdvanceNote: string | null = null;

    return {
      ok: true as const,
      hypothesisId: readiness.resolvedHypothesisId,
      hypothesisNote: readiness.hypothesisNote,
      autoAdvanceNote,
    };
  };

  const loadReviewClaims = async (claimIds?: string[]) => {
    if (!claimIds || claimIds.length === 0) return [];
    return prisma.researchClaim.findMany({
      where: { projectId, id: { in: claimIds } },
      select: { id: true, statement: true, status: true, summary: true },
      orderBy: { updatedAt: "desc" },
    });
  };

  const ingestTaskClaimReviews = async (task: {
    id: string;
    role: string;
    output: string | null;
  }) => {
    if (!task.output || !["reviewer", "reproducer"].includes(task.role)) return [];

    let parsedOutput: Record<string, unknown>;
    try {
      parsedOutput = JSON.parse(task.output) as Record<string, unknown>;
    } catch {
      return [];
    }

    if (parsedOutput.claimReviewsAppliedAt) return [];
    const claimReviews = Array.isArray(parsedOutput.claimReviews)
      ? parsedOutput.claimReviews as Array<Record<string, unknown>>
      : [];
    if (claimReviews.length === 0) return [];

    const projectClaims = await prisma.researchClaim.findMany({
      where: { projectId },
      select: { id: true, statement: true },
      orderBy: { updatedAt: "desc" },
    });

    const imported: string[] = [];

    for (const review of claimReviews) {
      const claimId = typeof review.claimId === "string" ? review.claimId : null;
      const claimStatement = typeof review.claimStatement === "string" ? review.claimStatement : null;
      const status = typeof review.status === "string" ? review.status.toUpperCase() : "";
      const confidence = typeof review.confidence === "string" ? review.confidence.toUpperCase() : undefined;
      const notes = typeof review.notes === "string" ? review.notes : null;

      if (!["SUPPORTED", "CONTESTED", "REPRODUCED", "RETRACTED"].includes(status)) continue;

      const matchedClaim = claimId
        ? projectClaims.find((claim) => claim.id === claimId)
        : claimStatement
          ? projectClaims.find((claim) => {
              const expected = normalizeClaimKey(claimStatement);
              const actual = normalizeClaimKey(claim.statement);
              return expected === actual || actual.includes(expected) || expected.includes(actual);
            })
          : null;

      if (!matchedClaim) {
        imported.push(`unmatched → ${status.toLowerCase()}`);
        continue;
      }

      await reviewClaim({
        claimId: matchedClaim.id,
        status: status as "SUPPORTED" | "CONTESTED" | "REPRODUCED" | "RETRACTED",
        confidence: confidence as "PRELIMINARY" | "MODERATE" | "STRONG" | undefined,
        notes: notes || undefined,
        createdBy: task.role === "reproducer" ? "reproducer" : "reviewer",
        evidence: [{
          kind: "agent_task",
          taskId: task.id,
          supports: !["CONTESTED", "RETRACTED"].includes(status),
          strength: task.role === "reproducer"
            ? "DIRECT"
            : ["CONTESTED", "RETRACTED"].includes(status)
              ? "REBUTTAL"
              : "INDIRECT",
          rationale: notes || `${task.role} assessment imported from collect_results`,
        }],
      });

      await prisma.researchLogEntry.create({
        data: {
          projectId,
          type: "observation",
          content: `${task.role === "reproducer" ? "Reproducer" : "Reviewer"} updated claim ${matchedClaim.id.slice(0, 8)} to ${status}. ${notes || ""}`.trim(),
        },
      }).catch(() => {});

      imported.push(`${matchedClaim.id.slice(0, 8)} → ${status.toLowerCase()}`);
    }

    parsedOutput.claimReviewsAppliedAt = new Date().toISOString();
    parsedOutput.claimReviewImportSummary = imported;
    await prisma.agentTask.update({
      where: { id: task.id },
      data: { output: JSON.stringify(parsedOutput) },
    });
    await syncCredibilityState();

    return imported;
  };

  return {
    commit_to_approach: tool({
      description: "Commit to a specific approach/mechanism design. Once committed, you cannot redesign from scratch — only iterate and improve. Use this after your mechanism design is written and you're confident in the direction. To change approaches later, you must explicitly call abandon_approach with evidence.",
      inputSchema: z.object({
        approach: z.string().describe("Name/description of the approach you're committing to"),
        rationale: z.string().describe("Why this approach and not alternatives"),
      }),
      execute: async ({ approach, rationale }: { approach: string; rationale: string }) => {
        committedApproachInner = approach;
        // Also create an ApproachBranch record for structured tracking
        let branchId = "";
        try {
          const branch = await prisma.approachBranch.create({
            data: { projectId, name: approach, description: rationale, status: "ACTIVE" },
          });
          branchId = branch.id.slice(0, 8);
        } catch {
          // Non-fatal — approach tracking is optional
        }
        await prisma.researchLogEntry.create({
          data: { projectId, type: "decision", content: `COMMITTED TO APPROACH: ${approach}\nRationale: ${rationale}` },
        });
        return `Committed to "${approach}"${branchId ? ` (approach ID: ${branchId})` : ""}. You are now locked into iterating on this approach. To change direction, you must call abandon_approach with evidence that this approach is fundamentally flawed.`;
      },
    }),

    abandon_approach: tool({
      description: "Abandon the current committed approach. Requires strong evidence that the approach is fundamentally flawed (not just 'needs more tuning'). After abandoning, you must commit to a new approach before running more experiments.",
      inputSchema: z.object({
        evidence: z.string().describe("Concrete evidence why the approach is fundamentally flawed"),
        experiments_tried: z.number().describe("How many experiments you ran with this approach"),
      }),
      execute: async ({ evidence, experiments_tried }: { evidence: string; experiments_tried: number }) => {
        if (experiments_tried < 3) {
          return `BLOCKED — You've only run ${experiments_tried} experiment(s) with the current approach. Run at least 3 before abandoning. Iterate and debug, don't give up early.`;
        }
        const prev = committedApproachInner;
        committedApproachInner = null;
        // Update the most recent ACTIVE approach branch to ABANDONED
        try {
          const activeBranch = await prisma.approachBranch.findFirst({
            where: { projectId, status: "ACTIVE" },
            orderBy: { createdAt: "desc" },
          });
          if (activeBranch) {
            await prisma.approachBranch.update({
              where: { id: activeBranch.id },
              data: { status: "ABANDONED" },
            });
          }
        } catch {
          // Non-fatal — approach tracking is optional
        }
        await prisma.researchLogEntry.create({
          data: { projectId, type: "decision", content: `ABANDONED APPROACH: ${prev}\nEvidence: ${evidence}\nExperiments tried: ${experiments_tried}` },
        });
        return `Abandoned "${prev}". You must now commit_to_approach with a new direction before running more experiments.`;
      },
    }),

    // ── Phase-gated research tools ─────────────────────────────────

    // advance_phase removed — FSM transition engine owns all state changes.
    // The agent never needs to call this; auto-transitions fire when guards are met.

    register_approach: tool({
      description: "Register a research approach in the approach tree. Use this to track different directions you're exploring. Returns an ID for linking experiments via record_result.",
      inputSchema: z.object({
        name: z.string().describe("Short name, e.g. 'LoRA fine-tuning with r=16'"),
        description: z.string().optional().describe("Detailed description of the approach"),
        parent_id: z.string().optional().describe("Parent approach ID if this is a sub-approach/refinement"),
        hypothesis_id: z.string().optional().describe("ID of the hypothesis this approach serves"),
        role: z.enum(["primary", "control", "ablation", "comparison"]).default("primary").describe("Role of this approach relative to the hypothesis"),
      }),
      execute: async ({ name, description, parent_id, hypothesis_id, role }: { name: string; description?: string; parent_id?: string; hypothesis_id?: string; role?: string }) => {
        if (parent_id) {
          const parent = await prisma.approachBranch.findFirst({ where: { id: parent_id, projectId } });
          if (!parent) return `Parent approach "${parent_id}" not found.`;
        }
        // Deduplicate: return existing approach if one with the same name exists
        const existing = await prisma.approachBranch.findFirst({
          where: { projectId, name, parentId: parent_id || null },
        });
        if (existing) {
          // Update description if provided
          if (description && description !== existing.description) {
            await prisma.approachBranch.update({ where: { id: existing.id }, data: { description } });
          }
          return `Approach "${name}" already exists (ID: ${existing.id.slice(0, 8)}). Use this ID in record_result.`;
        }
        const branch = await prisma.approachBranch.create({
          data: { projectId, name, description, parentId: parent_id },
        });
        if (hypothesis_id) {
          await prisma.hypothesisApproachLink.create({
            data: {
              hypothesisId: hypothesis_id,
              approachId: branch.id,
              role: role || "primary",
            },
          }).catch(() => {}); // Non-fatal — link is advisory
        }
        await prisma.researchLogEntry.create({
          data: { projectId, type: "decision", content: `Registered approach: ${name}` },
        });
        return `Approach "${name}" registered (ID: ${branch.id.slice(0, 8)}). Use this ID in record_result to link experiments.`;
      },
    }),

    define_metrics: tool({
      description: "Define the canonical metrics for this research project. All experiments will be measured against these metrics, enabling cross-experiment comparison. Call this in the hypothesis phase before running experiments. If the metric schema changes, existing results are automatically recomputed.",
      inputSchema: z.object({
        metrics: z.array(z.object({
          name: z.string().describe("Short metric name (e.g., 'f1', 'accuracy', 'loss')"),
          direction: z.enum(["higher", "lower"]).describe("Whether higher or lower values are better"),
          description: z.string().describe("What this metric measures"),
        })).min(1).describe("The canonical metrics for this project"),
      }),
      execute: async ({ metrics }: { metrics: Array<{ name: string; direction: string; description: string }> }) => {
        const existingWithRaw = await runDbTransaction(async (tx) => {
          await tx.researchProject.update({
            where: { id: projectId },
            data: { metricSchema: JSON.stringify(metrics) },
          });

          const rawCount = await tx.experimentResult.count({
            where: { projectId, rawMetrics: { not: null } },
          });

          await tx.researchLogEntry.create({
            data: {
              projectId,
              type: "decision",
              content: `Defined project metrics: ${metrics.map(m => `${m.name} (${m.direction} is better)`).join(", ")}`,
            },
          });

          return rawCount;
        });

        if (existingWithRaw > 0) {
          // Trigger recompute in background
          import("./metric-recompute").then(({ recomputeMetrics }) => {
            recomputeMetrics(projectId).then(count => {
              console.log(`[define_metrics] Recomputed ${count} experiment results`);
            }).catch(err => console.warn("[define_metrics] Recompute failed:", err));
          });
        }

        // FSM: auto-resolve DESIGN prerequisites (auto-create protocol from metrics)
        await resolveDesignPrerequisites(projectId).catch(() => {});

        return `Metrics defined: ${metrics.map(m => `${m.name} (${m.direction})`).join(", ")}. All experiments will be measured against these.${existingWithRaw > 0 ? ` Recomputing ${existingWithRaw} existing results in background.` : ""}`;
      },
    }),

    define_evaluation_protocol: tool({
      description: "Define the rigorous experiment evaluation protocol for this project: datasets, seeds, minimum runs, statistical test, and acceptance criteria. This creates an explicit contract for objective experimentation.",
      inputSchema: z.object({
        primary_metric: z.string().describe("Primary decision metric used to accept/reject hypotheses (e.g., 'f1', 'accuracy')"),
        secondary_metrics: z.array(z.string()).default([]).optional().describe("Additional metrics to track"),
        datasets: z.array(z.string()).min(1).describe("Datasets/splits used for evaluation (e.g., 'SQuAD v2 validation', 'MMLU test')"),
        seeds: z.array(z.number().int()).min(1).max(20).describe("Allowed random seeds for reproducibility (e.g., [11, 23, 47])"),
        min_runs: z.number().int().min(1).max(20).default(3).optional().describe("Minimum repeat runs before drawing conclusions"),
        statistical_test: z.string().default("bootstrap 95% CI").optional().describe("Statistical procedure used for confidence claims"),
        acceptance_criteria: z.string().describe("Explicit pass/fail criteria for the hypothesis"),
        required_baselines: z.array(z.string()).default([]).optional().describe("Baseline methods that must be compared"),
        notes: z.string().optional().describe("Optional protocol notes or constraints"),
      }),
      execute: async ({
        primary_metric,
        secondary_metrics,
        datasets,
        seeds,
        min_runs,
        statistical_test,
        acceptance_criteria,
        required_baselines,
        notes,
      }: {
        primary_metric: string;
        secondary_metrics?: string[];
        datasets: string[];
        seeds: number[];
        min_runs?: number;
        statistical_test?: string;
        acceptance_criteria: string;
        required_baselines?: string[];
        notes?: string;
      }) => {
        await runDbTransaction(async (tx) => {
          await saveEvaluationProtocolTx(projectId, {
            primaryMetric: primary_metric,
            secondaryMetrics: secondary_metrics || [],
            datasets,
            seeds,
            minRuns: min_runs || 3,
            statisticalTest: statistical_test || "bootstrap 95% CI",
            acceptanceCriteria: acceptance_criteria,
            requiredBaselines: required_baselines || [],
            notes,
          }, tx);

          await recordStepTx(tx, "analyze_results", `Define evaluation protocol (${primary_metric})`, "COMPLETED", {
            primaryMetric: primary_metric,
            datasets,
            seeds,
            minRuns: min_runs || 3,
          }, "hypothesis");
        });

        const protocol = await getEvaluationProtocol(projectId);
        if (!protocol) return "Evaluation protocol save failed unexpectedly. Retry define_evaluation_protocol.";
        return `Evaluation protocol defined.\n\n${summarizeEvaluationProtocol(protocol.protocol)}`;
      },
    }),

    show_evaluation_protocol: tool({
      description: "Show the currently active evaluation protocol for this project (metrics, seeds, datasets, acceptance criteria).",
      inputSchema: z.object({}),
      execute: async () => {
        const protocol = await getEvaluationProtocol(projectId);
        if (!protocol) {
          return "No evaluation protocol defined yet. Use define_evaluation_protocol before running new experiments.";
        }
        return `Evaluation protocol (defined ${protocol.createdAt.toISOString()}):\n\n${summarizeEvaluationProtocol(protocol.protocol)}`;
      },
    }),

    record_claim: tool({
      description: "Record a single atomic research claim in the claim ledger. Use this only for plain-text assertions that can be reviewed, contested, reproduced, and promoted into long-lived memory.",
      inputSchema: z.object({
        statement: z.string().describe("A single plain-text claim. No markdown headings, bullet lists, or multi-section summaries."),
        type: z.enum(["finding", "comparison", "hypothesis_assessment", "methodological", "risk", "reproduction"]).default("finding"),
        summary: z.string().optional().describe("Optional one-line summary or qualifier."),
        hypothesis_id: z.string().optional().describe("Related hypothesis ID, if any."),
        result_id: z.string().optional().describe("Related ExperimentResult ID, if any."),
        task_id: z.string().optional().describe("Related AgentTask ID, if any."),
        notes: z.string().optional().describe("Optional internal notes."),
      }),
      execute: async ({ statement, type, summary, hypothesis_id, result_id, task_id, notes }: {
        statement: string;
        type: "finding" | "comparison" | "hypothesis_assessment" | "methodological" | "risk" | "reproduction";
        summary?: string;
        hypothesis_id?: string;
        result_id?: string;
        task_id?: string;
        notes?: string;
      }) => {
        const claimId = await createClaim({
          projectId,
          statement,
          type,
          summary,
          hypothesisId: hypothesis_id || null,
          resultId: result_id || null,
          taskId: task_id || null,
          notes: notes || null,
          createdBy: "agent",
          createdFrom: "record_claim",
        });
        await syncCredibilityState();
        return `Claim recorded (${claimId.slice(0, 8)}): ${statement.slice(0, 160)}`;
      },
    }),

    attach_claim_evidence: tool({
      description: "Attach explicit evidence to an existing claim. Use this after a review, experiment, or literature lookup so the claim has traceable support or rebuttal.",
      inputSchema: z.object({
        claim_id: z.string().describe("Claim ID to attach evidence to."),
        kind: z.enum(["experiment_result", "artifact", "paper", "hypothesis", "log_entry", "agent_task", "remote_job"]),
        supports: z.boolean().default(true).optional(),
        strength: z.enum(["DIRECT", "INDIRECT", "CONTEXT", "REBUTTAL"]).default("DIRECT").optional(),
        rationale: z.string().optional(),
        excerpt: z.string().optional(),
        locator: z.string().optional(),
        paper_id: z.string().optional(),
        hypothesis_id: z.string().optional(),
        result_id: z.string().optional(),
        artifact_id: z.string().optional(),
        log_entry_id: z.string().optional(),
        task_id: z.string().optional(),
        remote_job_id: z.string().optional(),
      }),
      execute: async ({
        claim_id,
        kind,
        supports,
        strength,
        rationale,
        excerpt,
        locator,
        paper_id,
        hypothesis_id,
        result_id,
        artifact_id,
        log_entry_id,
        task_id,
        remote_job_id,
      }: {
        claim_id: string;
        kind: "experiment_result" | "artifact" | "paper" | "hypothesis" | "log_entry" | "agent_task" | "remote_job";
        supports?: boolean;
        strength?: "DIRECT" | "INDIRECT" | "CONTEXT" | "REBUTTAL";
        rationale?: string;
        excerpt?: string;
        locator?: string;
        paper_id?: string;
        hypothesis_id?: string;
        result_id?: string;
        artifact_id?: string;
        log_entry_id?: string;
        task_id?: string;
        remote_job_id?: string;
      }) => {
        await attachClaimEvidence(claim_id, {
          kind,
          supports,
          strength,
          rationale,
          excerpt,
          locator,
          paperId: paper_id,
          hypothesisId: hypothesis_id,
          resultId: result_id,
          artifactId: artifact_id,
          logEntryId: log_entry_id,
          taskId: task_id,
          remoteJobId: remote_job_id,
        });
        await syncCredibilityState();
        return `Attached ${supports === false ? "rebuttal" : "supporting"} evidence (${kind}) to claim ${claim_id.slice(0, 8)}.`;
      },
    }),

    review_claim: tool({
      description: "Update a claim after reviewer or reproducer scrutiny. Use this to mark claims SUPPORTED, CONTESTED, REPRODUCED, or RETRACTED.",
      inputSchema: z.object({
        claim_id: z.string(),
        status: z.enum(["SUPPORTED", "CONTESTED", "REPRODUCED", "RETRACTED"]),
        confidence: z.enum(["PRELIMINARY", "MODERATE", "STRONG"]).optional(),
        notes: z.string().optional(),
        reviewer_role: z.enum(["reviewer", "reproducer", "user", "system"]).default("reviewer").optional(),
      }),
      execute: async ({ claim_id, status, confidence, notes, reviewer_role }: {
        claim_id: string;
        status: "SUPPORTED" | "CONTESTED" | "REPRODUCED" | "RETRACTED";
        confidence?: "PRELIMINARY" | "MODERATE" | "STRONG";
        notes?: string;
        reviewer_role?: "reviewer" | "reproducer" | "user" | "system";
      }) => {
        await reviewClaim({
          claimId: claim_id,
          status,
          confidence,
          notes,
          createdBy: reviewer_role || "reviewer",
        });
        await syncCredibilityState();
        return `Claim ${claim_id.slice(0, 8)} marked ${status}${confidence ? ` (${confidence})` : ""}.`;
      },
    }),

    promote_claim_to_memory: tool({
      description: "Promote a supported claim into persistent process memory. This is the credibility-safe path for long-lived lessons and should replace saving research findings directly as lessons.",
      inputSchema: z.object({
        claim_id: z.string(),
        category: z.enum(["package", "environment", "code_pattern", "debugging", "dataset", "performance", "general"]),
        lesson: z.string().optional(),
        context: z.string().optional(),
      }),
      execute: async ({ claim_id, category, lesson, context }: {
        claim_id: string;
        category: "package" | "environment" | "code_pattern" | "debugging" | "dataset" | "performance" | "general";
        lesson?: string;
        context?: string;
      }) => {
        if (isBenchmarkProject) return "Memory promotion skipped in benchmark mode.";
        const memory = await promoteClaimToMemory({
          claimId: claim_id,
          userId,
          category,
          lesson,
          context: context || null,
          projectId,
        });
        await syncCredibilityState();
        return `Claim ${claim_id.slice(0, 8)} promoted to process memory (${memory.id.slice(0, 8)}).`;
      },
    }),

    show_claim_ledger: tool({
      description: "Show the current project claim ledger with statuses and evidence counts.",
      inputSchema: z.object({}),
      execute: async () => {
        const claims = await getClaimLedger(projectId);
        return formatClaimLedger(claims);
      },
    }),

    record_result: tool({
      description: "Record structured experiment results. Call this after EVERY completed experiment. Builds the results database for tracking progress and comparisons. Provide canonical metrics (matching define_metrics) and optionally raw_metrics for the full experiment-specific detail.",
      inputSchema: z.object({
        job_id: z.string().describe("Job ID from execute_remote or check_job"),
        approach_id: z.string().optional().describe("ApproachBranch ID from register_approach"),
        hypothesis_id: z.string().optional().describe("Hypothesis ID being tested"),
        baseline_id: z.string().optional().describe("ExperimentResult ID to compare against"),
        claim_ids: z.array(z.string()).optional().describe("Optional claim IDs this result should reconcile. Use this for coordinator-requested validation experiments so the right claim closes automatically."),
        metrics: z.record(z.string(), z.number()).describe("Key metrics: { accuracy: 0.85, loss: 0.23, f1: 0.81 }"),
        raw_metrics: z.record(z.string(), z.number()).optional().describe("Original experiment-specific metrics (full detail, any names)"),
        condition: z.string().optional().describe("Experimental condition (e.g., 'single agent, hypothesis-driven, budget=60')"),
        verdict: z.enum(["better", "worse", "inconclusive", "error"]).describe("How this compares to baseline or expectations"),
        summary: z.string().describe("One sentence: what this experiment demonstrated"),
      }),
      execute: async ({ job_id, approach_id, hypothesis_id, baseline_id, claim_ids, metrics, raw_metrics, condition, verdict, summary }: {
        job_id: string; approach_id?: string; hypothesis_id?: string; baseline_id?: string;
        claim_ids?: string[];
        metrics: Record<string, number>; raw_metrics?: Record<string, number>; condition?: string;
        verdict: string; summary: string;
      }) => {
        const resolvedJob = await resolveProjectRemoteJob(projectId, job_id);
        if (resolvedJob.ambiguous) {
          return `BLOCKED — Job "${job_id}" matches multiple jobs. Use a longer ID.\n\nMatches:\n${formatRemoteJobMatches(resolvedJob.matches as Array<{ id: string; command: string; status: string }>)} `;
        }
        const canonicalJobId = resolvedJob.job?.id || job_id;

        // Check for duplicate
        const existing = await prisma.experimentResult.findUnique({ where: { jobId: canonicalJobId } });
        if (existing) return `Result already recorded for job ${canonicalJobId.slice(0, 8)}.`;

        let job = resolvedJob.job;
        if (!job) {
          // List recent jobs so the agent can use the correct ID
          const recentJobs = await prisma.remoteJob.findMany({
            where: { projectId },
            orderBy: { createdAt: "desc" },
            take: 5,
            select: { id: true, command: true, status: true },
          });
          const jobList = formatRemoteJobMatches(recentJobs);
          return `BLOCKED — Job "${job_id}" not found. Use a real job ID from execute_remote or check_job.\n\nRecent jobs:\n${jobList}`;
        }
        if ((job.status === "RUNNING" || job.status === "SYNCING" || job.status === "QUEUED") && job.remoteDir) {
          try {
            const { reconcileRemoteJobState } = await import("./remote-executor");
            const reconciled = await reconcileRemoteJobState(job.id);
            if (reconciled) {
              job = reconciled;
            }
          } catch {
            // Fall back to the DB state below.
          }
        }
        if (job.status !== "COMPLETED") {
          if (job.status === "FAILED" || job.status === "CANCELLED") {
            return `BLOCKED — Job ${job_id.slice(0, 8)} is ${job.status.toLowerCase()}. Do not record an ExperimentResult for execution failures. Research failures use reflect_on_failure; code/resource failures use fix or diagnostic flows instead.`;
          }
          return `BLOCKED — Job ${job_id.slice(0, 8)} is still ${job.status.toLowerCase()}. Wait for terminal completion before recording a result.`;
        }
        const scriptName = job.command?.match(/python3?\s+(\S+\.py)/)?.[1] || job.command.slice(0, 40);
        const resolvedResultHypothesisId = hypothesis_id || job.hypothesisId || null;
        const resultContract = resolveExperimentContract({
          scriptName,
          command: job.command,
          experimentPurpose: job.experimentPurpose,
          grounding: job.grounding,
          claimEligibility: job.claimEligibility,
          promotionPolicy: job.promotionPolicy,
          evidenceClass: job.evidenceClass,
        });

        // If project has a metric schema, validate canonical metrics
        const projectRecord = await prisma.researchProject.findUnique({
          where: { id: projectId },
          select: { metricSchema: true },
        });

        let canonicalMetrics = metrics;
        if (projectRecord?.metricSchema) {
          const schema: { name: string }[] = JSON.parse(projectRecord.metricSchema);
          const schemaNames = new Set(schema.map(m => m.name));
          const providedNames = Object.keys(metrics);

          // Check if provided metrics match schema
          const matching = providedNames.filter(n => schemaNames.has(n));
          if (matching.length === 0 && raw_metrics) {
            // None match — agent provided raw metrics as canonical. Store as raw, warn.
            canonicalMetrics = {};
            // Will be recomputed by the metric system
          }
        }

        // Enforce protocol-level primary metric contract when protocol exists.
        const evaluationProtocol = await getEvaluationProtocol(projectId);
        if (evaluationProtocol) {
          const protocolCheck = checkProtocolPrimaryMetric(
            canonicalMetrics,
            raw_metrics || null,
            evaluationProtocol.protocol,
          );
          if (!protocolCheck.ok) {
            return `BLOCKED — ${protocolCheck.reason}`;
          }
        }

        // Compute comparison delta if baseline provided
        let comparison: Record<string, number> | null = null;
        if (baseline_id) {
          const baseline = await prisma.experimentResult.findUnique({ where: { id: baseline_id } });
          if (baseline?.metrics) {
            try {
              const baseMetrics = JSON.parse(baseline.metrics) as Record<string, number>;
              comparison = {};
              for (const [k, v] of Object.entries(canonicalMetrics)) {
                if (typeof baseMetrics[k] === "number") comparison[k] = Number((v - baseMetrics[k]).toFixed(6));
              }
            } catch {}
          }
        }

        const resultParameters = job?.command ? JSON.stringify({ command: job.command }) : null;
        const resultRawMetrics = raw_metrics
          ? JSON.stringify(raw_metrics)
          : Object.keys(canonicalMetrics).length === 0
            ? JSON.stringify(metrics)
            : null;
        const resultComparison = comparison ? JSON.stringify(comparison) : null;

        const result = await runDbTransaction(async (tx) => {
          const created = await tx.experimentResult.create({
            data: {
              projectId,
              jobId: canonicalJobId,
              hypothesisId: resolvedResultHypothesisId,
              experimentPurpose: resultContract.experimentPurpose,
              grounding: resultContract.grounding,
              claimEligibility: resultContract.claimEligibility,
              promotionPolicy: resultContract.promotionPolicy,
              evidenceClass: resultContract.evidenceClass,
              branchId: approach_id,
              baselineId: baseline_id, scriptName,
              parameters: resultParameters,
              metrics: JSON.stringify(canonicalMetrics),
              rawMetrics: resultRawMetrics,
              condition: condition || null,
              comparison: resultComparison,
              verdict, reflection: summary,
            },
          });

          if (approach_id && verdict === "error") {
            const errorCount = await tx.experimentResult.count({
              where: { branchId: approach_id, verdict: "error" },
            });
            if (errorCount >= 3) {
              await tx.approachBranch.update({
                where: { id: approach_id }, data: { status: "EXHAUSTED" },
              });
            }
          }
          if (approach_id && verdict === "better") {
            await tx.approachBranch.update({
              where: { id: approach_id }, data: { status: "PROMISING" },
            });
          }

          await recordStepTx(tx, "analyze_results", `Result: ${scriptName} → ${verdict}`, "COMPLETED",
            { resultId: created.id, metrics: canonicalMetrics, verdict });

          return created;
        });

        const reconciliation = await reconcileExperimentResultWithClaimCoordinator({
          projectId,
          resultId: result.id,
          remoteJobId: canonicalJobId,
          hypothesisId: resolvedResultHypothesisId,
          baselineResultId: baseline_id || null,
          verdict: verdict as "better" | "worse" | "inconclusive" | "error",
          scriptName,
          explicitClaimIds: claim_ids,
        });

        // Regenerate research state
        try {
          await syncCredibilityState();
        } catch {}

        const compStr = comparison ? Object.entries(comparison).map(([k, v]) => `${k}: ${v > 0 ? "+" : ""}${v}`).join(", ") : "";
        const reconciliationStr = reconciliation.ambiguousClaimIds.length > 0
          ? `\nCoordinator reconciliation skipped: multiple open claim obligations match this result (${reconciliation.ambiguousClaimIds.map((id) => id.slice(0, 8)).join(", ")}). Re-run record_result with claim_ids to resolve deterministically.`
          : reconciliation.matchedClaimIds.length > 0
            ? `\nCoordinator reconciled ${reconciliation.matchedClaimIds.length} claim obligation(s): ${reconciliation.matchedClaimIds.map((id) => id.slice(0, 8)).join(", ")}.`
            : "";

        return `Result recorded (${result.id.slice(0, 8)}). No claim was created automatically.\n${verdict.toUpperCase()}: ${summary}${compStr ? `\nΔ vs baseline: ${compStr}` : ""}${reconciliationStr}\nIf this result supports a durable assertion, restate it separately with record_claim or update_hypothesis.`;
      },
    }),

    reflect_on_failure: tool({
      description: "Record a research failure as a notebook dead-end with root cause analysis. Use this for RESEARCH_FAILURE outcomes that change your scientific direction. Do not use it for pure code bugs or host/environment failures.",
      inputSchema: z.object({
        job_id: z.string().describe("Job ID of the failed experiment"),
        root_cause: z.string().describe("What specifically caused the failure (be precise)"),
        what_this_teaches: z.string().describe("What you learned from this failure"),
        next_approach_should: z.string().describe("How the next attempt should differ fundamentally"),
      }),
      execute: async ({ job_id, root_cause, what_this_teaches, next_approach_should }: {
        job_id: string; root_cause: string; what_this_teaches: string; next_approach_should: string;
      }) => {
        const resolvedJob = await resolveProjectRemoteJob(projectId, job_id);
        if (resolvedJob.ambiguous) {
          return `BLOCKED — Job "${job_id}" matches multiple jobs. Use a longer ID.\n\nMatches:\n${formatRemoteJobMatches(resolvedJob.matches as Array<{ id: string; command: string; status: string }>)} `;
        }
        const job = resolvedJob.job;
        if (!job) {
          const recentJobs = await prisma.remoteJob.findMany({
            where: { projectId, status: "FAILED" },
            orderBy: { createdAt: "desc" },
            take: 5,
            select: { id: true, command: true },
          });
          const jobList = recentJobs.map(j => `- ${j.id}: ${j.command.slice(0, 60)}`).join("\n");
          return `BLOCKED — Job "${job_id}" not found. Use a real job ID.\n\nRecent failed jobs:\n${jobList}`;
        }
        const scriptName = job.command?.match(/python3?\s+(\S+\.py)/)?.[1] || job.command.slice(0, 40);

        const reflectedJobIds = await getReflectedFailureJobIds(projectId);
        if (reflectedJobIds.has(job.id)) return `Reflection already recorded for job ${job.id.slice(0, 8)}.`;

        const metadata = buildFailureReflectionMetadata({
          jobId: job.id,
          scriptName,
          rootCause: root_cause,
          lesson: what_this_teaches,
          nextApproach: next_approach_should,
        });

        await runDbTransaction(async (tx) => {
          await tx.researchLogEntry.create({
            data: {
              projectId,
              type: "dead_end",
              content: `Failure reflection (${scriptName}): ${root_cause}. Lesson: ${what_this_teaches}`,
              metadata,
            },
          });

          await recordStepTx(tx, "analyze_results", `Failure reflection: ${scriptName}`, "COMPLETED",
            {
              kind: "failure_reflection",
              jobId: job.id,
              scriptName,
              rootCause: root_cause,
              lesson: what_this_teaches,
              nextApproach: next_approach_should,
            });
        });

        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const entry = `\n### Failure Reflection (${timestamp})\n**Script:** ${scriptName}\n**Root cause:** ${root_cause}\n**Lesson:** ${what_this_teaches}\n**Next approach:** ${next_approach_should}\n`;
        await appendFile(path.join(workDir, "RESEARCH_LOG.md"), entry).catch(() => {});

        try {
          await syncCredibilityState();
        } catch {}

        return `Reflection recorded for ${scriptName}. The failure is logged as a dead end, not a claim.\nYou may now submit a new experiment.\nIf the lesson is reusable across projects, save it with save_lesson. If it changes the research conclusion, restate that implication separately with record_claim.\nKey lesson: ${what_this_teaches}`;
      },
    }),

    extract_results: tool({
      description: "Auto-extract structured metrics from experiment output using AI. Pass a job ID and the system will parse stdout/stderr to extract numeric metrics, determine success/failure, and return structured data ready for record_result. Use this instead of manually parsing experiment output.",
      inputSchema: z.object({
        job_id: z.string().describe("Job ID of a completed experiment"),
      }),
      execute: async ({ job_id }: { job_id: string }) => {
        const resolvedJob = await resolveProjectRemoteJob(projectId, job_id);
        if (resolvedJob.ambiguous) {
          return `Job "${job_id}" matches multiple jobs. Use a longer ID.\n\nMatches:\n${formatRemoteJobMatches(resolvedJob.matches as Array<{ id: string; command: string; status: string }>)} `;
        }
        const job = resolvedJob.job;
        if (!job) return `Job "${job_id}" not found.`;
        if (job.status !== "COMPLETED" && job.status !== "FAILED") {
          return `Job is still ${job.status}. Wait for completion first.`;
        }

        const output = [
          job.stdout ? `STDOUT:\n${job.stdout.slice(-3000)}` : "",
          job.stderr ? `STDERR:\n${job.stderr.slice(-1000)}` : "",
        ].filter(Boolean).join("\n\n");

        if (!output.trim()) return "No output to extract from.";

        try {
          const { getModelForTier } = await import("@/lib/llm/auto-process");
          const { getModel, setLlmContext } = await import("@/lib/llm/provider");
          const { provider, modelId, proxyConfig } = await getModelForTier("standard");
          setLlmContext("extract-results", userId, { projectId });
          const model = await getModel(provider, modelId, proxyConfig);

          const metricsSchema = z.object({
            metrics: z.record(z.string(), z.number()).describe("All numeric metrics found (e.g., accuracy, loss, f1, perplexity, BLEU, rouge)"),
            verdict: z.enum(["better", "worse", "inconclusive", "error"]).describe("Overall outcome based on the output"),
            summary: z.string().describe("One-sentence summary of what the experiment showed"),
            error_type: z.string().optional().describe("If failed: OOM, import error, CUDA error, etc."),
          });

          const { object } = await generateObject({
            model,
            schema: metricsSchema,
            system: "Extract structured metrics from experiment output. Find ALL numeric values that look like evaluation metrics (accuracy, loss, F1, BLEU, perplexity, etc.). If the experiment failed, set verdict='error' and describe the error type.",
            prompt: output.slice(0, 4000),
            abortSignal: sessionControl?.signal,
          });

          const metricsStr = Object.entries(object.metrics).map(([k, v]) => `${k}: ${v}`).join(", ");
          return `Extracted metrics: ${metricsStr}\nVerdict: ${object.verdict}\nSummary: ${object.summary}${object.error_type ? `\nError: ${object.error_type}` : ""}\n\nUse these values with record_result to save structured results.`;
        } catch (err) {
          return `Auto-extraction failed: ${err instanceof Error ? err.message : "unknown error"}. Parse the output manually and use record_result.`;
        }
      },
    }),

    query_results: tool({
      description: "Get a formatted table of all experiment results. Use this to see what you've tried, what worked, and compare approaches.",
      inputSchema: z.object({
        approach_id: z.string().optional().describe("Filter by approach branch ID"),
        hypothesis_id: z.string().optional().describe("Filter by hypothesis ID"),
      }),
      execute: async ({ approach_id, hypothesis_id }: { approach_id?: string; hypothesis_id?: string }) => {
        const where: { projectId: string; branchId?: string; hypothesisId?: string } = { projectId };
        if (approach_id) where.branchId = approach_id;
        if (hypothesis_id) where.hypothesisId = hypothesis_id;

        const results = await prisma.experimentResult.findMany({
          where,
          include: { branch: { select: { name: true } } },
          orderBy: { createdAt: "asc" },
        });

        if (results.length === 0) return "No experiment results recorded yet. Use record_result after experiments complete.";

        let table = "| # | Script | Approach | Key Metrics | vs Baseline | Verdict |\n|---|--------|----------|-------------|-------------|--------|\n";
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const metrics = r.metrics ? JSON.parse(r.metrics) : {};
          const metricsStr = Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join(", ").slice(0, 50);
          const comp = r.comparison ? JSON.parse(r.comparison) : null;
          const compStr = comp ? Object.entries(comp).map(([k, v]) => `${k}:${(v as number) > 0 ? "+" : ""}${v}`).join(", ") : "-";
          table += `| ${i + 1} | ${r.scriptName} | ${r.branch?.name || "-"} | ${metricsStr || "-"} | ${compStr} | ${r.verdict || "-"} |\n`;
        }
        return table;
      },
    }),

    view_approach_tree: tool({
      description: "Display the approach tree — all research directions, their status, and experiment counts. Use this to decide what to try next.",
      inputSchema: z.object({}),
      execute: async () => {
        const branches = await prisma.approachBranch.findMany({
          where: { projectId },
          include: { results: { select: { verdict: true, metrics: true } } },
          orderBy: { createdAt: "asc" },
        });

        if (branches.length === 0) return "No approaches registered. Use register_approach to start tracking research directions.";

        const roots = branches.filter(b => !b.parentId);
        let tree = "";
        const statusIcon: Record<string, string> = { ACTIVE: "●", PROMISING: "★", ABANDONED: "✗", EXHAUSTED: "◌" };

        for (const root of roots) {
          const icon = statusIcon[root.status] || "?";
          const expCount = root.results.length;
          const bestMetric = root.results.filter(r => r.metrics && r.verdict !== "error")
            .map(r => { try { return JSON.parse(r.metrics!); } catch { return {}; } })
            .reduce((best: { key: string; val: number }, m: Record<string, number>) => {
              const key = Object.keys(m)[0];
              if (key && (!best.key || m[key] > best.val)) return { key, val: m[key] };
              return best;
            }, { key: "", val: 0 });

          tree += `${icon} ${root.name} [${root.status}] (${expCount} exp${bestMetric.key ? `, best: ${bestMetric.key}=${bestMetric.val}` : ""})\n`;

          const children = branches.filter(b => b.parentId === root.id);
          for (const child of children) {
            const cIcon = statusIcon[child.status] || "?";
            tree += `  ${cIcon} ${child.name} [${child.status}] (${child.results.length} exp)\n`;
          }
        }
        return tree;
      },
    }),

    search_papers: tool({
      description: "Search academic databases (OpenAlex, Semantic Scholar, CrossRef) for papers on a topic. Only imports papers relevant to your query — irrelevant results are filtered out. Papers are added to the project collection (not your main library).",
      inputSchema: z.object({
        query: z.string().describe("Search query — use specific technical terms"),
        max_results: z.number().min(1).max(8).default(5).optional(),
      }),
      execute: async ({ query, max_results }: { query: string; max_results?: number }) => {
        // Hard rate-limit: max 2 consecutive search_papers calls before requiring a different tool
        consecutiveSearches.value++;
        if (consecutiveSearches.value > 2) {
          return `STOP: You've called search_papers ${consecutiveSearches.value} times in a row. This is inefficient — use dispatch_scouts to search multiple angles in parallel (one call replaces 3-4 search_papers). Search_papers is for single targeted follow-ups only. Call a different tool now.`;
        }

        const maxResults = max_results || 5;
        const results = await searchAllSources(query);
        // Filter by relevance BEFORE importing — only papers matching the query
        const relevant = filterByRelevance(results, query)
          .filter((r) => !isBanned(r)); // Exclude banned papers (benchmarks)
        const toImport = relevant.slice(0, maxResults);
        if (toImport.length === 0) {
          const totalFound = results.length;
          return totalFound > 0
            ? `Found ${totalFound} papers but none were relevant enough to "${query}". Try a more specific query.`
            : "No papers found for this query.";
        }

        // Ensure project collection exists
        const { collectionId } = await runDbTransaction(async (tx) => {
          const proj = await tx.researchProject.findUnique({
            where: { id: projectId },
            select: { collectionId: true, title: true },
          });
          if (proj?.collectionId) {
            return { collectionId: proj.collectionId };
          }

          const col = await tx.collection.create({
            data: { name: `Research: ${proj?.title || "Project"}` },
          });
          await tx.researchProject.update({
            where: { id: projectId },
            data: { collectionId: col.id },
          });
          return { collectionId: col.id };
        });

        const imported: string[] = [];
        const queuedDownloads: PdfDownloadItem[] = [];
        for (let i = 0; i < toImport.length; i++) {
          const r = toImport[i];
          // Skip figure/table/supplement DOIs (publishers like PeerJ assign DOIs to individual figures)
          if (isFigureOrSupplementDoi(r)) continue;

          emit({ type: "tool_progress", toolName: "search_papers", content: `Importing paper ${i + 1}/${toImport.length}: "${r.title.slice(0, 60)}..."` });
          try {
            const importOutcome = await runDbTransaction(async (tx) => {
              let existing: { id: string } | null = null;
              if (r.doi || r.arxivId) {
                existing = await tx.paper.findFirst({
                  where: {
                    userId,
                    OR: [
                      ...(r.doi ? [{ doi: r.doi }] : []),
                      ...(r.arxivId ? [{ arxivId: r.arxivId }] : []),
                    ],
                  },
                  select: { id: true },
                });
              }
              if (!existing && r.title) {
                const normTitle = r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
                const candidates = await tx.paper.findMany({
                  where: { userId },
                  select: { id: true, title: true },
                });
                existing = candidates.find((c: { id: string; title: string }) => {
                  const ct = c.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
                  return ct === normTitle || (normTitle.length > 20 && ct.includes(normTitle.slice(0, Math.floor(normTitle.length * 0.8))));
                }) || null;
              }
              if (existing) {
                await tx.collectionPaper.upsert({
                  where: { paperId_collectionId: { collectionId, paperId: existing.id } },
                  create: { collectionId, paperId: existing.id },
                  update: {},
                });
                return { kind: "existing" as const };
              }

              const paper = await tx.paper.create({
                data: {
                  title: r.title, userId,
                  abstract: r.abstract ?? null,
                  authors: r.authors ? JSON.stringify(r.authors) : null,
                  year: r.year ?? null, venue: r.venue ?? null,
                  doi: r.doi ?? null,
                  arxivId: r.arxivId ?? (r.doi?.match(/10\.48550\/arXiv\.(\d+\.\d+)/i)?.[1] || null),
                  sourceType: r.arxivId || r.doi?.match(/10\.48550\/arXiv\./i) ? "ARXIV" : "RESEARCH",
                  sourceUrl: r.externalUrl ?? null,
                  processingStatus: "PENDING",
                  isResearchOnly: true,
                },
              });
              await tx.collectionPaper.create({ data: { collectionId, paperId: paper.id } });
              return {
                kind: "created" as const,
                queueItem: {
                  paperId: paper.id,
                  doi: r.doi,
                  arxivId: r.arxivId,
                  openAccessPdfUrl: r.openAccessPdfUrl,
                  title: r.title,
                  hasAbstract: !!r.abstract,
                } satisfies PdfDownloadItem,
              };
            });

            if (importOutcome.kind === "existing") {
              imported.push(`"${r.title}" (already in library)`);
              continue;
            }
            queuedDownloads.push(importOutcome.queueItem);
            imported.push(`"${r.title}" (${r.year || "?"}) — ${r.citationCount || 0} citations${r.abstract ? `\n  Abstract: ${r.abstract.slice(0, 300)}` : ""}`);
          } catch (err) {
            imported.push(`"${r.title}" — failed to import: ${err instanceof Error ? err.message : "error"}`);
          }
        }

        for (const queueItem of queuedDownloads) {
          pdfDownloadQueue.push(queueItem);
        }

        // Start draining the PDF download queue (non-blocking, serial)
        drainPdfDownloadQueue().catch((err) => console.error("[pdf-queue] Drain error:", err));

        const summary = `Found and imported ${imported.length} papers:\n\n${imported.join("\n\n")}`;
        await recordStep("search_papers", `Search: "${query}"`, "COMPLETED", { imported: imported.length, query }, "DISCOVERY");
        return summary;
      },
    }),

    remove_paper: tool({
      description: "Remove an irrelevant paper from the current research project. Use when a paper turns out to be off-topic or not useful. This removes it from the project collection — if it was research-only, it's deleted entirely.",
      inputSchema: z.object({
        title: z.string().describe("Title or partial title of the paper to remove"),
        reason: z.string().optional().describe("Brief reason for removal"),
      }),
      execute: async ({ title, reason }: { title: string; reason?: string }) => {
        // Find the paper
        const proj = await prisma.researchProject.findUnique({
          where: { id: projectId },
          select: { collectionId: true },
        });
        if (!proj?.collectionId) return "No project collection found.";

        const collectionPapers = await prisma.collectionPaper.findMany({
          where: { collectionId: proj.collectionId },
          include: { paper: { select: { id: true, title: true, isResearchOnly: true } } },
        });

        const normTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const match = collectionPapers.find((cp) => {
          const ct = cp.paper.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          return ct.includes(normTitle) || normTitle.includes(ct.slice(0, Math.floor(ct.length * 0.8)));
        });

        if (!match) return `Paper "${title}" not found in this project's collection.`;

        const removedEntirely = await runDbTransaction(async (tx) => {
          await tx.collectionPaper.delete({
            where: { paperId_collectionId: { collectionId: proj.collectionId, paperId: match.paper.id } },
          });

          if (!match.paper.isResearchOnly) return false;

          const otherCollections = await tx.collectionPaper.count({
            where: { paperId: match.paper.id },
          });
          if (otherCollections !== 0) return false;

          await tx.paper.delete({ where: { id: match.paper.id } });
          return true;
        });

        if (removedEntirely) {
          return `Removed and deleted "${match.paper.title}" (research-only, no other collections).${reason ? ` Reason: ${reason}` : ""}`;
        }

        return `Removed "${match.paper.title}" from project collection.${reason ? ` Reason: ${reason}` : ""}`;
      },
    }),

    read_paper: tool({
      description: "Read a paper with all processed intelligence: metadata, key findings, insights from the Mind Palace, relationships to other papers, contradictions, citation contexts, and full text. This is your primary tool for deeply understanding a paper.",
      inputSchema: z.object({
        title: z.string().describe("Title (or partial title) of the paper to read"),
      }),
      execute: async ({ title }: { title: string }) => {
        // Check if trying to read a banned paper (benchmarks)
        if (bannedPapers && bannedPapers.length > 0) {
          for (const b of bannedPapers) {
            const normB = b.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
            const normT = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
            if (normB.includes(normT) || normT.includes(normB)) {
              return `Paper "${title}" not found in library.`;
            }
          }
        }
        emit({ type: "tool_progress", toolName: "read_paper", content: `Looking up "${title.slice(0, 60)}..."` });

        // In benchmark mode, only read papers from the project collection
        const readWhere: Record<string, unknown> = { title: { contains: title } };
        if (isBenchmarkProject) {
          const proj = await prisma.researchProject.findUnique({ where: { id: projectId }, select: { collectionId: true } });
          if (proj?.collectionId) {
            readWhere.collections = { some: { collectionId: proj.collectionId } };
          }
        } else {
          readWhere.userId = userId;
        }

        const paper = await prisma.paper.findFirst({
          where: readWhere,
          select: {
            id: true, title: true, abstract: true, authors: true,
            year: true, venue: true, summary: true, fullText: true,
            keyFindings: true, categories: true,
            processingStatus: true,
            tags: { include: { tag: true } },
            insights: {
              include: { room: { select: { name: true } } },
            },
            sourceRelations: {
              include: { targetPaper: { select: { title: true, year: true } } },
            },
            targetRelations: {
              include: { sourcePaper: { select: { title: true, year: true } } },
            },
            references: {
              where: { citationContext: { not: null } },
              select: { title: true, year: true, citationContext: true, matchedPaper: { select: { title: true } } },
              take: 20,
            },
            promptResults: {
              where: { promptType: "detectContradictions" },
              select: { result: true },
              take: 1,
            },
            figures: {
              select: { type: true, caption: true, description: true, page: true },
              take: 10,
            },
          },
        });
        if (!paper) return `Paper "${title}" not found in library. Try searching first.`;
        if (paper.processingStatus && !["COMPLETED", "FAILED", "NEEDS_DEFERRED", "NO_PDF"].includes(paper.processingStatus)) {
          return `Paper "${paper.title}" is still being processed (status: ${paper.processingStatus}). ` +
            `Wait for processing to complete before reading — you'll get abstracts, summaries, key findings, and full text. ` +
            `Do other work first (search for more papers, read already-processed papers) and come back to this one later.`;
        }

        const parts: string[] = [];

        // ── Metadata ──
        parts.push(`# ${paper.title}`);
        if (paper.authors) {
          try { parts.push(`Authors: ${JSON.parse(paper.authors).join(", ")}`); } catch { parts.push(`Authors: ${paper.authors}`); }
        }
        if (paper.year) parts.push(`Year: ${paper.year}`);
        if (paper.venue) parts.push(`Venue: ${paper.venue}`);
        if (paper.tags.length > 0) parts.push(`Tags: ${paper.tags.map((t) => t.tag.name).join(", ")}`);

        // ── Abstract & Summary ──
        if (paper.abstract) parts.push(`\n## Abstract\n${paper.abstract}`);
        if (paper.summary) parts.push(`\n## Summary\n${paper.summary}`);

        // ── Key Findings ──
        if (paper.keyFindings) {
          try {
            const findings = JSON.parse(paper.keyFindings);
            if (Array.isArray(findings) && findings.length > 0) {
              parts.push(`\n## Key Findings\n${findings.map((f: string) => `- ${f}`).join("\n")}`);
            }
          } catch { /* not JSON */ }
        }

        // ── Mind Palace Insights (skip in benchmark mode) ──
        if (!isBenchmarkProject && paper.insights.length > 0) {
          const insightLines = paper.insights.map((ins) => {
            let line = `- [${ins.room.name}] ${ins.learning}`;
            if (ins.significance) line += `\n  Significance: ${ins.significance}`;
            if (ins.applications) line += `\n  Applications: ${ins.applications}`;
            return line;
          });
          parts.push(`\n## Insights (Mind Palace)\n${insightLines.join("\n")}`);
        }

        // ── Relationships to Other Papers ──
        const allRelations = [
          ...paper.sourceRelations.map((r) => ({
            paper: r.targetPaper.title,
            year: r.targetPaper.year,
            type: r.relationType,
            desc: r.description,
            direction: "this paper →" as const,
          })),
          ...paper.targetRelations.map((r) => ({
            paper: r.sourcePaper.title,
            year: r.sourcePaper.year,
            type: r.relationType,
            desc: r.description,
            direction: "→ this paper" as const,
          })),
        ];
        if (allRelations.length > 0) {
          const relLines = allRelations.map((r) =>
            `- ${r.type}: "${r.paper}" (${r.year || "?"})${r.desc ? ` — ${r.desc}` : ""}`
          );
          parts.push(`\n## Relationships to Other Papers\n${relLines.join("\n")}`);
        }

        // ── Contradictions ──
        if (paper.promptResults.length > 0) {
          try {
            const contradictions = JSON.parse(paper.promptResults[0].result);
            if (Array.isArray(contradictions) && contradictions.length > 0) {
              const cLines = contradictions.map((c: { claim?: string; otherPaper?: string; contradiction?: string; severity?: string }) =>
                `- [${c.severity || "?"}] ${c.claim || ""} vs "${c.otherPaper || "?"}" — ${c.contradiction || ""}`
              );
              parts.push(`\n## Contradictions with Other Papers\n${cLines.join("\n")}`);
            }
          } catch { /* not valid JSON */ }
        }

        // ── Citation Contexts (why this paper cites others) ──
        const citedWithContext = paper.references.filter((r) => r.citationContext);
        if (citedWithContext.length > 0) {
          const ctxLines = citedWithContext.map((r) =>
            `- "${r.matchedPaper?.title || r.title}" (${r.year || "?"}): ${r.citationContext}`
          );
          parts.push(`\n## Key Citations & Why They Matter\n${ctxLines.join("\n")}`);
        }

        // ── Figures & Tables ──
        if (paper.figures.length > 0) {
          const figLines = paper.figures.map((f) =>
            `- [${f.type}, p.${f.page}] ${f.caption || ""}${f.description ? ` — ${f.description}` : ""}`
          );
          parts.push(`\n## Figures & Tables\n${figLines.join("\n")}`);
        }

        // ── Full Text (last, truncated) ──
        if (paper.fullText) {
          const text = paper.fullText.length > 12000
            ? paper.fullText.slice(0, 9000) + "\n\n[...truncated...]\n\n" + paper.fullText.slice(-3000)
            : paper.fullText;
          parts.push(`\n## Full Text\n${text}`);
        } else if (!paper.abstract && !paper.summary) {
          parts.push("\n(No text available — PDF may still be processing)");
        }

        return parts.join("\n");
      },
    }),

    write_file: tool({
      description: "Write a file to the experiment directory. Python scripts MUST follow the naming taxonomy:\n- poc_NNN_name.py — proof of concept (quick validation, <5 min)\n- exp_NNN_name.py — full experiment (tests a hypothesis)\n- analysis_NNN_name.py — post-experiment analysis/visualization\n- sweep_NNN_name.py — parameter sweep\nUtility modules (utils.py, config.py, etc.) and non-Python files use any name.",
      inputSchema: z.object({
        filename: z.string().describe("Filename following taxonomy: poc_NNN_name.py, exp_NNN_name.py, analysis_NNN_name.py, sweep_NNN_name.py. Utilities: utils.py, helpers.py, etc."),
        content: z.string().describe("Full file content"),
      }),
      execute: async ({ filename, content }: { filename: string; content: string }) => {
        // Legacy phase gate removed — FSM tool-set filtering controls availability.
        // Writing scripts is allowed in any state where write_file is available.

        // Prevent path traversal
        let safeName = path.basename(filename);
        const filePath = path.join(workDir, safeName);
        const fileAlreadyExists = await stat(filePath).then(() => true).catch(() => false);

        // Block infrastructure and monitoring scripts — these are not experiments
        if (safeName.endsWith(".py")) {
          const lowerName = safeName.toLowerCase();
          // Monitoring/cleanup/status scripts — use built-in tools
          if (/monitor|check_status|check_progress|check_log|tail_log|cleanup|kill_|read_result|read_log|gpu_mem|gpu_activity|check_running|deep_check/.test(lowerName)) {
            return `BLOCKED — Do not write monitoring/cleanup scripts. Use these tools instead:\n` +
              `- check_job: check experiment status\n- get_workspace: see all files and results\n` +
              `- read_remote_file: read a specific file\n- monitor_experiment: check training metrics`;
          }
          // Setup/install/verify/clone scripts — environment is managed automatically
          if (/setup|install|verify|clone|download|check_env|check_gpu|check_cuda|test_import|pip_|conda_|env_check|sanity/.test(lowerName)) {
            return `BLOCKED — Do not write setup/verification scripts. Environment management is automatic:\n` +
              `- Package installation: add to requirements.txt (helper installs automatically)\n` +
              `- GPU/CUDA checks: shown in host profile and get_workspace\n` +
              `- Import verification: handled by the auto-environment check before submission\n` +
              `- Repository cloning: write a Python script that does it, don't try to use git directly\n\n` +
              `Write actual experiments instead: poc_NNN_<what_you_test>.py`;
          }
        }

        const scriptPolicyViolation = getManagedScriptPolicyViolation(safeName);
        if (scriptPolicyViolation) {
          return scriptPolicyViolation;
        }

        if (fileAlreadyExists === false && isManagedExperimentScript(safeName)) {
          const creationBarrier = await getManagedScriptCreationBarrier(projectId, safeName);
          if (creationBarrier) return creationBarrier;
        }

        // Cap total scripts per project to prevent bloat
        try {
          const existingFiles = await readdir(workDir);
          const pyFiles = existingFiles.filter((f) => f.endsWith(".py") && !isUtilityScript(f));
          const isCreatingNewManagedScript = safeName.endsWith(".py") && !isUtilityScript(safeName) && !fileAlreadyExists;
          if (pyFiles.length > 30 && isCreatingNewManagedScript) {
            return `BLOCKED — ${pyFiles.length} Python scripts already exist. You're creating too many scripts.\n` +
              `Reuse or overwrite an existing script, or delete obsolete scripts with delete_file before creating a new one.\n` +
              `Use list_files to see what you have, then modify an existing script with write_file or remove stale files with delete_file.`;
          }
        } catch { /* dir may not exist yet */ }

        // ── Enforce naming taxonomy for Python scripts ──
        // Valid prefixes: poc_, exp_, analysis_, sweep_, or recognized utility names
        if (safeName.endsWith(".py") && !isUtilityScript(safeName)) {
          const validPrefix = /^(poc|exp|analysis|sweep)_\d{3}_/.test(safeName);
          if (!validPrefix) {
            // Check if it has a valid prefix but wrong numbering
            const hasPrefix = /^(poc|exp|analysis|sweep)_/.test(safeName);
            if (hasPrefix) {
              // Auto-fix numbering: poc_test.py → poc_NNN_test.py
              experimentCount.value++;
              const num = String(experimentCount.value).padStart(3, "0");
              const rest = safeName.replace(/^(poc|exp|analysis|sweep)_/, "");
              const prefix = safeName.match(/^(poc|exp|analysis|sweep)_/)![1];
              safeName = `${prefix}_${num}_${rest}`;
            } else {
              // Unknown prefix — block with taxonomy guidance
              return `BLOCKED — Python scripts must follow the naming taxonomy:\n` +
                `- \`poc_NNN_name.py\` — proof of concept (quick validation)\n` +
                `- \`exp_NNN_name.py\` — full experiment (tests hypothesis)\n` +
                `- \`analysis_NNN_name.py\` — post-experiment analysis\n` +
                `- \`sweep_NNN_name.py\` — parameter sweep\n\n` +
                `For utility modules, use: utils.py, helpers.py, config.py, eval_utils.py, data_loader.py, etc.\n` +
                `Got: "${safeName}". Rename it to follow the taxonomy.`;
            }
          }
        }

        await writeFile(filePath, content, "utf-8");
        // Record experiment code as a step
        if (safeName.endsWith(".py")) {
          await recordStep("generate_code", `Write: ${safeName}`, "COMPLETED", { filename: safeName, bytes: content.length }, "EXECUTION");
        }
        return `Written ${safeName} (${content.length} bytes) to ${workDir}`;
      },
    }),

    delete_file: tool({
      description: "Delete obsolete files from the experiment directory. Use this to prune stale scripts before creating new ones. Deletions are local-first; the next remote sync removes the same files from the remote workspace via rsync --delete.",
      inputSchema: z.object({
        paths: z.array(z.string()).min(1).max(50).describe("Paths relative to the experiment directory"),
      }),
      execute: async ({ paths }: { paths: string[] }) => {
        const deleted: string[] = [];
        const missing: string[] = [];

        for (const candidate of paths) {
          const safePath = candidate.replace(/\.\.\//g, "").replace(/^\//, "");
          if (!safePath || safePath.includes("..")) {
            missing.push(candidate);
            continue;
          }
          const fullPath = path.normalize(path.join(workDir, safePath));
          if (!isPathWithinRoot(workDir, fullPath)) {
            missing.push(candidate);
            continue;
          }

          const deleteBarrier = await getManagedScriptDeletionBarrier(projectId, safePath);
          if (deleteBarrier) {
            missing.push(`${candidate} (${deleteBarrier.replace(/\n/g, " ")})`);
            continue;
          }

          try {
            await rm(fullPath, { recursive: true, force: false });
            deleted.push(safePath);
          } catch {
            missing.push(candidate);
          }
        }

        if (deleted.length > 0) {
          await recordStep("generate_code", `Delete: ${deleted.join(", ")}`, "COMPLETED", {
            deleted,
            missing,
          }, "EXECUTION");
        }

        if (deleted.length === 0) {
          return `No files deleted. Missing or invalid paths: ${missing.join(", ")}`;
        }

        return `Deleted ${deleted.length} file(s): ${deleted.join(", ")}.${missing.length > 0 ? ` Missing or invalid: ${missing.join(", ")}` : ""}\nThe next remote sync will remove the same paths from the remote workspace.`;
      },
    }),

    write_shared_utility: tool({
      description: "Write a reusable Python utility to the shared directory. Use this when a capability involves logic that should be reused across experiments (API clients, data helpers, evaluation harnesses). These utilities are available to ALL research projects.",
      inputSchema: z.object({
        filename: z.string().describe("Module filename (e.g., llm_client.py, eval_utils.py)"),
        content: z.string().describe("Full Python module content — include docstrings, error handling, and sensible defaults"),
      }),
      execute: async ({ filename, content }: { filename: string; content: string }) => {
        const safeName = path.basename(filename);
        if (!safeName.endsWith(".py")) return "Shared utilities must be Python files (.py)";
        const filePath = path.join(sharedDir, safeName);
        await writeFile(filePath, content, "utf-8");
        return `Written shared utility ${safeName} (${content.length} bytes) to ${sharedDir}. All research projects can now import it with:\nimport sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'shared'))\nfrom ${safeName.replace(".py", "")} import ...`;
      },
    }),

    read_file: tool({
      description: "Read a file from the workspace. Checks the local experiment directory first; if not found and a remote host is configured, reads from the remote workspace. Supports subdirectories (e.g., 'run_055/results.json', 'results/metrics.csv'). Use tail_lines to read the end of long log files.",
      inputSchema: z.object({
        filepath: z.string().describe("Path relative to experiment directory (e.g., 'exp_055.py', 'run_055/results.json', 'stderr.log')"),
        tail_lines: z.number().optional().describe("Only return the last N lines (useful for long logs). Default: entire file."),
      }),
      execute: async ({ filepath, tail_lines }: { filepath: string; tail_lines?: number }) => {
        // Prevent path traversal
        const safePath = filepath.replace(/\.\.\//g, "").replace(/^\//, "");
        if (!safePath || safePath.includes("..")) return "Invalid path.";

        // Try local first
        const localPath = path.join(workDir, safePath);
        try {
          const content = await readFile(localPath, "utf-8");
          if (tail_lines) {
            const lines = content.split("\n");
            return lines.slice(-Math.min(tail_lines, 500)).join("\n");
          }
          if (content.length > 10000) {
            return content.slice(0, 8000) + "\n\n[...truncated...]\n\n" + content.slice(-2000);
          }
          return content;
        } catch {
          // Not found locally — try remote
        }

        // Try remote
        const host = await getSelectedRemoteHost();
        if (!host) return `File "${safePath}" not found locally. No remote hosts configured.`;

        const slug = workDir.split("/").filter(Boolean).pop() || "experiment";
        const remoteDir = `${host.workDir}/${slug}`;
        const fullPath = `${remoteDir}/${safePath}`;

        const cmd = tail_lines
          ? `tail -${Math.min(tail_lines, 500)} ${fullPath} 2>/dev/null`
          : `head -2000 ${fullPath} 2>/dev/null`;

        const result = await quickRemoteCommand(host.id, cmd);
        if (!result.ok) return `File "${safePath}" not found locally or on ${host.alias}.`;

        emit({ type: "tool_output", toolName: "read_file", content: `── ${safePath} (from ${host.alias}) ──` });
        const lines = result.output.split("\n");
        for (const line of lines.slice(0, 200)) {
          emit({ type: "tool_output", toolName: "read_file", content: line });
        }
        if (lines.length > 200) {
          emit({ type: "tool_output", toolName: "read_file", content: `... (${lines.length - 200} more lines, use tail_lines to see end)` });
        }

        return result.output.slice(-5000) || "File is empty.";
      },
    }),

    list_files: tool({
      description: "List files in the experiment directory.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const files = await readdir(workDir);
          if (files.length === 0) return "Directory is empty.";
          const details: string[] = [];
          for (const f of files) {
            try {
              const s = await stat(path.join(workDir, f));
              details.push(`${f} (${s.isDirectory() ? "dir" : `${s.size} bytes`})`);
            } catch {
              details.push(f);
            }
          }
          return details.join("\n");
        } catch {
          return "Could not list directory.";
        }
      },
    }),

    // execute_command removed — no shell access. Use run_experiment for Python scripts,
    // read_file/write_file/list_files for file operations, get_workspace for inspection.

    get_workspace: tool({
      description: "Get a complete, structured view of the remote experiment workspace: all files with sizes and timestamps, result file contents, installed packages, and job status. This is MUCH faster than reading files individually. Use this FIRST when you need to understand the current state of the workspace.",
      inputSchema: z.object({
        refresh: z.boolean().default(false).optional().describe("Force refresh from remote (default: use 30s cache)"),
      }),
      execute: async ({ refresh }: { refresh?: boolean }) => {
        const host = await getSelectedRemoteHost();
        if (!host) return "No remote hosts configured.";

        emit({ type: "tool_progress", toolName: "get_workspace", content: "Fetching workspace state..." });

        const state = await getWorkspaceState(projectId, host.id, refresh || false);
        if (!state) return "Could not fetch workspace state. The remote directory may not exist yet — run an experiment first.";

        return formatWorkspace(state);
      },
    }),

    clean_workspace: tool({
      description: "Clean up the remote experiment workspace. Archives old experiment run directories into compressed tarballs, removes orphaned output files from root (pre-migration leftovers), and trims old archives beyond the host's max. Use when get_workspace shows 'needs_attention' or when sync is slow. Supports dry_run to preview without acting.",
      inputSchema: z.object({
        dry_run: z.boolean().optional().default(false).describe("Preview what would be cleaned without actually doing it"),
        keep_recent: z.number().optional().default(0).describe("Number of recent run dirs to keep unarchived"),
      }),
      execute: async ({ dry_run, keep_recent }: { dry_run?: boolean; keep_recent?: number }) => {
        const host = await getSelectedRemoteHost();
        if (!host) return "No remote hosts configured.";

        emit({ type: "tool_progress", toolName: "clean_workspace", content: dry_run ? "Previewing workspace cleanup..." : "Cleaning workspace..." });

        try {
          const maxArchives = host.maxArchives || 20;
          const flags = [
            (keep_recent ?? 0) > 0 ? `--keep-recent ${keep_recent}` : "",
            `--max-archives ${maxArchives}`,
            dry_run ? "--dry-run" : "",
          ].filter(Boolean).join(" ");

          const workDirGlob = `~/experiments/*${projectId.slice(0, 8)}*`;
          const { ok, output, error } = await quickRemoteCommand(host.id,
            `python3 ~/.arcana/helper.py prune ${workDirGlob} ${flags} 2>/dev/null || echo '{"ok":false}'`
          );

          if (!ok) return `Workspace cleanup failed: ${error || "unknown error"}`;

          const parsed = JSON.parse(output);
          if (!parsed.ok) return `Workspace cleanup failed: ${parsed.error || "helper returned error"}`;

          if (!dry_run) {
            invalidateWorkspace(projectId);
          }

          const prefix = dry_run ? "**Dry run** — would " : "";
          const parts: string[] = [];
          if (parsed.archivedRuns?.length > 0) {
            parts.push(`${prefix}archive ${parsed.archivedRuns.length} run dirs: ${parsed.archivedRuns.join(", ")}`);
          }
          if (parsed.deletedArchives?.length > 0) {
            parts.push(`${prefix}delete ${parsed.deletedArchives.length} old archives: ${parsed.deletedArchives.join(", ")}`);
          }
          if (parsed.orphansCleaned > 0) {
            parts.push(`${prefix}remove ${parsed.orphansCleaned} orphaned files from root`);
          }
          if (parts.length === 0) {
            return "Workspace is already clean — nothing to do.";
          }

          const saved = parsed.bytesFreed > 0 ? ` (${Math.round(parsed.bytesFreed / 1024 / 1024)}MB freed)` : "";
          return parts.join("\n") + (dry_run ? "" : saved);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Workspace cleanup failed: ${msg}`;
        }
      },
    }),

    diagnose_remote_host: tool({
      description: "Run first-class remote diagnostics after submission failures, RESOURCE_ERRORs, or inconsistent workspace state. Checks SSH reachability, helper availability, runtime smoke, GPU profile, and workspace lock state. Use this instead of execute_remote probes or ad hoc test scripts.",
      inputSchema: z.object({
        host_alias: z.string().optional().describe("Remote host alias. Omit to use the selected/default host."),
        refresh_workspace: z.boolean().default(true).optional().describe("Refresh the cached workspace manifest while diagnosing."),
      }),
      execute: async ({ host_alias, refresh_workspace }: { host_alias?: string; refresh_workspace?: boolean }) => {
        const host = await getSelectedRemoteHost(host_alias);
        if (!host) return "No remote hosts configured.";

        emit({ type: "tool_progress", toolName: "diagnose_remote_host", content: `Diagnosing ${host.alias}...` });

        const [connection, profile, runtimeSmoke, workspaceGuard, workspaceState, helperVersionResult] = await Promise.all([
          testConnection(host.id),
          probeGpus(host.id).catch(() => null),
          probeRuntimeSmoke(host.id, workDir).catch((err) => ({
            ok: false,
            kind: "runtime_smoke",
            detail: "",
            error: err instanceof Error ? err.message : String(err),
          })),
          getActiveWorkspaceSubmissionGuard(projectId, host.id),
          getWorkspaceState(projectId, host.id, refresh_workspace ?? true).catch(() => null),
          quickRemoteCommand(host.id, "python3 ~/.arcana/helper.py version 2>/dev/null || echo '{\"ok\":false}'"),
        ]);

        let helperVersion: string | null = null;
        if (helperVersionResult.ok) {
          try {
            const parsed = JSON.parse(helperVersionResult.output.trim().split("\n").filter(Boolean).pop() || "{}") as { ok?: boolean; version?: string };
            if (parsed.ok && typeof parsed.version === "string") {
              helperVersion = parsed.version;
            }
          } catch {
            helperVersion = null;
          }
        }

        const lines: string[] = [`Remote diagnostics for ${host.alias}`];

        if (connection.ok) {
          lines.push(`- SSH: OK${connection.user || connection.hostname ? ` (${[connection.user, connection.hostname].filter(Boolean).join("@")})` : ""}`);
        } else {
          lines.push(`- SSH: FAILED — ${connection.error || "unknown error"}`);
        }

        if (helperVersion) {
          lines.push(`- Helper: version ${helperVersion}`);
        } else {
          lines.push(`- Helper: unavailable${helperVersionResult.error ? ` — ${helperVersionResult.error}` : ""}`);
        }

        if (profile) {
          lines.push(`- Host profile: ${profile.summary}`);
          const detailParts = [
            profile.cudaVersion ? `CUDA ${profile.cudaVersion}` : null,
            profile.pythonVersion ? `Python ${profile.pythonVersion}` : null,
            profile.diskFreeGb != null ? `${profile.diskFreeGb} GB disk free` : null,
          ].filter(Boolean);
          if (detailParts.length > 0) {
            lines.push(`  ${detailParts.join(" · ")}`);
          }
        } else {
          lines.push("- Host profile: unavailable");
        }

        if (runtimeSmoke.ok) {
          lines.push(`- Runtime smoke: ${runtimeSmoke.detail || "ok"}`);
        } else {
          lines.push(`- Runtime smoke: FAILED — ${runtimeSmoke.error || "unknown error"}`);
        }

        if (workspaceGuard?.activeJobId) {
          lines.push(`- Workspace lock: busy by job ${workspaceGuard.activeJobId.slice(0, 8)} (${workspaceGuard.activeJobStatus || "RUNNING"})`);
        } else if (workspaceGuard?.blockingOwner) {
          lines.push(`- Workspace lock: held by ${workspaceGuard.blockingOwner}${workspaceGuard.leaseExpiresAt ? ` until ${workspaceGuard.leaseExpiresAt.toISOString()}` : ""}`);
        } else {
          lines.push("- Workspace lock: no active job or lease blocker");
        }

        if (workspaceState) {
          lines.push(`- Workspace manifest: ${workspaceState.fileCount} files, ${workspaceState.runDirs.length} run dirs, last job ${workspaceState.jobStatus || "unknown"}${workspaceState.workspaceHealth === "needs_attention" ? ", needs attention" : ""}`);
        } else {
          lines.push("- Workspace manifest: unavailable");
        }

        lines.push("");
        lines.push("Recommended next actions:");
        if (workspaceGuard?.activeJobId) {
          lines.push(`- Use check_job(job_id="${workspaceGuard.activeJobId.slice(0, 8)}") or cancel_job(job_id="${workspaceGuard.activeJobId.slice(0, 8)}") if the job is clearly stuck.`);
        }
        if (!runtimeSmoke.ok) {
          lines.push(`- Use validate_environment${host_alias ? `(host_alias="${host.alias}")` : "()"} if this looks like a package/import/runtime setup issue.`);
        }
        if (!connection.ok) {
          lines.push("- Treat this as a host/control-plane issue. Do not submit more experiments until SSH/helper health is restored.");
        }
        lines.push("- Do not use execute_remote probes, python -c, echo, or probe scripts for this.");

        return lines.join("\n");
      },
    }),

    // check_script (pyright) removed — blocks valid code due to unresolvable
    // remote-only imports. Errors surface at runtime on the GPU host.

    // read_remote_file removed — merged into read_file (checks local first, then remote)

    run_experiment: tool({
      description: "Run a Python script. The system automatically determines WHERE to run it (local or remote GPU) based on resource rules — you never need to choose. Just provide the script name and optional args. For exp_* and poc_* scripts, it routes to remote GPU servers. For analysis_* scripts, it runs locally. This is the ONLY way to execute code.",
      inputSchema: z.object({
        script: z.string().describe("Script filename to run (e.g., 'exp_003_lora.py')"),
        args: z.string().optional().describe("Command-line arguments (e.g., '--seed 42 --epochs 10')"),
        hypothesis_id: z.string().optional().describe("ID of the hypothesis this experiment tests. If omitted, Arcana auto-attaches the single live hypothesis when unambiguous."),
        experiment_purpose: z.enum(["SMOKE", "SYNTHETIC_PROXY", "CALIBRATION", "BASELINE", "MAIN_EVAL", "TRAINING", "ANALYSIS"]).optional().describe("Explicit experiment contract purpose. Use this when the script is intentionally a smoke test, synthetic proxy, calibration run, baseline, main evaluation, training run, or analysis."),
        grounding: z.enum(["UNSPECIFIED", "SYNTHETIC", "LOCAL_ARTIFACT", "EXTERNAL_DATASET", "MODEL_INFERENCE", "HUMAN_EVAL", "MIXED"]).optional().describe("Explicit evidence grounding class for the run. Use SYNTHETIC only for exploratory proxy work."),
      }),
      execute: async ({ script, args, hypothesis_id, experiment_purpose, grounding }: {
        script: string;
        args?: string;
        hypothesis_id?: string;
        experiment_purpose?: ExperimentPurpose;
        grounding?: ExperimentGrounding;
      }) => {
        // ── Validate script name ──
        if (!script.endsWith(".py")) {
          return "BLOCKED — run_experiment only runs Python scripts. Provide a .py filename.";
        }

        // ── Check script exists ──
        const scriptPath = path.join(workDir, script);
        try {
          await stat(scriptPath);
        } catch {
          return `BLOCKED — Script "${script}" does not exist in the experiment directory. Write it first with write_file.`;
        }

        const scriptPolicyViolation = getManagedScriptPolicyViolation(script);
        if (scriptPolicyViolation) {
          return scriptPolicyViolation;
        }

        const scriptContent = await readFile(scriptPath, "utf-8").catch(() => "");
        const contract = resolveExperimentContract({
          scriptName: script,
          command: `python3 ${script}${args ? ` ${args}` : ""}`,
          code: scriptContent,
          experimentPurpose: experiment_purpose,
          grounding,
        });
        const { createHash } = await import("crypto");
        const scriptHash = createHash("sha256").update(scriptContent).digest("hex").slice(0, 16);

        await recoverProjectRemoteResults(projectId).catch(() => {});

        // ── Route the script ──
        const hostCount = await countDefaultResearchHosts({ includeSynthetic: allowSyntheticRemoteHosts });
        const routing = await routeScript(projectId, script, hostCount > 0);

        emit({ type: "tool_output", toolName: "run_experiment", content: `Routing: ${routing.reason}` });
        emit({
          type: "tool_output",
          toolName: "run_experiment",
          content: `Contract: ${contract.experimentPurpose} / ${contract.grounding} / ${contract.claimEligibility} / ${contract.evidenceClass}`,
        });

        const command = `python3 ${script}${args ? ` ${args}` : ""}`;
        const isManagedExperiment = isManagedExperimentScript(script);
        const isFullExperiment = /python3?\s+exp_\d+/.test(command);

        const readinessForLocal = isManagedExperiment
          ? await assessExperimentSubmission({
              command,
              scriptName: script,
              requireHypothesis: isFullExperiment,
              hypothesisId: hypothesis_id,
              scriptHash,
            })
          : null;
        if (readinessForLocal && !readinessForLocal.ok) {
          return readinessForLocal.message;
        }
        // autoAdvanceNote removed — FSM handles auto-transitions
        if (readinessForLocal?.hypothesisNote) {
          emit({ type: "tool_output", toolName: "run_experiment", content: readinessForLocal.hypothesisNote });
        }

        if (routing.runtime.type === "local") {
          // ════════════════════════════════════════════
          // LOCAL EXECUTION
          // ════════════════════════════════════════════
          emit({ type: "tool_output", toolName: "run_experiment", content: `$ [local] ${command}` });

          const logFile = path.join(workDir, `.run-${Date.now()}.log`);

          return new Promise<string>((resolve) => {
            const proc = spawn("bash", ["-c", command], {
              cwd: workDir,
              timeout: 600_000, // 10 min for local runs
              env: { ...process.env, PYTHONUNBUFFERED: "1" },
            });

            let stdout = "";
            let stderr = "";

            proc.stdout?.on("data", (chunk: Buffer) => {
              const text = chunk.toString();
              stdout += text;
              for (const line of text.split("\n").filter(Boolean)) {
                emit({ type: "tool_output", toolName: "run_experiment", content: line });
                appendFile(logFile, `[stdout] ${line}\n`).catch(() => {});
              }
            });

            proc.stderr?.on("data", (chunk: Buffer) => {
              const text = chunk.toString();
              stderr += text;
              for (const line of text.split("\n").filter(Boolean)) {
                emit({ type: "tool_output", toolName: "run_experiment", content: `[stderr] ${line}` });
                appendFile(logFile, `[stderr] ${line}\n`).catch(() => {});
              }
            });

            proc.on("close", async (code) => {
              const succeeded = code === 0;
              await recordStep(
                "run_experiment",
                `Local: ${command.slice(0, 80)}`,
                succeeded ? "COMPLETED" : "FAILED",
                { stdout: stdout.slice(-2000), stderr: stderr.slice(-500), exitCode: code, logFile, routing: routing.reason },
                "EXECUTION",
              );
              if (succeeded) {
                const taskCat = classifyTaskCategory(command);
                recordResourceChoice(userId, taskCat, "local", command.slice(0, 80), projectId).catch(() => {});
                resolve(`[local] ${script} completed successfully.\n\nOutput:\n${stdout.slice(-3000)}`);
              } else {
                resolve(`[local] ${script} failed (exit ${code}). YOU MUST read the error, fix the code, and re-run.\n\nstdout:\n${stdout.slice(-2000)}\n\nstderr:\n${stderr.slice(-1000)}`);
              }
            });

            proc.on("error", async (err) => {
              await recordStep("run_experiment", `Local: ${command.slice(0, 80)}`, "FAILED", { error: err.message, routing: routing.reason });
              resolve(`[local] Failed to run ${script}: ${err.message}`);
            });
          });
        } else {
          // ════════════════════════════════════════════
          // REMOTE EXECUTION
          // ════════════════════════════════════════════

          // ── Find host ──
          const host = await getSelectedRemoteHost(routing.runtime.hostAlias);
          if (!host) return "No remote hosts configured. Add a remote host in Settings, or set a resource rule for local execution.";

          // ── Sanitize command ──
          let sanitized = command;
          sanitized = sanitized.replace(/\bpython\b(?!3)/g, "python3");
          sanitized = sanitized.replace(/\s+/g, " ").trim();
          const readiness = isManagedExperiment
            ? await assessExperimentSubmission({
                command: sanitized,
                scriptName: script,
                requireHypothesis: isFullExperiment,
                hypothesisId: hypothesis_id,
                hostId: host.id,
                scriptHash,
              })
            : { ok: true as const, hypothesisId: hypothesis_id || null, hypothesisNote: undefined, autoAdvanceNote: null };
          if (!readiness.ok) {
            return readiness.message;
          }
          const resolvedHypothesisId = readiness.hypothesisId;
          // autoAdvanceNote removed — FSM handles auto-transitions
          if (readiness.hypothesisNote) {
            emit({ type: "tool_output", toolName: "run_experiment", content: readiness.hypothesisNote });
          }

          // ── Pre-flight validation ──
          const preflightGpuCount = cachedGpuInfo?.find((g: { alias: string }) => g.alias === host!.alias)?.gpuCount ?? 1;
          const { validateExperiment, requiresBlockingSemanticAnalysis } = await import("./preflight");
          const requiresStrictSemanticAnalysis = requiresBlockingSemanticAnalysis(script, scriptContent);
          try {
            const preflight = await validateExperiment(workDir, sanitized, preflightGpuCount, {
              experimentPurpose: contract.experimentPurpose,
              grounding: contract.grounding,
            });
            if (!preflight.ok) {
              emit({ type: "tool_output", toolName: "run_experiment", content: `\n⛔ PRE-FLIGHT CHECK FAILED\n${preflight.summary}` });
              return `BLOCKED — pre-flight validation found ${preflight.violations.filter(v => v.severity === "error").length} error(s). Fix these before submitting:\n\n${preflight.summary}`;
            }
            if (preflight.violations.length > 0) {
              emit({ type: "tool_output", toolName: "run_experiment", content: `\n⚠ Pre-flight warnings:\n${preflight.summary}` });
            }
          } catch (preflightErr) {
            console.warn("[agent] preflight validation error:", preflightErr);
          }

          // Static analysis (pyright) removed — it blocks valid code because it can't
          // resolve imports against the remote host's Python environment. Scripts that
          // import torch/transformers/etc. are flagged as errors even though the packages
          // are installed on the GPU host. Errors surface naturally at runtime.

          // ── Submit remote job ──
          emit({ type: "tool_output", toolName: "run_experiment", content: `$ [${host.alias}] ${sanitized}` });
          emit({ type: "tool_progress", toolName: "run_experiment", content: `Syncing files to ${host.alias}...` });

          let jobId: string;
          try {
            const result = await submitRemoteJob({
              hostId: host.id,
              localDir: workDir,
              command: sanitized,
              projectId,
              scriptHash,
              hypothesisId: resolvedHypothesisId || undefined,
              experimentPurpose: contract.experimentPurpose,
              grounding: contract.grounding,
              claimEligibility: contract.claimEligibility,
              promotionPolicy: contract.promotionPolicy,
              evidenceClass: contract.evidenceClass,
              diagnostics: undefined,
              mock: mockExecutor,
            });
            jobId = result.jobId;
          } catch (submitErr) {
            const errMsg = submitErr instanceof Error ? submitErr.message : String(submitErr);
            emit({ type: "tool_output", toolName: "run_experiment", content: `ERROR: Failed to submit job: ${errMsg}` });
            await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "FAILED", { host: host.alias, error: errMsg, routing: routing.reason });
            return formatRemoteSubmissionFailure(host.alias, errMsg, await getActiveWorkspaceSubmissionGuard(projectId, host.id));
          }

          activeJobIds.add(jobId);

          emit({ type: "tool_output", toolName: "run_experiment", content: `Job submitted (${jobId.slice(0, 8)}). Running in background on ${host.alias}.` });
          emit({ type: "tool_progress", toolName: "run_experiment", content: `Job submitted to ${host.alias}. Continuing...` });

          await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "COMPLETED", { host: host.alias, jobId, status: "SUBMITTED", routing: routing.reason }, "EXECUTION");
          const taskCat = classifyTaskCategory(command);
          recordResourceChoice(userId, taskCat, `remote:${host.alias}`, command.slice(0, 80), projectId).catch(() => {});

          return `Job submitted to ${host.alias} (ID: ${jobId.slice(0, 8)}). Routing: ${routing.reason}\n\n**Continue with other work** — read papers, write code for the next experiment, analyze previous results. Use \`check_job\` with job_id="${jobId}" to check progress, or \`wait_for_jobs\` when you need results before proceeding.\n\nActive jobs this session: ${activeJobIds.size}`;
        }
      },
    }),

    execute_remote: tool({
      description: "LEGACY compatibility shim. Prefer run_experiment. Do not use this for probes, shell commands, or routine execution; it only exists so older valid Python experiment scripts can still run.",
      inputSchema: z.object({
        command: z.string().describe("The experiment command ONLY — e.g. 'python3 experiment.py'. Do NOT include: cd, source .venv/bin/activate, bash -c wrappers, timeout, absolute paths, or nohup. The system handles all of that automatically."),
        host_alias: z.string().optional().describe("Remote host alias. Omit to use the default host."),
        hypothesis_id: z.string().optional().describe("ID of the hypothesis this experiment tests. If omitted, Arcana auto-attaches the single live hypothesis when unambiguous."),
        experiment_purpose: z.enum(["SMOKE", "SYNTHETIC_PROXY", "CALIBRATION", "BASELINE", "MAIN_EVAL", "TRAINING", "ANALYSIS"]).optional().describe("Explicit experiment contract purpose."),
        grounding: z.enum(["UNSPECIFIED", "SYNTHETIC", "LOCAL_ARTIFACT", "EXTERNAL_DATASET", "MODEL_INFERENCE", "HUMAN_EVAL", "MIXED"]).optional().describe("Explicit evidence grounding class for the run."),
      }),
      execute: async ({ command, host_alias, hypothesis_id, experiment_purpose, grounding }: {
        command: string;
        host_alias?: string;
        hypothesis_id?: string;
        experiment_purpose?: ExperimentPurpose;
        grounding?: ExperimentGrounding;
      }) => {
        await recoverProjectRemoteResults(projectId).catch(() => {});

        // Find host
        const host = await getSelectedRemoteHost(host_alias);
        if (!host) return "No remote hosts configured. Ask the user to configure a remote host in Settings.";

        // Sanitize command — the Arcana helper handles cd, venv activation,
        // conda, and setup. Strip all that so the command is just the actual work.
        let sanitized = command;

        // Unwrap bash -c "..." wrappers the agent sometimes adds
        sanitized = sanitized.replace(/^bash\s+-c\s+["'](.+?)["']\s*$/, "$1");

        // Strip timeout wrappers the agent might add — training can run for hours
        sanitized = sanitized.replace(/^timeout\s+\d+[smh]?\s+/, "");

        // Strip redirect guards early so subsequent patterns match cleanly
        sanitized = sanitized.replace(/\s*2>\/dev\/null\s*\|\|\s*true\s*/g, " ");

        // Strip venv activation — the helper already does this
        sanitized = sanitized.replace(/(?:source\s+)?\.venv\/bin\/activate\s*(?:&&|;)\s*/g, "");
        sanitized = sanitized.replace(/source\s+activate\s*(?:&&|;)\s*/g, "");

        // Strip cd to project/experiment dirs — the helper already cds
        sanitized = sanitized.replace(/cd\s+\S+\s*(?:&&|;)\s*/g, "");

        // Strip absolute paths to .venv python/pip — just use python3/pip3
        sanitized = sanitized.replace(/(?:\/\S+)?\.venv\/bin\/python3?\s/g, "python3 ");
        sanitized = sanitized.replace(/(?:\/\S+)?\.venv\/bin\/pip3?\s/g, "pip3 ");

        // Replace 'python ' with 'python3 '
        sanitized = sanitized.replace(/\bpython\b(?!3)/g, "python3");
        // Replace 'pip ' with 'pip3 '
        sanitized = sanitized.replace(/\bpip\b(?!3)/g, "pip3");

        // Strip venv creation and pip install — the helper handles these automatically
        sanitized = sanitized.replace(/python3\s+-m\s+venv\s+\.venv\s*(?:&&|;)\s*/g, "");
        sanitized = sanitized.replace(/pip3?\s+install\s+(?:-r\s+)?requirements\.txt\s*(?:&&|;)\s*/g, "");
        sanitized = sanitized.replace(/pip3?\s+install\s+--upgrade\s+pip\s*(?:&&|;)\s*/g, "");

        // Strip absolute local paths
        sanitized = sanitized.replace(new RegExp(workDir + "/", "g"), "");

        // Clean up whitespace
        sanitized = sanitized.replace(/\s+/g, " ").trim();

        // ── GATE: execute_remote is ONLY for running Python experiment scripts ──
        // Block arbitrary shell commands, oneliners, kill, echo, cat, ls, etc.
        // The agent must use read_file/get_workspace for inspection and write_file for scripts.
        const validExperimentCmd = /^python3?\s+[\w][\w\-]*\.py(?:\s+.*)?$/.test(sanitized);
        if (!validExperimentCmd) {
          // Check specific bad patterns and give targeted feedback
          if (/^(kill|pkill|killall)\b/.test(sanitized)) {
            return "BLOCKED — execute_remote is only for running Python experiment scripts (e.g. 'python3 experiment.py'). Process management is handled automatically.";
          }
          if (/^(echo|cat|ls|find|grep|head|tail|wc|du|df|ps|nvidia-smi|stat|file|which|whoami|pwd|env|printenv)\b/.test(sanitized)) {
            return "BLOCKED — execute_remote is only for running Python experiment scripts. Use read_file or get_workspace for inspecting the filesystem.";
          }
          if (/^python3?\s+-c\s/.test(sanitized)) {
            return "BLOCKED — execute_remote does not accept inline Python (-c). Write your code to a .py file with write_file first, then run it with 'python3 <filename>.py'.";
          }
          if (/^(pip3?|conda|apt|brew|npm|curl|wget)\b/.test(sanitized)) {
            return "BLOCKED — execute_remote is only for running experiments. Package management is handled automatically via requirements.txt.";
          }
          if (/^(bash|sh|zsh)\b/.test(sanitized)) {
            return "BLOCKED — execute_remote is only for running Python experiment scripts. Do not wrap commands in bash/sh.";
          }
          return `BLOCKED — execute_remote only accepts commands in the form 'python3 <script>.py [args]'. Got: "${sanitized.slice(0, 60)}". Write a Python script with write_file first.`;
        }

        const scriptMatchForPolicy = sanitized.match(/python3?\s+(\S+\.py)/);
        if (scriptMatchForPolicy) {
          const scriptPolicyViolation = getManagedScriptPolicyViolation(scriptMatchForPolicy[1]);
          if (scriptPolicyViolation) {
            return scriptPolicyViolation;
          }
        }

        const contractScriptName = scriptMatchForPolicy?.[1] || sanitized;
        let contractScriptContent = "";
        if (scriptMatchForPolicy) {
          const fullContractScriptPath = path.join(workDir, scriptMatchForPolicy[1]);
          if (isPathWithinRoot(workDir, fullContractScriptPath)) {
            contractScriptContent = await readFile(fullContractScriptPath, "utf-8").catch(() => "");
          }
        }
        const contract = resolveExperimentContract({
          scriptName: contractScriptName,
          command: sanitized,
          code: contractScriptContent,
          experimentPurpose: experiment_purpose,
          grounding,
        });
        emit({
          type: "tool_output",
          toolName: "execute_remote",
          content: `Contract: ${contract.experimentPurpose} / ${contract.grounding} / ${contract.claimEligibility} / ${contract.evidenceClass}`,
        });

        // ── Pre-flight validation: catch antipatterns before burning GPU time ──
        const preflightScriptMatch = sanitized.match(/python3?\s+(\S+\.py)/);
        const preflightScriptName = preflightScriptMatch ? preflightScriptMatch[1] : null;
        const preflightScriptContent = preflightScriptName === contractScriptName
          ? contractScriptContent
          : preflightScriptName
            ? await readFile(path.join(workDir, preflightScriptName), "utf-8").catch(() => "")
            : "";
        const preflightGpuCount = cachedGpuInfo?.find((g: { alias: string }) => g.alias === host.alias)?.gpuCount ?? 1;
        const { validateExperiment, requiresBlockingSemanticAnalysis } = await import("./preflight");
        const requiresStrictSemanticAnalysis = preflightScriptName
          ? requiresBlockingSemanticAnalysis(preflightScriptName, preflightScriptContent)
          : false;
        try {
          const preflight = await validateExperiment(workDir, sanitized, preflightGpuCount, {
            experimentPurpose: contract.experimentPurpose,
            grounding: contract.grounding,
          });
          if (!preflight.ok) {
            emit({ type: "tool_output", toolName: "execute_remote", content: `\n⛔ PRE-FLIGHT CHECK FAILED\n${preflight.summary}` });
            return `BLOCKED — pre-flight validation found ${preflight.violations.filter(v => v.severity === "error").length} error(s) in the experiment code. Fix these before submitting:\n\n${preflight.summary}\n\nThe experiment was NOT submitted. Fix the code with write_file and try again.`;
          }
          if (preflight.violations.length > 0) {
            emit({ type: "tool_output", toolName: "execute_remote", content: `\n⚠ Pre-flight warnings:\n${preflight.summary}` });
          }
        } catch (preflightErr) {
          // Don't block submission on validator errors
          console.warn("[agent] preflight validation error:", preflightErr);
        }

        // Static analysis (pyright) removed — see run_experiment comment.

        // Auto-kill is handled by the helper itself (kills stale process before starting new one)
        // No pre-kill needed here — the helper's cmd_run auto-kills if something is running

        // ── Verify the script exists locally before syncing ──
        const scriptMatch = sanitized.match(/python3?\s+(\S+\.py)/);
        let scriptHash: string | undefined;
        let resolvedHypothesisId: string | null = hypothesis_id || null;
        if (scriptMatch) {
          const scriptName = scriptMatch[1];
          const scriptPath = path.join(workDir, scriptName);
          try {
            await stat(scriptPath);
          } catch {
            return `BLOCKED — Script "${scriptName}" does not exist in the experiment directory. Write it first with write_file.`;
          }

          // ── DB-backed failure tracking (survives restarts) ──
          const scriptContent = await readFile(scriptPath, "utf-8");
          const { createHash } = await import("crypto");
          scriptHash = createHash("sha256").update(scriptContent).digest("hex").slice(0, 16);

          const isFullExperiment = /python3?\s+exp_\d+/.test(sanitized);
          const readiness = await assessExperimentSubmission({
            command: sanitized,
            scriptName,
            requireHypothesis: isFullExperiment,
            hypothesisId: hypothesis_id,
            hostId: host.id,
            scriptHash,
          });
          if (!readiness.ok) {
            return readiness.message;
          }
          resolvedHypothesisId = readiness.hypothesisId;
          // autoAdvanceNote removed — FSM handles auto-transitions
          if (readiness.hypothesisNote) {
            emit({ type: "tool_output", toolName: "execute_remote", content: readiness.hypothesisNote });
          }
        }

        emit({ type: "tool_output", toolName: "execute_remote", content: `$ [${host.alias}] ${sanitized}` });
        emit({ type: "tool_progress", toolName: "execute_remote", content: `Syncing files to ${host.alias}...` });

        // Submit job — catch sync/submit errors and surface them
        let jobId: string;
        try {
          const result = await submitRemoteJob({
            hostId: host.id,
            localDir: workDir,
            command: sanitized,
            projectId,
            scriptHash,
            hypothesisId: resolvedHypothesisId || undefined,
            experimentPurpose: contract.experimentPurpose,
            grounding: contract.grounding,
            claimEligibility: contract.claimEligibility,
            promotionPolicy: contract.promotionPolicy,
            evidenceClass: contract.evidenceClass,
            mock: mockExecutor,
          });
          jobId = result.jobId;
        } catch (submitErr) {
          const errMsg = submitErr instanceof Error ? submitErr.message : String(submitErr);
          emit({ type: "tool_output", toolName: "execute_remote", content: `ERROR: Failed to submit job: ${errMsg}` });
          await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "FAILED", { host: host.alias, error: errMsg });
          return formatRemoteSubmissionFailure(host.alias, errMsg, await getActiveWorkspaceSubmissionGuard(projectId, host.id));
        }

        // Track active job for this session
        activeJobIds.add(jobId);

        emit({ type: "tool_output", toolName: "execute_remote", content: `Job submitted (${jobId.slice(0, 8)}). Running in background on ${host.alias}.` });
        emit({ type: "tool_progress", toolName: "execute_remote", content: `Job submitted to ${host.alias}. Continuing...` });

        await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "COMPLETED", { host: host.alias, jobId, status: "SUBMITTED" }, "EXECUTION");
        const taskCat = classifyTaskCategory(command);
        recordResourceChoice(userId, taskCat, `remote:${host.alias}`, command.slice(0, 80), projectId).catch(() => {});

        return `Job submitted to ${host.alias} (ID: ${jobId.slice(0, 8)}). It is now running in the background.\n\n**Continue with other work** — read papers, write code for the next experiment, analyze previous results. Use \`check_job\` with job_id="${jobId}" to check progress, or \`wait_for_jobs\` when you need results before proceeding.\n\nActive jobs this session: ${activeJobIds.size}`;
      },
    }),

    validate_environment: tool({
      description: "Prepare and validate the actual remote runtime that Arcana will use for experiment runs. This syncs the workspace, sets up the helper-managed environment, and runs a runtime smoke probe against that real execution path.",
      inputSchema: z.object({
        host_alias: z.string().optional().describe("Remote host alias. Omit to use the default host."),
      }),
      execute: async ({ host_alias }: { host_alias?: string }) => {
        const host = await getSelectedRemoteHost(host_alias);
        if (!host) return "No remote hosts configured.";

        emit({ type: "tool_progress", toolName: "validate_environment", content: `Validating environment on ${host.alias}...` });

        try {
          const reqPath = path.join(workDir, "requirements.txt");
          const hasRequirements = await stat(reqPath).then(() => true).catch(() => false);
          const { sshExecutor, hostToConfig } = await import("./remote-executor");
          const remoteDir = await sshExecutor.syncUp(workDir, hostToConfig(host as Parameters<typeof hostToConfig>[0]));

          emit({ type: "tool_progress", toolName: "validate_environment", content: `Preparing runtime in ${host.alias}:${path.basename(remoteDir)}...` });
          const setup = await quickRemoteCommand(host.id, `python3 ~/.arcana/helper.py setup-env ${remoteDir}`);
          const setupOutput = (setup.output || setup.error || "").trim();

          const parseHelperPayload = (raw: string) => {
            const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
              if (!lines[i].startsWith("{")) continue;
              try {
                return JSON.parse(lines[i]) as { ok?: boolean; message?: string; log?: string; error?: string };
              } catch {
                continue;
              }
            }
            return null;
          };

          const setupPayload = parseHelperPayload(setupOutput);
          if (!setup.ok || setupPayload?.ok === false) {
            emit({ type: "tool_output", toolName: "validate_environment", content: `Environment validation FAILED on ${host.alias}` });
            return [
              `ENVIRONMENT VALIDATION FAILED on ${host.alias}.`,
              "",
              setupPayload?.error || setupPayload?.message || setupOutput || "The remote helper could not prepare the runtime environment.",
            ].join("\n");
          }

          const smoke = await probeRuntimeSmoke(host.id, workDir);
          if (!smoke.ok) {
            emit({ type: "tool_output", toolName: "validate_environment", content: `Environment validation FAILED on ${host.alias}` });
            return [
              `ENVIRONMENT VALIDATION FAILED on ${host.alias}.`,
              "",
              smoke.error || "Runtime smoke probe failed.",
            ].join("\n");
          }

          emit({ type: "tool_output", toolName: "validate_environment", content: `Environment validated on ${host.alias}` });
          return [
            `Runtime environment is ready on ${host.alias}.`,
            hasRequirements
              ? "requirements.txt was synced into the real experiment workspace and the helper prepared the execution environment."
              : "No requirements.txt was present; validated the existing runtime path Arcana will use for this workspace.",
            smoke.torchVersion ? `PyTorch: ${smoke.torchVersion}` : "",
            typeof smoke.cudaAvailable === "boolean" ? `CUDA available: ${smoke.cudaAvailable}` : "",
            typeof smoke.gpuCount === "number" ? `Visible GPUs: ${smoke.gpuCount}` : "",
            setupPayload?.message ? `Setup: ${setupPayload.message}` : "",
          ].filter(Boolean).join("\n");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to connect to ${host.alias}: ${msg}`;
        }
      },
    }),

    cancel_job: tool({
      description: "Cancel a running remote job and release its workspace lease. Use this when a job is clearly stuck, blocked, or no longer relevant.",
      inputSchema: z.object({
        job_id: z.string().describe("The remote job ID to cancel"),
      }),
      execute: async ({ job_id }: { job_id: string }) => {
        const resolvedJob = await resolveProjectRemoteJob(projectId, job_id);
        if (resolvedJob.ambiguous) {
          return `Job "${job_id}" matches multiple jobs. Use a longer ID.\n\nMatches:\n${formatRemoteJobMatches(resolvedJob.matches as Array<{ id: string; command: string; status: string }>)} `;
        }
        const job = resolvedJob.job;
        if (!job) return `Job "${job_id}" not found.`;
        if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") {
          return `Job ${job.id.slice(0, 8)} is already ${job.status.toLowerCase()}.`;
        }

        const { cancelRemoteJob, reconcileRemoteJobState } = await import("./remote-executor");
        await cancelRemoteJob(job.id);
        const refreshed = await reconcileRemoteJobState(job.id).catch(() => null);
        activeJobIds.delete(job.id);
        invalidateWorkspace(projectId);

        const finalStatus = refreshed?.status || "CANCELLED";
        return `Cancelled job ${job.id.slice(0, 8)} on ${job.host.alias}. Final status: ${finalStatus}.`;
      },
    }),

    check_job: tool({
      description: "Check the status of a background remote job. Returns status, recent stdout/stderr, and exit code if completed. Use this to monitor jobs submitted with execute_remote. Quick and non-blocking.",
      inputSchema: z.object({
        job_id: z.string().describe("The job ID returned by execute_remote"),
      }),
      execute: async ({ job_id }: { job_id: string }) => {
        const resolvedJob = await resolveProjectRemoteJob(projectId, job_id);
        if (resolvedJob.ambiguous) {
          return `Job "${job_id}" matches multiple jobs. Use a longer ID.\n\nMatches:\n${formatRemoteJobMatches(resolvedJob.matches as Array<{ id: string; command: string; status: string }>)} `;
        }
        let job = resolvedJob.job;
        if (!job) return `Job "${job_id}" not found.`;

        if ((job.status === "RUNNING" || job.status === "SYNCING" || job.status === "QUEUED") && job.remoteDir) {
          try {
            const { reconcileRemoteJobState } = await import("./remote-executor");
            const reconciled = await reconcileRemoteJobState(job.id);
            if (reconciled) job = reconciled;
          } catch {
            // Fall back to the cached DB view below.
          }
        }

        const elapsed = job.startedAt
          ? Math.floor((Date.now() - job.startedAt.getTime()) / 1000)
          : null;
        const elapsedStr = elapsed !== null ? ` (${elapsed}s elapsed)` : "";

        // Stream recent output to UI
        if (job.stdout) {
          const recentLines = job.stdout.split("\n").filter(Boolean).slice(-20);
          for (const line of recentLines) {
            emit({ type: "tool_output", toolName: "check_job", content: line });
          }
        }

        if (job.status === "COMPLETED") {
          activeJobIds.delete(job.id);
          emit({ type: "tool_output", toolName: "check_job", content: `\n✓ Job completed (exit ${job.exitCode ?? 0}) on ${job.host.alias}${elapsedStr}` });

          // Sync results back if not already synced
          if (!job.resultsSynced && job.localDir) {
            try {
              const { sshExecutor } = await import("./remote-executor");
              const config = {
                host: job.host.host, port: job.host.port, user: job.host.user,
                keyPath: job.host.keyPath, workDir: job.host.workDir,
                conda: job.host.conda, setupCmd: job.host.setupCmd,
              };
              await sshExecutor.syncDown(job.remoteDir, job.localDir, config);
              await prisma.remoteJob.update({ where: { id: job.id }, data: { resultsSynced: true } });
            } catch {
              // Non-critical
            }
          }

          return `Job COMPLETED (exit ${job.exitCode ?? 0}) on ${job.host.alias}${elapsedStr}.\n\nstdout:\n${(job.stdout || "").slice(-5000)}\n\n${job.stderr ? `stderr:\n${job.stderr.slice(-1000)}` : ""}`;
        }

        if (job.status === "FAILED" || job.status === "CANCELLED") {
          activeJobIds.delete(job.id);
          emit({ type: "tool_output", toolName: "check_job", content: `\n✗ Job ${job.status.toLowerCase()} (exit ${job.exitCode ?? "?"}) on ${job.host.alias}${elapsedStr}` });

          // Try to recover partial results
          let partialResults = "";
          try {
            const resultsPath = path.join(workDir, "results.json");
            const resultsContent = await readFile(resultsPath, "utf-8").catch(() => null);
            if (resultsContent) {
              partialResults = `\n\nPARTIAL RESULTS RECOVERED:\n${resultsContent.slice(-3000)}`;
            }
          } catch {
            // No partial results
          }

          // Detect OOM kills — exit 137 = SIGKILL (128+9), almost always OOM
          const isOOM = job.exitCode === 137
            || (job.stderr || "").includes("OUT OF MEMORY")
            || (job.stderr || "").includes("[OOM DETECTED]")
            || (job.stderr || "").includes("CUDA out of memory")
            || (job.stderr || "").includes("OutOfMemoryError");
          const oomGuidance = isOOM
            ? "\n\n⚠ OOM KILL DETECTED — the process ran out of memory. To fix:\n1. Reduce per_device_train_batch_size (try halving it)\n2. Enable gradient_checkpointing=True\n3. Use DeepSpeed ZeRO stage 2 or 3 (add deepspeed config)\n4. Use accelerate with device_map='auto' for model sharding\n5. Use mixed precision (fp16=True or bf16=True)\nDo NOT reduce the dataset or simplify the model — fix memory usage instead."
            : "";

          // Failure tracking is DB-backed — no session-local state needed

          return `EXPERIMENT FAILED (exit ${job.exitCode ?? "?"}) on ${job.host.alias}${elapsedStr}. Fix the code and re-run.\n\nstdout:\n${(job.stdout || "").slice(-3000)}\n\nstderr:\n${(job.stderr || "").slice(-2000)}${partialResults}${oomGuidance}`;
        }

        // Still running/syncing — use helper for single-call structured status
        if ((job.status === "RUNNING" || job.status === "SYNCING") && job.remoteDir) {
          try {
            const { getHelperStatus, reconcileRemoteJobState } = await import("./remote-executor");
            const config = {
              host: job.host.host, port: job.host.port, user: job.host.user,
              keyPath: job.host.keyPath, workDir: job.host.workDir,
              conda: job.host.conda, setupCmd: job.host.setupCmd,
            };
            const status = await getHelperStatus(config, job.remoteDir);

            // Update DB with fresh logs
            await prisma.remoteJob.update({
              where: { id: job.id },
              data: { stdout: status.stdout_tail || job.stdout, stderr: status.stderr_tail || job.stderr },
            });

            if (status.status !== "running" && status.status !== "setup") {
              const reconciled = await reconcileRemoteJobState(job.id).catch(() => null);
              if (reconciled) job = reconciled;
              if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") {
                activeJobIds.delete(job.id);
                const outcome = job.status === "COMPLETED" ? "COMPLETED" : job.status;
                return `Job ${outcome} (exit ${job.exitCode ?? "?"}) on ${job.host.alias}${elapsedStr}.\n\nstdout:\n${(job.stdout || "").slice(-5000)}\n\n${job.stderr ? `stderr:\n${job.stderr.slice(-1000)}` : ""}`;
              }
            }

            // Still running — return live status with resource info
            const resourceNote = status.resource_snapshots?.length
              ? (() => {
                  const latest = status.resource_snapshots[status.resource_snapshots.length - 1];
                  const ramUsed = latest.cpu_ram_total_gb - latest.cpu_ram_avail_gb;
                  const gpuNote = latest.gpu_mem.map(g => `GPU${g.idx}: ${g.used_mb}/${g.total_mb} MiB`).join(", ");
                  return `\nResources: CPU RAM ${ramUsed.toFixed(1)}/${latest.cpu_ram_total_gb.toFixed(1)} GB${gpuNote ? `, ${gpuNote}` : ""}`;
                })()
              : "";
            const statusHint = job.status === "SYNCING" ? "syncing files" : "running";
            return `Job is ${statusHint} on ${job.host.alias}${elapsedStr}.${resourceNote}\n\nstdout (live):\n${(status.stdout_tail || "").slice(-3000)}\n\n${status.stderr_tail ? `stderr:\n${status.stderr_tail.slice(-500)}` : ""}\n\nActive jobs: ${activeJobIds.size}. Continue with other work and check back later.`;
          } catch {
            // Fall through to DB-cached logs
          }
        }

        const statusHint = job.status === "SYNCING" ? "syncing files" : job.status === "RUNNING" ? "running" : job.status.toLowerCase();
        return `Job is ${statusHint} on ${job.host.alias}${elapsedStr}.\n\nstdout so far:\n${(job.stdout || "").slice(-3000)}\n\n${job.stderr ? `stderr:\n${job.stderr.slice(-500)}` : ""}\n\nActive jobs: ${activeJobIds.size}. Continue with other work and check back later.`;
      },
    }),

    wait_for_jobs: tool({
      description: "Wait for one or more background jobs to complete. Use this when you genuinely need results before proceeding (e.g., to compare experiment outputs). Polls all listed jobs until all complete or timeout. Uses soft timeout — if a job is still producing output, the wait extends automatically. Prefer check_job for non-blocking status checks.",
      inputSchema: z.object({
        job_ids: z.array(z.string()).describe("Job IDs to wait for"),
        timeout_minutes: z.number().default(120).optional().describe("Soft timeout in minutes (default 120). Extended automatically if job is still producing output. Hard max: 480 min (8h)."),
      }),
      execute: async ({ job_ids, timeout_minutes }: { job_ids: string[]; timeout_minutes?: number }) => {
        const softTimeoutMs = (timeout_minutes || 120) * 60 * 1000;
        const hardTimeoutMs = 480 * 60 * 1000; // 8 hours absolute max
        const start = Date.now();
        const results: Record<string, { status: string; stdout: string; stderr: string; exitCode: number | null }> = {};
        const lastOutputLength: Record<string, number> = {}; // Track output growth for soft timeout
        const resolvedJobIds: Record<string, string> = {};

        emit({ type: "tool_progress", toolName: "wait_for_jobs", content: `Waiting for ${job_ids.length} job(s)...` });

        for (const requestedId of job_ids) {
          const resolved = await resolveProjectRemoteJob(projectId, requestedId);
          if (resolved.ambiguous) {
            results[requestedId] = {
              status: "AMBIGUOUS",
              stdout: "",
              stderr: `Job "${requestedId}" matches multiple jobs.\n${formatRemoteJobMatches(resolved.matches as Array<{ id: string; command: string; status: string }>)}`,
              exitCode: null,
            };
            continue;
          }
          if (resolved.job) {
            resolvedJobIds[requestedId] = resolved.job.id;
          }
        }

        while (true) {
          const elapsed = Date.now() - start;

          // Hard timeout — absolute maximum
          if (elapsed > hardTimeoutMs) break;

          let allDone = true;
          let anyProgress = false;

          for (const jid of job_ids) {
            if (results[jid]) continue; // Already finished

            const canonicalJobId = resolvedJobIds[jid] || jid;
            const job = await prisma.remoteJob.findUnique({
              where: { id: canonicalJobId },
              include: { host: true },
            });
            if (!job) {
              results[jid] = { status: "NOT_FOUND", stdout: "", stderr: "", exitCode: null };
              continue;
            }

            let currentJob = job;
            if ((job.status === "RUNNING" || job.status === "SYNCING" || job.status === "QUEUED") && job.remoteDir) {
              try {
                const { reconcileRemoteJobState } = await import("./remote-executor");
                const reconciled = await reconcileRemoteJobState(canonicalJobId);
                if (reconciled) currentJob = reconciled;
              } catch {
                // Fall back to the cached DB view below.
              }
            }

            if (currentJob.status === "COMPLETED" || currentJob.status === "FAILED" || currentJob.status === "CANCELLED") {
              activeJobIds.delete(canonicalJobId);
              results[jid] = {
                status: currentJob.status,
                stdout: currentJob.stdout || "",
                stderr: currentJob.stderr || "",
                exitCode: currentJob.exitCode,
              };

              // Sync results if needed
              if (currentJob.status === "COMPLETED" && !currentJob.resultsSynced && currentJob.localDir) {
                try {
                  const { sshExecutor } = await import("./remote-executor");
                  const config = {
                    host: currentJob.host.host, port: currentJob.host.port, user: currentJob.host.user,
                    keyPath: currentJob.host.keyPath, workDir: currentJob.host.workDir,
                    conda: currentJob.host.conda, setupCmd: currentJob.host.setupCmd,
                  };
                  await sshExecutor.syncDown(job.remoteDir, job.localDir, config);
                  await prisma.remoteJob.update({ where: { id: canonicalJobId }, data: { resultsSynced: true } });
                } catch {
                  // Non-critical
                }
              }

              const emoji = job.status === "COMPLETED" ? "✓" : "✗";
              emit({ type: "tool_output", toolName: "wait_for_jobs", content: `${emoji} Job ${jid.slice(0, 8)} ${job.status.toLowerCase()} on ${job.host.alias}` });
            } else {
              allDone = false;
              // Track output growth for soft timeout extension
              const currentLen = (job.stdout || "").length;
              const prevLen = lastOutputLength[jid] || 0;
              if (currentLen > prevLen) {
                anyProgress = true;
                lastOutputLength[jid] = currentLen;
              }
            }
          }

          if (allDone) break;

          // Soft timeout: if past the soft limit but jobs are still producing output, keep waiting
          if (elapsed > softTimeoutMs && !anyProgress) {
            emit({ type: "tool_output", toolName: "wait_for_jobs", content: `Soft timeout reached (${Math.round(softTimeoutMs / 60000)}min) and jobs are not producing new output. Returning current state.` });
            break;
          }

          const elapsedSec = Math.floor(elapsed / 1000);
          const pending = job_ids.filter((jid) => !results[jid]).length;
          const progressNote = elapsed > softTimeoutMs ? " (extending — still producing output)" : "";
          emit({ type: "tool_progress", toolName: "wait_for_jobs", content: `${pending} job(s) still running (${elapsedSec}s)${progressNote}...` });

          await new Promise((r) => setTimeout(r, 10_000));
        }

        // Build summary
        const summary: string[] = [];
        for (const jid of job_ids) {
          const r = results[jid];
          if (!r) {
            summary.push(`Job ${jid.slice(0, 8)}: STILL RUNNING (timed out waiting). Use check_job to monitor.`);
            continue;
          }
          if (r.status === "COMPLETED") {
            summary.push(`Job ${jid.slice(0, 8)}: COMPLETED (exit ${r.exitCode ?? 0})\nstdout:\n${r.stdout.slice(-3000)}\n${r.stderr ? `stderr:\n${r.stderr.slice(-500)}` : ""}`);
          } else if (r.status === "FAILED" || r.status === "CANCELLED") {
            summary.push(`Job ${jid.slice(0, 8)}: ${r.status} (exit ${r.exitCode ?? "?"})\nstdout:\n${r.stdout.slice(-2000)}\nstderr:\n${r.stderr.slice(-1000)}`);
          } else {
            summary.push(`Job ${jid.slice(0, 8)}: ${r.status}`);
          }
        }

        return summary.join("\n\n---\n\n");
      },
    }),

    run_experiment_sweep: tool({
      description: "Submit multiple experiment variants to remote GPU servers in parallel. Each variant runs as a separate background job. Use this for hyperparameter sweeps, ablation studies, or testing multiple approaches simultaneously. Arcana enforces one active run per host workspace, so each variant needs its own free host unless you use distinct work directories. Returns all job IDs — use check_job or wait_for_jobs to monitor.",
      inputSchema: z.object({
        script: z.string().describe("Path to the base experiment script (e.g., 'experiment.py')"),
        hypothesis_id: z.string().optional().describe("Hypothesis ID for exp_* sweeps. If omitted, Arcana auto-attaches the single live hypothesis when unambiguous."),
        experiment_purpose: z.enum(["SMOKE", "SYNTHETIC_PROXY", "CALIBRATION", "BASELINE", "MAIN_EVAL", "TRAINING", "ANALYSIS"]).optional(),
        grounding: z.enum(["UNSPECIFIED", "SYNTHETIC", "LOCAL_ARTIFACT", "EXTERNAL_DATASET", "MODEL_INFERENCE", "HUMAN_EVAL", "MIXED"]).optional(),
        variants: z.array(z.object({
          name: z.string().describe("Variant name for identification (e.g., 'lr=0.001', 'no-dropout')"),
          env: z.record(z.string(), z.string()).optional().describe("Environment variables to set for this variant"),
          args: z.string().optional().describe("Additional command-line arguments for this variant"),
        })).min(2).max(8).describe("2-8 experiment variants to run in parallel"),
        host_aliases: z.array(z.string()).optional().describe("Specific hosts to use (round-robin). Omit to use all available hosts."),
      }),
      execute: async ({ script, hypothesis_id, experiment_purpose, grounding, variants, host_aliases }: {
        script: string;
        hypothesis_id?: string;
        experiment_purpose?: ExperimentPurpose;
        grounding?: ExperimentGrounding;
        variants: { name: string; env?: Record<string, string>; args?: string }[];
        host_aliases?: string[];
      }) => {
        const scriptPath = path.join(workDir, script);
        const scriptContent = await readFile(scriptPath, "utf-8").catch(() => "");
        const contract = resolveExperimentContract({
          scriptName: script,
          command: `python3 ${script}`,
          code: scriptContent,
          experimentPurpose: experiment_purpose,
          grounding,
        });
        const { createHash } = await import("crypto");
        const scriptHash = createHash("sha256").update(scriptContent).digest("hex").slice(0, 16);
        const isFullExperiment = /^exp_\d+_/i.test(path.basename(script));

        // Resolve hosts
        let hosts;
        if (host_aliases && host_aliases.length > 0) {
          hosts = await prisma.remoteHost.findMany({ where: { alias: { in: host_aliases } } });
        } else {
          hosts = await listDefaultResearchHosts({ take: 5, includeSynthetic: allowSyntheticRemoteHosts });
        }
        if (hosts.length === 0) return "No remote hosts available for sweep.";

        const firstVariantArgs = variants[0]?.args ? ` ${variants[0].args}` : "";
        const readiness = await assessExperimentSubmission({
          command: `python3 ${script}${firstVariantArgs}`,
          scriptName: path.basename(script),
          requireHypothesis: isFullExperiment,
          hypothesisId: hypothesis_id,
          scriptHash,
        });
        if (!readiness.ok) {
          return readiness.message;
        }
        const resolvedHypothesisId = readiness.hypothesisId;
        // autoAdvanceNote removed — FSM handles auto-transitions
        if (readiness.hypothesisNote) {
          emit({ type: "tool_output", toolName: "run_experiment_sweep", content: readiness.hypothesisNote });
        }

        // Enforce sweep safety: one active run per host workspace.
        // This tool expects true parallelism; partial submission causes inconsistent comparisons.
        const localBaseName = getWorkspaceBaseName(workDir);
        const hostAvailability = await Promise.all(hosts.map(async (host) => {
          const projectedRemoteDir = `${host.workDir}/${localBaseName}`;
          const conflict = await prisma.remoteJob.findFirst({
            where: {
              hostId: host.id,
              status: { in: ["SYNCING", "QUEUED", "RUNNING"] },
              OR: [
                { remoteDir: projectedRemoteDir },
                { remoteDir: "", localDir: workDir },
              ],
            },
            select: { id: true, status: true },
          });
          return { host, conflict };
        }));

        const freeHosts = hostAvailability.filter((x) => !x.conflict).map((x) => x.host);
        const busyHosts = hostAvailability.filter((x) => x.conflict);
        if (freeHosts.length < variants.length) {
          const blockedReason = `BLOCKED — requested ${variants.length} variant(s), but only ${freeHosts.length} free host workspace(s) are available right now. Arcana enforces one active run per host+workspace to avoid run interference.`;
          const busyDetails = busyHosts.length > 0
            ? ` Busy hosts: ${busyHosts.map((x) => `${x.host.alias}(${x.conflict!.status.toLowerCase()}:${x.conflict!.id.slice(0, 8)})`).join(", ")}.`
            : "";

          await recordStep("run_experiment", `Sweep blocked: ${variants.length} variants of ${script}`, "FAILED", {
            script,
            variants: variants.map((v) => v.name),
            availableHosts: freeHosts.map((h) => h.alias),
            busyHosts: busyHosts.map((x) => ({ alias: x.host.alias, jobId: x.conflict?.id, status: x.conflict?.status })),
            reason: "insufficient_free_hosts_for_parallel_sweep",
          }, "EXECUTION");

          return `${blockedReason}${busyDetails} Provide more hosts or use separate work directories per concurrent run.`;
        }
        hosts = freeHosts;

        const evalProtocol = await getEvaluationProtocol(projectId);
        if (evalProtocol) {
          for (const variant of variants) {
            const envPrefix = variant.env
              ? Object.entries(variant.env).map(([k, v]) => `${k}=${v}`).join(" ") + " "
              : "";
            const args = variant.args ? ` ${variant.args}` : "";
            let cmd = `${envPrefix}python3 ${script}${args}`;
            cmd = cmd.replace(/\bpython\b(?!3)/g, "python3").replace(/\s+/g, " ").trim();
            const protocolCheck = validateCommandAgainstEvaluationProtocol(cmd, evalProtocol.protocol);
            if (!protocolCheck.ok) {
              return `BLOCKED — Variant "${variant.name}" violates the evaluation protocol: ${protocolCheck.reason}\n\nUse show_evaluation_protocol to review the active protocol.`;
            }
          }
        }

        emit({
          type: "tool_output",
          toolName: "run_experiment_sweep",
          content: `Contract: ${contract.experimentPurpose} / ${contract.grounding} / ${contract.claimEligibility} / ${contract.evidenceClass}`,
        });

        emit({ type: "tool_progress", toolName: "run_experiment_sweep", content: `Starting sweep: ${variants.length} variants across ${hosts.length} host(s)...` });

        const jobResults: { name: string; jobId: string; host: string; error?: string }[] = [];

        for (let i = 0; i < variants.length; i++) {
          const variant = variants[i];
          const host = hosts[i];

          // Build command with variant env vars and args
          const envPrefix = variant.env
            ? Object.entries(variant.env).map(([k, v]) => `${k}=${v}`).join(" ") + " "
            : "";
          const args = variant.args ? ` ${variant.args}` : "";
          let cmd = `${envPrefix}python3 ${script}${args}`;

          // Apply standard sanitization
          cmd = cmd.replace(/\bpython\b(?!3)/g, "python3");
          cmd = cmd.replace(/\s+/g, " ").trim();

          try {
            const result = await submitRemoteJob({
              hostId: host.id,
              localDir: workDir,
              command: cmd,
              projectId,
              hypothesisId: resolvedHypothesisId || undefined,
              experimentPurpose: contract.experimentPurpose,
              grounding: contract.grounding,
              claimEligibility: contract.claimEligibility,
              promotionPolicy: contract.promotionPolicy,
              evidenceClass: contract.evidenceClass,
              mock: mockExecutor,
            });
            activeJobIds.add(result.jobId);
            jobResults.push({ name: variant.name, jobId: result.jobId, host: host.alias });
            emit({ type: "tool_output", toolName: "run_experiment_sweep", content: `Submitted "${variant.name}" to ${host.alias} (${result.jobId.slice(0, 8)})` });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            jobResults.push({ name: variant.name, jobId: "", host: host.alias, error: errMsg });
            emit({ type: "tool_output", toolName: "run_experiment_sweep", content: `Failed "${variant.name}" on ${host.alias}: ${errMsg}` });
          }
        }

        const successful = jobResults.filter((r) => !r.error);
        const failed = jobResults.filter((r) => r.error);

        await recordStep("run_experiment", `Sweep: ${variants.length} variants of ${script}`, successful.length > 0 ? "COMPLETED" : "FAILED", {
          script,
          variants: variants.map((v) => v.name),
          jobIds: successful.map((r) => r.jobId),
          failedCount: failed.length,
        }, "EXECUTION");

        let summary = `Experiment sweep submitted: ${successful.length}/${variants.length} jobs running\n\n`;
        summary += successful.map((r) => `- "${r.name}" → ${r.host} (ID: ${r.jobId.slice(0, 8)})`).join("\n");
        if (failed.length > 0) {
          summary += `\n\nFailed to submit:\n${failed.map((r) => `- "${r.name}" on ${r.host}: ${r.error}`).join("\n")}`;
        }
        summary += `\n\n**Continue with other work.** Use \`wait_for_jobs\` with IDs [${successful.map((r) => `"${r.jobId}"`).join(", ")}] when you need to compare results.`;

        return summary;
      },
    }),

    dispatch_scouts: tool({
      description: "Launch parallel literature scout agents to search from multiple angles. Scouts search and REPORT findings — they do NOT import papers. You review their findings via collect_results and import only the best papers with search_papers. This keeps your library clean.",
      inputSchema: z.object({
        facets: z.array(z.object({
          angle: z.string().describe("Search angle, e.g. 'theoretical foundations of attention mechanisms'"),
          keywords: z.array(z.string()).describe("Search keywords for this angle"),
        })).min(2).max(3).describe("2-3 different search facets to explore in parallel"),
      }),
      execute: async ({ facets }: { facets: { angle: string; keywords: string[] }[] }) => {
        if (!(prisma as unknown as Record<string, unknown>).agentTask) {
          return "Sub-agent tasks not available. Restart the dev server to pick up schema changes.";
        }
        emit({ type: "tool_progress", toolName: "dispatch_scouts", content: `Launching ${facets.length} literature scouts...` });

        const taskIds: string[] = [];
        for (const facet of facets) {
          const task = await prisma.agentTask.create({
            data: {
              projectId,
              role: "scout",
              goal: facet.angle,
              status: "PENDING",
              input: JSON.stringify({ angle: facet.angle, keywords: facet.keywords, userId, bannedPapers: bannedPapers || [] }),
            },
          });
          taskIds.push(task.id);

          launchTaskInBackground(task.id, "dispatch_scouts");

          emit({ type: "tool_output", toolName: "dispatch_scouts", content: `Scout launched: "${facet.angle}" (${task.id.slice(0, 8)})` });
        }

        await recordStep("search_papers", `Dispatched ${facets.length} literature scouts`, "COMPLETED", { taskIds, facets: facets.map((f) => f.angle) }, "DISCOVERY");

        return `Launched ${facets.length} literature scouts:\n${facets.map((f, i) => `${i + 1}. "${f.angle}" (ID: ${taskIds[i].slice(0, 8)})`).join("\n")}\n\nScouts are searching in the background. **Continue with other work** — formulate hypotheses, write code, analyze previous results. Use \`collect_results\` with these task IDs when you're ready to review their findings.`;
      },
    }),

    dispatch_reviewer: tool({
      description: "Launch a background adversarial reviewer (runs on Opus) to critique your hypotheses, methodology, or results. The reviewer has access to the paper library and Mind Palace to verify claims against literature. Returns a task ID — collect the review with collect_results when ready. Use this for deep, literature-grounded critique; use adversarial_review for quick inline critique.",
      inputSchema: z.object({
        content: z.string().describe("The hypotheses, experimental design, or results to review. Include specific numbers, methods, and claims."),
        focus: z.enum(["hypotheses", "methodology", "results", "statistical", "general"]).default("general").optional()
          .describe("What aspect to focus the review on"),
        claim_ids: z.array(z.string()).optional().describe("Optional claim IDs to review explicitly. When provided, collect_results will import the reviewer verdicts back into the claim ledger."),
      }),
      execute: async ({ content, focus, claim_ids }: { content: string; focus?: string; claim_ids?: string[] }) => {
        if (!(prisma as unknown as Record<string, unknown>).agentTask) {
          return "Sub-agent tasks not available. Restart the dev server to pick up schema changes.";
        }
        const reviewFocus = focus || "general";
        const claims = await loadReviewClaims(claim_ids);
        emit({ type: "tool_progress", toolName: "dispatch_reviewer", content: `Launching adversarial reviewer (${reviewFocus})...` });

        const task = await prisma.agentTask.create({
          data: {
            projectId,
            role: "reviewer",
            goal: `Adversarial review (${reviewFocus})`,
            status: "PENDING",
            input: JSON.stringify({ content, focus: reviewFocus, userId, claimIds: claim_ids || [], claims }),
          },
        });

        launchTaskInBackground(task.id, "dispatch_reviewer");

        emit({ type: "tool_output", toolName: "dispatch_reviewer", content: `Reviewer launched (${task.id.slice(0, 8)})` });
        await recordStep("critique", `Dispatched adversarial reviewer (${reviewFocus})`, "COMPLETED", { taskId: task.id, focus: reviewFocus });
        await syncCredibilityState();

        return `Launched adversarial reviewer (ID: ${task.id.slice(0, 8)}, focus: ${reviewFocus}).\n\nThe reviewer runs on Opus and has access to your paper library and Mind Palace — it will verify claims against literature. **Continue with other work** and use \`collect_results\` with ["${task.id}"] when ready.`;
      },
    }),

    dispatch_reproducer: tool({
      description: "Launch a background reproducer to verify claim(s) against recorded runs, files, and evidence. Use this when you want a claim to be promoted only after a stricter audit than a normal review. Completed reproducer verdicts are imported into the claim ledger by collect_results.",
      inputSchema: z.object({
        content: z.string().describe("The claim context to verify. Include the exact result summary, script names, and any artifacts or files worth inspecting."),
        focus: z.enum(["replication", "results", "artifacts", "protocol"]).default("replication").optional()
          .describe("What to focus on while verifying the claim"),
        claim_ids: z.array(z.string()).optional().describe("Claim IDs to audit explicitly. These are used for automatic ledger updates on collect_results."),
      }),
      execute: async ({ content, focus, claim_ids }: { content: string; focus?: string; claim_ids?: string[] }) => {
        if (!(prisma as unknown as Record<string, unknown>).agentTask) {
          return "Sub-agent tasks not available. Restart the dev server to pick up schema changes.";
        }
        const claims = await loadReviewClaims(claim_ids);
        const reviewFocus = focus || "replication";
        emit({ type: "tool_progress", toolName: "dispatch_reproducer", content: `Launching reproducer (${reviewFocus})...` });

        const task = await prisma.agentTask.create({
          data: {
            projectId,
            role: "reproducer",
            goal: `Reproduce claim (${reviewFocus})`,
            status: "PENDING",
            input: JSON.stringify({ content, focus: reviewFocus, userId, workDir, claimIds: claim_ids || [], claims }),
          },
        });

        launchTaskInBackground(task.id, "dispatch_reproducer");

        emit({ type: "tool_output", toolName: "dispatch_reproducer", content: `Reproducer launched (${task.id.slice(0, 8)})` });
        await recordStep("critique", `Dispatched reproducer (${reviewFocus})`, "COMPLETED", { taskId: task.id, focus: reviewFocus, claimIds: claim_ids || [] });
        await syncCredibilityState();

        return `Launched reproducer (ID: ${task.id.slice(0, 8)}, focus: ${reviewFocus}).\n\nThe reproducer will inspect the recorded evidence and workspace files before issuing a verdict. **Continue with other work** and use \`collect_results\` with ["${task.id}"] when ready.`;
      },
    }),

    // dispatch_experimenter: Disabled — the main agent handles experiments directly.
    // Revisit if we need truly independent background experiment runners.

    dispatch_synthesizer: tool({
      description: "Launch a background synthesizer (runs on Opus) to do deep cross-paper analysis. Given paper titles from your library, the synthesizer reads them all and finds contradictions, complementary techniques, and unexplored combinations that individual readings miss. Returns a task ID — collect with collect_results. Feed its output to dispatch_architect.",
      inputSchema: z.object({
        papers: z.array(z.string()).optional().describe("Paper titles to synthesize across. If omitted, synthesizer searches the library based on the focus."),
        focus: z.string().describe("What to focus the synthesis on (e.g., 'attention mechanism efficiency techniques across these papers')"),
      }),
      execute: async ({ papers, focus }: { papers?: string[]; focus: string }) => {
        if (!(prisma as unknown as Record<string, unknown>).agentTask) {
          return "Sub-agent tasks not available. Restart the dev server to pick up schema changes.";
        }
        emit({ type: "tool_progress", toolName: "dispatch_synthesizer", content: `Launching synthesizer: ${focus.slice(0, 60)}...` });

        const task = await prisma.agentTask.create({
          data: {
            projectId,
            role: "synthesizer",
            goal: `Synthesize: ${focus.slice(0, 200)}`,
            status: "PENDING",
            input: JSON.stringify({ papers: papers || [], focus, userId }),
          },
        });

        launchTaskInBackground(task.id, "dispatch_synthesizer");

        emit({ type: "tool_output", toolName: "dispatch_synthesizer", content: `Synthesizer launched (${task.id.slice(0, 8)})` });
        await recordStep("synthesize", `Dispatched synthesizer: ${focus.slice(0, 80)}`, "COMPLETED", { taskId: task.id, focus, paperCount: (papers || []).length }, "DISCOVERY");

        const paperNote = papers && papers.length > 0
          ? `Analyzing ${papers.length} papers: ${papers.slice(0, 3).map(p => `"${p.slice(0, 40)}"`).join(", ")}${papers.length > 3 ? ` +${papers.length - 3} more` : ""}`
          : "Searching library for relevant papers";
        return `Launched synthesizer (ID: ${task.id.slice(0, 8)}): ${paperNote}\nFocus: ${focus}\n\nThe synthesizer runs on Opus and reads papers deeply. **Continue with other work** and use \`collect_results\` with ["${task.id}"] when ready. Feed its output to \`dispatch_architect\` for novel approach proposals.`;
      },
    }),

    // dispatch_analyst: Disabled — never used in practice. The main agent reads results directly.
    // Revisit if we need structured diagnostic pipelines.

    dispatch_architect: tool({
      description: "Launch a background research architect (runs on Opus) to propose novel approaches. The architect combines synthesis reports (from dispatch_synthesizer) and your experiment results to propose 2-3 creative approaches with risk ratings and validation experiments. Call this AFTER you have synthesis output and experiment results.",
      inputSchema: z.object({
        goal: z.string().describe("The research goal (e.g., 'Improve attention efficiency for long-sequence modeling')"),
        synthesis: z.string().describe("Output from the synthesizer sub-agent (cross-paper analysis)"),
        diagnostics: z.string().optional().describe("Raw data from the analyst sub-agent (optional but recommended)"),
        current_approach: z.string().optional().describe("What's been tried so far and the results"),
      }),
      execute: async ({ goal, synthesis, diagnostics, current_approach }: {
        goal: string; synthesis: string; diagnostics?: string; current_approach?: string;
      }) => {
        if (!(prisma as unknown as Record<string, unknown>).agentTask) {
          return "Sub-agent tasks not available. Restart the dev server to pick up schema changes.";
        }
        emit({ type: "tool_progress", toolName: "dispatch_architect", content: `Launching architect: ${goal.slice(0, 60)}...` });

        const task = await prisma.agentTask.create({
          data: {
            projectId,
            role: "architect",
            goal: `Architect: ${goal.slice(0, 200)}`,
            status: "PENDING",
            input: JSON.stringify({ goal, synthesis, diagnostics, current_approach, userId }),
          },
        });

        launchTaskInBackground(task.id, "dispatch_architect");

        emit({ type: "tool_output", toolName: "dispatch_architect", content: `Architect launched (${task.id.slice(0, 8)})` });
        await recordStep("synthesize", `Dispatched architect: ${goal.slice(0, 80)}`, "COMPLETED", { taskId: task.id, goal, hasDiagnostics: !!diagnostics }, "DISCOVERY");

        return `Launched architect (ID: ${task.id.slice(0, 8)}): "${goal}"\n\nThe architect runs on Opus with library access and will propose 2-3 novel approaches with risk ratings. **Continue with other work** and use \`collect_results\` with ["${task.id}"] when ready.\n\n**Important:** Review proposals critically. Start with the cheapest validation experiment before committing to larger changes.`;
      },
    }),

    dispatch_visualizer: tool({
      description: "Launch a background visualizer to create publication-quality figures from experiment results. The visualizer reads result JSON/CSV files, creates matplotlib plots (training curves, method comparisons, ablation charts, heatmaps), and saves them as PNG+PDF. Use after experiments complete to visualize and compare results.",
      inputSchema: z.object({
        goal: z.string().describe("What to visualize (e.g., 'Compare training loss across all methods', 'Plot credit weight distributions')"),
        resultFiles: z.string().optional().describe("Comma-separated list of result files to read"),
        metrics: z.string().optional().describe("Key metrics to focus on (e.g., 'loss, accuracy, gradient_norm')"),
      }),
      execute: async ({ goal, resultFiles, metrics }: { goal: string; resultFiles?: string; metrics?: string }) => {
        if (!(prisma as unknown as Record<string, unknown>).agentTask) {
          return "Sub-agent tasks not available.";
        }
        emit({ type: "tool_progress", toolName: "dispatch_visualizer", content: `Launching visualizer...` });

        const task = await prisma.agentTask.create({
          data: {
            projectId,
            role: "visualizer",
            goal,
            status: "PENDING",
            input: JSON.stringify({ workDir, userId, resultFiles, metrics }),
          },
        });

        launchTaskInBackground(task.id, "dispatch_visualizer");

        return `Launched visualizer (ID: ${task.id.slice(0, 8)}): "${goal}"\n\nThe visualizer will read result files and create figures in the experiment directory. Collect results with \`collect_results\` when ready.`;
      },
    }),

    dispatch_provocateur: tool({
      description: "Launch a creative provocateur (runs on Opus) to suggest WILDLY DIFFERENT approaches from outside the current trajectory. The provocateur searches the web for inspiration from other fields (biology, physics, economics, etc.) and proposes lateral-thinking directions with concrete experiments. Use when you're stuck, when results plateau, or after 2+ experiments in the same direction without breakthrough.",
      inputSchema: z.object({
        goal: z.string().describe("The research goal"),
        trajectory: z.string().describe("What has been tried so far — approaches, results, and direction"),
        stuck_on: z.string().optional().describe("What specific problem you're stuck on, if any"),
      }),
      execute: async ({ goal, trajectory, stuck_on }: { goal: string; trajectory: string; stuck_on?: string }) => {
        if (!(prisma as unknown as Record<string, unknown>).agentTask) {
          return "Sub-agent tasks not available. Restart the dev server to pick up schema changes.";
        }
        emit({ type: "tool_progress", toolName: "dispatch_provocateur", content: `Launching provocateur: thinking laterally...` });

        const task = await prisma.agentTask.create({
          data: {
            projectId,
            role: "provocateur",
            goal: `Break from trajectory: ${goal.slice(0, 200)}`,
            status: "PENDING",
            input: JSON.stringify({ trajectory, stuck_on, goal, userId }),
          },
        });

        launchTaskInBackground(task.id, "dispatch_provocateur");

        emit({ type: "tool_output", toolName: "dispatch_provocateur", content: `Provocateur launched (${task.id.slice(0, 8)})` });
        return `Launched provocateur (ID: ${task.id.slice(0, 8)}): thinking laterally about "${goal.slice(0, 60)}"\n\nThe provocateur has web search + library access and will propose approaches from outside your current trajectory. **Continue with other work** and use \`collect_results\` with ["${task.id}"] when ready.`;
      },
    }),

    monitor_experiment: tool({
      description: "Parse live training output from a running experiment and flag anomalies. Call this periodically while experiments run on remote servers — it reads the latest stdout from check_job and detects NaN, divergence, plateaus, and suspicious values. Use DURING training, not after.",
      inputSchema: z.object({
        job_id: z.string().describe("Remote job ID to monitor"),
        expected_loss_range: z.array(z.number()).optional().describe("Expected [min, max] loss range based on literature baselines"),
      }),
      execute: async ({ job_id, expected_loss_range }: { job_id: string; expected_loss_range?: number[] }) => {
        const resolvedJob = await resolveProjectRemoteJob(projectId, job_id);
        if (resolvedJob.ambiguous) {
          return `Job "${job_id}" matches multiple jobs. Use a longer ID.\n\nMatches:\n${formatRemoteJobMatches(resolvedJob.matches as Array<{ id: string; command: string; status: string }>)} `;
        }
        const job = await prisma.remoteJob.findUnique({
          where: { id: resolvedJob.job?.id || job_id },
          select: { status: true, stdout: true, stderr: true, command: true },
        });
        if (!job) return `Job ${job_id} not found.`;
        if (job.status !== "RUNNING" && job.status !== "SYNCING" && job.status !== "QUEUED") {
          return `Job ${job_id} is ${job.status}, not running. Use check_job for final results.`;
        }

        const stdout = job.stdout || "";
        if (!stdout.trim()) return `Job ${job_id} is ${job.status} but has no output yet. Check back in a minute.`;

        const lines = stdout.split("\n").filter(Boolean);
        const issues: string[] = [];
        const metrics: { step?: number; loss?: number; acc?: number; lr?: number; gradNorm?: number }[] = [];

        // Parse training metrics from stdout
        for (const line of lines.slice(-100)) { // last 100 lines
          // Detect NaN/Inf
          if (/\bnan\b/i.test(line) && /loss|grad|norm|acc/i.test(line)) {
            issues.push(`NaN detected: ${line.trim().slice(0, 120)}`);
          }
          if (/\binf\b/i.test(line) && /loss|grad|norm/i.test(line)) {
            issues.push(`Inf detected: ${line.trim().slice(0, 120)}`);
          }

          // Extract numeric metrics
          const lossMatch = line.match(/loss[:\s=]+([0-9.e+-]+)/i);
          const accMatch = line.match(/acc(?:uracy)?[:\s=]+([0-9.]+)/i);
          const stepMatch = line.match(/(?:step|epoch|iter)[:\s=]+(\d+)/i);
          const gradMatch = line.match(/grad(?:_?norm)?[:\s=]+([0-9.e+-]+)/i);
          const lrMatch = line.match(/(?:lr|learning.?rate)[:\s=]+([0-9.e+-]+)/i);

          if (lossMatch || accMatch) {
            metrics.push({
              step: stepMatch ? parseInt(stepMatch[1]) : undefined,
              loss: lossMatch ? parseFloat(lossMatch[1]) : undefined,
              acc: accMatch ? parseFloat(accMatch[1]) : undefined,
              lr: lrMatch ? parseFloat(lrMatch[1]) : undefined,
              gradNorm: gradMatch ? parseFloat(gradMatch[1]) : undefined,
            });
          }
        }

        // Analyze trends
        const losses = metrics.map((m) => m.loss).filter((l): l is number => l != null && !isNaN(l));
        if (losses.length >= 3) {
          const recent = losses.slice(-5);
          const earlier = losses.slice(0, Math.max(1, losses.length - 5));

          // Check for divergence (loss increasing significantly)
          const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
          const earlierAvg = earlier.reduce((s, v) => s + v, 0) / earlier.length;
          if (recentAvg > earlierAvg * 1.5 && losses.length > 10) {
            issues.push(`Loss diverging: earlier avg ${earlierAvg.toFixed(4)} → recent avg ${recentAvg.toFixed(4)} (+${((recentAvg / earlierAvg - 1) * 100).toFixed(0)}%)`);
          }

          // Check for plateau
          const variance = recent.reduce((s, v) => s + (v - recentAvg) ** 2, 0) / recent.length;
          if (variance < 0.0001 && losses.length > 20) {
            issues.push(`Loss plateaued at ~${recentAvg.toFixed(4)} (variance ${variance.toExponential(2)})`);
          }

          // Check expected range
          if (expected_loss_range && expected_loss_range.length === 2) {
            const [min, max] = expected_loss_range;
            if (recentAvg > max) issues.push(`Loss ${recentAvg.toFixed(4)} is ABOVE expected range [${min}, ${max}]`);
            if (recentAvg < min * 0.5) issues.push(`Loss ${recentAvg.toFixed(4)} is suspiciously LOW (expected [${min}, ${max}])`);
          }
        }

        // Check gradient norms
        const grads = metrics.map((m) => m.gradNorm).filter((g): g is number => g != null && !isNaN(g));
        if (grads.length >= 3) {
          const maxGrad = Math.max(...grads.slice(-10));
          if (maxGrad > 100) issues.push(`Gradient explosion: norm reached ${maxGrad.toFixed(2)} — consider gradient clipping`);
          const minGrad = Math.min(...grads.slice(-10));
          if (minGrad < 1e-7 && grads.length > 5) issues.push(`Vanishing gradients: norm dropped to ${minGrad.toExponential(2)}`);
        }

        // Build report
        const parts: string[] = [`## Experiment Monitor: ${job.command?.match(/python3?\s+(\S+\.py)/)?.[1] || "experiment"}`];
        parts.push(`Status: ${job.status}, ${lines.length} output lines`);

        if (metrics.length > 0) {
          const last = metrics[metrics.length - 1];
          parts.push(`\nLatest metrics: ${[
            last.step != null ? `step=${last.step}` : "",
            last.loss != null ? `loss=${last.loss.toFixed(4)}` : "",
            last.acc != null ? `acc=${(last.acc * 100).toFixed(1)}%` : "",
            last.gradNorm != null ? `grad_norm=${last.gradNorm.toFixed(4)}` : "",
            last.lr != null ? `lr=${last.lr.toExponential(2)}` : "",
          ].filter(Boolean).join(", ")}`);

          if (losses.length >= 2) {
            parts.push(`Loss trend: ${losses[0].toFixed(4)} → ${losses[losses.length - 1].toFixed(4)} over ${losses.length} measurements`);
          }
        }

        if (issues.length > 0) {
          parts.push(`\n**ISSUES DETECTED (${issues.length}):**`);
          for (const issue of issues) parts.push(`- ${issue}`);
          parts.push(`\n**ACTION NEEDED:** Review the issues above. Consider stopping the experiment if you see NaN/divergence.`);
        } else {
          parts.push(`\nNo anomalies detected. Training appears healthy.`);
        }

        return parts.join("\n");
      },
    }),

    collect_results: tool({
      description: "Collect findings from dispatched sub-agents (scouts, reviewers, reproducers, synthesizers, architects, provocateurs). Returns completed outputs and status of pending ones. Automatically detects and re-launches zombie tasks that got stuck. Reviewer and reproducer verdicts are imported into the claim ledger exactly once. Call this after doing other work.",
      inputSchema: z.object({
        task_ids: z.array(z.string()).describe("Task IDs from any dispatch tool"),
      }),
      execute: async ({ task_ids }: { task_ids: string[] }) => {
        if (!(prisma as unknown as Record<string, unknown>).agentTask) {
          return "Sub-agent tasks not available. Restart the dev server to pick up schema changes.";
        }
        const tasks = await prisma.agentTask.findMany({
          where: { id: { in: task_ids } },
        });

        if (tasks.length === 0) return "No tasks found with those IDs.";

        const cooldown = evaluateCollectResultsCooldown(tasks, new Date());
        if (cooldown?.blocked) {
          return [
            "BLOCKED — collect_results was called again too soon for the same unchanged running task set.",
            cooldown.reason,
            "Do other substantive work first, or wait until the cooldown expires before polling again.",
          ].join("\n\n");
        }

        const completed: string[] = [];
        const pending: string[] = [];
        const failed: string[] = [];
        const relaunched: string[] = [];

        const ZOMBIE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes — scouts should finish in 2-5min

        const roleLabel = (t: { role: string }) => {
          const labels: Record<string, string> = {
            scout: "Scout", reviewer: "Reviewer", experimenter: "Experimenter",
            synthesizer: "Synthesizer", analyst: "Analyst", architect: "Architect", reproducer: "Reproducer",
          };
          return labels[t.role] || t.role;
        };

        // Zombie thresholds per role (experimenters take longer)
        const zombieThreshold = (role: string) =>
          role === "experimenter" ? 30 * 60 * 1000 : 10 * 60 * 1000;

        for (const task of tasks) {
          const label = roleLabel(task);
          if (task.status === "COMPLETED" && task.output) {
            try {
              const output = JSON.parse(task.output);
              const importedClaimReviews = await ingestTaskClaimReviews(task);
              let entry = `## ${label}: "${output.angle || task.goal}"\n${output.summary || "No summary"}\n(${output.stepsUsed || "?"} steps, ${task.tokenUsage || "?"} tokens)`;
              if (task.role === "architect") {
                entry += "\n\n> **Review these proposals critically.** Start with the cheapest validation experiment before committing to larger changes.";
              }
              if (importedClaimReviews.length > 0) {
                entry += `\n\nImported claim reviews:\n${importedClaimReviews.map((item) => `- ${item}`).join("\n")}`;
              }
              completed.push(entry);
            } catch {
              completed.push(`## ${label}: "${task.goal}"\n${task.output.slice(0, 3000)}`);
            }
          } else if (task.status === "FAILED") {
            failed.push(`${label} "${task.goal}": FAILED — ${task.error || "unknown error"}`);
          } else if (task.status === "RUNNING" || task.status === "PENDING") {
            const age = Date.now() - new Date(task.createdAt).getTime();
            if (age > zombieThreshold(task.role)) {
              // Zombie task — mark failed and re-launch
              await prisma.agentTask.update({
                where: { id: task.id },
                data: { status: "FAILED", error: `Zombie: stuck in ${task.status} for ${Math.round(age / 60000)}min`, completedAt: new Date() },
              });

              // Re-launch with a new task
              try {
                const newTask = await prisma.agentTask.create({
                  data: {
                    projectId: task.projectId,
                    role: task.role,
                    goal: task.goal,
                    status: "PENDING",
                    input: task.input,
                  },
                });
                launchTaskInBackground(newTask.id, "collect_results-relaunch");
                relaunched.push(`${label} "${task.goal}": was zombie (${Math.round(age / 60000)}min), re-launched as ${newTask.id.slice(0, 8)}`);
              } catch {
                failed.push(`${label} "${task.goal}": zombie (${Math.round(age / 60000)}min), re-launch failed`);
              }
            } else {
              pending.push(`${label} "${task.goal}": ${task.status.toLowerCase()} (${Math.round(age / 60000)}min)...`);
            }
          }
        }

        const parts: string[] = [];
        if (completed.length > 0) {
          parts.push(`# Completed Reports (${completed.length})\n\n${completed.join("\n\n---\n\n")}`);
        }
        if (relaunched.length > 0) {
          parts.push(`\n# Re-launched Zombie Tasks (${relaunched.length})\n${relaunched.join("\n")}\n\nThese were stuck and have been re-launched. Call collect_results again in a few minutes.`);
        }
        if (pending.length > 0) {
          parts.push(`\n# Still Running (${pending.length})\n${pending.join("\n")}\n\nCall collect_results again later.`);
        }
        if (failed.length > 0) {
          parts.push(`\n# Failed (${failed.length})\n${failed.join("\n")}`);
        }

        await prisma.agentTask.updateMany({
          where: { id: { in: tasks.map((task) => task.id) } },
          data: { lastCollectedAt: new Date() },
        });

        return parts.join("\n") || "No results yet. Sub-agents are still working.";
      },
    }),

    adversarial_review: tool({
      description: "Get a rigorous peer review of your hypotheses, experimental design, or results from an independent adversarial reviewer. The reviewer is a separate AI with a skeptical, journal-reviewer persona — it will find flaws, missing controls, confounding variables, statistical errors, and unjustified claims. Use this after formulating hypotheses (to stress-test them) and after getting results (to find weaknesses before designing follow-ups). This is your most powerful quality tool.",
      inputSchema: z.object({
        content: z.string().describe("The hypotheses, experimental design, or results to review. Include specific numbers, methods, and claims."),
        focus: z.enum(["hypotheses", "methodology", "results", "statistical"]).optional().describe("What aspect to focus the review on"),
      }),
      execute: async ({ content, focus }: { content: string; focus?: string }) => {
        if (!agentModel) return "Model not available for adversarial review.";

        emit({ type: "tool_progress", toolName: "adversarial_review", content: "Adversarial reviewer is analyzing..." });

        const focusGuide = focus === "hypotheses"
          ? "Focus on: Are these hypotheses specific and testable? Are there hidden assumptions? What alternative explanations exist? What would falsify them?"
          : focus === "methodology"
          ? "Focus on: Is the experimental design sound? Are there missing controls or baselines? Are datasets appropriate? Could confounding variables explain results?"
          : focus === "results"
          ? "Focus on: Are the claims supported by the evidence? Are comparisons fair? What's being cherry-picked or glossed over? What alternative interpretations exist?"
          : focus === "statistical"
          ? "Focus on: Is there statistical rigor? Are error bars present? Is the sample size sufficient? Are the statistical tests appropriate? Is there p-hacking?"
          : "Review all aspects: hypothesis validity, methodology soundness, result interpretation, and statistical rigor.";

        const reviewerSystem = `You are a skeptical, rigorous peer reviewer for a top-tier venue (NeurIPS, ICML, Nature). Your job is to find flaws, weaknesses, and gaps. Be specific and constructive — for every problem you identify, suggest how to fix it.

${focusGuide}

Structure your review as:
1. **Summary**: One-sentence summary of what's being claimed
2. **Strengths**: What's well-done (be brief)
3. **Weaknesses**: Specific flaws, each with a concrete fix
4. **Missing**: What's absent that a reviewer would expect
5. **Verdict**: Overall assessment and priority fixes

Be harsh but fair. Vague praise is useless. Specific criticism saves months of wasted work.`;

        try {
          setLlmContext("adversarial-review", userId, { projectId });
          const result = await generateText({
            model: agentModel,
            system: reviewerSystem,
            messages: [{ role: "user", content }],
            abortSignal: sessionControl?.signal,
          });

          emit({ type: "tool_output", toolName: "adversarial_review", content: "Review complete." });
          await recordStep("critique", `Adversarial review (${focus || "general"})`, "COMPLETED", { focus, reviewLength: result.text.length });

          return `## Adversarial Peer Review\n\n${result.text}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Review failed";
          return `Adversarial review failed: ${msg}`;
        }
      },
    }),

    log_finding: tool({
      description: "Record an important finding, hypothesis, decision, or question in the research log. This is the persistent lab notebook, not the claim ledger. Use it for synthesis, summaries, and broad observations. For atomic reviewable assertions, call record_claim separately. For hypotheses: write PLAIN TEXT only — no markdown headers, no **bold**, no bullet points.",
      inputSchema: z.object({
        type: z.enum(["finding", "hypothesis", "decision", "question", "breakthrough"]).describe("Type of entry"),
        content: z.string().describe("What you found/decided/hypothesized. For hypotheses: plain text claim, no markdown formatting."),
        theme: z.string().optional().describe("For hypotheses only: research theme group (e.g., 'Position Effects', 'Prior Knowledge', 'Architecture Design'). Hypotheses with the same theme are grouped together in the UI."),
        related_paper_title: z.string().optional().describe("Title (or fragment) of a paper this finding relates to. If provided, the insight will be linked to that paper in the Mind Palace."),
      }),
      execute: async ({ type, content, theme, related_paper_title }: { type: string; content: string; theme?: string; related_paper_title?: string }) => {
        const logType = getNotebookLogType(type as "finding" | "hypothesis" | "decision" | "question" | "breakthrough", content);

        // Append to RESEARCH_LOG.md
        const emoji = type === "breakthrough" ? "🔬" : type === "hypothesis" ? "💡" : type === "finding" ? "📊" : type === "question" ? "❓" : "📝";
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const notebookEntry = `\n### ${emoji} ${type.charAt(0).toUpperCase() + type.slice(1)} (${timestamp})\n${content}\n`;

        // If it's a hypothesis, also create a ResearchHypothesis record + step
        if (type === "hypothesis") {
          // Clean up hypothesis text: strip ALL markdown artifacts
          let statement = content;
          let rationale: string | null = "Generated by research agent";

          // Strip "## Hypothesis N: Title" prefix (various formats)
          statement = statement.replace(/^#+\s*(?:Hypothesis\s*\d*[:\s]*)?/i, "").trim();

          // Extract rationale if embedded as **Rationale**: ...
          const rationaleMatch = statement.match(/\*\*Rationale\*\*:\s*([\s\S]*?)$/i);
          if (rationaleMatch) {
            rationale = rationaleMatch[1].trim().replace(/\*\*/g, "").slice(0, 500);
            statement = statement.replace(/\s*\*\*Rationale\*\*:[\s\S]*$/i, "").trim();
          }

          // Extract just the claim if format is "Title **Claim**: actual claim"
          const claimMatch = statement.match(/\*\*Claim\*\*:\s*([\s\S]*)/i);
          if (claimMatch) {
            statement = claimMatch[1].trim();
          }

          // Strip all remaining markdown bold/italic markers
          statement = statement.replace(/\*\*(.+?)\*\*/g, "$1");
          statement = statement.replace(/\*(.+?)\*/g, "$1");
          statement = statement.replace(/__(.+?)__/g, "$1");
          statement = statement.replace(/_(.+?)_/g, "$1");
          // Strip markdown bullet points at start
          statement = statement.replace(/^[-*•]\s+/, "");
          // Strip numbered list prefix
          statement = statement.replace(/^\d+\.\s+/, "");
          // Strip "Hypothesis:" prefix if still present
          statement = statement.replace(/^Hypothesis:\s*/i, "").trim();

          // Clean rationale too
          if (rationale && rationale !== "Generated by research agent") {
            rationale = rationale.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
          }

          await runDbTransaction(async (tx) => {
            await tx.researchLogEntry.create({
              data: { projectId, type: logType, content },
            });
            await tx.researchHypothesis.create({
              data: {
                projectId,
                statement: statement.slice(0, 2000),
                rationale,
                theme: theme || null,
                status: "PROPOSED",
              },
            });
            await recordStepTx(tx, "formulate_hypothesis", `Hypothesis: ${statement.slice(0, 80)}`, "COMPLETED", { hypothesis: content }, "HYPOTHESIS");
          });
          await appendFile(path.join(workDir, "RESEARCH_LOG.md"), notebookEntry).catch(() => {});
          return `Hypothesis recorded and added to project: "${statement.slice(0, 100)}..."`;
        }

        if (type === "finding" || type === "breakthrough") {
          await runDbTransaction(async (tx) => {
            await tx.researchLogEntry.create({
              data: { projectId, type: logType, content },
            });
            await recordStepTx(tx, "analyze_results", `Finding: ${content.slice(0, 80)}`, "COMPLETED", { finding: content, type }, "ANALYSIS");
          });
          await appendFile(path.join(workDir, "RESEARCH_LOG.md"), notebookEntry).catch(() => {});
          return `Logged: [${type}] ${content.slice(0, 100)}...\nNotebook entry saved. If this should enter the claim ledger, restate it as one atomic sentence with record_claim.`;
        }

        await runDbTransaction(async (tx) => {
          await tx.researchLogEntry.create({
            data: { projectId, type: logType, content },
          });
        });
        await appendFile(path.join(workDir, "RESEARCH_LOG.md"), notebookEntry).catch(() => {});
        return `Logged: [${type}] ${content.slice(0, 100)}...`;
      },
    }),

    save_lesson: tool({
      description: "Save a practical lesson learned from trial and error. This goes into your persistent process memory — you'll see it at the start of every future session, across ALL projects. Use this when you discover something that would save time in the future: package quirks, environment fixes, code patterns that work, common errors and their solutions. Be specific and actionable.",
      inputSchema: z.object({
        category: z.enum(["package", "environment", "code_pattern", "debugging", "dataset", "performance", "general"])
          .describe("Category: package (dependency issues), environment (setup/config), code_pattern (what works), debugging (error fixes), dataset (data quirks), performance (speed/memory), general"),
        lesson: z.string().describe("The lesson — concise, actionable, specific. E.g., 'Always use transformers>=4.35 for Mistral models' or 'Use torch.cuda.empty_cache() between model loads to avoid OOM'"),
        context: z.string().optional().describe("Brief context: what error or situation led to this lesson"),
        approach_id: z.string().optional().describe("ID of the current approach/branch this lesson was learned in. Links the lesson to a specific research approach for traceability."),
        claim_id: z.string().optional().describe("Optional claim ID. If provided, the lesson is promoted from a supported claim instead of being saved as an ad-hoc memory."),
      }),
      execute: async ({ category, lesson, context, approach_id, claim_id }: { category: string; lesson: string; context?: string; approach_id?: string; claim_id?: string }) => {
        // Benchmarks don't save lessons — prevents contaminating future benchmark runs
        if (isBenchmarkProject) return "Lesson noted (not saved — benchmark mode).";

        if (claim_id) {
          const promoted = await promoteClaimToMemory({
            claimId: claim_id,
            userId,
            category,
            lesson,
            context: context || null,
            projectId,
          });
          await refreshResearchState();
          return `Lesson promoted from claim ${claim_id.slice(0, 8)} into process memory (${promoted.id.slice(0, 8)}).`;
        }

        // Check for duplicates (similar lesson already exists)
        const memoryAction = await runDbTransaction(async (tx) => {
          const existing = await tx.agentMemory.findMany({
            where: { userId },
            select: { id: true, lesson: true },
          });
          const lessonLower = lesson.toLowerCase();
          const duplicate = existing.find((m: { id: string; lesson: string }) => {
            const existingLower = m.lesson.toLowerCase();
            const newWords = lessonLower.split(/\s+/).filter((w: string) => w.length > 3);
            const existWords = new Set(existingLower.split(/\s+/).filter((w: string) => w.length > 3));
            if (newWords.length === 0) return false;
            let overlap = 0;
            for (let i = 0; i < newWords.length; i++) { if (existWords.has(newWords[i])) overlap++; }
            return overlap / newWords.length > 0.6;
          });

          if (duplicate) {
            await tx.agentMemory.update({
              where: { id: duplicate.id },
              data: { lesson, context, category, updatedAt: new Date() },
            });
            return { action: "updated" as const };
          }

          const contextWithApproach = approach_id
            ? `${context ? context + " " : ""}[approach:${approach_id}]`
            : context || null;

          await tx.agentMemory.create({
            data: {
              userId,
              category,
              lesson: lesson.slice(0, 1000),
              context: contextWithApproach?.slice(0, 500) || null,
              projectId,
              status: ["package", "environment", "debugging"].includes(category) ? "APPROVED" : "CANDIDATE",
            },
          });
          return { action: "created" as const };
        });

        if (memoryAction.action === "updated") {
          return `Updated existing lesson: "${lesson.slice(0, 100)}"`;
        }

        emit({ type: "tool_progress", toolName: "save_lesson", content: `Lesson saved: ${lesson.slice(0, 60)}` });
        return `Lesson saved to process memory [${category}]: "${lesson.slice(0, 100)}".${["package", "environment", "debugging"].includes(category) ? "\nThis is available in future sessions." : "\nStatus: CANDIDATE — promote a supported claim for durable research memory."}`;
      },
    }),

    request_help: tool({
      description: "Flag an issue for the user's attention WITHOUT blocking your work. Use this only for issues that genuinely require external user action: a package the user must install, a missing API key, or a strategic/user-input decision. Do NOT use it for workspace locks, stuck jobs, or script-budget cleanup — those should be handled with cancel_job, delete_file, or clean_workspace.",
      inputSchema: z.object({
        category: z.enum(["package", "api_key", "env_issue", "user_input", "general"]).describe("Type of help needed"),
        title: z.string().describe("Short title (e.g., 'flash-attn fails to install', 'Need OpenAI API key')"),
        detail: z.string().describe("What happened and what you tried"),
        suggestion: z.string().optional().describe("What the user could do to fix it"),
      }),
      execute: async ({ category, title, detail, suggestion }: { category: string; title: string; detail: string; suggestion?: string }) => {
        const selfManagedEnvIssue = category === "env_issue"
          && /(stale lock|workspace locked|workspace busy|zombie job|ghost job|stuck job|31 python scripts|script limit|too many scripts|cannot write files|cannot modify or create scripts)/i
            .test(`${title}\n${detail}\n${suggestion || ""}`);

        if (selfManagedEnvIssue) {
          return "Do not request user help for workspace-lock or script-budget issues. Use cancel_job to stop a stuck run, delete_file to prune obsolete scripts, or clean_workspace to reduce remote clutter.";
        }

        await createOrUpdateHelpRequest({
          projectId,
          category: category as "package" | "api_key" | "env_issue" | "user_input" | "general",
          title,
          detail,
          suggestion,
        });
        emit({ type: "tool_output", toolName: "request_help", content: `Help requested: ${title}` });
        return `Help request logged: "${title}". The user will see this in their attention queue. Continue working on other tasks.`;
      },
    }),

    search_library: tool({
      description: "Search your existing paper collection for content relevant to a specific question or problem. Unlike search_papers (which searches external databases), this searches papers you ALREADY HAVE — their full text, abstracts, summaries, key findings, Mind Palace insights, paper relationships, contradictions, and citation contexts. Use this when you need to understand WHY something happened, find a technique to solve a problem, or check if any paper in your library addresses a specific issue. Returns ranked results with the most relevant intelligence from each paper.",
      inputSchema: z.object({
        query: z.string().describe("Specific question or problem to search for (e.g., 'why does attention fail on long sequences', 'techniques for handling class imbalance')"),
        max_results: z.number().min(1).max(10).default(5).optional(),
      }),
      execute: async ({ query, max_results }: { query: string; max_results?: number }) => {
        const maxResults = max_results || 5;
        emit({ type: "tool_progress", toolName: "search_library", content: `Searching library for: "${query.slice(0, 60)}..."` });

        // Get all project papers
        const proj = await prisma.researchProject.findUnique({
          where: { id: projectId },
          select: { collectionId: true },
        });

        const paperIds = new Set<string>();
        if (proj?.collectionId) {
          const collPapers = await prisma.collectionPaper.findMany({
            where: { collectionId: proj.collectionId },
            select: { paperId: true },
          });
          collPapers.forEach((cp) => paperIds.add(cp.paperId));
        }

        // In benchmark mode, only search the project's own collection (seed papers)
        // to prevent knowledge leakage from prior runs
        const paperWhere: Record<string, unknown> = isBenchmarkProject && proj?.collectionId
          ? { collections: { some: { collectionId: proj.collectionId } } }
          : { userId };

        // Phase 1: lightweight query for scoring (no fullText, no nested relations)
        const lightPapers = await prisma.paper.findMany({
          where: paperWhere,
          select: {
            id: true, title: true, abstract: true, summary: true,
            year: true, venue: true, authors: true, keyFindings: true, doi: true, arxivId: true,
          },
        });

        // Phase 2: score with lightweight data (title, abstract, summary, keyFindings)
        const queryTerms = await processQuery(query);
        const lightScored = lightPapers.map((paper) => {
          const weighted: { text: string; weight: number }[] = [
            { text: paper.title || "", weight: 3 },
            { text: paper.abstract || "", weight: 2 },
            { text: paper.summary || "", weight: 2 },
            { text: paper.keyFindings || "", weight: 2.5 },
          ];
          let score = scoreWeighted(weighted, queryTerms);
          if (paperIds.has(paper.id)) score *= 1.5;
          return { paper, score };
        })
          .filter((s) => s.score > 0)
          .filter((s) => !isBanned(s.paper))
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);

        if (lightScored.length === 0) {
          return `No papers in your library match "${query}". Try search_papers to find new papers on this topic.`;
        }

        // Phase 3: enrich only the top results with relations, insights, citations
        const topIds = lightScored.map((s) => s.paper.id);
        const enriched = await prisma.paper.findMany({
          where: { id: { in: topIds } },
          select: {
            id: true,
            tags: { include: { tag: true } },
            insights: {
              include: { room: { select: { name: true } } },
            },
            sourceRelations: {
              include: { targetPaper: { select: { title: true, year: true } } },
            },
            targetRelations: {
              include: { sourcePaper: { select: { title: true, year: true } } },
            },
            references: {
              where: { citationContext: { not: null } },
              select: { title: true, year: true, citationContext: true, matchedPaper: { select: { title: true } } },
              take: 20,
            },
            promptResults: {
              where: { promptType: "detectContradictions" },
              select: { result: true },
              take: 1,
            },
          },
        });
        const enrichedMap = new Map(enriched.map((e) => [e.id, e]));

        const results = lightScored.map((s, i) => {
          const p = s.paper;
          const rich = enrichedMap.get(p.id);
          const inProject = paperIds.has(p.id) ? " [in project]" : "";
          const parts: string[] = [];
          parts.push(`${i + 1}. "${p.title}" (${p.year || "?"}${p.venue ? `, ${p.venue}` : ""})${inProject}`);

          if (p.summary) parts.push(`   Summary: ${p.summary.slice(0, 250)}`);
          if (p.keyFindings) parts.push(`   Key Findings: ${p.keyFindings.slice(0, 300)}`);

          if (rich) {
            // Matching insights (skip in benchmark mode)
            if (!isBenchmarkProject && rich.insights.length > 0) {
              const matchingInsights = rich.insights
                .filter((ins) => scoreText(`${ins.learning} ${ins.significance} ${ins.applications || ""}`, queryTerms) > 0)
                .slice(0, 3);
              if (matchingInsights.length > 0) {
                parts.push(`   Relevant Insights:`);
                for (const ins of matchingInsights) {
                  parts.push(`   - [${ins.room.name}] ${ins.learning.slice(0, 200)}`);
                  if (ins.applications) parts.push(`     Applications: ${ins.applications.slice(0, 150)}`);
                }
              }
            }

            // Matching relations
            const allRelations = [
              ...rich.sourceRelations.map((r) => ({ desc: r.description, type: r.relationType, other: r.targetPaper.title })),
              ...rich.targetRelations.map((r) => ({ desc: r.description, type: r.relationType, other: r.sourcePaper.title })),
            ];
            const matchingRels = allRelations
              .filter((r) => scoreText(`${r.desc || ""} ${r.other}`, queryTerms) > 0)
              .slice(0, 3);
            if (matchingRels.length > 0) {
              parts.push(`   Related Papers:`);
              for (const r of matchingRels) {
                parts.push(`   - [${r.type}] ${r.other}${r.desc ? `: ${r.desc.slice(0, 150)}` : ""}`);
              }
            }

            // Matching citation contexts
            const matchingCites = rich.references
              .filter((ref) => scoreText(ref.citationContext || "", queryTerms) > 0)
              .slice(0, 2);
            if (matchingCites.length > 0) {
              parts.push(`   Relevant Citations:`);
              for (const c of matchingCites) {
                parts.push(`   - ${c.title || "Unknown"}: ${(c.citationContext || "").slice(0, 200)}`);
              }
            }

            // Contradictions snippet
            if (rich.promptResults[0]?.result) {
              const contradText = typeof rich.promptResults[0].result === "string" ? rich.promptResults[0].result : JSON.stringify(rich.promptResults[0].result);
              if (scoreText(contradText, queryTerms) > 0) {
                parts.push(`   Contradictions: ${contradText.slice(0, 250)}`);
              }
            }
          }

          return parts.join("\n");
        }).join("\n\n");

        // Bump usageCount for insights surfaced
        const surfacedInsightIds = enriched.flatMap((e) =>
          e.insights
            .filter((ins) => scoreText(`${ins.learning} ${ins.significance} ${ins.applications || ""}`, queryTerms) > 0)
            .map((ins) => ins.id)
        );
        if (surfacedInsightIds.length > 0) {
          prisma.insight.updateMany({
            where: { id: { in: surfacedInsightIds } },
            data: { usageCount: { increment: 1 } },
          }).catch(() => {});
        }

        await recordStep("search_papers", `Library search: "${query.slice(0, 60)}"`, "COMPLETED", { query, matches: lightScored.length }, "DISCOVERY");
        return `Found ${lightScored.length} relevant papers in your library:\n\n${results}\n\nUse read_paper to get full details on any of these.`;
      },
    }),

    query_skills: tool({
      description: "Retrieve reusable Skill Cards distilled from your paper library and Mind Palace. Use this when planning experiments to avoid repeating obvious ideas and to compose techniques from multiple papers.",
      inputSchema: z.object({
        query: z.string().describe("What capability/technique you need"),
        mode: z.enum(["exploit", "balanced", "explore"]).default("balanced").optional().describe("exploit=highest confidence, explore=higher novelty, balanced=mix"),
        max_results: z.number().min(1).max(12).default(8).optional(),
        include_anti_patterns: z.boolean().default(true).optional().describe("Include matched anti-patterns from dead-end logs"),
      }),
      execute: async ({
        query,
        mode,
        max_results,
        include_anti_patterns,
      }: {
        query: string;
        mode?: SkillQueryMode;
        max_results?: number;
        include_anti_patterns?: boolean;
      }) => {
        if (isBenchmarkProject) {
          return "Skill Cards are disabled in benchmark mode. Use search_library and search_papers directly.";
        }

        const skillMode = mode || "balanced";
        const maxResults = max_results || 8;
        emit({ type: "tool_progress", toolName: "query_skills", content: `Retrieving ${skillMode} skill cards for "${query.slice(0, 60)}..."` });

        const { cards } = await querySkillCards({
          userId,
          projectId,
          query,
          mode: skillMode,
          maxResults,
          trackUsage: true,
        });

        if (cards.length === 0) {
          return `No skill cards match "${query}". Try query_insights or search_library for broader context.`;
        }

        const antiPatterns = include_anti_patterns
          ? await queryAntiPatterns({ projectId, query, maxResults: 5 })
          : [];

        const skillsFormatted = formatSkillCards(cards);
        const antiText = antiPatterns.length > 0
          ? `\n\nAnti-patterns to avoid (from prior dead ends):\n${antiPatterns.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
          : "";

        return `Found ${cards.length} skill card(s) (${skillMode} mode):\n\n${skillsFormatted}${antiText}`;
      },
    }),

    design_creative_portfolio: tool({
      description: "Generate a portfolio of novel but testable experiment ideas by combining high-relevance skill cards with anti-pattern constraints. Use this when you want non-obvious directions without sacrificing rigor.",
      inputSchema: z.object({
        research_question: z.string().describe("Current research question or bottleneck"),
        current_trajectory: z.string().optional().describe("What you've already tried"),
        n_ideas: z.number().int().min(2).max(8).default(4).optional(),
      }),
      execute: async ({
        research_question,
        current_trajectory,
        n_ideas,
      }: {
        research_question: string;
        current_trajectory?: string;
        n_ideas?: number;
      }) => {
        const nIdeas = n_ideas || 4;
        emit({ type: "tool_progress", toolName: "design_creative_portfolio", content: `Designing ${nIdeas} creative ideas...` });

        const [skills, antiPatterns, approaches] = await Promise.all([
          querySkillCards({
            userId,
            projectId,
            query: research_question,
            mode: "explore",
            maxResults: 10,
            trackUsage: false,
          }),
          queryAntiPatterns({ projectId, query: research_question, maxResults: 6 }),
          prisma.approachBranch.findMany({
            where: { projectId },
            orderBy: { updatedAt: "desc" },
            take: 10,
            select: { name: true, description: true, status: true },
          }),
        ]);

        const skillContext = skills.cards.map((card, idx) =>
          `${idx + 1}. ${card.learning} | trigger=${card.trigger} | mechanism=${card.mechanism} | risk=${card.riskNote} | confidence=${card.confidence.toFixed(2)} | novelty=${card.novelty.toFixed(2)}`
        ).join("\n");
        const antiContext = antiPatterns.length > 0 ? antiPatterns.map((x, i) => `${i + 1}. ${x}`).join("\n") : "None";
        const trajectoryContext = current_trajectory || approaches.map((a) => `- ${a.name} [${a.status}] ${a.description || ""}`).join("\n") || "Not provided";

        const ideaSchema = z.object({
          ideas: z.array(z.object({
            name: z.string(),
            cross_domain_analogy: z.string(),
            core_hypothesis: z.string(),
            uses_skills: z.array(z.string()).describe("Exact skill phrases from the provided skill context"),
            avoids_antipatterns: z.array(z.string()),
            novelty: z.number().min(1).max(10),
            feasibility: z.number().min(1).max(10),
            one_day_test: z.string(),
            success_metric: z.string(),
            kill_criterion: z.string(),
          })).min(2).max(8),
          recommended_first: z.string(),
          rationale: z.string(),
        });

        const modelCfg = await getModelForTier("reasoning");
        setLlmContext("creative-portfolio", userId, { projectId });
        const model = await getModel(modelCfg.provider, modelCfg.modelId, modelCfg.proxyConfig);

        const { object } = await generateObject({
          model,
          schema: ideaSchema,
          system: "You are a research portfolio designer. Produce diverse, concrete, testable ideas. Prioritize high novelty while keeping one-day tests cheap and falsifiable.",
          prompt: [
            `Research question:\n${research_question}`,
            `\nCurrent trajectory:\n${trajectoryContext}`,
            `\nAvailable skill cards:\n${skillContext || "None"}`,
            `\nAnti-patterns from failed work:\n${antiContext}`,
            `\nReturn exactly ${nIdeas} ideas.`,
          ].join("\n"),
          abortSignal: sessionControl?.signal,
        });

        const ideas = object.ideas.slice(0, nIdeas);
        const formatted = ideas.map((idea, i) => {
          return [
            `${i + 1}. ${idea.name} (novelty ${idea.novelty}/10, feasibility ${idea.feasibility}/10)`,
            `   Analogy: ${idea.cross_domain_analogy}`,
            `   Hypothesis: ${idea.core_hypothesis}`,
            `   Uses skills: ${idea.uses_skills.join("; ") || "-"}`,
            `   Avoids: ${idea.avoids_antipatterns.join("; ") || "-"}`,
            `   1-day test: ${idea.one_day_test}`,
            `   Success metric: ${idea.success_metric}`,
            `   Kill criterion: ${idea.kill_criterion}`,
          ].join("\n");
        }).join("\n\n");

        return `Creative portfolio for "${research_question}":\n\n${formatted}\n\nRecommended first: ${object.recommended_first}\nRationale: ${object.rationale}`;
      },
    }),

    query_insights: tool({
      description: "Search the Mind Palace for relevant insights, learned techniques, and methodology notes from papers you've studied. The Mind Palace contains distilled knowledge: what each paper taught you, its significance, and practical applications. Use this to find techniques, methods, or lessons that might apply to your current problem.",
      inputSchema: z.object({
        query: z.string().describe("What you're looking for (e.g., 'regularization techniques', 'how to handle noisy labels', 'transformer architecture improvements')"),
        max_results: z.number().min(1).max(15).default(8).optional(),
      }),
      execute: async ({ query, max_results }: { query: string; max_results?: number }) => {
        // Benchmarks get no Mind Palace access — prevents knowledge leakage
        if (isBenchmarkProject) return "Mind Palace is not available in benchmark mode. Use search_papers and search_library instead.";

        const maxResults = max_results || 8;
        emit({ type: "tool_progress", toolName: "query_insights", content: `Searching Mind Palace for: "${query.slice(0, 60)}..."` });

        // Load all insights with their papers
        const insights = await prisma.insight.findMany({
          include: {
            paper: { select: { id: true, title: true, year: true, venue: true } },
            room: { select: { name: true } },
          },
        });

        if (insights.length === 0) {
          return "No insights in the Mind Palace yet. Use search_library or search_papers to find relevant literature.";
        }

        // Score by relevance (stemmed + LLM-expanded terms)
        const queryTerms = await processQuery(query);
        const scored = insights.map((insight) => {
          const searchable = [
            insight.learning,
            insight.significance,
            insight.applications || "",
            insight.userNotes || "",
            insight.paper.title,
            insight.room.name,
          ].join(" ");

          return { insight, score: scoreText(searchable, queryTerms) };
        })
          .filter((s) => s.score > 0)
          .filter((s) => !isBanned(s.insight.paper)) // Exclude banned papers (benchmarks)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);

        if (scored.length === 0) {
          return `No insights match "${query}". Try search_library to search paper full texts, or search_papers for new papers.`;
        }

        // Bump usageCount for returned insights (strength grows with research usage)
        const matchedIds = scored.map((s) => s.insight.id);
        prisma.insight.updateMany({
          where: { id: { in: matchedIds } },
          data: { usageCount: { increment: 1 } },
        }).catch(() => {}); // non-blocking

        const results = scored.map((s, i) => {
          const ins = s.insight;
          let entry = `${i + 1}. [${ins.room.name}] From "${ins.paper.title}" (${ins.paper.year || "?"})`;
          entry += `\n   Learning: ${ins.learning}`;
          entry += `\n   Significance: ${ins.significance}`;
          if (ins.applications) entry += `\n   Applications: ${ins.applications}`;
          if (ins.userNotes) entry += `\n   Notes: ${ins.userNotes}`;
          return entry;
        }).join("\n\n");

        return `Found ${scored.length} relevant insights from the Mind Palace:\n\n${results}`;
      },
    }),

    web_search: tool({
      description: "Search the web for programming libraries, datasets, documentation, tutorials, code examples, or technical solutions. Use this to find the right tools for your experiments (e.g., 'trl library reinforcement learning from human feedback', 'huggingface datasets load squad', 'pytorch distributed training tutorial'). This searches the general web, not academic papers — use search_papers for that.",
      inputSchema: z.object({
        query: z.string().describe("Search query — be specific about what you need (library name, task, framework)"),
      }),
      execute: async ({ query }: { query: string }) => {
        emit({ type: "tool_progress", toolName: "web_search", content: `Searching web: "${query.slice(0, 60)}..."` });
        try {
          // Use DuckDuckGo HTML search via POST — no API key required
          // POST avoids the CAPTCHA that GET triggers for server-side requests
          const res = await fetch("https://html.duckduckgo.com/html/", {
            method: "POST",
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Referer": "https://duckduckgo.com/",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `q=${encodeURIComponent(query)}`,
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) return `Web search failed (HTTP ${res.status}). Try a different query.`;

          const html = await res.text();

          // Parse results from DuckDuckGo HTML response
          const results: { title: string; url: string; snippet: string }[] = [];
          // Match result blocks: class="result__a" for links, class="result__snippet" for descriptions
          const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
          const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

          const links: RegExpExecArray[] = [];
          const snippets: RegExpExecArray[] = [];
          let m: RegExpExecArray | null;
          while ((m = linkRegex.exec(html)) !== null) links.push(m);
          while ((m = snippetRegex.exec(html)) !== null) snippets.push(m);

          for (let i = 0; i < Math.min(links.length, 8); i++) {
            const rawUrl = links[i][1];
            // DuckDuckGo wraps URLs — extract the actual URL from redirect
            let actualUrl = rawUrl;
            const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
            if (uddgMatch) actualUrl = decodeURIComponent(uddgMatch[1]);

            const title = links[i][2].replace(/<[^>]+>/g, "").trim();
            const snippet = snippets[i]?.[1]?.replace(/<[^>]+>/g, "").trim() || "";

            if (title && actualUrl) {
              results.push({ title, url: actualUrl, snippet });
            }
          }

          if (results.length === 0) return `No web results found for "${query}". Try a different query.`;

          const formatted = results.map((r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
          ).join("\n\n");

          return `Web search results for "${query}":\n\n${formatted}\n\nUse fetch_webpage to read any of these pages for more detail.`;
        } catch (err) {
          return `Web search failed: ${err instanceof Error ? err.message : "unknown error"}. Try again or use a different query.`;
        }
      },
    }),

    fetch_webpage: tool({
      description: "Fetch and read a webpage — useful for reading documentation, README files, GitHub repos, PyPI pages, tutorials, or any URL from web search results. Returns the text content of the page (HTML stripped). Use this after web_search to read promising results.",
      inputSchema: z.object({
        url: z.string().describe("Full URL to fetch (e.g., https://github.com/huggingface/trl)"),
      }),
      execute: async ({ url }: { url: string }) => {
        emit({ type: "tool_progress", toolName: "fetch_webpage", content: `Fetching: ${url.slice(0, 80)}...` });

        // For GitHub repos, try the raw README first (more readable, no HTML noise)
        let fetchUrl = url;
        const ghMatch = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/?$/);
        if (ghMatch) {
          fetchUrl = `https://raw.githubusercontent.com/${ghMatch[1]}/main/README.md`;
        }

        try {
          // Use a realistic browser User-Agent — many sites block bot-like UAs
          const res = await fetch(fetchUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
              "Accept-Language": "en-US,en;q=0.9",
            },
            signal: AbortSignal.timeout(20_000),
            redirect: "follow",
          });

          // If raw README failed for GitHub, fall back to the original URL
          if (!res.ok && fetchUrl !== url) {
            const fallback = await fetch(url, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,text/plain",
              },
              signal: AbortSignal.timeout(20_000),
              redirect: "follow",
            });
            if (!fallback.ok) return `Failed to fetch ${url} (HTTP ${fallback.status}). The site may require authentication or block automated access. Try a different URL or search for the same content elsewhere.`;
            const html = await fallback.text();
            return processHtml(html, url);
          }

          if (!res.ok) return `Failed to fetch ${url} (HTTP ${res.status}). The site may require authentication or block automated access. Try a different URL or search for the same content elsewhere.`;

          const html = await res.text();
          return processHtml(html, fetchUrl);
        } catch (err) {
          return `Failed to fetch ${url}: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    }),

    view_figures: tool({
      description: "View extracted figures and tables from a paper in your library. Returns descriptions of all figures/tables with their captions and LLM-generated explanations. Use this to understand experimental setups, architectures, result plots, and data tables from papers without reading the full text.",
      inputSchema: z.object({
        title: z.string().describe("Title (or partial title) of the paper whose figures you want to see"),
      }),
      execute: async ({ title }: { title: string }) => {
        emit({ type: "tool_progress", toolName: "view_figures", content: `Looking up figures for "${title.slice(0, 60)}..."` });

        const paper = await prisma.paper.findFirst({
          where: { userId, title: { contains: title } },
          select: { id: true, title: true },
        });
        if (!paper) return `Paper "${title}" not found in library.`;

        const figures = await prisma.paperFigure.findMany({
          where: { paperId: paper.id },
          orderBy: [{ page: "asc" }, { figureIndex: "asc" }],
        });

        if (figures.length === 0) {
          return `No figures extracted yet for "${paper.title}". Figures are extracted during paper processing.`;
        }

        const result = figures.map((f) => {
          let entry = `[Page ${f.page}] ${f.type.toUpperCase()}`;
          if (f.caption) entry += `: ${f.caption}`;
          entry += `\n${f.description || "No description"}`;
          return entry;
        }).join("\n\n---\n\n");

        return `Figures and tables from "${paper.title}" (${figures.length} total):\n\n${result}`;
      },
    }),

    complete_iteration: tool({
      description: "Complete the current research iteration and start a new one. Use this when you've finished a full research cycle (DISCOVERY → HYPOTHESIS → EXECUTION → ANALYSIS) and want to start a new iteration with a different angle, deeper investigation, or follow-up questions. This creates a new iteration in the project.",
      inputSchema: z.object({
        reflection: z.string().describe("Summary of what was learned in this iteration — key findings, what worked, what didn't"),
        next_goal: z.string().describe("Goal for the next iteration — what new question, approach, or direction to pursue"),
        start_phase: z.enum(["DISCOVERY", "HYPOTHESIS", "EXECUTION"]).default("DISCOVERY").describe("Which phase to start the new iteration in"),
      }),
      execute: async ({ reflection, next_goal, start_phase }: { reflection: string; next_goal: string; start_phase: string }) => {
        const previousIterationId = currentIteration.id;
        const previousIterationNumber = currentIteration.number;
        const { withFsmBypassAsync } = await import("./fsm/state-guard");
        const newIteration = await withFsmBypassAsync(() => runDbTransaction(async (tx) => {
          await tx.researchIteration.update({
            where: { id: previousIterationId },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
              reflection,
            },
          });

          const created = await tx.researchIteration.create({
            data: {
              projectId,
              number: previousIterationNumber + 1,
              goal: next_goal,
              status: "ACTIVE",
            },
          });

          // Use raw tx update inside withFsmBypassAsync — the bypass flag is already
          // set by the caller wrapping the full transaction.
          await tx.researchProject.update({
            where: { id: projectId },
            data: { currentPhase: start_phase },
          });

          await tx.researchLogEntry.create({
            data: {
              projectId,
              type: "decision",
              content: `Completed iteration #${previousIterationNumber}. Starting iteration #${created.number}: ${next_goal}`,
            },
          });

          return created;
        }));

        // Append to RESEARCH_LOG.md
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const logEntry = `\n---\n## Iteration #${previousIterationNumber} Complete (${timestamp})\n**Reflection:** ${reflection}\n\n## Iteration #${newIteration.number}: ${next_goal}\n`;
        await appendFile(path.join(workDir, "RESEARCH_LOG.md"), logEntry).catch(() => {});

        // Update mutable refs so subsequent steps in this session go to the new iteration
        const prevNumber = previousIterationNumber;
        currentIteration.id = newIteration.id;
        currentIteration.number = newIteration.number;
        onIterationAdvance?.(newIteration.id, newIteration.number);

        // Regenerate research state document
        try {
          const { generateResearchState } = await import("./research-state");
          await generateResearchState(projectId, workDir);
        } catch {}

        return `Iteration #${prevNumber} completed. Starting iteration #${newIteration.number}: "${next_goal}". Phase set to ${start_phase}.`;
      },
    }),

    update_hypothesis: tool({
      description: "Update the status of an existing hypothesis based on experimental evidence. Use this after experiments to mark hypotheses as SUPPORTED, REFUTED, or REVISED. Include specific numbers and reasoning.",
      inputSchema: z.object({
        hypothesis_fragment: z.string().describe("A fragment of the hypothesis statement to match (case-insensitive)"),
        status: z.enum(["TESTING", "SUPPORTED", "REFUTED", "REVISED"]).describe("New status based on evidence"),
        evidence: z.string().describe("Specific evidence: what experiment, what numbers, what comparison. Be concrete."),
      }),
      execute: async ({ hypothesis_fragment, status, evidence }: { hypothesis_fragment: string; status: string; evidence: string }) => {
        // Find matching hypothesis
        const hypotheses = await prisma.researchHypothesis.findMany({
          where: { projectId },
          select: { id: true, statement: true, status: true, evidence: true },
        });

        const fragment = hypothesis_fragment.toLowerCase();
        const match = hypotheses.find((h) =>
          h.statement.toLowerCase().includes(fragment) ||
          fragment.includes(h.statement.toLowerCase().slice(0, 40))
        );

        if (!match) {
          return `No hypothesis matching "${hypothesis_fragment}" found. Current hypotheses:\n${hypotheses.map((h) => `- [${h.status}] ${h.statement.slice(0, 100)}`).join("\n")}\n\nUse log_finding(type="hypothesis") to create a new one, or try a different fragment.`;
        }

        // Accumulate evidence
        let existingEvidence: { type: string; summary: string; supports: boolean }[] = [];
        if (match.evidence) {
          try { existingEvidence = JSON.parse(match.evidence); } catch { /* start fresh */ }
        }
        existingEvidence.push({
          type: "experiment",
          summary: evidence,
          supports: status === "SUPPORTED" || status === "TESTING",
        });

        const claimId = await runDbTransaction(async (tx) => {
          await tx.researchHypothesis.update({
            where: { id: match.id },
            data: {
              status,
              evidence: JSON.stringify(existingEvidence),
            },
          });

          const hypothesisLog = await tx.researchLogEntry.create({
            data: {
              projectId,
              type: status === "SUPPORTED" ? "breakthrough" : status === "REFUTED" ? "dead_end" : "observation",
              content: `Hypothesis "${match.statement.slice(0, 80)}..." → ${status}. Evidence: ${evidence.slice(0, 300)}`,
            },
          });

          const nextClaimId = await createClaim({
            projectId,
            statement: `Hypothesis "${match.statement}" is ${status}.`,
            summary: evidence,
            type: "hypothesis_assessment",
            status: "SUPPORTED",
            confidence: status === "SUPPORTED" || status === "REFUTED" ? "MODERATE" : "PRELIMINARY",
            createdBy: "agent",
            createdFrom: "update_hypothesis",
            hypothesisId: match.id,
            evidence: [
              {
                kind: "hypothesis",
                hypothesisId: match.id,
                supports: true,
                strength: "DIRECT",
                rationale: evidence,
              },
              {
                kind: "log_entry",
                logEntryId: hypothesisLog.id,
                supports: true,
                strength: "DIRECT",
                rationale: `Hypothesis set to ${status}`,
              },
            ],
          }, tx);

          await recordStepTx(
            tx,
            "analyze_results",
            `Hypothesis ${status}: ${match.statement.slice(0, 60)}`,
            "COMPLETED",
            { hypothesisId: match.id, status, evidence },
            "ANALYSIS",
          );

          return nextClaimId;
        });

        // Append to RESEARCH_LOG.md
        const hEmoji = status === "SUPPORTED" ? "✅" : status === "REFUTED" ? "❌" : "🔄";
        const hTimestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const hEntry = `\n### ${hEmoji} Hypothesis ${status} (${hTimestamp})\n**"${match.statement.slice(0, 200)}"**\nEvidence: ${evidence}\n`;
        await appendFile(path.join(workDir, "RESEARCH_LOG.md"), hEntry).catch(() => {});

        // Regenerate research state document after hypothesis update
        try {
          await syncCredibilityState();
        } catch {}

        return `Updated hypothesis: "${match.statement.slice(0, 80)}..." → ${status}\nClaim recorded: ${claimId.slice(0, 8)}\nEvidence recorded: ${evidence.slice(0, 200)}`;
      },
    }),
  };
}
