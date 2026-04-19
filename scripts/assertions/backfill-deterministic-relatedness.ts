import fs from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/prisma";
import {
  recomputeDeterministicRelatednessForPapers,
  type DeterministicSignalName,
} from "@/lib/assertions/deterministic-relatedness";

interface CliOptions {
  apply: boolean;
  out: string | null;
  limit: number | null;
  startAfter: string | null;
  paperIds: string[];
}

function parseArgs(argv: string[]): CliOptions {
  let apply = false;
  let out: string | null = null;
  let limit: number | null = null;
  let startAfter: string | null = null;
  const paperIds: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }

    if (arg === "--out") {
      out = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      limit = Number.isFinite(value) ? value : null;
      index += 1;
      continue;
    }

    if (arg === "--start-after") {
      startAfter = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--paper-id") {
      const paperId = argv[index + 1] ?? null;
      if (paperId) paperIds.push(paperId);
      index += 1;
    }
  }

  return { apply, out, limit, startAfter, paperIds };
}

async function collectSnapshotCounts() {
  const [deterministicAssertions, llmSemanticAssertions, deterministicEvidence, projectedRelated] =
    await Promise.all([
      prisma.relationAssertion.count({
        where: { provenance: "deterministic_relatedness" },
      }),
      prisma.relationAssertion.count({
        where: { provenance: "llm_semantic" },
      }),
      prisma.relationEvidence.count({
        where: {
          type: { startsWith: "deterministic_signal:" },
        },
      }),
      prisma.paperRelation.count({
        where: {
          relationType: { not: "cites" },
        },
      }),
    ]);

  return {
    deterministicAssertions,
    llmSemanticAssertions,
    deterministicEvidence,
    projectedRelated,
  };
}

async function loadEligiblePaperIds(options: CliOptions): Promise<string[]> {
  if (options.paperIds.length > 0) {
    return options.paperIds;
  }

  const papers = await prisma.paper.findMany({
    where: {
      userId: { not: null },
      entityId: { not: null },
      ...(options.startAfter ? { id: { gt: options.startAfter } } : {}),
    },
    orderBy: { id: "asc" },
    ...(options.limit ? { take: options.limit } : {}),
    select: { id: true },
  });

  return papers.map((paper) => paper.id);
}

function emptyHistogram(): Record<
  DeterministicSignalName,
  { count: number; totalContribution: number }
> {
  return {
    direct_citation: { count: 0, totalContribution: 0 },
    reverse_citation: { count: 0, totalContribution: 0 },
    bibliographic_coupling: { count: 0, totalContribution: 0 },
    co_citation: { count: 0, totalContribution: 0 },
    title_similarity: { count: 0, totalContribution: 0 },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paperIds = await loadEligiblePaperIds(options);
  const before = await collectSnapshotCounts();

  const recomputeSummary = options.apply
    ? await recomputeDeterministicRelatednessForPapers(paperIds)
    : {
        processed: paperIds.length,
        updated: 0,
        skippedNoUser: 0,
        skippedNoEntity: 0,
        emittedCount: 0,
        signalHistogram: emptyHistogram(),
      };

  const after = options.apply ? await collectSnapshotCounts() : before;

  const payload = {
    generatedAt: new Date().toISOString(),
    apply: options.apply,
    paperIds,
    selection: {
      count: paperIds.length,
      startAfter: options.startAfter,
      limit: options.limit,
      explicitPaperIds: options.paperIds,
    },
    before,
    after,
    recomputeSummary,
  };

  if (options.out) {
    const outputPath = path.resolve(options.out);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`[deterministic-relatedness] Wrote artifact to ${outputPath}`);
  }

  console.log(JSON.stringify(payload, null, 2));
}

main()
  .catch((error) => {
    console.error("[deterministic-relatedness] Failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
