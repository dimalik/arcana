#!/usr/bin/env -S node --import tsx

import dataset from "./figure-review-dataset.json";

import { prisma } from "../src/lib/prisma";
import {
  classifyFigureRolloutStatus,
} from "../src/lib/figures/figure-audit";
import {
  evaluateReviewPaper,
  type ActualPrimaryFigure,
  type DatasetPaper,
  type LoadedPaperState,
  type PaperScore,
} from "./lib/figure-review-scoring";

async function resolvePaper(entry: DatasetPaper): Promise<{ id: string } | { error: string }> {
  if (entry.paperId) {
    const row = await prisma.paper.findUnique({
      where: { id: entry.paperId },
      select: { id: true },
    });
    return row ? { id: row.id } : { error: `paperId ${entry.paperId} not found` };
  }

  let where: Record<string, unknown> | null = null;
  let description = "";
  if (entry.arxivId) {
    where = { arxivId: entry.arxivId };
    description = `arxivId=${entry.arxivId}`;
  } else if (entry.doi) {
    where = { doi: entry.doi };
    description = `doi=${entry.doi}`;
  } else if (entry.fileBasename) {
    where = { filePath: { contains: entry.fileBasename } };
    description = `file=${entry.fileBasename}`;
  }

  if (!where) {
    return { error: "no stable identifier configured" };
  }

  const matches = await prisma.paper.findMany({
    where: where as never,
    select: { id: true },
    take: 3,
  });
  if (matches.length === 0) return { error: `${description} not found` };
  if (matches.length > 1) return { error: `${description} matched ${matches.length} papers` };
  return { id: matches[0].id };
}

async function loadPaperState(paperId: string): Promise<LoadedPaperState> {
  const [
    paper,
    extractionRunCount,
    bootstrapRunCount,
    rawPrimaryFigures,
  ] = await Promise.all([
    prisma.paper.findUnique({
      where: { id: paperId },
      select: {
        id: true,
        title: true,
        arxivId: true,
        publicationState: {
          select: {
            activeIdentityResolution: {
              select: {
                provenanceKind: true,
              },
            },
          },
        },
      },
    }),
    prisma.extractionRun.count({ where: { paperId } }),
    prisma.legacyPublicationBootstrapRun.count({ where: { paperId } }),
    prisma.paperFigure.findMany({
      where: { paperId, isPrimaryExtraction: true },
      orderBy: [{ figureIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        figureLabel: true,
        type: true,
        sourceMethod: true,
        imageSourceMethod: true,
        imagePath: true,
        gapReason: true,
      },
    }),
  ]);
  const primaryFigures = rawPrimaryFigures as ActualPrimaryFigure[];

  if (!paper) {
    throw new Error(`paper ${paperId} not found`);
  }

  const rolloutStatus = classifyFigureRolloutStatus({
    activeProvenanceKind: paper.publicationState?.activeIdentityResolution?.provenanceKind ?? null,
    extractionRunCount,
    bootstrapRunCount,
    primaryFigureCount: primaryFigures.length,
  });

  return {
    paperId: paper.id,
    title: paper.title,
    arxivId: paper.arxivId,
    rolloutStatus,
    primaryFigures,
    figuresWithImages: primaryFigures.filter((row) => !!row.imagePath).length,
    gapFigures: primaryFigures.filter((row) => !row.imagePath).length,
  };
}

function printHumanReport(scores: PaperScore[]): number {
  let totalChecks = 0;
  let passedChecks = 0;
  let papersWithTargets = 0;
  let labelPresenceChecks = 0;
  let labelPresencePassed = 0;
  let imageChecks = 0;
  let imageChecksPassed = 0;

  console.log(`Figure Review Dataset — ${scores.length} papers\n`);

  for (const score of scores) {
    const { datasetPaper, current, checks } = score;
    const checked = checks.length;
    const passed = checks.filter((check) => check.passed).length;
    const failedChecks = checks.filter((check) => !check.passed);
    const bySourceText = Object.entries(score.currentBySourceMethod)
      .map(([key, value]) => `${key}:${value}`)
      .join(", ");

    if (checked > 0) papersWithTargets += 1;
    totalChecks += checked;
    passedChecks += passed;

    for (const check of checks) {
      if (check.kind === "label_presence") {
        labelPresenceChecks += 1;
        if (check.passed) labelPresencePassed += 1;
      }
      if (check.kind === "label_detail" && check.message.includes("expected image=")) {
        imageChecks += 1;
        if (check.passed) imageChecksPassed += 1;
      }
    }

    const status = failedChecks.length === 0 ? "PASS" : "FAIL";
    const currentSummary = current
      ? `rollout=${current.rolloutStatus} primary=${current.primaryFigures.length} images=${current.figuresWithImages} gaps=${current.gapFigures}`
      : "unresolved";

    console.log(`${status}  ${datasetPaper.title} [${datasetPaper.bucket}] [${datasetPaper.targetsStatus}]`);
    console.log(`      Focus: ${datasetPaper.reviewFocus}`);
    console.log(`      Current: ${currentSummary}`);
    if (current) {
      console.log(`      Sources: ${bySourceText || "none"}`);
    }
    console.log(`      Checks: ${passed}/${checked}`);
    for (const failure of failedChecks) {
      console.log(`      - ${failure.message}`);
    }
    console.log("");
  }

  const percent = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 100;
  const labelPercent = labelPresenceChecks > 0 ? Math.round((labelPresencePassed / labelPresenceChecks) * 100) : 100;
  const imagePercent = imageChecks > 0 ? Math.round((imageChecksPassed / imageChecks) * 100) : 100;

  console.log("─".repeat(72));
  console.log(`Confirmed-target papers: ${papersWithTargets}/${scores.length}`);
  console.log(`Checks passed: ${passedChecks}/${totalChecks} (${percent}%)`);
  console.log(`Label presence: ${labelPresencePassed}/${labelPresenceChecks} (${labelPercent}%)`);
  console.log(`Image expectations: ${imageChecksPassed}/${imageChecks} (${imagePercent}%)`);

  return totalChecks === 0 ? 0 : (passedChecks === totalChecks ? 0 : 1);
}

async function main() {
  const args = process.argv.slice(2);
  const paperFilter = args.includes("--paper") ? args[args.indexOf("--paper") + 1] : null;
  const jsonMode = args.includes("--json");

  let papers = dataset.papers as unknown as DatasetPaper[];
  if (paperFilter) {
    papers = papers.filter((paper) =>
      paper.paperId === paperFilter
      || paper.arxivId === paperFilter
      || paper.title.toLowerCase().includes(paperFilter.toLowerCase()),
    );
    if (papers.length === 0) {
      console.error(`No review dataset paper matches: ${paperFilter}`);
      process.exit(1);
    }
  }

  const scores: PaperScore[] = [];

  for (const paper of papers) {
    const resolved = await resolvePaper(paper);
    if ("error" in resolved) {
      scores.push({
        datasetPaper: paper,
        resolvedPaperId: null,
        current: null,
        checks: [{
          kind: "rollout",
          passed: false,
          message: resolved.error,
        }],
        currentBySourceMethod: {},
      });
      continue;
    }

    const current = await loadPaperState(resolved.id);
    scores.push(evaluateReviewPaper(paper, current));
  }

  if (jsonMode) {
    console.log(JSON.stringify(scores, null, 2));
    process.exit(0);
  }

  const exitCode = printHumanReport(scores);
  process.exit(exitCode);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
