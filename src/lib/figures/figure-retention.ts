import { unlink } from "fs/promises";
import path from "path";
import { Prisma } from "@prisma/client";

import { prisma } from "../prisma";

type FigureRetentionTx = Prisma.TransactionClient;

export interface FigureRetentionPolicy {
  keepProjectionRuns: number;
  keepExtractionRuns: number;
  keepBootstrapRuns: number;
}

export const DEFAULT_FIGURE_RETENTION_POLICY: FigureRetentionPolicy = {
  keepProjectionRuns: 2,
  keepExtractionRuns: 2,
  keepBootstrapRuns: 1,
};

interface ProjectionRunRoot {
  id: string;
  identityResolutionId: string;
  createdAt: Date;
}

interface PreviewSelectionRunRoot {
  id: string;
  projectionRunId: string;
  createdAt: Date;
}

interface IdentityResolutionRoot {
  id: string;
  extractionRunId: string | null;
  bootstrapRunId: string | null;
  createdAt: Date;
}

interface ExtractionRunRoot {
  id: string;
  capabilitySnapshotId: string | null;
  createdAt: Date;
}

interface BootstrapRunRoot {
  id: string;
  createdAt: Date;
}

interface FigureRetentionRootInput {
  activeProjectionRunId: string | null;
  activeIdentityResolutionId: string | null;
  activePreviewSelectionRunId: string | null;
  latestBootstrapRunId: string | null;
  projectionRuns: ProjectionRunRoot[];
  previewSelectionRuns: PreviewSelectionRunRoot[];
  identityResolutions: IdentityResolutionRoot[];
  extractionRuns: ExtractionRunRoot[];
  bootstrapRuns: BootstrapRunRoot[];
}

interface FigureRetentionRootPlan {
  projectionRunIds: Set<string>;
  previewSelectionRunIds: Set<string>;
  identityResolutionIds: Set<string>;
  extractionRunIds: Set<string>;
  capabilitySnapshotIds: Set<string>;
  bootstrapRunIds: Set<string>;
}

export interface FigureRetentionAnalysis {
  paperId: string;
  policy: FigureRetentionPolicy;
  violations: string[];
  retained: Record<string, string[]>;
  deletable: Record<string, string[]>;
  assetFilesEligibleForDeletion: string[];
}

