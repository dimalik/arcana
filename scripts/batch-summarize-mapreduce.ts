/**
 * Map-reduce batch summarization for papers.
 *
 * Mirrors the sequential chunkedSummarize logic using the batch API:
 *   Round 1 (map): Extract notes from each chunk of each paper
 *   Poll until complete
 *   Round 2 (reduce): Synthesize final summary from notes
 *   Poll until complete
 *   Import: Write summaries to DB
 *
 * Run: npx tsx scripts/batch-summarize-mapreduce.ts [--limit N] [--dry-run]
 */
import path from "path";
import { PrismaClient } from "../src/generated/prisma/client";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const dbPath = path.join(process.cwd(), "prisma", "dev.db");
const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
const BACKUP_DIR = path.join(process.cwd(), "prisma", "backups", "summarize-mapreduce");

const CHUNK_SIZE = 100000; // ~MAX_PAPER_CHARS
const OVERLAP = 2000;
const MAX_BATCH_REQUESTS = 300;
const POLL_INTERVAL_MS = 60_000;

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const PAPER_LIMIT = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : 999999;
const DRY_RUN = args.includes("--dry-run");

// ── Prompts (mirrored from auto-process.ts) ──

const MAP_SYSTEM = `You are a research paper analyst. Extract ALL important information from this section of a research paper. Include:
- Key claims, findings, and contributions
- Methodology details (models, algorithms, datasets, hyperparameters)
- Mathematical formulations (reproduce key equations in LaTeX with $..$ or $$..$$)
- Experimental results with specific numbers (accuracy, F1, speedup, p-values, etc.)
- Tables of results (reproduce in markdown)
- Ablation study findings
- Limitations and future work mentioned

Be thorough and specific — include every number, model name, and dataset name you find. Do not summarize or editorialize, just extract the information.`;

// Read the actual summarize system prompt from the codebase
const SUMMARIZE_SYSTEM = `You are a senior scientific peer reviewer producing a structured review of a research paper. Write in clear, direct language. Be specific — cite numbers, model names, dataset names, and equations. Do not pad with generalities.

Your review MUST follow this exact structure:

---

## Summary

2-3 sentence TL;DR of what this paper does and achieves.

## Core Problem

What specific problem or gap does this paper address? Why has it not been solved before, or why are existing solutions insufficient?

## Why It Matters

What is the real-world or scientific impact? Who benefits and how?

## Novelty

What is genuinely new here? Be honest — if the novelty is incremental, say so. If it is a novel combination of known techniques, say that.

## Highlights

Bullet list of the most important or surprising takeaways. Include specific numbers/metrics.

## Reviewer Assessment

Score: X/10

A candid 2-3 paragraph assessment. Cover strengths, weaknesses, missing comparisons, questionable assumptions, reproducibility concerns, and whether the claims are well-supported by the evidence. Be constructively critical.

---

## Methodology

### Approach

Describe the overall approach and pipeline. What type of method is this (supervised, unsupervised, analytical, simulation, etc.)?

### Models & Datasets

List every model, architecture, baseline, and dataset mentioned. Use a table if there are many:

| Component | Details |
|-----------|---------|
| Model | ... |
| Dataset | ... |
| Baseline | ... |

### Technical Details

Explain the core methodology. If the paper includes mathematical formulations, reproduce the key equations using LaTeX math notation with dollar-sign delimiters: use $...$ for inline math and $$...$$ for display equations. Explain each term in plain English.

---

## Results

Present the key results one by one. Organize by importance and clarity.

For each result:
- State what was measured and how
- Give the specific numbers (accuracy, F1, BLEU, speedup, p-value, etc.)
- Compare to baselines where available
- Note if the result is statistically significant or if significance is not reported

Reproduce important tables from the paper in markdown format.

If there are ablation studies, summarize what each ablation reveals about which components matter most.

---

Rules:
- Use markdown headers, bullet points, tables, and code blocks for structure.
- Be specific. "Achieves good results" is not acceptable — give numbers.
- If information is missing from the paper (e.g., no ablation, no statistical tests), note its absence.
- Write as a knowledgeable reviewer, not a neutral summarizer. Your opinion matters.`;

