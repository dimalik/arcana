/**
 * Research Agent — autonomous research loop with tools.
 *
 * Like Claude Code but for research: searches papers, reads them,
 * writes experiment code, runs it (locally or remotely), analyzes
 * results, and iterates.
 */

import { streamText, generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { getModel } from "@/lib/llm/provider";
import { getDefaultModel, getModelForTier } from "@/lib/llm/auto-process";
import { setLlmContext } from "@/lib/llm/provider";
import { prisma } from "@/lib/prisma";
import { searchAllSources, isFigureOrSupplementDoi } from "@/lib/import/semantic-scholar";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { processingQueue } from "@/lib/processing/queue";
import { submitRemoteJob, probeGpus, quickRemoteCommand } from "./remote-executor";
import { classifyTaskCategory } from "./task-classifier";
import { processQuery, scoreWeighted, scoreText, filterByRelevance } from "./search-utils";
import { getAllResourcePreferences, recordResourceChoice, CONFIDENCE_THRESHOLD } from "./resource-preferences";
import { getWorkspaceState, formatWorkspace, invalidateWorkspace } from "./workspace";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, readFile, readdir, stat, appendFile } from "fs/promises";
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

// ── Agent entry point ────────────────────────────────────────────

// Track running agents so we can detect reconnection scenarios
const runningAgents = new Map<string, {
  events: AgentEvent[];
  closed: boolean;
  stopRequested: boolean;
  listeners: Set<(event: AgentEvent) => void>;
  startedAt: number;
}>();

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
): ReadableStream<Uint8Array> {
  // If agent is already running for this project, return an observer stream
  const existing = runningAgents.get(projectId);
  if (existing && !existing.closed) {
    return createObserverStream(projectId);
  }

  // Create agent state
  const state: typeof runningAgents extends Map<string, infer V> ? V : never = {
    events: [],
    closed: false,
    stopRequested: false,
    listeners: new Set(),
    startedAt: Date.now(),
  };
  runningAgents.set(projectId, state);

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
    const MAX_SESSIONS = 20; // Safety limit to prevent infinite loops

    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per session

    while (sessionCount < MAX_SESSIONS) {
      sessionCount++;
      try {
        console.log(`[research-agent] Session ${sessionCount} starting for project ${projectId}`);

        // Race the agent against a timeout — prevents hung sessions from blocking forever
        const sessionResult = await Promise.race([
          runAgent(projectId, userId, sessionCount === 1 ? (userMessage || null) : null, trackedEmit)
            .then(() => "completed" as const),
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), SESSION_TIMEOUT_MS)
          ),
        ]);

        if (sessionResult === "timeout") {
          console.warn(`[research-agent] Session ${sessionCount} timed out after ${SESSION_TIMEOUT_MS / 60000}min for project ${projectId}`);
          trackedEmit({ type: "error", content: `Session timed out after ${SESSION_TIMEOUT_MS / 60000} minutes. Auto-continuing with fresh session...` });
          // Timeout is not a consecutive error — it's likely a hung tool call. Fresh session will work.
          continue;
        }

        console.log(`[research-agent] Session ${sessionCount} completed for project ${projectId}`);
        consecutiveErrors = 0;
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
      }

      // Check if user requested stop or project is no longer ACTIVE
      if (state.stopRequested) {
        console.log(`[research-agent] Stop requested by user for project ${projectId}`);
        trackedEmit({ type: "done", content: "Agent stopped by user." });
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

      trackedEmit({ type: "done", content: `Session ${sessionCount} complete. Auto-continuing...` });
      // Brief pause between sessions
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    trackedEmit({ type: "done", content: "Agent finished." });
  };

  runWithAutoContinue().finally(() => {
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
) {
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

  // 2. Set up working directory (slug + short project ID to avoid collisions)
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const shortId = projectId.slice(0, 8);
  const workDir = project.outputFolder || path.join(process.cwd(), "output", "research", `${slug}-${shortId}`);
  await mkdir(workDir, { recursive: true });

  // Persist workDir so API endpoints (log-file, files) can find it
  if (!project.outputFolder) {
    await prisma.researchProject.update({
      where: { id: projectId },
      data: { outputFolder: workDir },
    });
  }

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
        import("./sub-agent").then(({ runSubAgent }) => {
          runSubAgent(orphan.id).catch((err) => {
            console.error(`[agent] Re-launched task ${orphan.id} (${orphan.role}) failed:`, err);
          });
        });
      }
    }
  }

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
  let iterationId = iteration.id;
  let iterationNumber = iteration.number;
  let stepSortOrder = iteration.steps?.length || 0;

  // 3b. Count existing experiments for sequential numbering
  const existingExpSteps = await prisma.researchStep.count({
    where: {
      iteration: { projectId },
      type: "generate_code",
    },
  });
  const experimentCounter = existingExpSteps;

  // 4. Detect remote hosts and probe GPUs (filtered by user resource preferences)
  let resourceSetting: "all" | "local" | string[] = "all";
  let bannedPapers: { title: string; doi?: string | null; arxivId?: string | null }[] = [];
  try {
    const briefParsed = JSON.parse(project.brief);
    if (briefParsed.resources) resourceSetting = briefParsed.resources;
    if (Array.isArray(briefParsed.bannedPapers)) bannedPapers = briefParsed.bannedPapers;
  } catch { /* plain text brief */ }

  const allRemoteHosts = resourceSetting === "local" ? [] : await prisma.remoteHost.findMany({ take: 5 });
  const remoteHosts = resourceSetting === "all" || resourceSetting === "local"
    ? allRemoteHosts
    : allRemoteHosts.filter((h) => (resourceSetting as string[]).includes(h.id));

  // Probe GPUs on allowed remote hosts (run in parallel, non-blocking)
  const gpuProbes = await Promise.all(
    remoteHosts.map((h) => probeGpus(h.id).catch(() => null))
  );
  const gpuInfo = gpuProbes.filter(Boolean) as NonNullable<Awaited<ReturnType<typeof probeGpus>>>[];

  emit({ type: "tool_progress", toolName: "system", content: gpuInfo.length > 0 ? `Detected GPUs: ${gpuInfo.map((g) => g.summary).join("; ")}` : "No GPU info available" });

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
  const systemPrompt = buildSystemPrompt(project, papers, workDir, remoteHosts, resourceSetting, capabilities, gpuInfo, processMemories, resourcePreferences, sharedUtilities, sharedDir);
  const messages = buildMessages(project, papers, userMessage, researchLog);

  // 6. Get model — Opus for the main research agent (critical reasoning)
  const { provider, modelId, proxyConfig } = await getModelForTier("reasoning");
  const model = await getModel(provider, modelId, proxyConfig);
  setLlmContext("research-agent", userId, { projectId });

  // Helper: create a ResearchStep and advance project phase
  const recordStep = async (
    type: string,
    title: string,
    status: "COMPLETED" | "FAILED",
    output: unknown,
    phase?: string,
  ) => {
    await prisma.researchStep.create({
      data: {
        iterationId,
        type,
        title,
        status,
        output: typeof output === "string" ? output : JSON.stringify(output),
        sortOrder: stepSortOrder++,
        completedAt: new Date(),
      },
    });
    if (phase) {
      await prisma.researchProject.update({
        where: { id: projectId },
        data: { currentPhase: phase },
      }).catch(() => {});
    }
  };

  // 7. Create tools
  const onIterationAdvance = (newId: string, newNumber: number) => {
    iterationId = newId;
    iterationNumber = newNumber;
    stepSortOrder = 0;
  };
  const expCounter = { value: experimentCounter };
  const searchCounter = { value: 0 };
  const rawTools = createTools(projectId, userId, workDir, emit, remoteHosts, recordStep, { id: iterationId, number: iteration.number }, sharedDir, onIterationAdvance, model, expCounter, searchCounter, gpuInfo?.map((g) => ({ alias: g.alias, gpuCount: g.gpuCount })), bannedPapers, isBenchmarkProject);

  // Wrap every tool's execute to sanitize return values — prevents invalid Unicode
  // surrogates from entering the LLM message history and causing API errors
  const tools = Object.fromEntries(
    Object.entries(rawTools).map(([name, t]) => {
      const orig = t as { execute?: (...args: unknown[]) => Promise<unknown> };
      if (!orig.execute) return [name, t];
      return [name, {
        ...t,
        execute: async (...args: unknown[]) => {
          const result = await orig.execute!(...args);
          if (typeof result === "string") return sanitizeForJson(result);
          return result;
        },
      }];
    })
  ) as typeof rawTools;

  // 6. Stream with tool use
  const MAX_STEPS = 80;
  let stepCount = 0;

  // Track tool usage for nudges
  let experimentsSinceLastLitReview = 0;
  let totalExperimentsRun = 0;
  let totalPaperConsultations = 0;
  const LIT_TOOLS = new Set(["search_papers", "read_paper", "search_library", "query_insights"]);
  const EXPERIMENT_TOOLS = new Set(["execute_command", "execute_remote"]);
  let iterationNudged = false;
  const iterationStepsAtStart = stepSortOrder; // total steps already in this iteration

  // Step budget tracking
  const stepBudget = {
    literature: 0,
    design: 0,
    experiment: 0,
    analysis: 0,
    infraDebug: 0,
  };

  emit({ type: "thinking", content: "Analyzing project state and planning next steps..." });

  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: async ({ text, toolCalls }) => {
      stepCount++;

      // Track tool usage patterns for nudges
      let hasNonSearch = false;
      for (const tc of toolCalls || []) {
        if (LIT_TOOLS.has(tc.toolName)) {
          experimentsSinceLastLitReview = 0;
          totalPaperConsultations++;
        }
        if (EXPERIMENT_TOOLS.has(tc.toolName)) {
          experimentsSinceLastLitReview++;
          totalExperimentsRun++;
        }
        if (tc.toolName !== "search_papers") hasNonSearch = true;
      }
      // Reset consecutive search counter when agent does something else
      if (hasNonSearch || (toolCalls || []).length === 0) {
        searchCounter.value = 0;
      }

      // Persist important events to research log
      if (text && text.length > 10) {
        await prisma.researchLogEntry.create({
          data: {
            projectId,
            type: "agent_suggestion",
            content: text.slice(0, 500),
            metadata: JSON.stringify({ step: stepCount }),
          },
        }).catch(() => {});
      }

      for (const tc of toolCalls || []) {
        const logType = tc.toolName === "log_finding" ? "observation" : "agent_suggestion";
        await prisma.researchLogEntry.create({
          data: {
            projectId,
            type: logType,
            content: `[${tc.toolName}] ${JSON.stringify(tc.input).slice(0, 300)}`,
            metadata: JSON.stringify({ step: stepCount, tool: tc.toolName }),
          },
        }).catch(() => {});
      }

      emit({ type: "step_done", stepNumber: stepCount });

      // Internal nudges — logged for debugging but NOT emitted to the user's console.
      // These are already covered by the system prompt; emitting them leaked prompt text to the UI.
      const remaining = MAX_STEPS - stepCount;
      if (remaining === 10 || remaining === 3) {
        // Budget reminders — only log, agent already knows from system prompt
        console.log(`[agent] Step budget: ${remaining} steps remaining (step ${stepCount}/${MAX_STEPS})`);
      }
      if (experimentsSinceLastLitReview >= 3) {
        console.log(`[agent] Nudge: ${experimentsSinceLastLitReview} experiments without lit review`);
      }
      // Replan nudge every 20 steps
      if (stepCount % 20 === 0 && stepCount > 0) {
        emit({ type: "text", content: "\n\n[System: You've completed 20 steps since your last plan. Write an updated plan to RESEARCH_LOG.md before continuing.]\n\n" });
      }

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
        } else if (["execute_remote", "validate_environment"].includes(tc.toolName)) {
          stepBudget.experiment++;
        } else if (["check_job", "monitor_experiment", "read_file"].includes(tc.toolName)) {
          stepBudget.analysis++;
        } else if (["check_remote", "execute_command"].includes(tc.toolName)) {
          stepBudget.infraDebug++;
        }
      }

      // Warn if infrastructure debugging exceeds budget
      const totalBudgetSteps = Object.values(stepBudget).reduce((s, v) => s + v, 0);
      if (totalBudgetSteps > 10 && stepBudget.infraDebug / totalBudgetSteps > 0.1) {
        emit({ type: "text", content: `\n\n[System: Infrastructure debugging is ${Math.round(stepBudget.infraDebug / totalBudgetSteps * 100)}% of your steps (target: <5%). Focus on research, not environment issues. Use get_workspace instead of check_remote.]\n\n` });
      }

      // Emit thinking indicator
      emit({ type: "thinking", content: thinkingHint(toolCalls) });
    },
  });

  // 7. Forward stream events to SSE
  let lastToolName: string | undefined;
  try {
    for await (const chunk of result.fullStream) {
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
    // stopWhen termination throws "terminated" — this is normal, not an error
    const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    if (msg !== "terminated") throw streamErr;
    emit({ type: "text", content: `\n\n[Session reached ${stepCount} step limit. Auto-continuing...]` });
  }

  // 8. Final summary
  // result.text may throw "terminated" when stopWhen triggers — that's normal
  let finalText = "";
  try {
    finalText = await result.text;
  } catch {
    // stopWhen termination — not an error
  }
  if (finalText) {
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
  project: { title: string; brief: string; methodology: string | null },
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
2. **Device map** (for inference / loading large models): \`model = AutoModelForCausalLM.from_pretrained(name, device_map="auto")\` — HuggingFace automatically shards across all GPUs.
3. **DataParallel** (simple but slower): \`model = torch.nn.DataParallel(model)\` — only if you can't use accelerate.
4. **Manual FSDP**: For custom training loops that need fine-grained control.

**CRITICAL RULES:**
- **Default to multi-GPU.** With ${totalGpus} GPUs, your EFFECTIVE memory is ~${totalGpus}x a single GPU. Use it.
- **NEVER reduce dataset size to avoid environment/memory issues.** Instead: use DeepSpeed ZeRO stage 2/3, gradient accumulation, or mixed precision. These solve the REAL problem instead of watering down your experiment.
- **NEVER simplify your experiment setup to avoid installing a package.** If DeepSpeed or accelerate fails to install, fix the installation — don't rewrite the experiment to avoid it. Use \`validate_environment\` to test first.
- **NEVER train on a tiny subset "just to test" and call it an experiment.** A full run on real data with proper distributed training is the minimum. Subsets are only acceptable as a debugging step before the real run.
- Always check memory FIRST: \`torch.cuda.mem_get_info()\` at script start, print available memory per GPU.
- For batch processing, scale batch size with GPU count: \`per_gpu_batch * ${totalGpus}\`.
- If you get OOM: try (in order) mixed precision (bf16) → DeepSpeed ZeRO-2 → gradient accumulation → ZeRO-3. NEVER fall back to single-GPU or reduced data as a first resort.
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
      const label = p.preference === "local" ? "use execute_command (local)"
        : p.preference.startsWith("remote:") ? `use execute_remote on "${p.preference.slice(7)}"`
        : p.preference === "remote" ? "use execute_remote"
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
- \`execute_remote\` → submit experiments to GPU servers (syncs files, starts job, returns IMMEDIATELY). The job runs in the background — you can do other work while it runs.
- \`check_job\` → check status of a background job (quick, non-blocking). Call periodically to monitor progress.
- \`wait_for_jobs\` → block until specific jobs complete (use when you need results before proceeding, e.g., to compare outputs).
- \`get_workspace\` → PREFERRED: structured view of all files, results, packages, job status (cached, fast)
- \`check_remote\` → LAST RESORT: run a specific command only when get_workspace doesn't have what you need (e.g., reading a specific log file line range). Limited to 3 consecutive calls.
- \`execute_command\` → local tasks (editing files, data prep, lightweight compute)

### Parallel Workflow (YOU MUST DO THIS — NOT OPTIONAL)
You have the ability to do multiple things at once. **Use it aggressively.** Sequential one-at-a-time work is unacceptable when you have tools for parallelism.

**Experiments run in background — ALWAYS keep working:**
1. Submit experiment with \`execute_remote\` → get job ID → **immediately** start your next task
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

**Adversarial review — use \`adversarial_review\` for quick inline critique or \`dispatch_reviewer\` for deep background review.**

**Provocateur — use \`dispatch_provocateur\` when you need creative lateral thinking:**
Call it when you're stuck in a rut, when results plateau, or after 2+ experiments in the same direction without a breakthrough. The provocateur searches OUTSIDE the current research trajectory — different fields, unconventional approaches, counterintuitive ideas. It has web search access beyond academic papers.

**Training monitor — use \`monitor_experiment\` DURING long-running experiments:**
While an experiment runs on a remote server, call \`monitor_experiment\` periodically (every few steps) to check for NaN, loss divergence, gradient explosion, plateaus, and other anomalies. Don't wait until the experiment finishes to discover it diverged at step 100. Monitor early, catch problems early.

**The full research pipeline:**
1. \`dispatch_scouts\` (3 angles) → read existing papers while scouts work
2. \`collect_results\` → import best papers → \`dispatch_synthesizer\`
3. \`collect_results\` (synthesis) → \`dispatch_architect\` with synthesis
4. \`collect_results\` (architect proposals) → implement cheapest validation experiment
5. Run experiment → analyze results yourself → \`dispatch_architect\` with synthesis + results → iterate

${!resourcePreferences || resourcePreferences.length === 0 ? "**Default: use execute_remote for running experiments** (training, evaluation). Use execute_command for local-only tasks.\n" : ""}### Environment Setup (AUTOMATIC — but validate first!)
The remote execution system **automatically handles Python environments**:
- Creates a \`.venv\` if one doesn't exist and \`requirements.txt\` is present
- Installs/updates packages when \`requirements.txt\` changes (tracked via hash)
- Skips installation on subsequent runs if requirements haven't changed
- Activates the venv before running your command

**IMPORTANT: Validate before your first experiment:**
1. Write a \`requirements.txt\` with your dependencies using \`write_file\`
2. Call \`validate_environment\` to test that all packages install correctly on the remote host
3. If validation FAILS: read the error carefully, fix requirements.txt, and try again. If you cannot fix it (missing system libraries, CUDA version mismatch), **tell the user** what needs to be installed on the remote host and wait for their confirmation.
4. Once validated: write your experiment script and run with \`execute_remote\`

**Do NOT include** venv creation, pip install, or activation in your command — the system does it all.

**requirements.txt best practices:**
- Check the "Pre-installed" packages listed above — if torch/transformers/etc are already on the host, pin compatible versions (don't blindly install a different torch version that breaks CUDA)
- Include commonly useful packages that improve experiment quality:
  - \`flash-attn\` for efficient attention (if the host has CUDA 11.8+)
  - \`accelerate\` for multi-GPU training
  - \`wandb\` or \`tensorboard\` for experiment tracking
  - \`bitsandbytes\` for quantization
  - \`einops\` for tensor operations
  - \`scipy\` and \`scikit-learn\` for statistical tests
- Match torch version to the host's CUDA version (check the CUDA info above)

**When environment issues occur:**
- **NEVER simplify your experiment to avoid a dependency.** If torch + deepspeed + accelerate fails, fix the installation — don't rewrite without multi-GPU support.
- **NEVER reduce data or model size because of environment problems.** The environment should accommodate the experiment, not the other way around.
- If a package fails to install, check the host's Python version and CUDA version listed above for compatibility.
- **ASK THE USER for help** when you cannot resolve a dependency issue after 2 attempts. They can install system packages, update CUDA, or configure conda.`
    : `\n## Execution
${resourceSetting === "local" ? `**The user chose LOCAL-ONLY execution.** Do NOT write code that assumes GPU access or remote servers. Design experiments that run on CPU (or MPS on macOS). Use smaller models, smaller datasets, and CPU-friendly approaches. If a task genuinely requires a GPU, explain this to the user and suggest they change the resource setting.` : `No remote servers configured.`} Use execute_command to run experiments locally.

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

## The Research Cycle (repeat this loop — NEVER stop after one experiment)

### Phase 1: Literature, Synthesis & Hypotheses
**IMPORTANT: Use \`dispatch_scouts\` for all bulk literature search — do NOT call \`search_papers\` more than twice in a row.** Scouts run in parallel and are much faster. Use \`search_papers\` only for targeted follow-up queries on a specific sub-question.

**Step-by-step:**
1. \`dispatch_scouts\` with 2-3 angles → while they run, read papers already in your library with \`search_library\`
2. \`collect_results\` → import the best papers with \`search_papers\`
3. **\`dispatch_synthesizer\`** with the imported paper titles and your research focus → the synthesizer (Opus) reads them all together and finds contradictions, complementary techniques, and unexplored combinations
4. \`collect_results\` (synthesis) → use the cross-paper analysis to formulate hypotheses
5. Formulate 2-3 testable hypotheses using log_finding(type="hypothesis"). Write PLAIN TEXT — no markdown, no headers, no bold. Be specific: "Model X will outperform Y on dataset Z by N% because of mechanism W."
6. **\`dispatch_architect\`** with the synthesis output and your goal → the architect (Opus) proposes novel approaches with risk ratings and validation experiments
7. \`collect_results\` (architect proposals) → pick the cheapest validation experiment to try first

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

**DO NOT run ls, find, cat, or nvidia-smi via check_remote to understand the workspace.** Use \`get_workspace\` instead — it returns everything in one call. check_remote is for rare cases like reading a specific line range from a log file.

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
3. **For inference across multiple models:** Use device_map="auto" for large models, or distribute models across GPUs. But training MUST use proper data parallelism (not just pinning one model per GPU).
4. **Scale batch sizes with GPU count.** per_device_train_batch_size should be at least 4, giving effective batch = 4×${totalGpus}=${4 * totalGpus}.

**STATISTICAL RIGOR:**
1. **Multiple seeds** (minimum 3) for any experiment. Report mean ± std.
2. **Bootstrap confidence intervals** for final metrics.
3. **Compare against baselines** from the literature with the same datasets and metrics.

**Experiment naming:** Every experiment script MUST be named \`exp_NNN_descriptive_name.py\` (e.g., \`exp_001_baseline_gpt2.py\`, \`exp_002_finetune_lora.py\`). The system auto-numbers if you forget, but use consistent naming so experiments can be ordered and compared. Helper scripts (data loaders, utils) don't need numbering.

- **Before EVERY experiment, check the literature.** Use \`search_library\` to find relevant techniques in papers you already have. Use \`search_papers\` when you need new papers on a specific sub-problem. Use \`read_paper\` to extract exact methods, hyperparameters, and baselines from the most relevant papers. The experiment you design should cite at least one paper's approach. Never design an experiment from scratch when a paper has already solved part of the problem — build on their work.
- **Before writing code, search the web for existing tools.** Use \`web_search\` to find libraries that already do what you need (e.g., \`trl\` for RLHF, \`peft\` for parameter-efficient fine-tuning, \`accelerate\` for distributed training). Read their documentation with \`fetch_webpage\`. Don't rewrite from scratch what a mature library already provides — use pip packages.
- **USE REAL DATASETS.** When papers mention specific datasets (GLUE, SQuAD, MMLU, ImageNet, WMT, etc.), use those SAME datasets so your results are directly comparable. Download them via HuggingFace \`datasets\`, \`torchvision\`, or direct URLs. NEVER generate tiny synthetic toy data as a substitute for real benchmarks — the results would be scientifically meaningless.
- If the real dataset is very large, use a well-known subset or split (e.g., validation set, first 1000 examples) and note this explicitly. A subset of real data is infinitely better than fake data.
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

2. **\`adversarial_review\` or \`dispatch_reviewer\`** — get independent critique of your hypotheses, methods, and findings. Use \`adversarial_review\` for quick inline feedback, or \`dispatch_reviewer\` for deep background review (Opus with library access).

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
2. **Check existing insights** — use \`query_insights\` to find relevant methodology insights, learned techniques, and applications from your Mind Palace. These are distilled learnings from papers you've studied.
3. **Search for NEW papers** — if your library doesn't have the answer, use \`search_papers\` with targeted queries about the specific problem (NOT the original broad topic). For example, if your model is overfitting: search for "regularization techniques for [your specific architecture]" or "overfitting mitigation in [your domain]".
4. **Search the web** — use \`web_search\` to find library documentation, Stack Overflow answers, GitHub repos, or tutorials that address the specific technical problem. Then \`fetch_webpage\` to read them. Often the solution is a library parameter you didn't know about or a known issue with a workaround.
5. **Read the relevant papers** — extract the specific technique, dataset, hyperparameter, or trick they used to solve the problem you're facing.
6. **Adapt their approach** — incorporate what you learned into a new experiment design. Cite why: "Paper X showed that technique Y improves Z by N% in a similar setting, so I'm applying it here."

**Example flow:**
- Experiment shows 60% accuracy vs. 85% baseline from Paper A
- \`search_library("why low accuracy on [task] compared to baseline")\` → finds Paper B mentions data preprocessing is critical
- \`query_insights("preprocessing techniques for [task]")\` → finds insight: "Paper C found that normalization order matters significantly"
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
- **NEVER manage the Python environment manually when using execute_remote.** The remote wrapper handles venv creation, package installation, and activation automatically. Just write a \`requirements.txt\` and run \`python3 script.py\`. For local runs with execute_command, create a venv once: \`python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python3 script.py\`, then reuse on subsequent runs.
- **execute_remote handles EVERYTHING automatically and returns immediately.** The remote wrapper: (1) cds into the experiment directory, (2) creates .venv if needed, (3) installs requirements.txt if changed, (4) activates .venv, (5) runs your command, (6) captures exit code. So your command should be JUST the experiment, e.g. \`python3 experiment.py\`. NEVER include: \`cd\`, \`source .venv/bin/activate\`, \`python3 -m venv\`, \`pip install\`, \`bash -c\`, \`timeout\`, \`nohup\`, absolute paths to python or .venv/bin/python3. These WILL break the command. After submitting, **keep working** — don't just call check_job in a loop. Do something useful (read papers, write code) and check back later.
- **NEVER use execute_remote for checking files, reading logs, or listing results.** Use check_remote for that — it's a direct SSH command with no sync overhead. execute_remote does a full rsync which is slow and can fail.
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
): { role: "user" | "assistant"; content: string }[] {
  const messages: { role: "user" | "assistant"; content: string }[] = [];

  // Build the initial user message with context
  let context = "";

  // Inject the persistent research log (user-editable)
  if (researchLog && researchLog.trim().length > 50) {
    // Truncate if very long to preserve context budget
    const logContent = researchLog.length > 8000
      ? researchLog.slice(0, 6000) + "\n\n[...truncated — read RESEARCH_LOG.md for the full log...]\n\n" + researchLog.slice(-2000)
      : researchLog;
    context += `\n\n## RESEARCH_LOG.md (your persistent lab notebook — READ THIS CAREFULLY)\n${logContent}`;
  }

  if (project.hypotheses.length > 0) {
    context += `\n\nCurrent hypotheses:\n${project.hypotheses.map((h) => `- [${h.status}] ${h.statement}`).join("\n")}`;
  }

  // Include recent DB log entries not already in the file
  const recentLog = project.log
    .filter((l) => l.type !== "agent_suggestion")
    .filter((l) => {
      // Exclude ground truth entries (benchmarks) from agent context
      if (!l.metadata) return true;
      try { return !JSON.parse(l.metadata).groundTruth; } catch { return true; }
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
    case "execute_command":
      return "Analyzing command output...";
    case "check_remote":
      return "Checking remote files...";
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
  currentIteration: { id: string; number: number },
  sharedDir: string,
  onIterationAdvance?: (newId: string, newNumber: number) => void,
  agentModel?: Parameters<typeof streamText>[0]["model"],
  expCounter?: { value: number },
  searchCounter?: { value: number },
  cachedGpuInfo?: { alias: string; gpuCount: number }[],
  bannedPapers?: { title: string; doi?: string | null; arxivId?: string | null }[],
  isBenchmarkProject?: boolean,
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
  const consecutiveSearches = searchCounter || { value: 0 };
  let consecutiveCheckRemote = 0;
  // Experiment counter for sequential naming (shared with caller via ref object)
  const experimentCount = expCounter || { value: 0 };

  const BLOCKED_COMMAND_PATTERNS = /\b(pip3?\s+install|pip3?\s+uninstall|conda\s+(install|create|env)|apt(-get)?\s+install|sudo\s)/i;

  function isBlockedInfraCommand(cmd: string): string | null {
    if (BLOCKED_COMMAND_PATTERNS.test(cmd)) {
      return "Package management commands are not allowed. To add dependencies:\n" +
        "1. Add them to requirements.txt using write_file\n" +
        "2. The system installs them automatically when you run execute_remote\n" +
        "3. If a package fails to install, ask the user for help — don't try to pip install manually.";
    }
    return null;
  }

  return {
    search_papers: tool({
      description: "Search academic databases (OpenAlex, Semantic Scholar, CrossRef) for papers on a topic. Only imports papers relevant to your query — irrelevant results are filtered out. Papers are added to the project collection (not your main library).",
      inputSchema: z.object({
        query: z.string().describe("Search query — use specific technical terms"),
        max_results: z.number().min(1).max(8).default(5).optional(),
      }),
      execute: async ({ query, max_results }: { query: string; max_results?: number }) => {
        consecutiveCheckRemote = 0;
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
        const proj = await prisma.researchProject.findUnique({
          where: { id: projectId },
          select: { collectionId: true, title: true },
        });
        let collectionId = proj?.collectionId;
        if (!collectionId) {
          const col = await prisma.collection.create({
            data: { name: `Research: ${proj?.title || "Project"}` },
          });
          collectionId = col.id;
          await prisma.researchProject.update({
            where: { id: projectId },
            data: { collectionId },
          });
        }

        const imported: string[] = [];
        for (let i = 0; i < toImport.length; i++) {
          const r = toImport[i];
          // Skip figure/table/supplement DOIs (publishers like PeerJ assign DOIs to individual figures)
          if (isFigureOrSupplementDoi(r)) continue;

          emit({ type: "tool_progress", toolName: "search_papers", content: `Importing paper ${i + 1}/${toImport.length}: "${r.title.slice(0, 60)}..."` });
          try {
            // Check duplicates by DOI, arxivId, or title similarity
            let existing: { id: string } | null = null;
            if (r.doi || r.arxivId) {
              existing = await prisma.paper.findFirst({
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
            // Fallback: title similarity check (normalized, case-insensitive)
            if (!existing && r.title) {
              const normTitle = r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
              const candidates = await prisma.paper.findMany({
                where: { userId },
                select: { id: true, title: true },
              });
              existing = candidates.find((c) => {
                const ct = c.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
                return ct === normTitle || (normTitle.length > 20 && ct.includes(normTitle.slice(0, Math.floor(normTitle.length * 0.8))));
              }) || null;
            }
            if (existing) {
              await prisma.collectionPaper.upsert({
                where: { paperId_collectionId: { collectionId, paperId: existing.id } },
                create: { collectionId, paperId: existing.id },
                update: {},
              });
              imported.push(`"${r.title}" (already in library)`);
              continue;
            }

            // Create paper immediately — PDF download happens in background
            const paper = await prisma.paper.create({
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
            await prisma.collectionPaper.create({ data: { collectionId, paperId: paper.id } });

            // Queue PDF download in background — serialized to avoid rate limits
            pdfDownloadQueue.push({
              paperId: paper.id,
              doi: r.doi,
              arxivId: r.arxivId,
              openAccessPdfUrl: r.openAccessPdfUrl,
              title: r.title,
              hasAbstract: !!r.abstract,
            });
            imported.push(`"${r.title}" (${r.year || "?"}) — ${r.citationCount || 0} citations${r.abstract ? `\n  Abstract: ${r.abstract.slice(0, 300)}` : ""}`);
          } catch (err) {
            imported.push(`"${r.title}" — failed to import: ${err instanceof Error ? err.message : "error"}`);
          }
        }

        // Start draining the PDF download queue (non-blocking, serial)
        drainPdfDownloadQueue().catch((err) => console.error("[pdf-queue] Drain error:", err));

        const summary = `Found and imported ${imported.length} papers:\n\n${imported.join("\n\n")}`;
        await recordStep("search_papers", `Search: "${query}"`, "COMPLETED", { imported: imported.length, query }, "literature");
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

        // Remove from project collection
        await prisma.collectionPaper.delete({
          where: { paperId_collectionId: { collectionId: proj.collectionId, paperId: match.paper.id } },
        });

        // If research-only and no other collections, delete the paper entirely
        if (match.paper.isResearchOnly) {
          const otherCollections = await prisma.collectionPaper.count({
            where: { paperId: match.paper.id },
          });
          if (otherCollections === 0) {
            await prisma.paper.delete({ where: { id: match.paper.id } });
            return `Removed and deleted "${match.paper.title}" (research-only, no other collections).${reason ? ` Reason: ${reason}` : ""}`;
          }
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
        consecutiveCheckRemote = 0;
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
        const paper = await prisma.paper.findFirst({
          where: {
            userId,
            title: { contains: title },
          },
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
        if (paper.processingStatus && !["COMPLETED", "FAILED", "NEEDS_DEFERRED"].includes(paper.processingStatus)) {
          emit({ type: "tool_progress", toolName: "read_paper", content: `Paper is still being processed (${paper.processingStatus}). Reading what's available...` });
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

        // ── Mind Palace Insights ──
        if (paper.insights.length > 0) {
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
      description: "Write a file to the experiment directory. Use for Python scripts, requirements.txt, configs, etc. Overwrites if exists. Experiment scripts MUST follow naming: exp_NNN_name.py (e.g. exp_001_baseline.py). Helper/utility scripts can use any name.",
      inputSchema: z.object({
        filename: z.string().describe("Filename. For experiments: exp_NNN_name.py (e.g. exp_001_baseline.py, exp_002_finetune.py). For utilities/helpers: any name."),
        content: z.string().describe("Full file content"),
      }),
      execute: async ({ filename, content }: { filename: string; content: string }) => {
        consecutiveCheckRemote = 0;
        // Prevent path traversal
        let safeName = path.basename(filename);

        // Auto-number experiment scripts that don't follow the convention
        if (safeName.endsWith(".py") && !safeName.startsWith("exp_") && !isUtilityScript(safeName)) {
          experimentCount.value++;
          const num = String(experimentCount.value).padStart(3, "0");
          const stem = safeName.replace(/\.py$/, "").replace(/[^a-z0-9_]/gi, "_").toLowerCase();
          safeName = `exp_${num}_${stem}.py`;
        }

        const filePath = path.join(workDir, safeName);
        await writeFile(filePath, content, "utf-8");
        // Record experiment code as a step
        if (safeName.endsWith(".py")) {
          await recordStep("generate_code", `Write: ${safeName}`, "COMPLETED", { filename: safeName, bytes: content.length }, "experiment");
        }
        return `Written ${safeName} (${content.length} bytes) to ${workDir}`;
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
      description: "Read a file from the experiment directory.",
      inputSchema: z.object({
        filename: z.string().describe("Filename to read"),
      }),
      execute: async ({ filename }: { filename: string }) => {
        const safeName = path.basename(filename);
        const filePath = path.join(workDir, safeName);
        try {
          const content = await readFile(filePath, "utf-8");
          if (content.length > 10000) {
            return content.slice(0, 8000) + "\n\n[...truncated...]\n\n" + content.slice(-2000);
          }
          return content;
        } catch {
          return `File "${safeName}" not found.`;
        }
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

    execute_command: tool({
      description: "Run a shell command in the experiment directory. Use for: pip install, python scripts, checking outputs, etc. For long-running experiments, prefer execute_remote.",
      inputSchema: z.object({
        command: z.string().describe("Shell command to run"),
        timeout_seconds: z.number().default(300).optional().describe("Max execution time in seconds (default 300)"),
      }),
      execute: async ({ command, timeout_seconds }: { command: string; timeout_seconds?: number }) => {
        const blocked = isBlockedInfraCommand(command);
        if (blocked) return blocked;

        emit({ type: "tool_progress", toolName: "execute_command", content: `$ ${command.slice(0, 100)}${command.length > 100 ? "..." : ""}` });
        const timeoutSec = timeout_seconds || 300;
        const isPythonRun = /python\s/.test(command);
        const logFile = path.join(workDir, `.run-${Date.now()}.log`);

        return new Promise<string>((resolve) => {
          const proc = spawn("bash", ["-c", command], {
            cwd: workDir,
            timeout: timeoutSec * 1000,
            env: { ...process.env, PYTHONUNBUFFERED: "1" },
          });

          let stdout = "";
          let stderr = "";
          let lineCount = 0;

          const emitLine = (line: string, stream: "stdout" | "stderr") => {
            lineCount++;
            emit({
              type: "tool_output",
              toolName: "execute_command",
              content: line,
            });
            // Also write to logfile
            appendFile(logFile, `[${stream}] ${line}\n`).catch(() => {});
          };

          let stdoutBuf = "";
          proc.stdout?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stdout += text;
            stdoutBuf += text;
            const lines = stdoutBuf.split("\n");
            stdoutBuf = lines.pop() || "";
            for (const line of lines) {
              emitLine(line, "stdout");
            }
          });

          let stderrBuf = "";
          proc.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stderr += text;
            stderrBuf += text;
            const lines = stderrBuf.split("\n");
            stderrBuf = lines.pop() || "";
            for (const line of lines) {
              emitLine(line, "stderr");
            }
          });

          proc.on("close", async (code) => {
            // Flush remaining buffered text
            if (stdoutBuf) emitLine(stdoutBuf, "stdout");
            if (stderrBuf) emitLine(stderrBuf, "stderr");

            const succeeded = code === 0;
            if (isPythonRun) {
              await recordStep(
                "run_experiment",
                `Local: ${command.slice(0, 80)}`,
                succeeded ? "COMPLETED" : "FAILED",
                { stdout: stdout.slice(-2000), stderr: stderr.slice(-500), exitCode: code, logFile },
                "experiment",
              );
              if (succeeded) {
                const taskCat = classifyTaskCategory(command);
                recordResourceChoice(userId, taskCat, "local", command.slice(0, 80), projectId).catch(() => {});
              }
            }

            if (succeeded) {
              let result = "";
              if (stdout) result += `stdout:\n${stdout.slice(-5000)}\n`;
              if (stderr) result += `stderr:\n${stderr.slice(-2000)}\n`;
              resolve(result || "Command completed with no output.");
            } else {
              resolve(`COMMAND FAILED (exit ${code}). YOU MUST read the error, fix the code, and re-run before proceeding.\n\nstdout:\n${stdout.slice(-3000)}\n\nstderr:\n${stderr.slice(-2000)}`);
            }
          });

          proc.on("error", async (err) => {
            if (isPythonRun) {
              await recordStep("run_experiment", `Local: ${command.slice(0, 80)}`, "FAILED", { error: err.message });
            }
            resolve(`Command error: ${err.message}`);
          });
        });
      },
    }),

    get_workspace: tool({
      description: "Get a complete, structured view of the remote experiment workspace: all files with sizes and timestamps, result file contents, installed packages, and job status. This is MUCH faster than running multiple check_remote ls/cat commands. Use this FIRST when you need to understand the current state of the workspace.",
      inputSchema: z.object({
        refresh: z.boolean().default(false).optional().describe("Force refresh from remote (default: use 30s cache)"),
      }),
      execute: async ({ refresh }: { refresh?: boolean }) => {
        consecutiveCheckRemote = 0;
        const hostWhere = { isDefault: true as const };
        let host = await prisma.remoteHost.findFirst({ where: hostWhere });
        if (!host) host = await prisma.remoteHost.findFirst();
        if (!host) return "No remote hosts configured.";

        emit({ type: "tool_progress", toolName: "get_workspace", content: "Fetching workspace state..." });

        const state = await getWorkspaceState(projectId, host.id, refresh || false);
        if (!state) return "Could not fetch workspace state. The remote directory may not exist yet — run an experiment first.";

        return formatWorkspace(state);
      },
    }),

    check_remote: tool({
      description: "Run a quick command on the remote server via SSH — NO file sync, NO job record. Use this for lightweight operations: reading log files, checking results, listing files, checking disk space, etc. Much faster than execute_remote since it skips rsync. Do NOT use this for running experiments — use execute_remote for that.",
      inputSchema: z.object({
        command: z.string().describe("Shell command to run on the remote host (e.g., 'cat results.json', 'ls -la *.json', 'tail -50 stdout.log')"),
        host_alias: z.string().optional().describe("Remote host alias. Omit for default."),
      }),
      execute: async ({ command, host_alias }: { command: string; host_alias?: string }) => {
        consecutiveCheckRemote++;
        if (consecutiveCheckRemote > 3) {
          consecutiveCheckRemote = 0;
          return "You've checked the remote 3 times in a row. Use check_job for running experiments, read_file for local files, or get back to research. If you need the workspace state, describe what you're looking for and use a single targeted command.";
        }

        const blocked = isBlockedInfraCommand(command);
        if (blocked) return blocked;

        const hostWhere = host_alias ? { alias: host_alias } : { isDefault: true };
        let host = await prisma.remoteHost.findFirst({ where: hostWhere });
        if (!host) host = await prisma.remoteHost.findFirst();
        if (!host) return "No remote hosts configured.";

        // Strip unnecessary timeout wrapper — check_remote has its own SSH timeout
        const cleanCmd = command.replace(/^timeout\s+\d+\s+/, "");

        // Isolate: block access to other projects' remote directories
        const projectSlug = path.basename(workDir);
        const refsExperimentsDir = /~\/experiments\/|\/home\/.*\/experiments\//.test(cleanCmd);
        const refsOurProject = cleanCmd.includes(projectSlug);
        if (refsExperimentsDir && !refsOurProject) {
          return "You can only access this project's remote directory. Other projects' files are off-limits.";
        }

        emit({ type: "tool_progress", toolName: "check_remote", content: `$ [${host.alias}] ${cleanCmd.slice(0, 80)}` });

        // Build the full path to the experiment directory on the remote
        const slug = workDir.split("/").filter(Boolean).pop() || "experiment";
        const remoteDir = `${host.workDir}/${slug}`;

        // Wrap with cd to experiment dir + venv activation
        const fullCmd = `cd ${remoteDir} 2>/dev/null && [ -f .venv/bin/activate ] && source .venv/bin/activate 2>/dev/null; ${cleanCmd}`;

        const result = await quickRemoteCommand(host.id, fullCmd);

        if (!result.ok) {
          emit({ type: "tool_output", toolName: "check_remote", content: `ERROR: ${result.error}` });
          return `Command failed on ${host.alias}: ${result.error}`;
        }

        // Stream output lines
        const lines = result.output.split("\n");
        for (const line of lines.slice(0, 100)) {
          emit({ type: "tool_output", toolName: "check_remote", content: line });
        }
        if (lines.length > 100) {
          emit({ type: "tool_output", toolName: "check_remote", content: `... (${lines.length - 100} more lines)` });
        }

        return result.output.slice(-5000) || "Command completed with no output.";
      },
    }),

    execute_remote: tool({
      description: "Submit an experiment to a remote GPU server. Syncs files and starts the job, then returns IMMEDIATELY — the job runs in the background. Use check_job to monitor progress, or wait_for_jobs if you need results before continuing. This lets you submit multiple experiments and do other work (read papers, write code) while they run. ONLY use for running experiments (python scripts). For checking files/logs, use check_remote instead.",
      inputSchema: z.object({
        command: z.string().describe("The experiment command ONLY — e.g. 'python3 experiment.py'. Do NOT include: cd, source .venv/bin/activate, bash -c wrappers, timeout, absolute paths, or nohup. The system handles all of that automatically."),
        host_alias: z.string().optional().describe("Remote host alias. Omit to use the default host."),
      }),
      execute: async ({ command, host_alias }: { command: string; host_alias?: string }) => {
        consecutiveCheckRemote = 0;
        // Find host
        const hostWhere = host_alias
          ? { alias: host_alias }
          : { isDefault: true };
        let host = await prisma.remoteHost.findFirst({ where: hostWhere });
        if (!host) {
          host = await prisma.remoteHost.findFirst();
        }
        if (!host) return "No remote hosts configured. Use execute_command to run locally, or ask the user to configure a remote host.";

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

        // No timeout wrapper — ML training can run for hours/days.
        // The stale job cleanup handles genuinely stuck jobs.

        // ── Pre-flight validation: catch antipatterns before burning GPU time ──
        // Skip preflight for proof-of-concept scripts (poc_NNN_*.py) — they're intentionally small
        const isPoc = /python3?\s+poc_\d+/.test(sanitized);
        const preflightGpuCount = cachedGpuInfo?.find((g: { alias: string }) => g.alias === host.alias)?.gpuCount ?? 1;
        if (isPoc) {
          emit({ type: "tool_output", toolName: "execute_remote", content: `PoC script detected — skipping pre-flight checks` });
        }
        try {
          const { validateExperiment } = await import("./preflight");
          const preflight = isPoc ? { ok: true, violations: [], summary: "" } : await validateExperiment(workDir, sanitized, preflightGpuCount);
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

        // ── Auto environment check: verify packages before submission ──
        // If host has a pre-existing env, check that required packages are importable
        // This replaces the need for the agent to manually call validate_environment
        if (host.conda?.trim()) {
          try {
            const reqPath = path.join(workDir, "requirements.txt");
            const reqContent = await readFile(reqPath, "utf-8").catch(() => "");
            if (reqContent.trim()) {
              const pkgNames = reqContent.split("\n")
                .map((l) => l.trim().split(/[>=<!\[]/)[0].trim().replace(/-/g, "_"))
                .filter((p) => p && !p.startsWith("#"));

              if (pkgNames.length > 0) {
                emit({ type: "tool_progress", toolName: "execute_remote", content: `Checking packages on ${host.alias}...` });

                const condaVal = host.conda.trim();
                let activateCmd = "";
                if (condaVal.endsWith("/activate")) activateCmd = `source ${condaVal}`;
                else if (condaVal.endsWith("/python") || condaVal.endsWith("/python3")) {
                  const binDir = condaVal.replace(/\/python3?$/, "");
                  activateCmd = `source ${binDir}/activate 2>/dev/null || export PATH=${binDir}:$PATH`;
                } else activateCmd = `conda activate ${condaVal} 2>/dev/null || source ${condaVal} 2>/dev/null`;

                const checkResult = await quickRemoteCommand(host.id,
                  `${activateCmd} && python3 -c "
missing = []
for p in ${JSON.stringify(pkgNames)}:
    try: __import__(p)
    except ImportError: missing.append(p)
if missing: print('MISSING:' + ','.join(missing))
else: print('OK')
" 2>&1`
                );

                const output = checkResult.output?.trim() || "";
                if (output.startsWith("MISSING:")) {
                  const missing = output.replace("MISSING:", "").split(",").map(s => s.trim());
                  emit({ type: "tool_output", toolName: "execute_remote", content: `⚠ Missing packages: ${missing.join(", ")}` });
                  return `BLOCKED — The following packages from requirements.txt are not available in the host's environment:\n\n${missing.map(m => `  - ${m}`).join("\n")}\n\n` +
                    `The host "${host.alias}" uses a pre-configured environment (${host.conda}). ` +
                    `Either remove these from requirements.txt (if the host already has equivalents), ` +
                    `or ask the user to install them in the host environment.\n\n` +
                    `Available packages can be seen with get_workspace.`;
                }
              }
            }
          } catch (envErr) {
            // Don't block on env check failures — let the job attempt to run
            console.warn("[agent] auto env check failed:", envErr);
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
          });
          jobId = result.jobId;
        } catch (submitErr) {
          const errMsg = submitErr instanceof Error ? submitErr.message : String(submitErr);
          emit({ type: "tool_output", toolName: "execute_remote", content: `ERROR: Failed to submit job: ${errMsg}` });
          await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "FAILED", { host: host.alias, error: errMsg });
          return `Failed to submit remote job to ${host.alias}:\n${errMsg}\n\nThis likely means rsync or SSH failed. Check the remote host configuration.`;
        }

        // Track active job for this session
        activeJobIds.add(jobId);

        emit({ type: "tool_output", toolName: "execute_remote", content: `Job submitted (${jobId.slice(0, 8)}). Running in background on ${host.alias}.` });
        emit({ type: "tool_progress", toolName: "execute_remote", content: `Job submitted to ${host.alias}. Continuing...` });

        await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "COMPLETED", { host: host.alias, jobId, status: "SUBMITTED" }, "experiment");
        const taskCat = classifyTaskCategory(command);
        recordResourceChoice(userId, taskCat, `remote:${host.alias}`, command.slice(0, 80), projectId).catch(() => {});

        return `Job submitted to ${host.alias} (ID: ${jobId.slice(0, 8)}). It is now running in the background.\n\n**Continue with other work** — read papers, write code for the next experiment, analyze previous results. Use \`check_job\` with job_id="${jobId}" to check progress, or \`wait_for_jobs\` when you need results before proceeding.\n\nActive jobs this session: ${activeJobIds.size}`;
      },
    }),

    validate_environment: tool({
      description: "Verify that all packages in requirements.txt are available on the remote host. If the host has a pre-configured environment (venv/conda), checks packages are importable there. Otherwise creates a temp venv and installs. Use BEFORE your first experiment to catch missing packages early.",
      inputSchema: z.object({
        host_alias: z.string().optional().describe("Remote host alias. Omit to use the default host."),
      }),
      execute: async ({ host_alias }: { host_alias?: string }) => {
        const hostWhere = host_alias ? { alias: host_alias } : { isDefault: true };
        let host = await prisma.remoteHost.findFirst({ where: hostWhere });
        if (!host) host = await prisma.remoteHost.findFirst();
        if (!host) return "No remote hosts configured.";

        // Check that requirements.txt exists locally
        const reqPath = path.join(workDir, "requirements.txt");
        let reqContent: string;
        try {
          reqContent = await readFile(reqPath, "utf-8");
        } catch {
          return "No requirements.txt found in the experiment directory. Write one first with write_file.";
        }

        emit({ type: "tool_progress", toolName: "validate_environment", content: `Validating environment on ${host.alias}...` });

        try {
          // Extract package names from requirements.txt for import test
          const pkgNames = reqContent.split("\n")
            .map((l) => l.trim().split(/[>=<!\[]/)[0].trim().replace(/-/g, "_"))
            .filter((p) => p && !p.startsWith("#"));

          const smokeTest = pkgNames.length > 0
            ? `python3 -c "\nimport sys; failed = []\nfor p in ${JSON.stringify(pkgNames)}:\n    try:\n        __import__(p)\n    except ImportError as e:\n        failed.append(f'{p}: {e}')\nif failed:\n    print('IMPORT FAILURES:'); [print(f'  - {f}') for f in failed]; sys.exit(1)\nelse:\n    print('All packages import OK')\nimport torch; print(f'PyTorch: {torch.__version__}, CUDA: {torch.cuda.is_available()}, GPUs: {torch.cuda.device_count()}')\n" 2>&1`
            : `echo "No packages to test"`;

          // Determine environment activation — respect host's existing venv/conda
          const condaVal = host.conda?.trim() || "";
          let activateCmd = "";
          if (condaVal.endsWith("/activate")) {
            activateCmd = `source ${condaVal} && `;
          } else if (condaVal.endsWith("/python") || condaVal.endsWith("/python3")) {
            const binDir = condaVal.replace(/\/python3?$/, "");
            activateCmd = `source ${binDir}/activate 2>/dev/null && ` || `export PATH=${binDir}:$PATH && `;
          } else if (condaVal) {
            activateCmd = `conda activate ${condaVal} 2>/dev/null && ` || `source ${condaVal} 2>/dev/null && `;
          }

          let result;
          if (activateCmd) {
            // Has existing env — just verify packages are importable, don't install
            emit({ type: "tool_progress", toolName: "validate_environment", content: `Checking packages in existing env on ${host.alias}...` });
            result = await quickRemoteCommand(host.id,
              `${activateCmd}echo "=== SMOKE TEST ===" && ${smokeTest}`
            );
          } else {
            // No existing env — install in temp venv
            emit({ type: "tool_progress", toolName: "validate_environment", content: `Installing packages on ${host.alias}...` });
            result = await quickRemoteCommand(host.id,
              `cd ${host.workDir} && mkdir -p _env_test && cat > _env_test/requirements.txt << 'EOF'\n${reqContent}\nEOF\n` +
              `cd _env_test && python3 -m venv .venv 2>&1 && source .venv/bin/activate && ` +
              `pip3 install --upgrade pip -q 2>&1 && pip3 install -r requirements.txt 2>&1 && ` +
              `echo "=== SMOKE TEST ===" && ${smokeTest}; ` +
              `EXIT=$?; rm -rf ${host.workDir}/_env_test; exit $EXIT`
            );
          }

          if (result.ok) {
            emit({ type: "tool_output", toolName: "validate_environment", content: `Environment validated on ${host.alias}` });
            return `All requirements install and import successfully on ${host.alias}.\n\nOutput:\n${result.output.slice(-2000)}`;
          } else {
            emit({ type: "tool_output", toolName: "validate_environment", content: `Environment validation FAILED on ${host.alias}` });
            const output = (result.error || result.output).slice(-3000);
            const isImportFailure = output.includes("IMPORT FAILURES");
            return `ENVIRONMENT VALIDATION FAILED on ${host.alias}.\n\n${isImportFailure ? "Packages installed but some failed to import" : "Package installation failed"}:\n${output}\n\n` +
              `**ACTION REQUIRED:**\n` +
              `- Check package names and versions in requirements.txt\n` +
              `- Some packages need system libraries (e.g. libffi-dev, libssl-dev)\n` +
              `- CUDA-dependent packages need matching CUDA version\n` +
              `- flash-attn needs CUDA 11.8+ and matching torch version\n` +
              `- Try pinning versions: torch==2.1.0 instead of just torch\n\n` +
              `**Ask the user for help** if you cannot resolve this after 2 attempts.`;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to connect to ${host.alias}: ${msg}`;
        }
      },
    }),

    check_job: tool({
      description: "Check the status of a background remote job. Returns status, recent stdout/stderr, and exit code if completed. Use this to monitor jobs submitted with execute_remote. Quick and non-blocking.",
      inputSchema: z.object({
        job_id: z.string().describe("The job ID returned by execute_remote"),
      }),
      execute: async ({ job_id }: { job_id: string }) => {
        const job = await prisma.remoteJob.findUnique({
          where: { id: job_id },
          include: { host: true },
        });
        if (!job) return `Job "${job_id}" not found.`;

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
          activeJobIds.delete(job_id);
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
              await prisma.remoteJob.update({ where: { id: job_id }, data: { resultsSynced: true } });
            } catch {
              // Non-critical
            }
          }

          return `Job COMPLETED (exit ${job.exitCode ?? 0}) on ${job.host.alias}${elapsedStr}.\n\nstdout:\n${(job.stdout || "").slice(-5000)}\n\n${job.stderr ? `stderr:\n${job.stderr.slice(-1000)}` : ""}`;
        }

        if (job.status === "FAILED" || job.status === "CANCELLED") {
          activeJobIds.delete(job_id);
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

          return `EXPERIMENT FAILED (exit ${job.exitCode ?? "?"}) on ${job.host.alias}${elapsedStr}. Fix the code and re-run.\n\nstdout:\n${(job.stdout || "").slice(-3000)}\n\nstderr:\n${(job.stderr || "").slice(-2000)}${partialResults}${oomGuidance}`;
        }

        // Still running/syncing — use helper for single-call structured status
        if ((job.status === "RUNNING" || job.status === "SYNCING") && job.remoteDir) {
          try {
            const { getHelperStatus, sshExecutor } = await import("./remote-executor");
            const config = {
              host: job.host.host, port: job.host.port, user: job.host.user,
              keyPath: job.host.keyPath, workDir: job.host.workDir,
              conda: job.host.conda, setupCmd: job.host.setupCmd,
            };
            const status = await getHelperStatus(config, job.remoteDir);

            // Update DB with fresh logs
            await prisma.remoteJob.update({
              where: { id: job_id },
              data: { stdout: status.stdout_tail || job.stdout, stderr: status.stderr_tail || job.stderr },
            });

            // Process finished — detected by helper via waitpid
            if (status.status !== "running" && status.status !== "setup") {
              const exitCode = status.exit_code;
              const oomKill = status.oom_detected;
              let stderr = status.stderr_tail || "";
              if (oomKill && status.oom_detail) {
                stderr = `${stderr}\n\n[OOM DETECTED] ${status.oom_detail}`.trim();
              }
              const failed = oomKill || (exitCode !== null && exitCode !== 0);

              // Sync results back
              if (job.localDir) {
                await sshExecutor.syncDown(job.remoteDir, job.localDir, config).catch(() => {});
              }
              await prisma.remoteJob.update({
                where: { id: job_id },
                data: {
                  status: failed ? "FAILED" : "COMPLETED",
                  exitCode,
                  stdout: status.stdout_tail || job.stdout,
                  stderr,
                  resultsSynced: true,
                  completedAt: new Date(),
                },
              });
              activeJobIds.delete(job_id);

              const oomGuidance = oomKill
                ? "\n\n⚠ OOM KILL DETECTED — the process ran out of CPU RAM. To fix:\n1. Use streaming/lazy dataset loading (datasets.load_dataset with streaming=True)\n2. Load model directly to GPU: model.to('cuda') or device_map='auto'\n3. Don't load multiple models simultaneously\n4. Reduce batch size\nDo NOT just retry the same script — fix memory usage first."
                : "";
              return `Job ${failed ? "FAILED" : "COMPLETED"} (exit ${exitCode}) on ${job.host.alias}${elapsedStr}. Results synced.\n\nstdout:\n${(status.stdout_tail || "").slice(-5000)}${stderr ? `\n\nstderr:\n${stderr.slice(-1000)}` : ""}${oomGuidance}`;
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
      description: "Wait for one or more background jobs to complete. Use this when you genuinely need results before proceeding (e.g., to compare experiment outputs). Polls all listed jobs until all complete or timeout. Prefer check_job for non-blocking status checks.",
      inputSchema: z.object({
        job_ids: z.array(z.string()).describe("Job IDs to wait for"),
        timeout_minutes: z.number().default(120).optional().describe("Max wait time in minutes (default 120 — ML training can take hours)"),
      }),
      execute: async ({ job_ids, timeout_minutes }: { job_ids: string[]; timeout_minutes?: number }) => {
        const timeoutMs = (timeout_minutes || 120) * 60 * 1000;
        const start = Date.now();
        const results: Record<string, { status: string; stdout: string; stderr: string; exitCode: number | null }> = {};

        emit({ type: "tool_progress", toolName: "wait_for_jobs", content: `Waiting for ${job_ids.length} job(s)...` });

        while (Date.now() - start < timeoutMs) {
          let allDone = true;

          for (const jid of job_ids) {
            if (results[jid]) continue; // Already finished

            const job = await prisma.remoteJob.findUnique({
              where: { id: jid },
              include: { host: true },
            });
            if (!job) {
              results[jid] = { status: "NOT_FOUND", stdout: "", stderr: "", exitCode: null };
              continue;
            }

            if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") {
              activeJobIds.delete(jid);
              results[jid] = {
                status: job.status,
                stdout: job.stdout || "",
                stderr: job.stderr || "",
                exitCode: job.exitCode,
              };

              // Sync results if needed
              if (job.status === "COMPLETED" && !job.resultsSynced && job.localDir) {
                try {
                  const { sshExecutor } = await import("./remote-executor");
                  const config = {
                    host: job.host.host, port: job.host.port, user: job.host.user,
                    keyPath: job.host.keyPath, workDir: job.host.workDir,
                    conda: job.host.conda, setupCmd: job.host.setupCmd,
                  };
                  await sshExecutor.syncDown(job.remoteDir, job.localDir, config);
                  await prisma.remoteJob.update({ where: { id: jid }, data: { resultsSynced: true } });
                } catch {
                  // Non-critical
                }
              }

              const emoji = job.status === "COMPLETED" ? "✓" : "✗";
              emit({ type: "tool_output", toolName: "wait_for_jobs", content: `${emoji} Job ${jid.slice(0, 8)} ${job.status.toLowerCase()} on ${job.host.alias}` });
            } else {
              allDone = false;
            }
          }

          if (allDone) break;

          const elapsed = Math.floor((Date.now() - start) / 1000);
          const pending = job_ids.filter((jid) => !results[jid]).length;
          emit({ type: "tool_progress", toolName: "wait_for_jobs", content: `${pending} job(s) still running (${elapsed}s)...` });

          await new Promise((r) => setTimeout(r, 5_000));
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
      description: "Submit multiple experiment variants to remote GPU servers in parallel. Each variant runs as a separate background job. Use this for hyperparameter sweeps, ablation studies, or testing multiple approaches simultaneously. Jobs are distributed across available hosts round-robin. Returns all job IDs — use check_job or wait_for_jobs to monitor.",
      inputSchema: z.object({
        script: z.string().describe("Path to the base experiment script (e.g., 'experiment.py')"),
        variants: z.array(z.object({
          name: z.string().describe("Variant name for identification (e.g., 'lr=0.001', 'no-dropout')"),
          env: z.record(z.string(), z.string()).optional().describe("Environment variables to set for this variant"),
          args: z.string().optional().describe("Additional command-line arguments for this variant"),
        })).min(2).max(8).describe("2-8 experiment variants to run in parallel"),
        host_aliases: z.array(z.string()).optional().describe("Specific hosts to use (round-robin). Omit to use all available hosts."),
      }),
      execute: async ({ script, variants, host_aliases }: { script: string; variants: { name: string; env?: Record<string, string>; args?: string }[]; host_aliases?: string[] }) => {
        // Resolve hosts
        let hosts;
        if (host_aliases && host_aliases.length > 0) {
          hosts = await prisma.remoteHost.findMany({ where: { alias: { in: host_aliases } } });
        } else {
          hosts = await prisma.remoteHost.findMany({ take: 5 });
        }
        if (hosts.length === 0) return "No remote hosts available for sweep.";

        emit({ type: "tool_progress", toolName: "run_experiment_sweep", content: `Starting sweep: ${variants.length} variants across ${hosts.length} host(s)...` });

        const jobResults: { name: string; jobId: string; host: string; error?: string }[] = [];

        for (let i = 0; i < variants.length; i++) {
          const variant = variants[i];
          const host = hosts[i % hosts.length];

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
        }, "experiment");

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
        consecutiveCheckRemote = 0;
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

          // Launch in background — fire and forget
          import("./sub-agent").then(({ runSubAgent }) => {
            runSubAgent(task.id).catch((err) => {
              console.error(`[dispatch_scouts] Scout ${task.id} failed:`, err);
            });
          });

          emit({ type: "tool_output", toolName: "dispatch_scouts", content: `Scout launched: "${facet.angle}" (${task.id.slice(0, 8)})` });
        }

        await recordStep("search_papers", `Dispatched ${facets.length} literature scouts`, "COMPLETED", { taskIds, facets: facets.map((f) => f.angle) }, "literature");

        return `Launched ${facets.length} literature scouts:\n${facets.map((f, i) => `${i + 1}. "${f.angle}" (ID: ${taskIds[i].slice(0, 8)})`).join("\n")}\n\nScouts are searching in the background. **Continue with other work** — formulate hypotheses, write code, analyze previous results. Use \`collect_results\` with these task IDs when you're ready to review their findings.`;
      },
    }),

    dispatch_reviewer: tool({
      description: "Launch a background adversarial reviewer (runs on Opus) to critique your hypotheses, methodology, or results. The reviewer has access to the paper library and Mind Palace to verify claims against literature. Returns a task ID — collect the review with collect_results when ready. Use this for deep, literature-grounded critique; use adversarial_review for quick inline critique.",
      inputSchema: z.object({
        content: z.string().describe("The hypotheses, experimental design, or results to review. Include specific numbers, methods, and claims."),
        focus: z.enum(["hypotheses", "methodology", "results", "statistical", "general"]).default("general").optional()
          .describe("What aspect to focus the review on"),
      }),
      execute: async ({ content, focus }: { content: string; focus?: string }) => {
        consecutiveCheckRemote = 0;
        if (!(prisma as unknown as Record<string, unknown>).agentTask) {
          return "Sub-agent tasks not available. Restart the dev server to pick up schema changes.";
        }
        const reviewFocus = focus || "general";
        emit({ type: "tool_progress", toolName: "dispatch_reviewer", content: `Launching adversarial reviewer (${reviewFocus})...` });

        const task = await prisma.agentTask.create({
          data: {
            projectId,
            role: "reviewer",
            goal: `Adversarial review (${reviewFocus})`,
            status: "PENDING",
            input: JSON.stringify({ content, focus: reviewFocus, userId }),
          },
        });

        import("./sub-agent").then(({ runSubAgent }) => {
          runSubAgent(task.id).catch((err) => {
            console.error(`[dispatch_reviewer] Reviewer ${task.id} failed:`, err);
          });
        });

        emit({ type: "tool_output", toolName: "dispatch_reviewer", content: `Reviewer launched (${task.id.slice(0, 8)})` });
        await recordStep("critique", `Dispatched adversarial reviewer (${reviewFocus})`, "COMPLETED", { taskId: task.id, focus: reviewFocus });

        return `Launched adversarial reviewer (ID: ${task.id.slice(0, 8)}, focus: ${reviewFocus}).\n\nThe reviewer runs on Opus and has access to your paper library and Mind Palace — it will verify claims against literature. **Continue with other work** and use \`collect_results\` with ["${task.id}"] when ready.`;
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
        consecutiveCheckRemote = 0;
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

        import("./sub-agent").then(({ runSubAgent }) => {
          runSubAgent(task.id).catch((err) => {
            console.error(`[dispatch_synthesizer] Synthesizer ${task.id} failed:`, err);
          });
        });

        emit({ type: "tool_output", toolName: "dispatch_synthesizer", content: `Synthesizer launched (${task.id.slice(0, 8)})` });
        await recordStep("synthesize", `Dispatched synthesizer: ${focus.slice(0, 80)}`, "COMPLETED", { taskId: task.id, focus, paperCount: (papers || []).length }, "literature");

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
        consecutiveCheckRemote = 0;
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

        import("./sub-agent").then(({ runSubAgent }) => {
          runSubAgent(task.id).catch((err) => {
            console.error(`[dispatch_architect] Architect ${task.id} failed:`, err);
          });
        });

        emit({ type: "tool_output", toolName: "dispatch_architect", content: `Architect launched (${task.id.slice(0, 8)})` });
        await recordStep("synthesize", `Dispatched architect: ${goal.slice(0, 80)}`, "COMPLETED", { taskId: task.id, goal, hasDiagnostics: !!diagnostics }, "literature");

        return `Launched architect (ID: ${task.id.slice(0, 8)}): "${goal}"\n\nThe architect runs on Opus with library access and will propose 2-3 novel approaches with risk ratings. **Continue with other work** and use \`collect_results\` with ["${task.id}"] when ready.\n\n**Important:** Review proposals critically. Start with the cheapest validation experiment before committing to larger changes.`;
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
        consecutiveCheckRemote = 0;
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

        import("./sub-agent").then(({ runSubAgent }) => {
          runSubAgent(task.id).catch((err) => {
            console.error(`[dispatch_provocateur] Provocateur ${task.id} failed:`, err);
          });
        });

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
        const job = await prisma.remoteJob.findUnique({
          where: { id: job_id },
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
      description: "Collect findings from dispatched sub-agents (scouts, reviewers, synthesizers, architects, provocateurs). Returns completed outputs and status of pending ones. Automatically detects and re-launches zombie tasks that got stuck. Call this after doing other work.",
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

        const completed: string[] = [];
        const pending: string[] = [];
        const failed: string[] = [];
        const relaunched: string[] = [];

        const ZOMBIE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes — scouts should finish in 2-5min

        const roleLabel = (t: { role: string }) => {
          const labels: Record<string, string> = {
            scout: "Scout", reviewer: "Reviewer", experimenter: "Experimenter",
            synthesizer: "Synthesizer", analyst: "Analyst", architect: "Architect",
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
              let entry = `## ${label}: "${output.angle || task.goal}"\n${output.summary || "No summary"}\n(${output.stepsUsed || "?"} steps, ${task.tokenUsage || "?"} tokens)`;
              if (task.role === "architect") {
                entry += "\n\n> **Review these proposals critically.** Start with the cheapest validation experiment before committing to larger changes.";
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
                import("./sub-agent").then(({ runSubAgent }) => {
                  runSubAgent(newTask.id).catch((err) => {
                    console.error(`[collect_results] Re-launched ${task.role} ${newTask.id} failed:`, err);
                  });
                });
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
      description: "Record an important finding, hypothesis, decision, or question in the research log. This appends to RESEARCH_LOG.md (the persistent lab notebook) AND the project database. Findings and breakthroughs are also saved to the Mind Palace. For hypotheses: write PLAIN TEXT only — no markdown headers, no **bold**, no bullet points. Just a clear, direct statement of the claim.",
      inputSchema: z.object({
        type: z.enum(["finding", "hypothesis", "decision", "question", "breakthrough"]).describe("Type of entry"),
        content: z.string().describe("What you found/decided/hypothesized. For hypotheses: plain text claim, no markdown formatting."),
        related_paper_title: z.string().optional().describe("Title (or fragment) of a paper this finding relates to. If provided, the insight will be linked to that paper in the Mind Palace."),
      }),
      execute: async ({ type, content, related_paper_title }: { type: string; content: string; related_paper_title?: string }) => {
        consecutiveCheckRemote = 0;
        const logType = type === "finding" ? "observation"
          : type === "hypothesis" ? "agent_suggestion"
          : type === "breakthrough" ? "breakthrough"
          : type === "question" ? "question"
          : "decision";

        await prisma.researchLogEntry.create({
          data: { projectId, type: logType, content },
        });

        // Append to RESEARCH_LOG.md
        const emoji = type === "breakthrough" ? "🔬" : type === "hypothesis" ? "💡" : type === "finding" ? "📊" : type === "question" ? "❓" : "📝";
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const logEntry = `\n### ${emoji} ${type.charAt(0).toUpperCase() + type.slice(1)} (${timestamp})\n${content}\n`;
        await appendFile(path.join(workDir, "RESEARCH_LOG.md"), logEntry).catch(() => {});

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

          await prisma.researchHypothesis.create({
            data: {
              projectId,
              statement: statement.slice(0, 500),
              rationale,
              status: "PROPOSED",
            },
          });
          await recordStep("formulate_hypothesis", `Hypothesis: ${statement.slice(0, 80)}`, "COMPLETED", { hypothesis: content }, "hypothesis");
          return `Hypothesis recorded and added to project: "${statement.slice(0, 100)}..."`;
        }

        if (type === "finding" || type === "breakthrough") {
          await recordStep("analyze_results", `Finding: ${content.slice(0, 80)}`, "COMPLETED", { finding: content, type }, "analysis");

          // Save to Mind Palace for reuse in future research
          try {
            // Find or create a "Research Findings" room
            let room = await prisma.mindPalaceRoom.findFirst({
              where: { name: "Research Findings" },
            });
            if (!room) {
              room = await prisma.mindPalaceRoom.create({
                data: {
                  name: "Research Findings",
                  description: "Insights and findings from autonomous research projects",
                  color: "#F59E0B",
                  icon: "flask",
                  isAutoGenerated: true,
                },
              });
            }

            // Find a paper to link to (prefer the related paper if specified, otherwise first project paper)
            let paperId: string | null = null;
            if (related_paper_title) {
              const match = await prisma.paper.findFirst({
                where: { userId, title: { contains: related_paper_title } },
                select: { id: true },
              });
              paperId = match?.id || null;
            }
            if (!paperId) {
              // Use first paper from the project collection
              const proj = await prisma.researchProject.findUnique({
                where: { id: projectId },
                select: { collectionId: true },
              });
              if (proj?.collectionId) {
                const first = await prisma.collectionPaper.findFirst({
                  where: { collectionId: proj.collectionId },
                  select: { paperId: true },
                });
                paperId = first?.paperId || null;
              }
            }

            if (paperId) {
              await prisma.insight.create({
                data: {
                  roomId: room.id,
                  paperId,
                  learning: content.slice(0, 1000),
                  significance: type === "breakthrough"
                    ? "Major finding from autonomous research"
                    : "Experimental finding from research project",
                  applications: null,
                  isAutoGenerated: true,
                  source: "research",
                  projectId,
                },
              });
              emit({ type: "tool_progress", toolName: "log_finding", content: "Finding saved to Mind Palace" });
            }
          } catch (err) {
            // Non-critical — don't fail the tool if Mind Palace write fails
            console.warn("[research-agent] Failed to save finding to Mind Palace:", (err as Error).message);
          }
        }

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
      }),
      execute: async ({ category, lesson, context }: { category: string; lesson: string; context?: string }) => {
        // Benchmarks don't save lessons — prevents contaminating future benchmark runs
        if (isBenchmarkProject) return "Lesson noted (not saved — benchmark mode).";

        // Check for duplicates (similar lesson already exists)
        const existing = await prisma.agentMemory.findMany({
          where: { userId },
          select: { id: true, lesson: true },
        });
        const lessonLower = lesson.toLowerCase();
        const duplicate = existing.find((m) => {
          const existingLower = m.lesson.toLowerCase();
          // Simple similarity: check if >60% of words overlap
          const newWords = lessonLower.split(/\s+/).filter((w) => w.length > 3);
          const existWords = new Set(existingLower.split(/\s+/).filter((w) => w.length > 3));
          if (newWords.length === 0) return false;
          let overlap = 0;
          for (let i = 0; i < newWords.length; i++) { if (existWords.has(newWords[i])) overlap++; }
          return overlap / newWords.length > 0.6;
        });

        if (duplicate) {
          // Update existing instead of creating duplicate
          await prisma.agentMemory.update({
            where: { id: duplicate.id },
            data: { lesson, context, category, updatedAt: new Date() },
          });
          return `Updated existing lesson: "${lesson.slice(0, 100)}"`;
        }

        await prisma.agentMemory.create({
          data: {
            userId,
            category,
            lesson: lesson.slice(0, 1000),
            context: context?.slice(0, 500) || null,
            projectId,
          },
        });

        emit({ type: "tool_progress", toolName: "save_lesson", content: `Lesson saved: ${lesson.slice(0, 60)}` });
        return `Lesson saved to process memory [${category}]: "${lesson.slice(0, 100)}".\nThis will be available in all future research sessions.`;
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

        // Fetch all user papers with full processed intelligence
        const allPapers = await prisma.paper.findMany({
          where: { userId },
          select: {
            id: true, title: true, abstract: true, summary: true, fullText: true,
            year: true, venue: true, authors: true, keyFindings: true, doi: true, arxivId: true,
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

        // Build searchable text per paper including all intelligence
        const queryTerms = await processQuery(query);
        const scored = allPapers.map((paper) => {
          // Gather all searchable text with weight multipliers
          const weighted: { text: string; weight: number }[] = [
            { text: paper.title || "", weight: 3 },
            { text: paper.abstract || "", weight: 2 },
            { text: paper.summary || "", weight: 2 },
            { text: paper.keyFindings || "", weight: 2.5 },
            { text: paper.tags.map((t) => t.tag.name).join(" "), weight: 1.5 },
            { text: (paper.fullText || "").slice(0, 30000), weight: 1 },
          ];

          // Add insights (high value — distilled knowledge)
          for (const ins of paper.insights) {
            weighted.push({ text: `${ins.learning} ${ins.significance} ${ins.applications || ""}`, weight: 2.5 });
          }

          // Add relation descriptions
          for (const rel of paper.sourceRelations) {
            weighted.push({ text: `${rel.description || ""} ${rel.targetPaper.title}`, weight: 1.5 });
          }
          for (const rel of paper.targetRelations) {
            weighted.push({ text: `${rel.description || ""} ${rel.sourcePaper.title}`, weight: 1.5 });
          }

          // Add citation contexts
          for (const ref of paper.references) {
            weighted.push({ text: ref.citationContext || "", weight: 2 });
          }

          // Add contradictions
          if (paper.promptResults[0]?.result) {
            weighted.push({ text: typeof paper.promptResults[0].result === "string" ? paper.promptResults[0].result : JSON.stringify(paper.promptResults[0].result), weight: 2 });
          }

          // Score with weights (stemmed + expanded terms)
          let score = scoreWeighted(weighted, queryTerms);

          // Boost project papers
          if (paperIds.has(paper.id)) score *= 1.5;

          return { paper, score };
        })
          .filter((s) => s.score > 0)
          .filter((s) => !isBanned(s.paper)) // Exclude banned papers (benchmarks)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);

        if (scored.length === 0) {
          return `No papers in your library match "${query}". Try search_papers to find new papers on this topic.`;
        }

        const results = scored.map((s, i) => {
          const p = s.paper;
          const inProject = paperIds.has(p.id) ? " [in project]" : "";
          const parts: string[] = [];
          parts.push(`${i + 1}. "${p.title}" (${p.year || "?"}${p.venue ? `, ${p.venue}` : ""})${inProject}`);

          if (p.summary) parts.push(`   Summary: ${p.summary.slice(0, 250)}`);

          // Key findings
          if (p.keyFindings) {
            parts.push(`   Key Findings: ${p.keyFindings.slice(0, 300)}`);
          }

          // Matching insights
          if (p.insights.length > 0) {
            const matchingInsights = p.insights
              .filter((ins) => {
                const text = `${ins.learning} ${ins.significance} ${ins.applications || ""}`;
                return scoreText(text, queryTerms) > 0;
              })
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
            ...p.sourceRelations.map((r) => ({ desc: r.description, type: r.relationType, other: r.targetPaper.title })),
            ...p.targetRelations.map((r) => ({ desc: r.description, type: r.relationType, other: r.sourcePaper.title })),
          ];
          const matchingRels = allRelations
            .filter((r) => {
              const text = `${r.desc || ""} ${r.other}`;
              return scoreText(text, queryTerms) > 0;
            })
            .slice(0, 3);
          if (matchingRels.length > 0) {
            parts.push(`   Related Papers:`);
            for (const r of matchingRels) {
              parts.push(`   - [${r.type}] ${r.other}${r.desc ? `: ${r.desc.slice(0, 150)}` : ""}`);
            }
          }

          // Matching citation contexts
          const matchingCites = p.references
            .filter((ref) => scoreText(ref.citationContext || "", queryTerms) > 0)
            .slice(0, 2);
          if (matchingCites.length > 0) {
            parts.push(`   Relevant Citations:`);
            for (const c of matchingCites) {
              parts.push(`   - ${c.title || "Unknown"}: ${(c.citationContext || "").slice(0, 200)}`);
            }
          }

          // Contradictions snippet if relevant
          if (p.promptResults[0]?.result) {
            const contradText = typeof p.promptResults[0].result === "string" ? p.promptResults[0].result : JSON.stringify(p.promptResults[0].result);
            if (scoreText(contradText, queryTerms) > 0) {
              parts.push(`   Contradictions: ${contradText.slice(0, 250)}`);
            }
          }

          return parts.join("\n");
        }).join("\n\n");

        // Bump usageCount for insights surfaced in search results
        const surfacedInsightIds = scored.flatMap((s) =>
          s.paper.insights
            .filter((ins) => scoreText(`${ins.learning} ${ins.significance} ${ins.applications || ""}`, queryTerms) > 0)
            .map((ins) => ins.id)
        );
        if (surfacedInsightIds.length > 0) {
          prisma.insight.updateMany({
            where: { id: { in: surfacedInsightIds } },
            data: { usageCount: { increment: 1 } },
          }).catch(() => {}); // non-blocking
        }

        await recordStep("search_papers", `Library search: "${query.slice(0, 60)}"`, "COMPLETED", { query, matches: scored.length }, "literature");
        return `Found ${scored.length} relevant papers in your library:\n\n${results}\n\nUse read_paper to get full details on any of these.`;
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
      description: "Complete the current research iteration and start a new one. Use this when you've finished a full research cycle (literature → hypotheses → experiments → analysis) and want to start a new iteration with a different angle, deeper investigation, or follow-up questions. This creates a new iteration in the project.",
      inputSchema: z.object({
        reflection: z.string().describe("Summary of what was learned in this iteration — key findings, what worked, what didn't"),
        next_goal: z.string().describe("Goal for the next iteration — what new question, approach, or direction to pursue"),
        start_phase: z.enum(["literature", "hypothesis", "experiment"]).default("literature").describe("Which phase to start the new iteration in"),
      }),
      execute: async ({ reflection, next_goal, start_phase }: { reflection: string; next_goal: string; start_phase: string }) => {
        // Complete current iteration
        await prisma.researchIteration.update({
          where: { id: currentIteration.id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            reflection,
          },
        });

        // Create new iteration
        const newIteration = await prisma.researchIteration.create({
          data: {
            projectId,
            number: currentIteration.number + 1,
            goal: next_goal,
            status: "ACTIVE",
          },
        });

        // Update project phase
        await prisma.researchProject.update({
          where: { id: projectId },
          data: { currentPhase: start_phase },
        });

        // Log the transition
        await prisma.researchLogEntry.create({
          data: {
            projectId,
            type: "decision",
            content: `Completed iteration #${currentIteration.number}. Starting iteration #${newIteration.number}: ${next_goal}`,
          },
        });

        // Append to RESEARCH_LOG.md
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const logEntry = `\n---\n## Iteration #${currentIteration.number} Complete (${timestamp})\n**Reflection:** ${reflection}\n\n## Iteration #${newIteration.number}: ${next_goal}\n`;
        await appendFile(path.join(workDir, "RESEARCH_LOG.md"), logEntry).catch(() => {});

        // Update mutable refs so subsequent steps in this session go to the new iteration
        const prevNumber = currentIteration.number;
        currentIteration.id = newIteration.id;
        currentIteration.number = newIteration.number;
        onIterationAdvance?.(newIteration.id, newIteration.number);

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

        await prisma.researchHypothesis.update({
          where: { id: match.id },
          data: {
            status,
            evidence: JSON.stringify(existingEvidence),
          },
        });

        // Also log it
        await prisma.researchLogEntry.create({
          data: {
            projectId,
            type: status === "SUPPORTED" ? "breakthrough" : status === "REFUTED" ? "dead_end" : "observation",
            content: `Hypothesis "${match.statement.slice(0, 80)}..." → ${status}. Evidence: ${evidence.slice(0, 300)}`,
          },
        });

        await recordStep(
          "analyze_results",
          `Hypothesis ${status}: ${match.statement.slice(0, 60)}`,
          "COMPLETED",
          { hypothesisId: match.id, status, evidence },
          "analysis",
        );

        // Append to RESEARCH_LOG.md
        const hEmoji = status === "SUPPORTED" ? "✅" : status === "REFUTED" ? "❌" : "🔄";
        const hTimestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const hEntry = `\n### ${hEmoji} Hypothesis ${status} (${hTimestamp})\n**"${match.statement.slice(0, 200)}"**\nEvidence: ${evidence}\n`;
        await appendFile(path.join(workDir, "RESEARCH_LOG.md"), hEntry).catch(() => {});

        return `Updated hypothesis: "${match.statement.slice(0, 80)}..." → ${status}\nEvidence recorded: ${evidence.slice(0, 200)}`;
      },
    }),
  };
}
