/**
 * Research Agent — autonomous research loop with tools.
 *
 * Like Claude Code but for research: searches papers, reads them,
 * writes experiment code, runs it (locally or remotely), analyzes
 * results, and iterates.
 */

import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { getModel } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";
import { setLlmContext } from "@/lib/llm/provider";
import { prisma } from "@/lib/prisma";
import { searchAllSources } from "@/lib/import/semantic-scholar";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { processingQueue } from "@/lib/processing/queue";
import { submitRemoteJob, probeGpus, quickRemoteCommand } from "./remote-executor";
import { classifyTaskCategory } from "./task-classifier";
import { getAllResourcePreferences, recordResourceChoice, CONFIDENCE_THRESHOLD } from "./resource-preferences";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, readFile, readdir, stat, appendFile } from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

// ── Helpers ──────────────────────────────────────────────────────

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

export function startResearchAgent(
  projectId: string,
  userId: string,
  userMessage?: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      let closed = false;

      // Server-side activity tracking — shared with heartbeat
      const activity = {
        phase: "thinking" as "generating" | "tool_running" | "thinking" | "idle",
        tokens: 0,
        tool: undefined as string | undefined,
        stepCount: 0,
        lastEventAt: Date.now(),
      };

      const emit = (event: AgentEvent) => {
        if (closed) return;
        // Update activity tracker based on event type
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
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Heartbeat every 8s with activity metadata
      const heartbeat = setInterval(() => {
        if (closed) { clearInterval(heartbeat); return; }
        try {
          const hb: AgentEvent = {
            type: "heartbeat",
            activity: {
              phase: activity.phase,
              tokens: activity.tokens,
              tool: activity.tool,
              stepCount: activity.stepCount,
              lastEventAgoMs: Date.now() - activity.lastEventAt,
            },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(hb)}\n\n`));
        } catch {
          closed = true;
          clearInterval(heartbeat);
        }
      }, 8_000);

      try {
        await runAgent(projectId, userId, userMessage || null, emit);
        emit({ type: "done", content: "Agent finished." });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Agent error";
        console.error("[research-agent] Fatal:", msg);
        emit({ type: "error", content: msg });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
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
      log: { orderBy: { createdAt: "desc" }, take: 30 },
      iterations: { orderBy: { number: "desc" }, take: 1, include: { steps: true } },
    },
  });
  if (!project) throw new Error("Project not found");

  // 2. Set up working directory
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const workDir = project.outputFolder || path.join(process.cwd(), "output", "research", slug);
  await mkdir(workDir, { recursive: true });

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

  // 4. Detect remote hosts and probe GPUs
  const remoteHosts = await prisma.remoteHost.findMany({ take: 5 });

  // Probe GPUs on all remote hosts (run in parallel, non-blocking)
  const gpuProbes = await Promise.all(
    remoteHosts.map((h) => probeGpus(h.id).catch(() => null))
  );
  const gpuInfo = gpuProbes.filter(Boolean) as NonNullable<Awaited<ReturnType<typeof probeGpus>>>[];

  emit({ type: "tool_progress", toolName: "system", content: gpuInfo.length > 0 ? `Detected GPUs: ${gpuInfo.map((g) => g.summary).join("; ")}` : "No GPU info available" });

  // 4b. Load user-defined agent capabilities (defensive — model may not exist if server hasn't restarted after migration)
  let capabilities: { name: string; description: string; instructions: string }[] = [];
  try {
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
  let sharedUtilities: { filename: string; description: string }[] = [];
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

  // 5b. Load process memories (practical learnings from previous experiments)
  let processMemories: { id: string; category: string; lesson: string; context: string | null }[] = [];
  try {
    processMemories = await prisma.agentMemory.findMany({
      where: { userId },
      select: { id: true, category: true, lesson: true, context: true },
      orderBy: { usageCount: "desc" },
      take: 50,
    });
    // Bump usage count for loaded memories
    if (processMemories.length > 0) {
      await prisma.agentMemory.updateMany({
        where: { id: { in: processMemories.map((m) => m.id) } },
        data: { usageCount: { increment: 1 } },
      });
    }
  } catch (err) {
    console.warn("[research-agent] Could not load process memories:", (err as Error).message);
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
  const systemPrompt = buildSystemPrompt(project, papers, workDir, remoteHosts, capabilities, gpuInfo, processMemories, resourcePreferences, sharedUtilities, sharedDir);
  const messages = buildMessages(project, papers, userMessage, researchLog);

  // 6. Get model
  const { provider, modelId, proxyConfig } = await getDefaultModel();
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
  const tools = createTools(projectId, userId, workDir, emit, remoteHosts, recordStep, { id: iterationId, number: iteration.number }, sharedDir, onIterationAdvance);

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
      for (const tc of toolCalls || []) {
        if (LIT_TOOLS.has(tc.toolName)) {
          experimentsSinceLastLitReview = 0;
          totalPaperConsultations++;
        }
        if (EXPERIMENT_TOOLS.has(tc.toolName)) {
          experimentsSinceLastLitReview++;
          totalExperimentsRun++;
        }
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

      // Inject step budget reminders at key thresholds
      const remaining = MAX_STEPS - stepCount;
      if (stepCount === 15 && remaining > 50) {
        emit({ type: "text", content: "\n\n[System: 15 steps used this session. If you've only run 1 experiment, that's not enough — you should be designing follow-ups, ablations, and alternative approaches. Keep going.]\n" });
      } else if (remaining === 10) {
        emit({ type: "text", content: "\n\n[System: 10 steps left in this session. Log your findings with log_finding and update hypotheses. The session will auto-continue so you won't lose progress — but save your key results now.]\n" });
      } else if (remaining === 3) {
        emit({ type: "text", content: "\n\n[System: 3 steps left in this session. Quickly log any unrecorded findings. The session will auto-restart and you'll continue from where you left off.]\n" });
      }

      // Literature consultation nudges — trigger when running many experiments without consulting papers
      if (experimentsSinceLastLitReview >= 3) {
        emit({ type: "text", content: `\n\n[System: You've run ${experimentsSinceLastLitReview} experiments without consulting the literature. Before designing another experiment, search for papers or check your library for relevant techniques. Use search_library or search_papers with a SPECIFIC question about what you're observing. Good research is literature-informed, not trial-and-error.]\n` });
      }
      // Nudge if low paper consultation ratio overall
      if (totalExperimentsRun >= 4 && totalPaperConsultations === 0) {
        emit({ type: "text", content: "\n\n[System: You have not consulted any papers during this session. Use search_library to check if existing papers in your collection address the patterns you're seeing. Use search_papers to find new papers on specific sub-problems. This is research, not blind experimentation.]\n" });
      }

      // Iteration advancement nudge — if this iteration has accumulated many steps, prompt to advance
      const totalIterationSteps = iterationStepsAtStart + stepCount;
      if (!iterationNudged && totalIterationSteps >= 50 && stepCount >= 10) {
        iterationNudged = true;
        emit({ type: "text", content: `\n\n[System: This iteration (#${iteration.number}) has ${totalIterationSteps} steps. If you have solid findings and see a new direction, use \`complete_iteration\` to record what was learned and start a fresh iteration with a new goal. Good research has clear iterations — each with a focused question, experiments, and conclusions. Don't stuff everything into one iteration forever.]\n` });
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
          emit({ type: "text", content: chunk.text });
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
            result: typeof chunk.output === "string"
              ? chunk.output.slice(0, 2000)
              : JSON.stringify(chunk.output).slice(0, 2000),
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
  remoteHosts: { alias: string; gpuType: string | null }[],
  capabilities?: { name: string; description: string; instructions: string }[],
  gpuInfo?: { alias: string; gpuCount: number; gpus: { index: number; name: string; memoryTotal: string; memoryFree: string }[]; summary: string }[],
  processMemories?: { category: string; lesson: string; context: string | null }[],
  resourcePreferences?: { taskCategory: string; preference: string; usageCount: number }[],
  sharedUtilities?: { filename: string; description: string }[],
  sharedDir?: string,
): string {
  // Build detailed GPU info section
  let gpuSection = "";
  if (gpuInfo && gpuInfo.length > 0) {
    const details = gpuInfo.map((h) => {
      if (h.gpuCount === 0) return `- "${h.alias}": No GPUs detected`;
      const gpuLines = h.gpus.map((g) => `  GPU ${g.index}: ${g.name} — ${g.memoryTotal} total, ${g.memoryFree} free`);
      return `- "${h.alias}": ${h.gpuCount} GPU(s)\n${gpuLines.join("\n")}`;
    }).join("\n");

    const totalGpus = gpuInfo.reduce((s, h) => s + h.gpuCount, 0);
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

${totalGpus > 1 ? `**Multi-GPU approaches (use when model doesn't fit in one GPU):**
1. **DataParallel** (easiest, for training): \`model = torch.nn.DataParallel(model)\` — replicates model on each GPU, splits batches. Only works if model fits on ONE GPU.
2. **Device map** (for inference with large models): \`model = AutoModelForCausalLM.from_pretrained(name, device_map="auto")\` — HuggingFace automatically shards across GPUs.
3. **DeepSpeed / FSDP** (for training large models): Use \`accelerate launch --multi_gpu\` with a config. Better memory efficiency than DataParallel.
4. **Pipeline parallelism**: Put different layers on different GPUs manually. Use when model is too big for any single GPU.

**Rules:**
- Always check memory FIRST: \`torch.cuda.mem_get_info()\` at script start, print available memory.
- If estimated model size > 80% of single GPU memory → use device_map="auto" or multi-GPU.
- Set \`CUDA_VISIBLE_DEVICES=0,1,...\` if you want to control which GPUs to use.
- For batch processing, use the largest batch size that fits: start small, double until OOM, back off.
- Always use \`torch.cuda.empty_cache()\` between major operations to free memory.
- If you get OOM: try (in order) fp16/bf16 → int8 quantization → device_map="auto" → reduce batch size.
${multiGpuHost ? `- On "${multiGpuHost.alias}" you have ${multiGpuHost.gpuCount} GPUs — prefer this host for large models.` : ""}` : `**If you get OOM on a single GPU:**
1. Switch to fp16/bf16: \`model.half()\` or \`torch.autocast("cuda")\`
2. Use int8 quantization: \`load_in_8bit=True\`
3. Reduce batch size
4. Use gradient checkpointing for training
5. Try a smaller model variant`}`;
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

  const remoteSection = remoteHosts.length > 0
    ? `\n## Remote GPU Servers (IMPORTANT)
You have ${remoteHosts.length} remote server(s) configured:
${remoteHosts.map((h) => `- "${h.alias}"${h.gpuType ? ` (${h.gpuType})` : ""}`).join("\n")}
${gpuSection}
${prefSection}
**Tool selection guide:**
- \`execute_remote\` → run experiments on GPU servers (syncs files, creates job, polls for completion)
- \`check_remote\` → read files/logs on remote, list results, check status (SSH only, instant)
- \`execute_command\` → local tasks (editing files, data prep, lightweight compute)

${!resourcePreferences || resourcePreferences.length === 0 ? "**Default: use execute_remote for running experiments** (training, evaluation). Use execute_command for local-only tasks.\n" : ""}### Environment Setup (IMPORTANT — do this ONCE, not every run)
On the FIRST experiment run, create a virtual environment and install dependencies:
\`\`\`
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python3 experiment.py
\`\`\`
On SUBSEQUENT runs, just activate and run — do NOT reinstall packages:
\`\`\`
source .venv/bin/activate && python3 experiment.py
\`\`\`
Only re-run pip install if you've changed requirements.txt. The venv persists between runs in the same directory.`
    : `\n## Execution
No remote servers configured. Use execute_command to run experiments locally.

### Environment Setup (IMPORTANT — do this ONCE, not every run)
On the FIRST experiment run, create a virtual environment:
\`python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python3 experiment.py\`
On SUBSEQUENT runs: \`source .venv/bin/activate && python3 experiment.py\`
Do NOT reinstall packages every time — the venv persists.`;

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
## The Research Cycle (repeat this loop — NEVER stop after one experiment)

### Phase 1: Literature & Hypotheses
- Search for papers. Read them carefully — extract specific numbers, methods, datasets, and claims.
- Formulate 2-3 testable hypotheses using log_finding(type="hypothesis"). Be specific: "Model X will outperform Y on dataset Z by N% because of mechanism W."
- Identify what the literature DOESN'T answer. That's where you contribute.

### Phase 2: Experiment
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
- On first run, create a venv and install deps. On re-runs, just activate the existing venv (see Environment Setup above).

### Phase 3: Critique (THIS IS THE MOST IMPORTANT PHASE)
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
Based on your critique AND literature consultation, design and run follow-up experiments:
- **Literature-informed fixes**: Apply techniques from papers that address the specific weaknesses you found.
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
- **NEVER move on after a failed experiment.** Read the error, fix the code, re-run. Only analyze results from successful (exit 0) runs.
- **NEVER stop after one or two experiments.** One experiment is not research — it's a first draft. You must run ablations, parameter sweeps, alternative approaches, and follow-ups. If you find yourself writing a summary after 2 experiments, STOP and design more experiments instead.
- **NEVER say "final experiment" or "in conclusion".** You run continuously. Always have a next action planned.
- **NEVER claim a result without comparing to a baseline.** "We got 92% accuracy" is meaningless without "compared to baseline X which gets Y%."
- **NEVER accept results without statistical rigor.** Run experiments multiple times with different seeds. Report mean and standard deviation.
- **NEVER generate synthetic toy data when a real dataset exists.** If a paper evaluates on GLUE, use GLUE. If on SQuAD, use SQuAD. Generating 50 random samples to "simulate" a dataset invalidates the entire experiment. Use \`datasets\` library, \`torchvision.datasets\`, or direct download URLs from the papers.
- **NEVER reinstall packages on every run.** Create a venv ONCE with \`python3 -m venv .venv\`, install requirements into it, then reuse it. On subsequent runs just \`source .venv/bin/activate && python3 script.py\`. Only reinstall if requirements.txt has changed.
- **execute_remote handles EVERYTHING automatically.** The remote wrapper: (1) cds into the experiment directory, (2) activates .venv, (3) runs your command, (4) captures exit code. So your command should be JUST the experiment, e.g. \`python3 experiment.py\`. NEVER include: \`cd\`, \`source .venv/bin/activate\`, \`bash -c\`, \`timeout\`, \`nohup\`, absolute paths to python or .venv/bin/python3. These WILL break the command.
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
  project: { brief: string; hypotheses: { statement: string; status: string }[]; log: { type: string; content: string }[] },
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
    .slice(0, 10);
  if (recentLog.length > 0) {
    context += `\n\nRecent activity:\n${recentLog.map((l) => `[${l.type}] ${l.content}`).join("\n")}`;
  }

  if (userMessage) {
    messages.push({ role: "user", content: userMessage + context });
  } else {
    let brief = project.brief;
    try {
      const parsed = JSON.parse(project.brief);
      brief = parsed.question || parsed.topic || project.brief;
    } catch { /* plain text */ }

    const hasWork = papers.length > 0 || project.hypotheses.length > 0;
    const hasPapersNoHypotheses = papers.length > 0 && project.hypotheses.length === 0;
    const allHypothesesResolved = project.hypotheses.length > 0 && project.hypotheses.every((h) => h.status === "SUPPORTED" || h.status === "REFUTED");

    messages.push({
      role: "user",
      content: hasWork
        ? `Continue researching this topic: ${brief}

You already have ${papers.length} papers and prior work. Check the existing results files with list_files and read_file before starting new experiments. If experiment code already exists, review it, fix any issues, and re-run. Do NOT re-search for papers you already have.

IMPORTANT: Don't just re-run what failed. Critically examine the results so far. What's missing? What wasn't tested? What would a reviewer criticize? Design follow-up experiments that address these gaps. Your goal is to produce findings that are NOVEL — something not already known from the papers.${hasPapersNoHypotheses ? `

CRITICAL: You have ${papers.length} papers but NO hypotheses yet. Before running any experiments, you MUST formulate 2-3 specific, testable hypotheses using log_finding(type="hypothesis"). Read the papers first if you haven't, extract their key claims and methods, then formulate hypotheses that you can test experimentally.` : ""}${allHypothesesResolved ? `

All current hypotheses have been resolved (supported or refuted). Consider: (1) formulating NEW hypotheses based on what you learned, (2) using complete_iteration to start a new research cycle with a fresh direction, or (3) running deeper experiments on the most interesting findings.` : ""}${context}`
        : `Start researching this topic: ${brief}

Follow the full research cycle:
1. Search broadly for papers (2-3 different queries covering different angles)
2. Read the most relevant ones — extract specific methods, datasets, baselines, and numerical results
3. Formulate 2-3 specific, testable hypotheses
4. Design your first experiment WITH baselines from the literature
5. Run it, then CRITIQUE the results ruthlessly before deciding what to do next
6. Run follow-up experiments based on your critique
7. Keep iterating until you have genuine findings

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
    case "read_paper":
      return "Processing paper content and extracting key insights...";
    case "write_file":
      return "Reviewing written code and planning next action...";
    case "execute_command":
      return "Analyzing command output...";
    case "check_remote":
      return "Checking remote files...";
    case "execute_remote":
      return "Reviewing remote execution results...";
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
) {
  return {
    search_papers: tool({
      description: "Search academic databases (OpenAlex, Semantic Scholar, CrossRef) for papers on a topic. Returns titles, abstracts, authors, citation counts. Papers are automatically added to your library.",
      inputSchema: z.object({
        query: z.string().describe("Search query — use specific technical terms"),
        max_results: z.number().min(1).max(15).default(8).optional(),
      }),
      execute: async ({ query, max_results }: { query: string; max_results?: number }) => {
        const maxResults = max_results || 8;
        const results = await searchAllSources(query);
        const toImport = results.slice(0, maxResults);
        if (toImport.length === 0) return "No papers found for this query.";

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

            let filePath: string | undefined;
            try {
              const pdf = await findAndDownloadPdf({ doi: r.doi, arxivId: r.arxivId, existingPdfUrl: r.openAccessPdfUrl });
              if (pdf) filePath = pdf.filePath;
            } catch { /* optional */ }

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
                filePath,
                processingStatus: filePath ? "EXTRACTING_TEXT" : "PENDING",
              },
            });
            await prisma.collectionPaper.create({ data: { collectionId, paperId: paper.id } });
            if (filePath) processingQueue.enqueue(paper.id);
            imported.push(`"${r.title}" (${r.year || "?"}) — ${r.citationCount || 0} citations${r.abstract ? `\n  Abstract: ${r.abstract.slice(0, 300)}` : ""}`);
          } catch (err) {
            imported.push(`"${r.title}" — failed to import: ${err instanceof Error ? err.message : "error"}`);
          }
        }

        const summary = `Found and imported ${imported.length} papers:\n\n${imported.join("\n\n")}`;
        await recordStep("search_papers", `Search: "${query}"`, "COMPLETED", { imported: imported.length, query }, "literature");
        return summary;
      },
    }),

    read_paper: tool({
      description: "Read a paper with all processed intelligence: metadata, key findings, insights from the Mind Palace, relationships to other papers, contradictions, citation contexts, and full text. This is your primary tool for deeply understanding a paper.",
      inputSchema: z.object({
        title: z.string().describe("Title (or partial title) of the paper to read"),
      }),
      execute: async ({ title }: { title: string }) => {
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
      description: "Write a file to the experiment directory. Use for Python scripts, requirements.txt, configs, etc. Overwrites if exists.",
      inputSchema: z.object({
        filename: z.string().describe("Filename (e.g., experiment.py, requirements.txt)"),
        content: z.string().describe("Full file content"),
      }),
      execute: async ({ filename, content }: { filename: string; content: string }) => {
        // Prevent path traversal
        const safeName = path.basename(filename);
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

    check_remote: tool({
      description: "Run a quick command on the remote server via SSH — NO file sync, NO job record. Use this for lightweight operations: reading log files, checking results, listing files, checking disk space, etc. Much faster than execute_remote since it skips rsync. Do NOT use this for running experiments — use execute_remote for that.",
      inputSchema: z.object({
        command: z.string().describe("Shell command to run on the remote host (e.g., 'cat results.json', 'ls -la *.json', 'tail -50 stdout.log')"),
        host_alias: z.string().optional().describe("Remote host alias. Omit for default."),
      }),
      execute: async ({ command, host_alias }: { command: string; host_alias?: string }) => {
        const hostWhere = host_alias ? { alias: host_alias } : { isDefault: true };
        let host = await prisma.remoteHost.findFirst({ where: hostWhere });
        if (!host) host = await prisma.remoteHost.findFirst();
        if (!host) return "No remote hosts configured.";

        // Strip unnecessary timeout wrapper — check_remote has its own SSH timeout
        const cleanCmd = command.replace(/^timeout\s+\d+\s+/, "");

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
      description: "Run an experiment on a remote GPU server. Syncs the experiment directory, runs the command, and syncs results back. ONLY use for actually running experiments (python scripts). For checking files, reading logs, or listing results, use check_remote instead — it's much faster. The remote environment automatically activates .venv and cds into the experiment directory — do NOT include those in your command.",
      inputSchema: z.object({
        command: z.string().describe("The experiment command ONLY — e.g. 'python3 experiment.py'. Do NOT include: cd, source .venv/bin/activate, bash -c wrappers, timeout, absolute paths, or nohup. The system handles all of that automatically."),
        host_alias: z.string().optional().describe("Remote host alias. Omit to use the default host."),
      }),
      execute: async ({ command, host_alias }: { command: string; host_alias?: string }) => {
        // Find host
        const hostWhere = host_alias
          ? { alias: host_alias }
          : { isDefault: true };
        let host = await prisma.remoteHost.findFirst({ where: hostWhere });
        if (!host) {
          host = await prisma.remoteHost.findFirst();
        }
        if (!host) return "No remote hosts configured. Use execute_command to run locally, or ask the user to configure a remote host.";

        // Sanitize command — the .run.sh wrapper already handles cd, venv activation,
        // conda, and setup. Strip all that so the command is just the actual work.
        let sanitized = command;

        // Unwrap bash -c "..." wrappers the agent sometimes adds
        sanitized = sanitized.replace(/^bash\s+-c\s+["'](.+?)["']\s*$/, "$1");

        // Strip existing timeout wrappers (we'll re-add cleanly)
        sanitized = sanitized.replace(/^timeout\s+\d+[smh]?\s+/, "");

        // Strip redirect guards early so subsequent patterns match cleanly
        sanitized = sanitized.replace(/\s*2>\/dev\/null\s*\|\|\s*true\s*/g, " ");

        // Strip venv activation — .run.sh already does this
        sanitized = sanitized.replace(/(?:source\s+)?\.venv\/bin\/activate\s*(?:&&|;)\s*/g, "");
        sanitized = sanitized.replace(/source\s+activate\s*(?:&&|;)\s*/g, "");

        // Strip cd to project/experiment dirs — .run.sh already cds
        sanitized = sanitized.replace(/cd\s+\S+\s*(?:&&|;)\s*/g, "");

        // Strip absolute paths to .venv python/pip — just use python3/pip3
        sanitized = sanitized.replace(/(?:\/\S+)?\.venv\/bin\/python3?\s/g, "python3 ");
        sanitized = sanitized.replace(/(?:\/\S+)?\.venv\/bin\/pip3?\s/g, "pip3 ");

        // Replace 'python ' with 'python3 '
        sanitized = sanitized.replace(/\bpython\b(?!3)/g, "python3");
        // Replace 'pip ' with 'pip3 '
        sanitized = sanitized.replace(/\bpip\b(?!3)/g, "pip3");

        // Strip absolute local paths
        sanitized = sanitized.replace(new RegExp(workDir + "/", "g"), "");

        // Clean up whitespace
        sanitized = sanitized.replace(/\s+/g, " ").trim();

        // Add timeout wrapper for safety (40 min max)
        if (!sanitized.includes("timeout ")) {
          sanitized = `timeout 2400 ${sanitized}`;
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

        emit({ type: "tool_output", toolName: "execute_remote", content: `Job submitted (${jobId.slice(0, 8)}). Waiting for output...` });
        emit({ type: "tool_progress", toolName: "execute_remote", content: `Job submitted to ${host.alias}. Waiting...` });

        // Poll until done (max 30 minutes)
        const maxWait = 30 * 60 * 1000;
        const start = Date.now();
        let lastLog = "";
        let lastStderr = "";

        while (Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 5_000)); // poll every 5s instead of 10s

          const job = await prisma.remoteJob.findUnique({ where: { id: jobId } });
          if (!job) {
            emit({ type: "tool_output", toolName: "execute_remote", content: "ERROR: Job record disappeared." });
            return "Job disappeared unexpectedly.";
          }

          const elapsed = Math.floor((Date.now() - start) / 1000);
          const statusHint = job.status === "SYNCING" ? "syncing files" : job.status === "RUNNING" ? "running" : job.status.toLowerCase();
          emit({ type: "tool_progress", toolName: "execute_remote", content: `${statusHint} on ${host.alias} (${elapsed}s)` });

          // Stream new stdout lines
          if (job.stdout && job.stdout !== lastLog) {
            const newPart = job.stdout.slice(lastLog.length);
            for (const line of newPart.split("\n").filter(Boolean)) {
              emit({ type: "tool_output", toolName: "execute_remote", content: line });
            }
            lastLog = job.stdout;
          }

          // Stream new stderr lines (prefix with stderr:)
          if (job.stderr && job.stderr !== lastStderr) {
            const newPart = job.stderr.slice(lastStderr.length);
            for (const line of newPart.split("\n").filter(Boolean)) {
              emit({ type: "tool_output", toolName: "execute_remote", content: `[stderr] ${line}` });
            }
            lastStderr = job.stderr;
          }

          if (job.status === "COMPLETED") {
            emit({ type: "tool_output", toolName: "execute_remote", content: `\n✓ Job completed (exit 0) on ${host.alias}` });
            const result = `Job completed successfully on ${host.alias}.\n\nstdout:\n${(job.stdout || "").slice(-5000)}\n\n${job.stderr ? `stderr:\n${job.stderr.slice(-1000)}` : ""}`;
            await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "COMPLETED", { host: host.alias, stdout: (job.stdout || "").slice(-2000), stderr: (job.stderr || "").slice(-500) });
            const taskCat = classifyTaskCategory(command);
            recordResourceChoice(userId, taskCat, `remote:${host.alias}`, command.slice(0, 80), projectId).catch(() => {});
            return result;
          }
          if (job.status === "FAILED" || job.status === "CANCELLED") {
            emit({ type: "tool_output", toolName: "execute_remote", content: `\n✗ Job ${job.status.toLowerCase()} (exit ${job.exitCode ?? "?"}) on ${host.alias}` });
            if (job.stderr) {
              emit({ type: "tool_output", toolName: "execute_remote", content: `--- stderr ---\n${job.stderr.slice(-1000)}` });
            }

            // Try to recover partial results even on failure
            let partialResults = "";
            try {
              const resultsPath = path.join(workDir, "results.json");
              const resultsContent = await readFile(resultsPath, "utf-8").catch(() => null);
              if (resultsContent) {
                partialResults = `\n\nPARTIAL RESULTS RECOVERED (results.json was saved before crash):\n${resultsContent.slice(-3000)}`;
                emit({ type: "tool_output", toolName: "execute_remote", content: `\n📊 Partial results recovered from results.json` });
              }
            } catch {
              // No partial results available
            }

            const result = `EXPERIMENT FAILED (exit ${job.exitCode ?? "?"}) on ${host.alias}. YOU MUST read the error below, fix the code, and re-run before proceeding.\n\nstdout (last 3000 chars):\n${(job.stdout || "").slice(-3000)}\n\nstderr (last 2000 chars):\n${(job.stderr || "").slice(-2000)}${partialResults}`;
            await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "FAILED", { host: host.alias, error: job.stderr?.slice(-1000), exitCode: job.exitCode, hasPartialResults: !!partialResults });
            return result;
          }
        }

        // Timeout — try to get current state and return what we have
        emit({ type: "tool_output", toolName: "execute_remote", content: `\n⚠ Job polling timeout after 30 minutes. ID: ${jobId}` });
        const finalJob = await prisma.remoteJob.findUnique({ where: { id: jobId } });
        const hasOutput = finalJob?.stdout && finalJob.stdout.trim().length > 0;
        if (hasOutput) {
          emit({ type: "tool_output", toolName: "execute_remote", content: `Job has output — treating as completed.` });
          await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "COMPLETED", { host: host.alias, stdout: (finalJob!.stdout || "").slice(-2000), timedOut: true });
          return `Job polling timed out after 30 minutes but has output. The background poller will update the final status.\n\nstdout so far:\n${(finalJob!.stdout || "").slice(-5000)}`;
        }
        return `Job still running after 30 minutes on ${host.alias}. Job ID: ${jobId}. The stale job cleanup will auto-resolve this. Use check_remote to inspect the remote host directly.`;
      },
    }),

    log_finding: tool({
      description: "Record an important finding, hypothesis, decision, or question in the research log. This appends to RESEARCH_LOG.md (the persistent lab notebook) AND the project database. Findings and breakthroughs are also saved to the Mind Palace so they can be reused in future research projects. Use liberally — this is how you build the project's knowledge base.",
      inputSchema: z.object({
        type: z.enum(["finding", "hypothesis", "decision", "question", "breakthrough"]).describe("Type of entry"),
        content: z.string().describe("What you found/decided/hypothesized"),
        related_paper_title: z.string().optional().describe("Title (or fragment) of a paper this finding relates to. If provided, the insight will be linked to that paper in the Mind Palace."),
      }),
      execute: async ({ type, content, related_paper_title }: { type: string; content: string; related_paper_title?: string }) => {
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
          await prisma.researchHypothesis.create({
            data: {
              projectId,
              statement: content.slice(0, 500),
              rationale: "Generated by research agent",
              status: "PROPOSED",
            },
          });
          await recordStep("formulate_hypothesis", `Hypothesis: ${content.slice(0, 80)}`, "COMPLETED", { hypothesis: content }, "hypothesis");
          return `Hypothesis recorded and added to project: "${content.slice(0, 100)}..."`;
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
            year: true, venue: true, authors: true, keyFindings: true,
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
        const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
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

          // Score with weights
          let score = 0;
          for (const { text, weight } of weighted) {
            const lower = text.toLowerCase();
            for (const term of queryTerms) {
              score += (lower.match(new RegExp(term, "g")) || []).length * weight;
            }
          }

          // Boost project papers
          if (paperIds.has(paper.id)) score *= 1.5;

          return { paper, score };
        })
          .filter((s) => s.score > 0)
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
                const text = `${ins.learning} ${ins.significance} ${ins.applications || ""}`.toLowerCase();
                return queryTerms.some((t) => text.includes(t));
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
              const text = `${r.desc || ""} ${r.other}`.toLowerCase();
              return queryTerms.some((t) => text.includes(t));
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
            .filter((ref) => {
              const text = (ref.citationContext || "").toLowerCase();
              return queryTerms.some((t) => text.includes(t));
            })
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
            if (queryTerms.some((t) => contradText.toLowerCase().includes(t))) {
              parts.push(`   Contradictions: ${contradText.slice(0, 250)}`);
            }
          }

          return parts.join("\n");
        }).join("\n\n");

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

        // Score by relevance
        const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
        const scored = insights.map((insight) => {
          const searchable = [
            insight.learning,
            insight.significance,
            insight.applications || "",
            insight.userNotes || "",
            insight.paper.title,
            insight.room.name,
          ].join(" ").toLowerCase();

          let score = 0;
          for (const term of queryTerms) {
            score += (searchable.match(new RegExp(term, "g")) || []).length;
          }
          return { insight, score };
        })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);

        if (scored.length === 0) {
          return `No insights match "${query}". Try search_library to search paper full texts, or search_papers for new papers.`;
        }

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
          // Use DuckDuckGo HTML search — no API key required
          const encoded = encodeURIComponent(query);
          const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
          const res = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; ArcanaResearchBot/1.0)",
            },
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
