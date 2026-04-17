#!/usr/bin/env -S node --import tsx
/**
 * Figure extraction acceptance runner.
 *
 * Smoke-level harness that checks label-level recall against a fixture
 * of papers with known expected figures and tables.
 *
 * Usage:
 *   node --import tsx scripts/figure-acceptance.ts                         # report from existing DB (default)
 *   node --import tsx scripts/figure-acceptance.ts --extract               # extract then report
 *   node --import tsx scripts/figure-acceptance.ts --extract --paper 2506.08712
 *   npm run figures:acceptance
 */

import { prisma } from "../src/lib/prisma";
import { normalizeLabel } from "../src/lib/figures/label-utils";
import fixture from "./figure-acceptance.json";

// ── Types ────────────────────────────────────────────────────────────

interface FixturePaper {
  arxivId?: string;
  doi?: string;
  fileBasename?: string;
  title: string;
  category: string;
  notes?: string;
  expectedFigures: string[];
  expectedTables: string[];
  expectedSources?: Record<string, string>;
  labelExpectations?: Record<string, { expectsImage?: boolean; expectedGapReason?: string; expectedImageSourceMethod?: string }>;
}

interface PaperResult {
  title: string;
  category: string;
  paperId: string | null;
  resolved: boolean;
  figureRecall: { expected: number; found: number; missing: string[] };
  tableRecall: { expected: number; found: number; missing: string[] };
  unexpected: string[];
  sourceMismatches: string[];
  labelViolations: string[];
  highConfidence: number;
  lowConfidence: number;
  gaps: number;
  structured: number;
}

// ── Fixture loading with normalization ───────────────────────────────

function normalizeFixtureMap<T>(map: Record<string, T>): Map<string, T> {
  const result = new Map<string, T>();
  for (const [key, value] of Object.entries(map)) {
    const norm = normalizeLabel(key);
    if (norm) result.set(norm, value);
  }
  return result;
}

// ── Paper resolution ─────────────────────────────────────────────────

async function resolvePaper(fp: FixturePaper): Promise<{ id: string } | { error: string }> {
  let where: Record<string, unknown>;
  let desc: string;

  if (fp.arxivId) {
    where = { arxivId: fp.arxivId };
    desc = `arxivId=${fp.arxivId}`;
  } else if (fp.doi) {
    where = { doi: fp.doi };
    desc = `doi=${fp.doi}`;
  } else if (fp.fileBasename) {
    where = { filePath: { contains: fp.fileBasename } };
    desc = `file=${fp.fileBasename}`;
  } else {
    return { error: "No stable identifier (arxivId, doi, or fileBasename)" };
  }

  const matches = await prisma.paper.findMany({ where: where as never, select: { id: true }, take: 3 });

  if (matches.length === 0) return { error: `Paper not found: ${desc}` };
  if (matches.length > 1) return { error: `Ambiguous identifier: ${desc} matched ${matches.length} papers` };
  return { id: matches[0].id };
}

// ── Check gapReason column existence ─────────────────────────────────

