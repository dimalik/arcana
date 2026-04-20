import fs from "fs";
import path from "path";

import { prisma } from "@/lib/prisma";
import {
  authorBucketKey,
  canonicalizeAuthorName,
  parsePaperAuthorsJson,
  syncPaperAuthorIndex,
} from "@/lib/papers/authors";

function valueFor(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hasParseAnomaly(authors: string | null): boolean {
  if (!authors) return false;
  try {
    const parsed = JSON.parse(authors);
    return !Array.isArray(parsed);
  } catch {
    return true;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const userId = valueFor(argv, "--user-id");
  const afterCursor = valueFor(argv, "--after-cursor");
  const outPath = valueFor(argv, "--out");
  const limit = Number(valueFor(argv, "--limit") ?? "250");

  const authorCountBefore = await prisma.author.count();
  const paperAuthorCountBefore = await prisma.paperAuthor.count();

  const papers = await prisma.paper.findMany({
    where: {
      ...(userId ? { userId } : { userId: { not: null } }),
      ...(afterCursor ? { id: { gt: afterCursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: limit,
    select: {
      id: true,
      title: true,
      authors: true,
    },
  });

  const summary = {
    scanned: papers.length,
    papersWithAuthors: 0,
    papersSynced: 0,
    parseAnomalyCount: 0,
    authorCountBefore,
    authorCountAfter: authorCountBefore,
    paperAuthorCountBefore,
    paperAuthorCountAfter: paperAuthorCountBefore,
    lastCursor: papers.at(-1)?.id ?? null,
    anomalies: [] as Array<{ paperId: string; title: string; authors: string | null }>,
    results: [] as Array<{
      paperId: string;
      title: string;
      authorCount: number;
      buckets: Array<{
        rawName: string;
        normalizedName: string;
      }>;
    }>,
  };

  for (const paper of papers) {
    const parsedAuthors = parsePaperAuthorsJson(paper.authors);
    if (parsedAuthors.length > 0) {
      summary.papersWithAuthors += 1;
    }

    if (hasParseAnomaly(paper.authors)) {
      summary.parseAnomalyCount += 1;
      summary.anomalies.push({
        paperId: paper.id,
        title: paper.title,
        authors: paper.authors,
      });
    }

    const synced = await syncPaperAuthorIndex(paper.id, paper.authors);
    if (parsedAuthors.length > 0 || synced.length > 0) {
      summary.papersSynced += 1;
    }

    summary.results.push({
      paperId: paper.id,
      title: paper.title,
      authorCount: synced.length,
      buckets: parsedAuthors.map((rawName) => ({
        rawName: canonicalizeAuthorName(rawName),
        normalizedName: authorBucketKey(rawName),
      })),
    });
  }

  summary.authorCountAfter = await prisma.author.count();
  summary.paperAuthorCountAfter = await prisma.paperAuthor.count();

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("[backfill-paper-authors] Failed:", error);
  process.exit(1);
});
