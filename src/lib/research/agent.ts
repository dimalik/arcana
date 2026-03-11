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
import { submitRemoteJob, probeGpus } from "./remote-executor";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, readFile, readdir, stat, appendFile } from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

// ── Types ────────────────────────────────────────────────────────

export interface AgentEvent {
  type: "text" | "tool_call" | "tool_result" | "tool_progress" | "tool_output" | "step_done" | "thinking" | "error" | "done" | "heartbeat";
  content?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  stepNumber?: number;
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
      const emit = (event: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Heartbeat every 15s so the client knows the connection is alive
      const heartbeat = setInterval(() => {
        if (closed) { clearInterval(heartbeat); return; }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`));
        } catch {
          closed = true;
          clearInterval(heartbeat);
        }
      }, 15_000);

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
  const iterationId = iteration.id;
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

  // 6. Build context
  const papers = project.collection?.papers.map((cp) => cp.paper) || [];
  const systemPrompt = buildSystemPrompt(project, papers, workDir, remoteHosts, capabilities, gpuInfo);
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
  const tools = createTools(projectId, userId, workDir, emit, remoteHosts, recordStep);

  // 6. Stream with tool use
  const MAX_STEPS = 80;
  let stepCount = 0;

  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: async ({ text, toolCalls }) => {
      stepCount++;

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

      // Inject step budget reminder at key thresholds
      const remaining = MAX_STEPS - stepCount;
      if (remaining === 20) {
        emit({ type: "text", content: "\n\n[System: 20 steps remaining. Continue experiments but start thinking about synthesis.]\n" });
      } else if (remaining === 10) {
        emit({ type: "text", content: "\n\n[System: 10 steps remaining. Wrap up: update all hypotheses, log final findings, produce summary.]\n" });
      }

      // Emit thinking indicator
      emit({ type: "thinking", content: thinkingHint(toolCalls) });
    },
  });

  // 7. Forward stream events to SSE
  let lastToolName: string | undefined;
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

  // 8. Final summary
  const finalText = await result.text;
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

  const remoteSection = remoteHosts.length > 0
    ? `\n## Remote GPU Servers (IMPORTANT)
You have ${remoteHosts.length} remote server(s) configured:
${remoteHosts.map((h) => `- "${h.alias}"${h.gpuType ? ` (${h.gpuType})` : ""}`).join("\n")}
${gpuSection}

**You MUST use execute_remote (not execute_command) for running experiments.** The remote servers have GPUs and proper environments. Only use execute_command for quick local tasks like checking file contents, pip freeze, etc.

### Environment Setup (IMPORTANT — do this ONCE, not every run)
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
` : ""}
## The Research Cycle (repeat this loop — NEVER stop after one experiment)

### Phase 1: Literature & Hypotheses
- Search for papers. Read them carefully — extract specific numbers, methods, datasets, and claims.
- Formulate 2-3 testable hypotheses using log_finding(type="hypothesis"). Be specific: "Model X will outperform Y on dataset Z by N% because of mechanism W."
- Identify what the literature DOESN'T answer. That's where you contribute.

### Phase 2: Experiment
- **USE REAL DATASETS.** When papers mention specific datasets (GLUE, SQuAD, MMLU, ImageNet, WMT, etc.), use those SAME datasets so your results are directly comparable. Download them via HuggingFace \`datasets\`, \`torchvision\`, or direct URLs. NEVER generate tiny synthetic toy data as a substitute for real benchmarks — the results would be scientifically meaningless.
- If the real dataset is very large, use a well-known subset or split (e.g., validation set, first 1000 examples) and note this explicitly. A subset of real data is infinitely better than fake data.
- Write a complete, runnable experiment. Include baselines from the literature — you can't claim something is good without comparing it to known results.
- Make experiments save results to a JSON or CSV file (e.g., results.json) so you can compare across runs.
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
4. **Read the relevant papers** — extract the specific technique, dataset, hyperparameter, or trick they used to solve the problem you're facing.
5. **Adapt their approach** — incorporate what you learned into a new experiment design. Cite why: "Paper X showed that technique Y improves Z by N% in a similar setting, so I'm applying it here."

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

## Critical Rules
- Write COMPLETE, RUNNABLE Python code. No placeholders. Always include requirements.txt.
- **NEVER move on after a failed experiment.** Read the error, fix the code, re-run. Only analyze results from successful (exit 0) runs.
- **NEVER stop after one experiment.** One experiment is not research — it's a first draft. Critique it and run follow-ups.
- **NEVER claim a result without comparing to a baseline.** "We got 92% accuracy" is meaningless without "compared to baseline X which gets Y%."
- **NEVER accept results without statistical rigor.** Run experiments multiple times with different seeds. Report mean and standard deviation.
- **NEVER generate synthetic toy data when a real dataset exists.** If a paper evaluates on GLUE, use GLUE. If on SQuAD, use SQuAD. Generating 50 random samples to "simulate" a dataset invalidates the entire experiment. Use \`datasets\` library, \`torchvision.datasets\`, or direct download URLs from the papers.
- **NEVER reinstall packages on every run.** Create a venv ONCE with \`python3 -m venv .venv\`, install requirements into it, then reuse it. On subsequent runs just \`source .venv/bin/activate && python3 script.py\`. Only reinstall if requirements.txt has changed.
- **execute_remote handles job management automatically.** Do NOT manually nohup, background, sleep, or poll. Just pass the command.
- Use log_finding liberally: record hypotheses, findings, decisions, and breakthroughs. This is your lab notebook.
- Use update_hypothesis to track evidence for/against each hypothesis as you go.
- **NEVER design a follow-up experiment after failure without consulting literature first.** Use search_library + query_insights before retrying. Blind trial-and-error is not science.
- When you reach ~70% of your step budget, start wrapping up: synthesize findings, update all hypotheses, produce a final summary.

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
    messages.push({
      role: "user",
      content: hasWork
        ? `Continue researching this topic: ${brief}

You already have ${papers.length} papers and prior work. Check the existing results files with list_files and read_file before starting new experiments. If experiment code already exists, review it, fix any issues, and re-run. Do NOT re-search for papers you already have.

IMPORTANT: Don't just re-run what failed. Critically examine the results so far. What's missing? What wasn't tested? What would a reviewer criticize? Design follow-up experiments that address these gaps. Your goal is to produce findings that are NOVEL — something not already known from the papers.${context}`
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
    case "execute_remote":
      return "Reviewing remote execution results...";
    case "log_finding":
      return "Continuing research based on findings...";
    case "search_library":
      return "Analyzing library search results for relevant techniques...";
    case "query_insights":
      return "Reviewing Mind Palace insights for applicable methods...";
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
                sourceType: r.arxivId || r.doi?.match(/10\.48550\/arXiv\./i) ? "ARXIV" : "URL",
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
      description: "Read a paper's full text, abstract, and metadata. Use the paper title to find it.",
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
            processingStatus: true,
          },
        });
        if (!paper) return `Paper "${title}" not found in library. Try searching first.`;
        if (paper.processingStatus && !["COMPLETED", "FAILED"].includes(paper.processingStatus)) {
          emit({ type: "tool_progress", toolName: "read_paper", content: `Paper is still being processed (${paper.processingStatus}). Reading what's available...` });
        }

