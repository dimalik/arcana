/**
 * Submit batch jobs for papers that completed processing but are missing summaries.
 * Uses the batch API directly (50% discount) with truncated text.
 *
 * Run: npx tsx scripts/batch-missing-summaries.ts
 */
import path from "path";
import { PrismaClient } from "../src/generated/prisma/client";

const dbPath = path.join(process.cwd(), "prisma", "dev.db");
const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });

async function getConfig() {
  const settings = await prisma.setting.findMany();
  const s = Object.fromEntries(settings.map(r => [r.key, r.value]));
  return {
    baseUrl: s.proxy_anthropic_base_url,
    modelId: s.proxy_model_id || "claude-sonnet-4-6",
    headerName: s.proxy_header_name,
    headerValue: s.proxy_header_value,
  };
}

function truncate(text: string, maxChars: number = 100000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[...truncated...]";
}

async function main() {
  const config = await getConfig();
  console.log(`Model: ${config.modelId}`);
  console.log(`API: ${config.baseUrl}/messages/batches`);

  const papers = await prisma.paper.findMany({
    where: {
      processingStatus: "COMPLETED",
      OR: [{ summary: null }, { summary: "" }],
      fullText: { not: null },
    },
    select: { id: true, title: true, fullText: true },
  });

  console.log(`Papers missing summaries: ${papers.length}\n`);
  if (papers.length === 0) { console.log("Nothing to do."); return; }

  // Build summary requests
  const BATCH_SIZE = 150;
  let totalSubmitted = 0;
  let totalRequests = 0;

  for (let offset = 0; offset < papers.length; offset += BATCH_SIZE) {
    const chunk = papers.slice(offset, offset + BATCH_SIZE);
    const requests = chunk.map(paper => ({
      custom_id: `${paper.id}--summarize`,
      params: {
        model: config.modelId,
        max_tokens: 4096,
        system: "You are a research paper analyst. Provide a comprehensive summary of the paper including: key contributions, methodology, main findings, and limitations. Format with markdown headers.",
        messages: [{ role: "user" as const, content: `Summarize this research paper:\n\n${truncate(paper.fullText!)}` }],
      },
    }));

    console.log(`Batch ${Math.floor(offset / BATCH_SIZE) + 1}: ${chunk.length} papers, ${requests.length} requests...`);

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

    if (!res.ok) {
      const err = await res.text();
      console.error(`  FAILED (${res.status}): ${err.slice(0, 200)}`);
      break;
    }

    const data = await res.json() as { id: string };
    console.log(`  Submitted: ${data.id}`);

    // Save batch record
    const { v4: uuidv4 } = await import("uuid");
    await prisma.processingBatch.create({
      data: {
        groupId: uuidv4(),
        anthropicBatchId: data.id,
        phase: 1,
        status: "SUBMITTED",
        modelId: config.modelId,
        paperIds: JSON.stringify(chunk.map(p => p.id)),
        stepTypes: JSON.stringify(["summarize"]),
        requestCount: requests.length,
      },
    });

    totalSubmitted++;
    totalRequests += requests.length;

    if (offset + BATCH_SIZE < papers.length) {
      console.log("  Waiting 10s...");
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  console.log(`\nDone: ${totalSubmitted} batches, ${totalRequests} requests for ${papers.length} papers`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); prisma.$disconnect(); process.exit(1); });
