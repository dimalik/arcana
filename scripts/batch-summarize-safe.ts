/**
 * Batch summarization that exactly mirrors the sequential pipeline.
 *
 * Uses the EXACT same prompts, chunk sizes, and flow as
 * chunkedSummarize() in auto-process.ts:
 *
 *   Short papers (≤20k chars): single call with buildPrompt("summarize")
 *   Long papers (>20k chars):
 *     Round 1 (map): extract notes per 20k chunk (2k overlap), max_tokens=1500
 *     Round 1b (condense): if combined notes >20k, condense in groups of 3, max_tokens=1500
 *     Round 2 (reduce): final synthesis with full summarize system prompt, NO max_tokens cap
 *
 * Run: npx tsx scripts/batch-summarize-safe.ts [--batch-size 50]
 * Import only: npx tsx scripts/batch-summarize-safe.ts --import-only
 */
import path from "path";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { PrismaClient } from "../src/generated/prisma/client";
import { buildPrompt } from "../src/lib/llm/prompts.js";

const dbPath = path.join(process.cwd(), "prisma", "dev.db");
const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
const RESULTS_DIR = path.join(process.cwd(), "prisma", "backups", "summarize-results-v2");

// ── EXACT constants from auto-process.ts ──
const MAX_PAPER_CHARS = 20_000; // from provider.ts line 126
const OVERLAP = 2000;           // from auto-process.ts line 178

const MAX_BATCH_REQUESTS = 300;
const POLL_INTERVAL_MS = 60_000;

const args = process.argv.slice(2);
const batchSizeIdx = args.indexOf("--batch-size");
const BATCH_SIZE = batchSizeIdx >= 0 ? parseInt(args[batchSizeIdx + 1], 10) : 50;
const IMPORT_ONLY = args.includes("--import-only");

// ── EXACT prompts from auto-process.ts ──

const MAP_SYSTEM = `You are a research paper analyst. Extract ALL important information from this section of a research paper. Include:
- Key claims, findings, and contributions
- Methodology details (models, algorithms, datasets, hyperparameters)
- Mathematical formulations (reproduce key equations in LaTeX with $..$ or $$..$$)
- Experimental results with specific numbers (accuracy, F1, speedup, p-values, etc.)
- Tables of results (reproduce in markdown)
- Ablation study findings
- Limitations and future work mentioned

Be thorough and specific — include every number, model name, and dataset name you find. Do not summarize or editorialize, just extract the information.`;

const CONDENSE_SYSTEM = "You are a research paper analyst. Condense these extracted notes into a shorter but complete summary. Keep ALL specific numbers, equations, model names, dataset names, and key findings. Remove redundancy but preserve detail.";

// The summarize system prompt comes from buildPrompt("summarize") — the real one from prompts.ts

// ── API helpers ──

interface BatchRequest {
  custom_id: string;
  params: { model: string; max_tokens: number; system: string; messages: { role: "user"; content: string }[] };
}
interface BatchResult {
  custom_id: string;
  result: { type: string; message?: { content: { type: string; text: string }[]; usage: { input_tokens: number; output_tokens: number } } };
}

async function getConfig() {
  const settings = await prisma.setting.findMany();
  const s = Object.fromEntries(settings.map(r => [r.key, r.value]));
  return { baseUrl: s.proxy_anthropic_base_url!, modelId: s.proxy_model_id || "claude-sonnet-4-6", headerName: s.proxy_header_name!, headerValue: s.proxy_header_value! };
}

