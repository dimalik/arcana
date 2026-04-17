#!/usr/bin/env -S node --import tsx
/**
 * Figure operator and override CLI.
 *
 * Usage examples:
 *   npm run figures:ops -- refresh-capability <paper-id>
 *   npm run figures:ops -- extract-evidence <paper-id> [--max-pages 20] [--skip-pdf]
 *   npm run figures:ops -- resolve-identities <paper-id> [--extraction-run <id> | --bootstrap-run <id>]
 *   npm run figures:ops -- project-canonical <paper-id> --identity-resolution <id>
 *   npm run figures:ops -- publish-projection <paper-id> --identity-resolution <id> --projection-run <id>
 *   npm run figures:ops -- render-previews <paper-id>
 *   npm run figures:ops -- publish-previews <paper-id> --preview-selection-run <id> [--projection-run <id>]
 *   npm run figures:ops -- rebuild-from-evidence <paper-id> [--extraction-run <id> | --bootstrap-run <id>]
 *   npm run figures:ops -- bootstrap-legacy-publication <paper-id>
 *   npm run figures:ops -- override-add-force-gap <paper-id> --identity-key <key> [--gap-reason manual_override]
 *   npm run figures:ops -- override-add-suppress-preview <paper-id> --identity-key <key>
 *   npm run figures:ops -- override-list <paper-id>
 *   npm run figures:ops -- override-disable --override-id <id>
 *   npm run figures:ops -- retention-audit <paper-id> [--keep-projections 2 --keep-extractions 2 --keep-bootstraps 1]
 *   npm run figures:ops -- retention-apply <paper-id> [--delete-files]
 *   npm run figures:ops -- paper-audit <paper-id>
 *   npm run figures:ops -- rollout-summary [--structured|--arxiv|--doi|--all] [--paper <paper-id> ...] [--limit N] [--include-papers]
 */

import { prisma } from "../src/lib/prisma";
import {
  createFigureCapabilitySnapshotForPaper,
  extractFigureEvidenceOnly,
  resolveFigureIdentities,
  createFigureProjection,
  publishFigureProjection,
  renderFigurePreviews,
  publishFigurePreviewSelection,
  rebuildFiguresFromEvidence,
  bootstrapLegacyFigurePublication,
} from "../src/lib/figures/figure-operators";
import {
  analyzeFigureRetention,
  applyFigureRetentionPolicy,
} from "../src/lib/figures/figure-retention";
import {
  inspectFigurePaperState,
  summarizeFigureRollout,
  type FigureRolloutSelection,
} from "../src/lib/figures/figure-audit";
import {
  createFigureOverride,
  disableFigureOverride,
  FIGURE_OVERRIDE_SELECTOR_IDENTITY_KEY,
  FIGURE_OVERRIDE_STAGE_PREVIEW,
  FIGURE_OVERRIDE_STAGE_PROJECTION,
  FIGURE_OVERRIDE_TYPE_FORCE_GAP_REASON,
  FIGURE_OVERRIDE_TYPE_SUPPRESS_PREVIEW,
  listFigureOverrides,
} from "../src/lib/figures/figure-overrides";

function getOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function requireOption(args: string[], name: string): string {
  const value = getOption(args, name);
  if (!value) {
    throw new Error(`missing required option ${name}`);
  }
  return value;
}

function parseEvidenceRootArgs(args: string[]) {
  const extractionRunId = getOption(args, "--extraction-run");
  const bootstrapRunId = getOption(args, "--bootstrap-run");

  if (extractionRunId && bootstrapRunId) {
    throw new Error("provide only one of --extraction-run or --bootstrap-run");
  }
  if (extractionRunId) {
    return {
      provenanceKind: "extraction" as const,
      extractionRunId,
    };
  }
  if (bootstrapRunId) {
    return {
      provenanceKind: "legacy_bootstrap" as const,
      bootstrapRunId,
    };
  }
  return undefined;
}

function printUsage(): void {
  console.log("Usage: npm run figures:ops -- <command> <paper-id> [options]");
}

function parseRetentionPolicy(args: string[]) {
  const keepProjectionRuns = getOption(args, "--keep-projections");
  const keepExtractionRuns = getOption(args, "--keep-extractions");
  const keepBootstrapRuns = getOption(args, "--keep-bootstraps");

  return {
    ...(keepProjectionRuns ? { keepProjectionRuns: parseInt(keepProjectionRuns, 10) } : {}),
    ...(keepExtractionRuns ? { keepExtractionRuns: parseInt(keepExtractionRuns, 10) } : {}),
    ...(keepBootstrapRuns ? { keepBootstrapRuns: parseInt(keepBootstrapRuns, 10) } : {}),
  };
}

function collectOptionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function parseRolloutSelection(args: string[]): FigureRolloutSelection {
  const explicitPaperIds = collectOptionValues(args, "--paper");
  const limitRaw = getOption(args, "--limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : null;

  const bucket = hasFlag(args, "--structured")
    ? "structured"
    : hasFlag(args, "--arxiv")
      ? "arxiv"
      : hasFlag(args, "--doi")
        ? "doi"
        : "all";

  return {
    bucket,
    paperIds: explicitPaperIds,
    limit: Number.isFinite(limit) ? limit : null,
    includePapers: hasFlag(args, "--include-papers"),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(1);
  }

  if (command === "override-disable") {
    const overrideId = requireOption(args, "--override-id");
    const row = await disableFigureOverride(overrideId);
    console.log(JSON.stringify({
      command,
      overrideId: row.id,
      status: row.status,
      disabledAt: row.disabledAt,
    }, null, 2));
    return;
  }

  if (command === "rollout-summary") {
    const result = await summarizeFigureRollout(parseRolloutSelection(args));
    console.log(JSON.stringify({
      command,
      ...result,
    }, null, 2));
    return;
  }

  const paperId = args[1];
  if (!paperId) {
    printUsage();
    process.exit(1);
  }

  if (command === "refresh-capability") {
    const result = await createFigureCapabilitySnapshotForPaper(paperId);
    console.log(JSON.stringify({
      command,
      paperId,
      capabilitySnapshotId: result.capabilitySnapshotId,
      coverageClass: result.coverageClass,
      entries: result.entries,
    }, null, 2));
    return;
  }

  if (command === "extract-evidence") {
    const maxPagesRaw = getOption(args, "--max-pages");
    const result = await extractFigureEvidenceOnly(paperId, {
      maxPages: maxPagesRaw ? parseInt(maxPagesRaw, 10) : undefined,
      skipPdf: hasFlag(args, "--skip-pdf"),
    });
    console.log(JSON.stringify({
      command,
      paperId,
      ...result,
    }, null, 2));
    return;
  }

  if (command === "resolve-identities") {
    const result = await resolveFigureIdentities(paperId, parseEvidenceRootArgs(args));
    console.log(JSON.stringify({
      command,
      paperId,
      ...result,
    }, null, 2));
    return;
  }

  if (command === "project-canonical") {
    const identityResolutionId = requireOption(args, "--identity-resolution");
    const result = await createFigureProjection(paperId, identityResolutionId);
    console.log(JSON.stringify({
      command,
      paperId,
      identityResolutionId,
      ...result,
    }, null, 2));
    return;
  }

  if (command === "publish-projection") {
    const identityResolutionId = requireOption(args, "--identity-resolution");
    const projectionRunId = requireOption(args, "--projection-run");
    const result = await publishFigureProjection(
      paperId,
      identityResolutionId,
      projectionRunId,
      hasFlag(args, "--force"),
    );
    console.log(JSON.stringify({
      command,
      paperId,
      ...result,
    }, null, 2));
    return;
  }

  if (command === "render-previews") {
    const result = await renderFigurePreviews(paperId);
    console.log(JSON.stringify({
      command,
      paperId,
      ...result,
    }, null, 2));
    return;
  }

  if (command === "publish-previews") {
    const previewSelectionRunId = requireOption(args, "--preview-selection-run");
    const expectedProjectionRunId = getOption(args, "--projection-run");
    const result = await publishFigurePreviewSelection(
      paperId,
      previewSelectionRunId,
      expectedProjectionRunId,
      hasFlag(args, "--force"),
    );
    console.log(JSON.stringify({
      command,
      paperId,
      ...result,
    }, null, 2));
    return;
  }

  if (command === "rebuild-from-evidence") {
    const result = await rebuildFiguresFromEvidence(
      paperId,
      parseEvidenceRootArgs(args),
      hasFlag(args, "--force"),
    );
    console.log(JSON.stringify({
      command,
      paperId,
      ...result,
    }, null, 2));
    return;
  }

  if (command === "bootstrap-legacy-publication") {
    const result = await bootstrapLegacyFigurePublication(paperId);
    console.log(JSON.stringify({
      command,
      paperId,
      ...result,
    }, null, 2));
    return;
  }

  if (command === "override-add-force-gap") {
    const identityKey = requireOption(args, "--identity-key");
    const gapReason = getOption(args, "--gap-reason") ?? "manual_override";
    const createdBy = getOption(args, "--created-by") ?? "figure-ops";
    const row = await createFigureOverride({
      paperId,
      overrideType: FIGURE_OVERRIDE_TYPE_FORCE_GAP_REASON,
      overrideStage: FIGURE_OVERRIDE_STAGE_PROJECTION,
      selectorType: FIGURE_OVERRIDE_SELECTOR_IDENTITY_KEY,
      selectorValue: identityKey,
      payload: { gapReason },
      createdBy,
      reason: getOption(args, "--reason"),
    });
    console.log(JSON.stringify({
      command,
      paperId,
      overrideId: row.id,
      identityKey,
      gapReason,
    }, null, 2));
    return;
  }

  if (command === "override-add-suppress-preview") {
    const identityKey = requireOption(args, "--identity-key");
    const createdBy = getOption(args, "--created-by") ?? "figure-ops";
    const row = await createFigureOverride({
      paperId,
      overrideType: FIGURE_OVERRIDE_TYPE_SUPPRESS_PREVIEW,
      overrideStage: FIGURE_OVERRIDE_STAGE_PREVIEW,
      selectorType: FIGURE_OVERRIDE_SELECTOR_IDENTITY_KEY,
      selectorValue: identityKey,
      createdBy,
      reason: getOption(args, "--reason"),
    });
    console.log(JSON.stringify({
      command,
      paperId,
      overrideId: row.id,
      identityKey,
    }, null, 2));
    return;
  }

  if (command === "override-list") {
    const rows = await listFigureOverrides(paperId);
    console.log(JSON.stringify({
      command,
      paperId,
      overrides: rows,
    }, null, 2));
    return;
  }

  if (command === "retention-audit") {
    const result = await analyzeFigureRetention(paperId, parseRetentionPolicy(args));
    console.log(JSON.stringify({
      command,
      ...result,
    }, null, 2));
    return;
  }

  if (command === "retention-apply") {
    const result = await applyFigureRetentionPolicy(
      paperId,
      parseRetentionPolicy(args),
      { deleteFiles: hasFlag(args, "--delete-files") },
    );
    console.log(JSON.stringify({
      command,
      ...result,
    }, null, 2));
    return;
  }

  if (command === "paper-audit") {
    const result = await inspectFigurePaperState(paperId);
    console.log(JSON.stringify({
      command,
      paperId,
      ...result,
    }, null, 2));
    return;
  }

  throw new Error(`unknown command ${command}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
