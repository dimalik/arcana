import fs from "fs";
import path from "path";

import { prisma } from "@/lib/prisma";
import { upsertSharedPaperRepresentation } from "@/lib/papers/retrieval";

function valueFor(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const userId = valueFor(argv, "--user-id");
  const afterCursor = valueFor(argv, "--after-cursor");
  const outPath = valueFor(argv, "--out");
  const limit = Number(valueFor(argv, "--limit") ?? "200");

  const papers = await prisma.paper.findMany({
    where: {
      duplicateState: "ACTIVE",
      ...(userId ? { userId } : { userId: { not: null } }),
      ...(afterCursor ? { id: { gt: afterCursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: limit,
    select: {
      id: true,
      userId: true,
      title: true,
    },
  });

  const summary = {
    scanned: papers.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    lastCursor: papers.at(-1)?.id ?? null,
    results: [] as Array<{
      paperId: string;
      title: string;
      status: "created" | "updated" | "unchanged";
      sourceFingerprint: string;
    }>,
  };

  for (const paper of papers) {
    const result = await upsertSharedPaperRepresentation(paper.id);
    summary[result.status] += 1;
    summary.results.push({
      paperId: paper.id,
      title: paper.title,
      status: result.status,
      sourceFingerprint: result.representation.sourceFingerprint,
    });
  }

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("[backfill-paper-representations] Failed:", error);
  process.exit(1);
});