function sortByNewest<T extends { createdAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

function takeNewestExcluding<T extends { id: string; createdAt: Date }>(
  rows: T[],
  count: number,
  excluded: Set<string>,
): T[] {
  return sortByNewest(rows).filter((row) => !excluded.has(row.id)).slice(0, Math.max(count, 0));
}

export function computeRetainedFigureRoots(
  input: FigureRetentionRootInput,
  policy: FigureRetentionPolicy,
): FigureRetentionRootPlan {
  const retainedProjectionRunIds = new Set<string>();
  if (input.activeProjectionRunId) {
    retainedProjectionRunIds.add(input.activeProjectionRunId);
  }
  for (const row of takeNewestExcluding(input.projectionRuns, policy.keepProjectionRuns, retainedProjectionRunIds)) {
    retainedProjectionRunIds.add(row.id);
  }

  const retainedPreviewSelectionRunIds = new Set<string>();
  if (input.activePreviewSelectionRunId) {
    retainedPreviewSelectionRunIds.add(input.activePreviewSelectionRunId);
  }
  for (const row of input.previewSelectionRuns) {
    if (retainedProjectionRunIds.has(row.projectionRunId)) {
      retainedPreviewSelectionRunIds.add(row.id);
    }
  }

  const retainedIdentityResolutionIds = new Set<string>();
  if (input.activeIdentityResolutionId) {
    retainedIdentityResolutionIds.add(input.activeIdentityResolutionId);
  }
  const projectionRunsById = new Map(input.projectionRuns.map((row) => [row.id, row]));
  for (const projectionRunId of Array.from(retainedProjectionRunIds)) {
    const row = projectionRunsById.get(projectionRunId);
    if (row) retainedIdentityResolutionIds.add(row.identityResolutionId);
  }

  const identityResolutionsById = new Map(input.identityResolutions.map((row) => [row.id, row]));
  const retainedExtractionRunIds = new Set<string>();
  const retainedBootstrapRunIds = new Set<string>();
  const retainedCapabilitySnapshotIds = new Set<string>();

  for (const identityResolutionId of Array.from(retainedIdentityResolutionIds)) {
    const row = identityResolutionsById.get(identityResolutionId);
    if (!row) continue;
    if (row.extractionRunId) retainedExtractionRunIds.add(row.extractionRunId);
    if (row.bootstrapRunId) retainedBootstrapRunIds.add(row.bootstrapRunId);
  }

  const extractionRunsById = new Map(input.extractionRuns.map((row) => [row.id, row]));
  for (const extractionRunId of Array.from(retainedExtractionRunIds)) {
    const row = extractionRunsById.get(extractionRunId);
    if (row?.capabilitySnapshotId) retainedCapabilitySnapshotIds.add(row.capabilitySnapshotId);
  }

  for (const row of takeNewestExcluding(input.extractionRuns, policy.keepExtractionRuns, retainedExtractionRunIds)) {
    retainedExtractionRunIds.add(row.id);
    if (row.capabilitySnapshotId) retainedCapabilitySnapshotIds.add(row.capabilitySnapshotId);
  }

  if (input.latestBootstrapRunId) {
    retainedBootstrapRunIds.add(input.latestBootstrapRunId);
  }
  for (const row of takeNewestExcluding(input.bootstrapRuns, policy.keepBootstrapRuns, retainedBootstrapRunIds)) {
    retainedBootstrapRunIds.add(row.id);
  }

  return {
    projectionRunIds: retainedProjectionRunIds,
    previewSelectionRunIds: retainedPreviewSelectionRunIds,
    identityResolutionIds: retainedIdentityResolutionIds,
    extractionRunIds: retainedExtractionRunIds,
    capabilitySnapshotIds: retainedCapabilitySnapshotIds,
    bootstrapRunIds: retainedBootstrapRunIds,
  };
}

function resolveStoragePath(storagePath: string): string {
  return path.isAbsolute(storagePath)
    ? storagePath
    : path.join(process.cwd(), storagePath);
}

function stringSetToArray(set: Set<string>): string[] {
  return Array.from(set) as string[];
}

async function analyzeFigureRetentionTx(
  tx: FigureRetentionTx,
  paperId: string,
  policy: FigureRetentionPolicy,
): Promise<FigureRetentionAnalysis> {
  const [
    publicationState,
    migrationState,
    projectionRuns,
    previewSelectionRuns,
    identityResolutions,
    extractionRuns,
    bootstrapRuns,
  ] = await Promise.all([
    tx.paperPublicationState.findUnique({
      where: { paperId },
      select: {
        activeProjectionRunId: true,
        activeIdentityResolutionId: true,
        activePreviewSelectionRunId: true,
      },
    }),
    tx.paperMigrationState.findUnique({
      where: { paperId },
      select: {
        latestBootstrapRunId: true,
      },
    }),
    tx.projectionRun.findMany({
      where: { paperId },
      select: {
        id: true,
        identityResolutionId: true,
        createdAt: true,
      },
    }),
    tx.previewSelectionRun.findMany({
      where: { paperId },
      select: {
        id: true,
        projectionRunId: true,
        createdAt: true,
      },
    }),
    tx.identityResolution.findMany({
      where: { paperId },
      select: {
        id: true,
        extractionRunId: true,
        bootstrapRunId: true,
        createdAt: true,
      },
    }),
    tx.extractionRun.findMany({
      where: { paperId },
      select: {
        id: true,
        capabilitySnapshotId: true,
        createdAt: true,
      },
    }),
    tx.legacyPublicationBootstrapRun.findMany({
      where: { paperId },
      select: {
        id: true,
        createdAt: true,
      },
    }),
  ]);

  const rootPlan = computeRetainedFigureRoots({
    activeProjectionRunId: publicationState?.activeProjectionRunId ?? null,
    activeIdentityResolutionId: publicationState?.activeIdentityResolutionId ?? null,
    activePreviewSelectionRunId: publicationState?.activePreviewSelectionRunId ?? null,
    latestBootstrapRunId: migrationState?.latestBootstrapRunId ?? null,
    projectionRuns,
    previewSelectionRuns,
    identityResolutions,
    extractionRuns,
    bootstrapRuns,
  }, policy);

  const [projectionFigures, previewSelectionFigures, candidates, snapshotEntries, renderRuns, renderedPreviews, assets, sourceCapabilityEvaluations, publishedHandles] = await Promise.all([
    tx.projectionFigure.findMany({
      where: {
        projectionRun: {
          paperId,
        },
      },
      select: {
        id: true,
        projectionRunId: true,
        figureIdentityId: true,
        publishedFigureHandleId: true,
      },
    }),
    tx.previewSelectionFigure.findMany({
      where: {
        previewSelectionRun: {
          paperId,
        },
      },
      select: {
        id: true,
        previewSelectionRunId: true,
        selectedAssetId: true,
        selectedRenderedPreviewId: true,
        selectedNativeCandidateId: true,
      },
    }),
    tx.figureCandidate.findMany({
      where: { paperId },
      select: {
        id: true,
        extractionRunId: true,
        bootstrapRunId: true,
        nativeAssetId: true,
      },
    }),
    tx.capabilitySnapshotEntry.findMany({
      where: {
        capabilitySnapshot: {
          paperId,
        },
      },
      select: {
        id: true,
        capabilitySnapshotId: true,
        sourceCapabilityEvaluationId: true,
      },
    }),
    tx.renderRun.findMany({
      where: { paperId },
      select: {
        id: true,
      },
    }),
    tx.renderedPreview.findMany({
      where: {
        renderRun: {
          paperId,
        },
      },
      select: {
        id: true,
        renderRunId: true,
        assetId: true,
      },
    }),
    tx.asset.findMany({
      where: { paperId },
      select: {
        id: true,
        storagePath: true,
      },
    }),
    tx.sourceCapabilityEvaluation.findMany({
      where: { paperId },
      select: {
        id: true,
      },
    }),
    tx.publishedFigureHandle.findMany({
      where: { paperId },
      select: {
        id: true,
      },
    }),
  ]);

  const retainedProjectionFigureIds = new Set<string>(
    projectionFigures
      .filter((row: (typeof projectionFigures)[number]) => rootPlan.projectionRunIds.has(row.projectionRunId))
      .map((row: (typeof projectionFigures)[number]) => row.id),
  );
  const retainedPublishedHandleIds = new Set<string>(
    projectionFigures
      .filter((row: (typeof projectionFigures)[number]) => rootPlan.projectionRunIds.has(row.projectionRunId) && !!row.publishedFigureHandleId)
      .map((row: (typeof projectionFigures)[number]) => row.publishedFigureHandleId as string),
  );
  const retainedPreviewSelectionFigureIds = new Set<string>(
    previewSelectionFigures
      .filter((row: (typeof previewSelectionFigures)[number]) => rootPlan.previewSelectionRunIds.has(row.previewSelectionRunId))
      .map((row: (typeof previewSelectionFigures)[number]) => row.id),
  );
  const retainedCandidateIds = new Set<string>(
    candidates
      .filter((row: (typeof candidates)[number]) => (
        (row.extractionRunId && rootPlan.extractionRunIds.has(row.extractionRunId))
        || (row.bootstrapRunId && rootPlan.bootstrapRunIds.has(row.bootstrapRunId))
      ))
      .map((row: (typeof candidates)[number]) => row.id),
  );
  const retainedCapabilitySnapshotEntryIds = new Set<string>(
    snapshotEntries
      .filter((row: (typeof snapshotEntries)[number]) => rootPlan.capabilitySnapshotIds.has(row.capabilitySnapshotId))
      .map((row: (typeof snapshotEntries)[number]) => row.id),
  );
  const retainedSourceCapabilityEvaluationIds = new Set<string>(
    snapshotEntries
      .filter((row: (typeof snapshotEntries)[number]) => rootPlan.capabilitySnapshotIds.has(row.capabilitySnapshotId))
      .map((row: (typeof snapshotEntries)[number]) => row.sourceCapabilityEvaluationId),
  );
  const retainedRenderedPreviewIds = new Set<string>(
    previewSelectionFigures
      .filter((row: (typeof previewSelectionFigures)[number]) => rootPlan.previewSelectionRunIds.has(row.previewSelectionRunId) && !!row.selectedRenderedPreviewId)
      .map((row: (typeof previewSelectionFigures)[number]) => row.selectedRenderedPreviewId as string),
  );
  const retainedRenderRunIds = new Set<string>(
    renderedPreviews
      .filter((row: (typeof renderedPreviews)[number]) => retainedRenderedPreviewIds.has(row.id))
      .map((row: (typeof renderedPreviews)[number]) => row.renderRunId),
  );

  const retainedAssetIds = new Set<string>();
  for (const row of candidates) {
    if (retainedCandidateIds.has(row.id) && row.nativeAssetId) {
      retainedAssetIds.add(row.nativeAssetId);
    }
  }
  for (const row of previewSelectionFigures) {
    if (!rootPlan.previewSelectionRunIds.has(row.previewSelectionRunId)) continue;
    if (row.selectedAssetId) retainedAssetIds.add(row.selectedAssetId);
  }
  for (const row of renderedPreviews) {
    if (retainedRenderedPreviewIds.has(row.id)) retainedAssetIds.add(row.assetId);
  }

  const violations: string[] = [];
  for (const row of previewSelectionRuns) {
    if (rootPlan.previewSelectionRunIds.has(row.id) && !rootPlan.projectionRunIds.has(row.projectionRunId)) {
      violations.push(`retained preview selection run ${row.id} does not retain its parent projection run ${row.projectionRunId}`);
    }
  }
  for (const row of projectionRuns) {
    if (rootPlan.projectionRunIds.has(row.id) && !rootPlan.identityResolutionIds.has(row.identityResolutionId)) {
      violations.push(`retained projection run ${row.id} does not retain identity resolution ${row.identityResolutionId}`);
    }
  }
  for (const row of identityResolutions) {
    if (!rootPlan.identityResolutionIds.has(row.id)) continue;
    if (row.extractionRunId && !rootPlan.extractionRunIds.has(row.extractionRunId)) {
      violations.push(`retained identity resolution ${row.id} does not retain extraction run ${row.extractionRunId}`);
    }
    if (row.bootstrapRunId && !rootPlan.bootstrapRunIds.has(row.bootstrapRunId)) {
      violations.push(`retained identity resolution ${row.id} does not retain bootstrap run ${row.bootstrapRunId}`);
    }
  }
  for (const row of previewSelectionFigures) {
    if (!rootPlan.previewSelectionRunIds.has(row.previewSelectionRunId)) continue;
    if (row.selectedRenderedPreviewId && !retainedRenderedPreviewIds.has(row.selectedRenderedPreviewId)) {
      violations.push(`retained preview selection figure ${row.id} does not retain rendered preview ${row.selectedRenderedPreviewId}`);
    }
    if (row.selectedNativeCandidateId && !retainedCandidateIds.has(row.selectedNativeCandidateId)) {
      violations.push(`retained preview selection figure ${row.id} does not retain native candidate ${row.selectedNativeCandidateId}`);
    }
  }
  if (publicationState?.activeProjectionRunId && !rootPlan.projectionRunIds.has(publicationState.activeProjectionRunId)) {
    violations.push(`active projection run ${publicationState.activeProjectionRunId} is not retained`);
  }
  if (publicationState?.activePreviewSelectionRunId && !rootPlan.previewSelectionRunIds.has(publicationState.activePreviewSelectionRunId)) {
    violations.push(`active preview selection run ${publicationState.activePreviewSelectionRunId} is not retained`);
  }
  if (publicationState?.activeIdentityResolutionId && !rootPlan.identityResolutionIds.has(publicationState.activeIdentityResolutionId)) {
    violations.push(`active identity resolution ${publicationState.activeIdentityResolutionId} is not retained`);
  }

  const deletableProjectionRunIds = projectionRuns
    .filter((row: (typeof projectionRuns)[number]) => !rootPlan.projectionRunIds.has(row.id))
    .map((row: (typeof projectionRuns)[number]) => row.id);
  const deletablePreviewSelectionRunIds = previewSelectionRuns
    .filter((row: (typeof previewSelectionRuns)[number]) => !rootPlan.previewSelectionRunIds.has(row.id))
    .map((row: (typeof previewSelectionRuns)[number]) => row.id);
  const deletableIdentityResolutionIds = identityResolutions
    .filter((row: (typeof identityResolutions)[number]) => !rootPlan.identityResolutionIds.has(row.id))
    .map((row: (typeof identityResolutions)[number]) => row.id);
  const deletableExtractionRunIds = extractionRuns
    .filter((row: (typeof extractionRuns)[number]) => !rootPlan.extractionRunIds.has(row.id))
    .map((row: (typeof extractionRuns)[number]) => row.id);
  const deletableBootstrapRunIds = bootstrapRuns
    .filter((row: (typeof bootstrapRuns)[number]) => !rootPlan.bootstrapRunIds.has(row.id))
    .map((row: (typeof bootstrapRuns)[number]) => row.id);
  const deletableCapabilitySnapshotIds = stringSetToArray(new Set<string>(
      extractionRuns
        .map((row: (typeof extractionRuns)[number]) => row.capabilitySnapshotId)
        .filter((id: string | null): id is string => !!id && !rootPlan.capabilitySnapshotIds.has(id)),
    ));
  const deletableSourceCapabilityEvaluationIds = sourceCapabilityEvaluations
    .filter((row: (typeof sourceCapabilityEvaluations)[number]) => !retainedSourceCapabilityEvaluationIds.has(row.id))
    .map((row: (typeof sourceCapabilityEvaluations)[number]) => row.id);
  const deletablePublishedHandleIds = publishedHandles
    .filter((row: (typeof publishedHandles)[number]) => !retainedPublishedHandleIds.has(row.id))
    .map((row: (typeof publishedHandles)[number]) => row.id);
  const deletableRenderRunIds = renderRuns
    .filter((row: (typeof renderRuns)[number]) => !retainedRenderRunIds.has(row.id))
    .map((row: (typeof renderRuns)[number]) => row.id);
  const deletableAssetRows = assets.filter((row: (typeof assets)[number]) => !retainedAssetIds.has(row.id));

  return {
    paperId,
    policy,
    violations,
    retained: {
      projectionRuns: stringSetToArray(rootPlan.projectionRunIds),
      previewSelectionRuns: stringSetToArray(rootPlan.previewSelectionRunIds),
      identityResolutions: stringSetToArray(rootPlan.identityResolutionIds),
      extractionRuns: stringSetToArray(rootPlan.extractionRunIds),
      capabilitySnapshots: stringSetToArray(rootPlan.capabilitySnapshotIds),
      bootstrapRuns: stringSetToArray(rootPlan.bootstrapRunIds),
      projectionFigures: stringSetToArray(retainedProjectionFigureIds),
      previewSelectionFigures: stringSetToArray(retainedPreviewSelectionFigureIds),
      figureCandidates: stringSetToArray(retainedCandidateIds),
      capabilitySnapshotEntries: stringSetToArray(retainedCapabilitySnapshotEntryIds),
      sourceCapabilityEvaluations: stringSetToArray(retainedSourceCapabilityEvaluationIds),
      renderedPreviews: stringSetToArray(retainedRenderedPreviewIds),
      renderRuns: stringSetToArray(retainedRenderRunIds),
      assets: stringSetToArray(retainedAssetIds),
      publishedFigureHandles: stringSetToArray(retainedPublishedHandleIds),
    },
    deletable: {
      projectionRuns: deletableProjectionRunIds,
      previewSelectionRuns: deletablePreviewSelectionRunIds,
      identityResolutions: deletableIdentityResolutionIds,
      extractionRuns: deletableExtractionRunIds,
      capabilitySnapshots: deletableCapabilitySnapshotIds,
      bootstrapRuns: deletableBootstrapRunIds,
      sourceCapabilityEvaluations: deletableSourceCapabilityEvaluationIds,
      renderRuns: deletableRenderRunIds,
      publishedFigureHandles: deletablePublishedHandleIds,
      assets: deletableAssetRows.map((row: (typeof deletableAssetRows)[number]) => row.id),
    },
    assetFilesEligibleForDeletion: deletableAssetRows.map((row: (typeof deletableAssetRows)[number]) => row.storagePath),
  };
}

export async function analyzeFigureRetention(
  paperId: string,
  policy: Partial<FigureRetentionPolicy> = {},
): Promise<FigureRetentionAnalysis> {
  const normalizedPolicy: FigureRetentionPolicy = {
    ...DEFAULT_FIGURE_RETENTION_POLICY,
    ...policy,
  };

  return prisma.$transaction((tx) => analyzeFigureRetentionTx(tx, paperId, normalizedPolicy));
}

export async function applyFigureRetentionPolicy(
  paperId: string,
  policy: Partial<FigureRetentionPolicy> = {},
  options?: { deleteFiles?: boolean },
): Promise<FigureRetentionAnalysis> {
  const normalizedPolicy: FigureRetentionPolicy = {
    ...DEFAULT_FIGURE_RETENTION_POLICY,
    ...policy,
  };

  const analysis = await prisma.$transaction(async (tx) => {
    const result = await analyzeFigureRetentionTx(tx, paperId, normalizedPolicy);
    if (result.violations.length > 0) {
      throw new Error(`retention closure violations prevent cleanup: ${result.violations.join("; ")}`);
    }

    await tx.previewSelectionRun.deleteMany({
      where: { id: { in: result.deletable.previewSelectionRuns } },
    });
    await tx.renderRun.deleteMany({
      where: { id: { in: result.deletable.renderRuns } },
    });
    await tx.projectionRun.deleteMany({
      where: { id: { in: result.deletable.projectionRuns } },
    });
    await tx.identityResolution.deleteMany({
      where: { id: { in: result.deletable.identityResolutions } },
    });
    await tx.extractionRun.deleteMany({
      where: { id: { in: result.deletable.extractionRuns } },
    });
    await tx.legacyPublicationBootstrapRun.deleteMany({
      where: { id: { in: result.deletable.bootstrapRuns } },
    });
    await tx.capabilitySnapshot.deleteMany({
      where: { id: { in: result.deletable.capabilitySnapshots } },
    });
    await tx.sourceCapabilityEvaluation.deleteMany({
      where: { id: { in: result.deletable.sourceCapabilityEvaluations } },
    });
    await tx.publishedFigureHandle.deleteMany({
      where: { id: { in: result.deletable.publishedFigureHandles } },
    });
    await tx.asset.deleteMany({
      where: { id: { in: result.deletable.assets } },
    });

    return result;
  });

  if (options?.deleteFiles) {
    for (const storagePath of analysis.assetFilesEligibleForDeletion) {
      const absolutePath = resolveStoragePath(storagePath);
      if (!absolutePath.startsWith(process.cwd())) continue;
      try {
        await unlink(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  return analysis;
}

export const figureRetentionInternals = {
  computeRetainedFigureRoots,
};