function apiHeaders(config: Awaited<ReturnType<typeof getConfig>>) {
  return { [config.headerName]: config.headerValue, "X-LLM-Proxy-Target-URL": "https://api.anthropic.com", "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
}

function sanitizeText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

async function submitBatch(requests: BatchRequest[], config: Awaited<ReturnType<typeof getConfig>>): Promise<string> {
  // Sanitize all text to prevent broken JSON from unpaired surrogates
  const sanitized = requests.map(r => ({
    ...r,
    params: {
      ...r.params,
      system: sanitizeText(r.params.system),
      messages: r.params.messages.map(m => ({ ...m, content: sanitizeText(m.content) })),
    },
  }));
  const res = await fetch(`${config.baseUrl}/messages/batches`, { method: "POST", headers: apiHeaders(config), body: JSON.stringify({ requests: sanitized }) });
  if (!res.ok) throw new Error(`Submit failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { id: string }).id;
}

async function pollUntilDone(batchId: string, config: Awaited<ReturnType<typeof getConfig>>): Promise<BatchResult[]> {
  while (true) {
    const res = await fetch(`${config.baseUrl}/messages/batches/${batchId}`, { headers: apiHeaders(config) });
    if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
    const data = await res.json() as { processing_status: string; request_counts: Record<string, number> };
    const c = data.request_counts;
    process.stdout.write(`\r  ${data.processing_status}: ok=${c.succeeded} working=${c.processing} err=${c.errored}   `);
    if (data.processing_status === "ended") {
      console.log();
      const r2 = await fetch(`${config.baseUrl}/messages/batches/${batchId}/results`, { headers: apiHeaders(config) });
      if (!r2.ok) throw new Error(`Results failed: ${r2.status}`);
      const text = await r2.text();
      mkdirSync(RESULTS_DIR, { recursive: true });
      writeFileSync(path.join(RESULTS_DIR, `${batchId}.jsonl`), text);
      return text.trim().split("\n").map(l => JSON.parse(l) as BatchResult);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function getText(r: BatchResult): string | null {
  if (r.result.type !== "succeeded" || !r.result.message) return null;
  return r.result.message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

function getUsage(r: BatchResult): { input: number; output: number } {
  if (!r.result.message?.usage) return { input: 0, output: 0 };
  return { input: r.result.message.usage.input_tokens, output: r.result.message.usage.output_tokens };
}

// ── Chunking — EXACT same logic as auto-process.ts line 187-191 ──

function chunkText(text: string): string[] {
  if (text.length <= MAX_PAPER_CHARS) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += MAX_PAPER_CHARS - OVERLAP) {
    chunks.push(text.slice(start, Math.min(start + MAX_PAPER_CHARS, text.length)));
    if (start + MAX_PAPER_CHARS >= text.length) break;
  }
  return chunks;
}

// ── Submit and poll helper ──

async function submitAndPoll(requests: BatchRequest[], config: Awaited<ReturnType<typeof getConfig>>, label: string): Promise<{ results: BatchResult[]; inputTokens: number; outputTokens: number }> {
  let allResults: BatchResult[] = [];
  let totalIn = 0, totalOut = 0;

  for (let i = 0; i < requests.length; i += MAX_BATCH_REQUESTS) {
    const chunk = requests.slice(i, i + MAX_BATCH_REQUESTS);
    console.log(`  ${label} chunk ${Math.floor(i / MAX_BATCH_REQUESTS) + 1} (${chunk.length} requests)...`);
    const batchId = await submitBatch(chunk, config);
    console.log(`  ${batchId} — polling...`);
    const results = await pollUntilDone(batchId, config);
    allResults.push(...results);
    for (const r of results) { const u = getUsage(r); totalIn += u.input; totalOut += u.output; }
    if (i + MAX_BATCH_REQUESTS < requests.length) await new Promise(r => setTimeout(r, 5000));
  }

  return { results: allResults, inputTokens: totalIn, outputTokens: totalOut };
}

// ── Main ──

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const config = await getConfig();

  // Get the REAL summarize system prompt from prompts.ts
  const { system: SUMMARIZE_SYSTEM } = buildPrompt("summarize", "");
  console.log(`Model: ${config.modelId}`);
  console.log(`Chunk size: ${MAX_PAPER_CHARS}, overlap: ${OVERLAP}`);
  console.log(`Summarize system prompt: ${SUMMARIZE_SYSTEM.length} chars`);

  const papers = await prisma.paper.findMany({
    where: {
      fullText: { not: null },
      OR: [
        { summary: null },
        { summary: "" },
        { NOT: { summary: { contains: "## Results" } } },
      ],
    },
    select: { id: true, fullText: true },
    orderBy: { id: "asc" },
  });
  console.log(`Papers to process: ${papers.length}\n`);
  if (papers.length === 0) return;

  let grandTotalIn = 0, grandTotalOut = 0;

  for (let offset = 0; offset < papers.length; offset += BATCH_SIZE) {
    const batch = papers.slice(offset, offset + BATCH_SIZE);
    const batchNum = Math.floor(offset / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(papers.length / BATCH_SIZE);
    console.log(`\n========== Batch ${batchNum}/${totalBatches} (${batch.length} papers) ==========`);

    // Classify
    const shortPapers = batch.filter(p => p.fullText!.length <= MAX_PAPER_CHARS);
    const longPapers = batch.filter(p => p.fullText!.length > MAX_PAPER_CHARS);
    console.log(`  Short (single call): ${shortPapers.length}, Long (map-reduce): ${longPapers.length}`);

    const batchSummaries = new Map<string, string>();
    let batchIn = 0, batchOut = 0;

    // ── Short papers: single call, EXACT same as auto-process.ts line 181-183 ──
    if (shortPapers.length > 0) {
      const shortRequests: BatchRequest[] = shortPapers.map(p => {
        const { system, prompt } = buildPrompt("summarize", p.fullText!);
        return {
          custom_id: `${p.id}--summarize-short`,
          // No max_tokens — matches sequential (generateLLMResponse default)
          params: { model: config.modelId, max_tokens: 16384, system, messages: [{ role: "user", content: prompt }] },
        };
      });

      const { results, inputTokens, outputTokens } = await submitAndPoll(shortRequests, config, "Short");
      batchIn += inputTokens; batchOut += outputTokens;
      for (const r of results) {
        const text = getText(r);
        if (text) batchSummaries.set(r.custom_id.split("--")[0], text);
      }
    }

    // ── Long papers: map-reduce, EXACT same as auto-process.ts line 186-253 ──
    if (longPapers.length > 0) {
      // Round 1: Map — extract notes per chunk
      const mapRequests: BatchRequest[] = [];
      const paperChunkCounts = new Map<string, number>();

      for (const p of longPapers) {
        const chunks = chunkText(p.fullText!);
        paperChunkCounts.set(p.id, chunks.length);
        for (let i = 0; i < chunks.length; i++) {
          mapRequests.push({
            custom_id: `${p.id}--map--${i}--${chunks.length}`,
            params: {
              model: config.modelId,
              max_tokens: 1500, // EXACT same as auto-process.ts line 217
              system: MAP_SYSTEM,
              messages: [{ role: "user", content: `This is section ${i + 1} of ${chunks.length} from the paper:\n\n${chunks[i]}` }],
            },
          });
        }
      }

      console.log(`  Map: ${mapRequests.length} requests for ${longPapers.length} papers`);
      const mapResult = await submitAndPoll(mapRequests, config, "Map");
      batchIn += mapResult.inputTokens; batchOut += mapResult.outputTokens;

      // Collect notes per paper
      const paperNotes = new Map<string, string[]>();
      for (const r of mapResult.results) {
        if (!r.custom_id.includes("--map--")) continue;
        const parts = r.custom_id.split("--");
        const paperId = parts[0];
        const chunkIdx = parseInt(parts[2], 10);
        const totalChunks = parseInt(parts[3], 10);
        const text = getText(r);
        if (!text) continue;

        if (!paperNotes.has(paperId)) paperNotes.set(paperId, new Array(totalChunks).fill(""));
        paperNotes.get(paperId)![chunkIdx] = `## Section ${chunkIdx + 1} of ${totalChunks}\n\n${text}`;
      }

      // Condense if needed — EXACT same as auto-process.ts line 222-241
      const combinedNotes = new Map<string, string>();
      const needsCondense: { paperId: string; notes: string[] }[] = [];

      for (const [paperId, notes] of paperNotes) {
        const combined = notes.filter(Boolean).join("\n\n---\n\n");
        if (combined.length > MAX_PAPER_CHARS) {
          needsCondense.push({ paperId, notes: notes.filter(Boolean) });
        } else {
          combinedNotes.set(paperId, combined);
        }
      }

      if (needsCondense.length > 0) {
        console.log(`  Condense needed for ${needsCondense.length} papers`);
        const condenseRequests: BatchRequest[] = [];

        for (const { paperId, notes } of needsCondense) {
          // Groups of 3 — EXACT same as auto-process.ts line 228
          for (let i = 0; i < notes.length; i += 3) {
            const group = notes.slice(i, i + 3).join("\n\n---\n\n");
            condenseRequests.push({
              custom_id: `${paperId}--condense--${Math.floor(i / 3)}`,
              params: {
                model: config.modelId,
                max_tokens: 1500, // EXACT same as auto-process.ts line 235
                system: CONDENSE_SYSTEM,
                messages: [{ role: "user", content: group }],
              },
            });
          }
        }

        const condenseResult = await submitAndPoll(condenseRequests, config, "Condense");
        batchIn += condenseResult.inputTokens; batchOut += condenseResult.outputTokens;

        // Collect condensed notes per paper
        const condensedParts = new Map<string, Map<number, string>>();
        for (const r of condenseResult.results) {
          if (!r.custom_id.includes("--condense--")) continue;
          const [paperId, , idx] = r.custom_id.split("--");
          const text = getText(r);
          if (!text) continue;
          if (!condensedParts.has(paperId)) condensedParts.set(paperId, new Map());
          condensedParts.get(paperId)!.set(parseInt(idx, 10), text);
        }

        for (const [paperId, parts] of condensedParts) {
          const sorted = Array.from(parts.entries()).sort((a, b) => a[0] - b[0]).map(([, t]) => t);
          combinedNotes.set(paperId, sorted.join("\n\n---\n\n"));
        }
      }

      // Round 2: Reduce — final synthesis
      // EXACT same as auto-process.ts line 244-253
      const reduceRequests: BatchRequest[] = [];
      for (const [paperId, combined] of combinedNotes) {
        reduceRequests.push({
          custom_id: `${paperId}--reduce`,
          params: {
            model: config.modelId,
            // No artificial max_tokens cap — matches sequential (generateLLMResponse default is unset)
            max_tokens: 16384,
            system: SUMMARIZE_SYSTEM,
            messages: [{ role: "user", content: `Below are detailed notes extracted from all sections of a research paper. Using these notes, produce your full structured review.\n\n${combined}` }],
          },
        });
      }

      console.log(`  Reduce: ${reduceRequests.length} requests`);
      const reduceResult = await submitAndPoll(reduceRequests, config, "Reduce");
      batchIn += reduceResult.inputTokens; batchOut += reduceResult.outputTokens;

      for (const r of reduceResult.results) {
        if (!r.custom_id.endsWith("--reduce")) continue;
        const text = getText(r);
        if (text) batchSummaries.set(r.custom_id.split("--")[0], text);
      }
    }

    grandTotalIn += batchIn;
    grandTotalOut += batchOut;

    // Save to JSON first
    const resultsFile = path.join(RESULTS_DIR, `batch-${batchNum}-${Date.now()}.json`);
    writeFileSync(resultsFile, JSON.stringify(
      Array.from(batchSummaries.entries()).map(([id, summary]) => ({ paperId: id, summaryLength: summary.length, summary })),
      null, 2,
    ));
    console.log(`  Saved ${batchSummaries.size} summaries to ${path.basename(resultsFile)}`);

    // Import to DB
    let ok = 0;
    for (const [paperId, summary] of batchSummaries) {
      try {
        await prisma.paper.update({ where: { id: paperId }, data: { summary } });
        ok++;
      } catch { /* skip */ }
    }
    console.log(`  Imported ${ok}/${batchSummaries.size} to DB`);

    const cost = (grandTotalIn / 1e6) * 1.5 + (grandTotalOut / 1e6) * 7.5;
    console.log(`  Running: ${grandTotalIn.toLocaleString()} in, ${grandTotalOut.toLocaleString()} out, $${cost.toFixed(2)}`);

    if (offset + BATCH_SIZE < papers.length) {
      console.log("  Waiting 10s...");
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  const finalCost = (grandTotalIn / 1e6) * 1.5 + (grandTotalOut / 1e6) * 7.5;
  console.log(`\n=== DONE ===`);
  console.log(`Total: ${grandTotalIn.toLocaleString()} input, ${grandTotalOut.toLocaleString()} output`);
  console.log(`Cost: $${finalCost.toFixed(2)}`);
}

main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
