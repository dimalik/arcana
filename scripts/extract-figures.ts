#!/usr/bin/env -S node --import tsx
/**
 * Extract figures from one or more papers.
 *
 * Usage:
 *   node --import tsx scripts/extract-figures.ts <paper-id>           # single paper
 *   node --import tsx scripts/extract-figures.ts <id1> <id2> ...      # multiple papers
 *   node --import tsx scripts/extract-figures.ts --arxiv              # all papers with arXivId
 *   node --import tsx scripts/extract-figures.ts --all                # all papers with a PDF
 *   node --import tsx scripts/extract-figures.ts --limit 10           # first 10 papers
 *   node --import tsx scripts/extract-figures.ts --dry-run <paper-id> # show what would run, don't extract
 *   npm run figures:extract -- <paper-id>
 */

import { prisma } from "../src/lib/prisma";
import { extractAllFigures } from "../src/lib/figures/extract-all-figures";

interface Paper {
  id: string;
  title: string | null;
  arxivId: string | null;
  doi: string | null;
  filePath: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filtered = args.filter(a => a !== "--dry-run");

  let papers: Paper[] = [];

  if (filtered.includes("--arxiv")) {
    papers = await prisma.paper.findMany({
      where: { arxivId: { not: null }, filePath: { not: null } },
      select: { id: true, title: true, arxivId: true, doi: true, filePath: true },
    });
  } else if (filtered.includes("--all")) {
    const limitIdx = filtered.indexOf("--limit");
    const limit = limitIdx >= 0 ? parseInt(filtered[limitIdx + 1]) : undefined;
    papers = await prisma.paper.findMany({
      where: { filePath: { not: null } },
      select: { id: true, title: true, arxivId: true, doi: true, filePath: true },
      ...(limit ? { take: limit } : {}),
    });
  } else if (filtered.includes("--limit")) {
    const limitIdx = filtered.indexOf("--limit");
    const limit = parseInt(filtered[limitIdx + 1]) || 10;
    papers = await prisma.paper.findMany({
      where: { filePath: { not: null } },
      select: { id: true, title: true, arxivId: true, doi: true, filePath: true },
      take: limit,
    });
  } else {
    // Treat remaining args as paper IDs
    const ids = filtered.filter(a => !a.startsWith("--"));
    if (ids.length === 0) {
      console.log("Usage: node --import tsx scripts/extract-figures.ts <paper-id> [<paper-id> ...]");
      console.log("       node --import tsx scripts/extract-figures.ts --arxiv");
      console.log("       node --import tsx scripts/extract-figures.ts --all [--limit N]");
      console.log("       node --import tsx scripts/extract-figures.ts --dry-run <paper-id>");
      console.log("       npm run figures:extract -- <paper-id>");
      process.exit(1);
    }
    papers = await prisma.paper.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, arxivId: true, doi: true, filePath: true },
    });
    const found = new Set(papers.map(p => p.id));
    for (const id of ids) {
      if (!found.has(id)) console.warn(`Paper not found: ${id}`);
    }
  }

  console.log(`${dryRun ? "[DRY RUN] " : ""}Processing ${papers.length} papers\n`);

  let totalFigures = 0;
  let totalImages = 0;
  let totalGaps = 0;
  let totalErrors = 0;

  for (let i = 0; i < papers.length; i++) {
    const p = papers[i];
    const identity = [
      p.arxivId ? `arxiv:${p.arxivId}` : null,
      p.doi ? `doi:${p.doi}` : null,
      !p.arxivId && !p.doi ? "pdf-only" : null,
    ].filter(Boolean).join(" ");

    console.log(`[${i + 1}/${papers.length}] ${p.title?.slice(0, 60)} (${identity})`);

    if (dryRun) {
      console.log(`  Would run: PMC=${!!p.doi} arXiv=${!!p.arxivId} publisher=${!!p.doi} PDF=${!!p.filePath}\n`);
      continue;
    }

    try {
      const report = await extractAllFigures(p.id, { maxPages: 20 });
      const sources = report.sources
        .filter(s => s.attempted && s.figuresFound > 0)
        .map(s => `${s.method}=${s.figuresFound}`)
        .join(", ") || "none";

      console.log(`  ${report.totalFigures} figures (${report.figuresWithImages} images, ${report.gapPlaceholders} gaps) from ${sources}`);
      if (report.persistErrors > 0) {
        console.log(`  ⚠ ${report.persistErrors} persist errors`);
      }

      totalFigures += report.totalFigures;
      totalImages += report.figuresWithImages;
      totalGaps += report.gapPlaceholders;
      totalErrors += report.persistErrors;
    } catch (err) {
      console.log(`  ERROR: ${(err as Error).message}`);
      totalErrors++;
    }
    console.log("");
  }

  if (!dryRun && papers.length > 1) {
    console.log("─".repeat(60));
    console.log(`Total: ${totalFigures} figures, ${totalImages} with images, ${totalGaps} gaps, ${totalErrors} errors`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