// ── API helpers ──

async function getConfig() {
  const settings = await prisma.setting.findMany();
  const s = Object.fromEntries(settings.map(r => [r.key, r.value]));
  return {
    baseUrl: s.proxy_anthropic_base_url!,
    modelId: s.proxy_model_id || "claude-sonnet-4-6",
    headerName: s.proxy_header_name!,
    headerValue: s.proxy_header_value!,
  };
}

interface BatchRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    system: string;
    messages: { role: "user"; content: string }[];
  };
}

interface BatchResult {
  custom_id: string;
  result: {
    type: string;
    message?: {
      content: { type: string; text: string }[];
      usage: { input_tokens: number; output_tokens: number };
    };
  };
}

async function submitBatch(requests: BatchRequest[], config: Awaited<ReturnType<typeof getConfig>>): Promise<string> {
  const res = await fetch(`${config.baseUrl}/messages/batches`, {
    method: "POST",
    headers: {
      [config.headerName]: config.headerValue,
      "X-LLM-Proxy-Target-URL": "https://api.anthropic.com",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Batch submit failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { id: string };
  return data.id;
}

async function pollUntilDone(batchId: string, config: Awaited<ReturnType<typeof getConfig>>): Promise<BatchResult[]> {
  while (true) {
    const res = await fetch(`${config.baseUrl}/messages/batches/${batchId}`, {
      headers: {
        [config.headerName]: config.headerValue,
        "X-LLM-Proxy-Target-URL": "https://api.anthropic.com",
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
    const data = await res.json() as { processing_status: string; request_counts: Record<string, number> };

    const counts = data.request_counts;
    process.stdout.write(`\r  Status: ${data.processing_status} (succeeded=${counts.succeeded} processing=${counts.processing} errored=${counts.errored})   `);

    if (data.processing_status === "ended") {
      console.log();
      // Download results
      const resResults = await fetch(`${config.baseUrl}/messages/batches/${batchId}/results`, {
        headers: {
          [config.headerName]: config.headerValue,
          "X-LLM-Proxy-Target-URL": "https://api.anthropic.com",
          "anthropic-version": "2023-06-01",
        },
      });
      if (!resResults.ok) throw new Error(`Results download failed: ${resResults.status}`);
      const text = await resResults.text();

      // Save backup
      mkdirSync(BACKUP_DIR, { recursive: true });
      writeFileSync(path.join(BACKUP_DIR, `${batchId}.jsonl`), text);

      return text.trim().split("\n").map(line => JSON.parse(line) as BatchResult);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function extractResponseText(result: BatchResult): string | null {
  if (result.result.type !== "succeeded" || !result.result.message) return null;
  return result.result.message.content
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("\n");
}

// ── Chunking ──

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += CHUNK_SIZE - OVERLAP) {
    chunks.push(text.slice(start, Math.min(start + CHUNK_SIZE, text.length)));
    if (start + CHUNK_SIZE >= text.length) break;
  }
  return chunks;
}

// ── Main ──

async function main() {
  const config = await getConfig();
  console.log(`Model: ${config.modelId}`);
  console.log(`Chunk size: ${CHUNK_SIZE} chars, overlap: ${OVERLAP}`);
  console.log(`Max batch requests: ${MAX_BATCH_REQUESTS}`);
  if (DRY_RUN) console.log("DRY RUN — no API calls\n");

  // Find papers needing summaries
  const papers = await prisma.paper.findMany({
    where: {
      OR: [{ summary: null }, { summary: "" }],
      fullText: { not: null },
    },
    select: { id: true, title: true, fullText: true },
    take: PAPER_LIMIT,
  });

  console.log(`\nPapers needing summaries: ${papers.length}`);
  if (papers.length === 0) return;

  // ── Round 1: Map ──
  // For each paper, create one request per chunk
  console.log("\n=== ROUND 1: Map (extract notes per chunk) ===\n");

  type PaperChunkPlan = { paperId: string; chunks: string[]; needsMapReduce: boolean };
  const plans: PaperChunkPlan[] = papers.map(p => {
    const chunks = chunkText(p.fullText!);
    return { paperId: p.id, chunks, needsMapReduce: chunks.length > 1 };
  });

  const shortPapers = plans.filter(p => !p.needsMapReduce);
  const longPapers = plans.filter(p => p.needsMapReduce);
  const totalMapRequests = longPapers.reduce((s, p) => s + p.chunks.length, 0);

  console.log(`Short papers (single-shot summarize): ${shortPapers.length}`);
  console.log(`Long papers (map-reduce): ${longPapers.length} (${totalMapRequests} map requests)`);

  // Build map requests for long papers
  const mapRequests: BatchRequest[] = [];
  for (const plan of longPapers) {
    for (let i = 0; i < plan.chunks.length; i++) {
      mapRequests.push({
        custom_id: `${plan.paperId}--map--${i}--${plan.chunks.length}`,
        params: {
          model: config.modelId,
          max_tokens: 2000,
          system: MAP_SYSTEM,
          messages: [{ role: "user", content: `This is section ${i + 1} of ${plan.chunks.length} from the paper:\n\n${plan.chunks[i]}` }],
        },
      });
    }
  }

  // Build single-shot requests for short papers
  const shortRequests: BatchRequest[] = shortPapers.map(plan => ({
    custom_id: `${plan.paperId}--summarize-direct`,
    params: {
      model: config.modelId,
      max_tokens: 8192,
      system: SUMMARIZE_SYSTEM,
      messages: [{ role: "user", content: plan.chunks[0] }],
    },
  }));

  const allRound1 = [...mapRequests, ...shortRequests];
  console.log(`\nTotal Round 1 requests: ${allRound1.length}`);

  if (DRY_RUN) {
    console.log("DRY RUN — skipping API calls");
    return;
  }

  // Submit in chunks
  const round1BatchIds: string[] = [];
  for (let i = 0; i < allRound1.length; i += MAX_BATCH_REQUESTS) {
    const chunk = allRound1.slice(i, i + MAX_BATCH_REQUESTS);
    console.log(`\nSubmitting Round 1 batch ${round1BatchIds.length + 1} (${chunk.length} requests)...`);
    const batchId = await submitBatch(chunk, config);
    round1BatchIds.push(batchId);
    console.log(`  Batch ID: ${batchId}`);
    if (i + MAX_BATCH_REQUESTS < allRound1.length) await new Promise(r => setTimeout(r, 5000));
  }

  // Poll all Round 1 batches
  console.log(`\nPolling ${round1BatchIds.length} Round 1 batches...`);
  const allRound1Results: BatchResult[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const batchId of round1BatchIds) {
    console.log(`\nPolling ${batchId}:`);
    const results = await pollUntilDone(batchId, config);
    allRound1Results.push(...results);
    for (const r of results) {
      if (r.result.message?.usage) {
        totalInputTokens += r.result.message.usage.input_tokens;
        totalOutputTokens += r.result.message.usage.output_tokens;
      }
    }
  }

  console.log(`\nRound 1 complete: ${allRound1Results.length} results`);
  console.log(`  Tokens so far: ${totalInputTokens} input, ${totalOutputTokens} output`);

  // ── Collect short paper summaries directly ──
  const directSummaries = new Map<string, string>();
  for (const r of allRound1Results) {
    if (r.custom_id.endsWith("--summarize-direct")) {
      const paperId = r.custom_id.split("--")[0];
      const text = extractResponseText(r);
      if (text) directSummaries.set(paperId, text);
    }
  }
  console.log(`\nDirect summaries (short papers): ${directSummaries.size}`);

  // ── Collect map notes for long papers ──
  const paperNotes = new Map<string, Map<number, string>>();
  for (const r of allRound1Results) {
    if (!r.custom_id.includes("--map--")) continue;
    const parts = r.custom_id.split("--");
    const paperId = parts[0];
    const chunkIdx = parseInt(parts[2], 10);
    const text = extractResponseText(r);
    if (!text) continue;
    if (!paperNotes.has(paperId)) paperNotes.set(paperId, new Map());
    paperNotes.get(paperId)!.set(chunkIdx, text);
  }

  // ── Round 2: Reduce ──
  console.log("\n=== ROUND 2: Reduce (synthesize final summaries) ===\n");

  const reduceRequests: BatchRequest[] = [];
  for (const [paperId, notes] of paperNotes) {
    // Sort by chunk index and combine
    const sorted = Array.from(notes.entries()).sort((a, b) => a[0] - b[0]);
    const combined = sorted.map(([i, text]) => `## Section ${i + 1}\n\n${text}`).join("\n\n---\n\n");

    // If combined is still very large, we'll truncate for the reduce step
    const truncated = combined.length > CHUNK_SIZE
      ? combined.slice(0, CHUNK_SIZE) + "\n\n[...truncated for synthesis...]"
      : combined;

    reduceRequests.push({
      custom_id: `${paperId}--reduce`,
      params: {
        model: config.modelId,
        max_tokens: 8192,
        system: SUMMARIZE_SYSTEM,
        messages: [{ role: "user", content: `Below are detailed notes extracted from all sections of a research paper. Using these notes, produce your full structured review.\n\n${truncated}` }],
      },
    });
  }

  console.log(`Reduce requests: ${reduceRequests.length}`);

  if (reduceRequests.length === 0) {
    console.log("No reduce requests needed (all papers were short).");
  } else {
    const round2BatchIds: string[] = [];
    for (let i = 0; i < reduceRequests.length; i += MAX_BATCH_REQUESTS) {
      const chunk = reduceRequests.slice(i, i + MAX_BATCH_REQUESTS);
      console.log(`\nSubmitting Round 2 batch ${round2BatchIds.length + 1} (${chunk.length} requests)...`);
      const batchId = await submitBatch(chunk, config);
      round2BatchIds.push(batchId);
      console.log(`  Batch ID: ${batchId}`);
      if (i + MAX_BATCH_REQUESTS < reduceRequests.length) await new Promise(r => setTimeout(r, 5000));
    }

    // Poll Round 2
    console.log(`\nPolling ${round2BatchIds.length} Round 2 batches...`);
    for (const batchId of round2BatchIds) {
      console.log(`\nPolling ${batchId}:`);
      const results = await pollUntilDone(batchId, config);
      for (const r of results) {
        if (r.result.message?.usage) {
          totalInputTokens += r.result.message.usage.input_tokens;
          totalOutputTokens += r.result.message.usage.output_tokens;
        }
        if (r.custom_id.endsWith("--reduce")) {
          const paperId = r.custom_id.split("--")[0];
          const text = extractResponseText(r);
          if (text) directSummaries.set(paperId, text);
        }
      }
    }
  }

  // ── Import to DB ──
  console.log("\n=== IMPORT: Writing summaries to DB ===\n");

  let imported = 0;
  let failed = 0;
  for (const [paperId, summary] of directSummaries) {
    try {
      await prisma.paper.update({
        where: { id: paperId },
        data: { summary },
      });
      await prisma.promptResult.create({
        data: {
          paperId,
          promptType: "summarize",
          prompt: "batch-mapreduce-summarize",
          result: summary,
          provider: "proxy",
          model: config.modelId,
        },
      });
      imported++;
    } catch (err) {
      console.error(`  Failed to import ${paperId}: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nImported: ${imported}`);
  console.log(`Failed: ${failed}`);

  // ── Cost summary ──
  const inputCostPerM = config.modelId.includes("sonnet") ? 1.50 : config.modelId.includes("haiku") ? 0.40 : 7.50;
  const outputCostPerM = config.modelId.includes("sonnet") ? 7.50 : config.modelId.includes("haiku") ? 1.00 : 37.50;
  const inputCost = (totalInputTokens / 1_000_000) * inputCostPerM;
  const outputCost = (totalOutputTokens / 1_000_000) * outputCostPerM;

  console.log(`\n=== COST SUMMARY ===`);
  console.log(`Model: ${config.modelId}`);
  console.log(`Input tokens:  ${totalInputTokens.toLocaleString()} ($${inputCost.toFixed(2)})`);
  console.log(`Output tokens: ${totalOutputTokens.toLocaleString()} ($${outputCost.toFixed(2)})`);
  console.log(`Total cost:    $${(inputCost + outputCost).toFixed(2)} (batch 50% discount applied in per-M prices)`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); prisma.$disconnect(); process.exit(1); });