        const parts: string[] = [];
        parts.push(`Title: ${paper.title}`);
        if (paper.authors) {
          try { parts.push(`Authors: ${JSON.parse(paper.authors).join(", ")}`); } catch { parts.push(`Authors: ${paper.authors}`); }
        }
        if (paper.year) parts.push(`Year: ${paper.year}`);
        if (paper.venue) parts.push(`Venue: ${paper.venue}`);
        if (paper.abstract) parts.push(`\nAbstract:\n${paper.abstract}`);
        if (paper.summary) parts.push(`\nSummary:\n${paper.summary}`);
        if (paper.fullText) {
          // Truncate to ~15K chars to avoid blowing context
          const text = paper.fullText.length > 15000
            ? paper.fullText.slice(0, 12000) + "\n\n[...truncated...]\n\n" + paper.fullText.slice(-3000)
            : paper.fullText;
          parts.push(`\nFull Text:\n${text}`);
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
              await recordStep("run_experiment", `Local: ${command.slice(0, 80)}`, "FAILED", { error: err.message }, "experiment");
            }
            resolve(`Command error: ${err.message}`);
          });
        });
      },
    }),

    execute_remote: tool({
      description: "Run an experiment on a remote GPU server. Syncs the experiment directory, runs the command, and syncs results back. Use for GPU-intensive or long-running experiments. Commands run inside the synced experiment directory on the remote. Use relative paths only (e.g., 'python3 experiment.py', not absolute paths).",
      inputSchema: z.object({
        command: z.string().describe("Shell command to run on the remote host. Use python3, not python. Use relative file paths only (e.g., 'python3 experiment.py')."),
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

        // Sanitize command for remote execution
        let sanitized = command;
        // Replace 'python ' with 'python3 ' (many servers only have python3)
        sanitized = sanitized.replace(/\bpython\b(?!3)/g, "python3");
        // Replace 'pip ' with 'pip3 ' for consistency
        sanitized = sanitized.replace(/\bpip\b(?!3)/g, "pip3");
        // Strip absolute local paths — only filenames should be used since we cd into the remote dir
        sanitized = sanitized.replace(new RegExp(workDir + "/", "g"), "");
        // Add timeout wrapper for safety (40 min max) — skip if command already has timeout
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
          await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "FAILED", { host: host.alias, error: errMsg }, "experiment");
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
            await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "COMPLETED", { host: host.alias, stdout: (job.stdout || "").slice(-2000), stderr: (job.stderr || "").slice(-500) }, "analysis");
            return result;
          }
          if (job.status === "FAILED" || job.status === "CANCELLED") {
            emit({ type: "tool_output", toolName: "execute_remote", content: `\n✗ Job ${job.status.toLowerCase()} (exit ${job.exitCode ?? "?"}) on ${host.alias}` });
            if (job.stderr) {
              emit({ type: "tool_output", toolName: "execute_remote", content: `--- stderr ---\n${job.stderr.slice(-1000)}` });
            }
            const result = `EXPERIMENT FAILED (exit ${job.exitCode ?? "?"}) on ${host.alias}. YOU MUST read the error below, fix the code, and re-run before proceeding.\n\nstdout (last 3000 chars):\n${(job.stdout || "").slice(-3000)}\n\nstderr (last 2000 chars):\n${(job.stderr || "").slice(-2000)}`;
            await recordStep("run_experiment", `Remote (${host.alias}): ${command.slice(0, 60)}`, "FAILED", { host: host.alias, error: job.stderr?.slice(-1000), exitCode: job.exitCode }, "experiment");
            return result;
          }
        }

        emit({ type: "tool_output", toolName: "execute_remote", content: `\n⚠ Job still running after 30 minutes. ID: ${jobId}` });
        return `Job still running after 30 minutes. Job ID: ${jobId}. Check back later.`;
      },
    }),

    log_finding: tool({
      description: "Record an important finding, hypothesis, decision, or question in the research log. This appends to RESEARCH_LOG.md (the persistent lab notebook) AND the project database. Use liberally — this is how you build the project's knowledge base.",
      inputSchema: z.object({
        type: z.enum(["finding", "hypothesis", "decision", "question", "breakthrough"]).describe("Type of entry"),
        content: z.string().describe("What you found/decided/hypothesized"),
      }),
      execute: async ({ type, content }: { type: string; content: string }) => {
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
        }

        return `Logged: [${type}] ${content.slice(0, 100)}...`;
      },
    }),

    search_library: tool({
      description: "Search your existing paper collection for content relevant to a specific question or problem. Unlike search_papers (which searches external databases), this searches papers you ALREADY HAVE — their full text, abstracts, summaries, and insights. Use this when you need to understand WHY something happened, find a technique to solve a problem, or check if any paper in your library addresses a specific issue. Returns ranked results with relevant excerpts.",
      inputSchema: z.object({
        query: z.string().describe("Specific question or problem to search for (e.g., 'why does attention fail on long sequences', 'techniques for handling class imbalance')"),
        max_results: z.number().min(1).max(10).default(5).optional(),
      }),
      execute: async ({ query, max_results }: { query: string; max_results?: number }) => {
        const maxResults = max_results || 5;
        emit({ type: "tool_progress", toolName: "search_library", content: `Searching library for: "${query.slice(0, 60)}..."` });

        // Get all project papers (and all user papers if project has few)
        const proj = await prisma.researchProject.findUnique({
          where: { id: projectId },
          select: { collectionId: true },
        });

        // Search project papers first, then broader library
        const paperIds = new Set<string>();
        if (proj?.collectionId) {
          const collPapers = await prisma.collectionPaper.findMany({
            where: { collectionId: proj.collectionId },
            select: { paperId: true },
          });
          collPapers.forEach((cp) => paperIds.add(cp.paperId));
        }

        // Also search all user papers if collection is small
        const allPapers = await prisma.paper.findMany({
          where: { userId },
          select: {
            id: true, title: true, abstract: true, summary: true, fullText: true,
            year: true, venue: true, authors: true,
          },
        });

        // Score each paper by relevance to the query
        const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
        const scored = allPapers.map((paper) => {
          let score = 0;
          const searchable = [
            paper.title || "",
            paper.abstract || "",
            paper.summary || "",
            (paper.fullText || "").slice(0, 30000), // limit full text search
          ].join(" ").toLowerCase();

          // Count term matches
          for (const term of queryTerms) {
            const matches = (searchable.match(new RegExp(term, "g")) || []).length;
            score += matches;
          }

          // Boost project papers
          if (paperIds.has(paper.id)) score *= 1.5;

          // Find the most relevant excerpt
          let bestExcerpt = "";
          if (score > 0 && paper.fullText) {
            const text = paper.fullText;
            let bestPos = -1;
            let bestDensity = 0;
            // Sliding window to find densest region of query term matches
            const windowSize = 500;
            for (let i = 0; i < text.length - windowSize; i += 100) {
              const window = text.slice(i, i + windowSize).toLowerCase();
              let density = 0;
              for (const term of queryTerms) {
                density += (window.match(new RegExp(term, "g")) || []).length;
              }
              if (density > bestDensity) {
                bestDensity = density;
                bestPos = i;
              }
            }
            if (bestPos >= 0) {
              bestExcerpt = text.slice(Math.max(0, bestPos - 50), bestPos + windowSize + 50).trim();
            }
          }
          if (!bestExcerpt && paper.abstract) bestExcerpt = paper.abstract;
          if (!bestExcerpt && paper.summary) bestExcerpt = paper.summary;

          return { paper, score, excerpt: bestExcerpt };
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
          let entry = `${i + 1}. "${p.title}" (${p.year || "?"}${p.venue ? `, ${p.venue}` : ""})${inProject}`;
          if (s.excerpt) {
            entry += `\n   Relevant excerpt: ...${s.excerpt.slice(0, 400)}...`;
          }
          if (p.summary && !s.excerpt.includes(p.summary.slice(0, 50))) {
            entry += `\n   Summary: ${p.summary.slice(0, 200)}`;
          }
          return entry;
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