async function hasGapReasonColumn(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe(`SELECT gapReason FROM PaperFigure LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

// ── Per-paper evaluation ─────────────────────────────────────────────

async function evaluatePaper(fp: FixturePaper, paperId: string, gapReasonExists: boolean): Promise<PaperResult> {
  const figures = await prisma.paperFigure.findMany({
    where: { paperId, isPrimaryExtraction: true },
    orderBy: [{ pdfPage: "asc" }, { figureIndex: "asc" }],
  });

  // Normalize expected labels
  const expectedFigNorm = new Set(fp.expectedFigures.map(l => normalizeLabel(l)).filter(Boolean) as string[]);
  const expectedTabNorm = new Set(fp.expectedTables.map(l => normalizeLabel(l)).filter(Boolean) as string[]);
  const allExpected = new Set(Array.from(expectedFigNorm).concat(Array.from(expectedTabNorm)));

  // Normalize actual labels
  const actualLabels = new Map<string, typeof figures[0]>();
  for (const f of figures) {
    const norm = normalizeLabel(f.figureLabel);
    if (norm) actualLabels.set(norm, f);
  }

  // Figure recall
  const missingFigs: string[] = [];
  for (const norm of Array.from(expectedFigNorm)) {
    if (!actualLabels.has(norm)) missingFigs.push(norm);
  }

  // Table recall
  const missingTabs: string[] = [];
  for (const norm of Array.from(expectedTabNorm)) {
    if (!actualLabels.has(norm)) missingTabs.push(norm);
  }

  // Unexpected labels
  const unexpected: string[] = [];
  for (const [norm] of Array.from(actualLabels.entries())) {
    if (!allExpected.has(norm) && !norm.startsWith("uncaptioned-")) {
      unexpected.push(norm);
    }
  }

  // Source expectations
  const sourceMismatches: string[] = [];
  if (fp.expectedSources) {
    const normSources = normalizeFixtureMap(fp.expectedSources);
    for (const [norm, expectedSource] of Array.from(normSources.entries())) {
      const actual = actualLabels.get(norm);
      if (actual && actual.sourceMethod !== expectedSource) {
        sourceMismatches.push(`${norm}: expected ${expectedSource}, got ${actual.sourceMethod}`);
      }
    }
  }

  // Label expectations (image + gapReason)
  const labelViolations: string[] = [];
  if (fp.labelExpectations) {
    const normExpectations = normalizeFixtureMap(fp.labelExpectations);
    for (const [norm, exp] of Array.from(normExpectations.entries())) {
      const actual = actualLabels.get(norm);
      if (!actual) continue; // Missing labels already caught in recall

      if (exp.expectsImage !== undefined) {
        const hasImage = !!actual.imagePath;
        if (exp.expectsImage && !hasImage) {
          labelViolations.push(`${norm}: expected image but has none`);
        } else if (!exp.expectsImage && hasImage) {
          labelViolations.push(`${norm}: expected no image but has ${actual.imagePath?.split("/").pop()}`);
        }
      }

      if (exp.expectedImageSourceMethod) {
        if (actual.imageSourceMethod !== exp.expectedImageSourceMethod) {
          labelViolations.push(`${norm}: expected imageSourceMethod=${exp.expectedImageSourceMethod}, got ${actual.imageSourceMethod || "null"}`);
        }
      }

      if (exp.expectedGapReason && gapReasonExists) {
        if (actual.gapReason !== exp.expectedGapReason) {
          labelViolations.push(`${norm}: expected gapReason=${exp.expectedGapReason}, got ${actual.gapReason || "null"}`);
        }
      }
    }
  }

  return {
    title: fp.title,
    category: fp.category,
    paperId,
    resolved: true,
    figureRecall: { expected: expectedFigNorm.size, found: expectedFigNorm.size - missingFigs.length, missing: missingFigs },
    tableRecall: { expected: expectedTabNorm.size, found: expectedTabNorm.size - missingTabs.length, missing: missingTabs },
    unexpected,
    sourceMismatches,
    labelViolations,
    highConfidence: figures.filter(f => f.confidence === "high").length,
    lowConfidence: figures.filter(f => f.confidence === "low").length,
    gaps: figures.filter(f => !f.imagePath).length,
    structured: figures.filter(f => f.description && f.description.length > 100).length,
  };
}

// ── Report formatting ────────────────────────────────────────────────

function printReport(results: PaperResult[]) {
  let totalExpFig = 0, totalFoundFig = 0;
  let totalExpTab = 0, totalFoundTab = 0;
  let totalHigh = 0, totalLow = 0, totalGaps = 0, totalStructured = 0;
  let totalViolations = 0;
  let allPassed = true;

  for (const r of results) {
    const figPct = r.figureRecall.expected > 0
      ? Math.round(100 * r.figureRecall.found / r.figureRecall.expected) : 100;
    const tabPct = r.tableRecall.expected > 0
      ? Math.round(100 * r.tableRecall.found / r.tableRecall.expected) : 100;

    const issues: string[] = [];
    if (r.figureRecall.missing.length) issues.push(`missing figs: ${r.figureRecall.missing.join(", ")}`);
    if (r.tableRecall.missing.length) issues.push(`missing tabs: ${r.tableRecall.missing.join(", ")}`);
    if (r.unexpected.length) issues.push(`unexpected: ${r.unexpected.join(", ")}`);
    if (r.sourceMismatches.length) issues.push(...r.sourceMismatches);
    if (r.labelViolations.length) issues.push(...r.labelViolations);

    const passed = issues.length === 0;
    if (!passed) allPassed = false;

    console.log(`${passed ? "PASS" : "FAIL"}  ${r.title} [${r.category}]`);
    console.log(`      Figures: ${r.figureRecall.found}/${r.figureRecall.expected} (${figPct}%)  Tables: ${r.tableRecall.found}/${r.tableRecall.expected} (${tabPct}%)  High: ${r.highConfidence}  Low: ${r.lowConfidence}  Gaps: ${r.gaps}  Structured: ${r.structured}`);
    for (const issue of issues) {
      console.log(`      - ${issue}`);
    }
    console.log("");

    totalExpFig += r.figureRecall.expected;
    totalFoundFig += r.figureRecall.found;
    totalExpTab += r.tableRecall.expected;
    totalFoundTab += r.tableRecall.found;
    totalHigh += r.highConfidence;
    totalLow += r.lowConfidence;
    totalGaps += r.gaps;
    totalStructured += r.structured;
    totalViolations += issues.length;
  }

  console.log("─".repeat(70));
  const figPct = totalExpFig > 0 ? Math.round(100 * totalFoundFig / totalExpFig) : 100;
  const tabPct = totalExpTab > 0 ? Math.round(100 * totalFoundTab / totalExpTab) : 100;
  console.log(`Aggregate: Figure recall ${totalFoundFig}/${totalExpFig} (${figPct}%)  Table recall ${totalFoundTab}/${totalExpTab} (${tabPct}%)`);
  console.log(`           High confidence: ${totalHigh}  Low confidence: ${totalLow}  Gaps: ${totalGaps}  Structured: ${totalStructured}`);
  console.log(`           Issues: ${totalViolations}`);
  console.log(`           ${allPassed ? "ALL PASSED" : "SOME FAILED"}`);

  return allPassed;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const doExtract = args.includes("--extract");
  const paperFilter = args.includes("--paper") ? args[args.indexOf("--paper") + 1] : null;

  let papers = fixture.papers as unknown as FixturePaper[];
  if (paperFilter) {
    papers = papers.filter(p =>
      p.arxivId === paperFilter || p.doi === paperFilter || p.fileBasename === paperFilter,
    );
    if (papers.length === 0) {
      console.error(`No fixture paper matches: ${paperFilter}`);
      process.exit(1);
    }
  }

  console.log(`Figure Acceptance Runner — ${papers.length} papers, mode: ${doExtract ? "extract+report" : "report-only"}\n`);

  const gapReasonExists = await hasGapReasonColumn();

  const results: PaperResult[] = [];

  for (const fp of papers) {
    const resolved = await resolvePaper(fp);
    if ("error" in resolved) {
      console.error(`FAIL  ${fp.title}: ${resolved.error}`);
      results.push({
        title: fp.title,
        category: fp.category,
        paperId: null,
        resolved: false,
        figureRecall: { expected: fp.expectedFigures.length, found: 0, missing: [] },
        tableRecall: { expected: fp.expectedTables.length, found: 0, missing: [] },
        unexpected: [],
        sourceMismatches: [],
        labelViolations: [],
        highConfidence: 0,
        lowConfidence: 0,
        gaps: 0,
        structured: 0,
      });
      continue;
    }

    if (doExtract) {
      const { extractAllFigures } = await import("../src/lib/figures/extract-all-figures");
      await prisma.paperFigure.deleteMany({ where: { paperId: resolved.id } });
      await extractAllFigures(resolved.id, { maxPages: 20 });
    }

    const result = await evaluatePaper(fp, resolved.id, gapReasonExists);
    results.push(result);
  }

  console.log("");
  const allPassed = printReport(results);
  process.exit(allPassed ? 0 : 1);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
