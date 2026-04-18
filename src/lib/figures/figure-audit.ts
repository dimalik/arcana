import { prisma } from "../prisma";

// Audit helpers summarize the published compatibility cache and the rollout
// state behind it. Keep these outputs aligned with the product read contract.

export interface FigureRolloutSelection {
  bucket?: "structured" | "arxiv" | "doi" | "all";
  paperIds?: string[];
  limit?: number | null;
  includePapers?: boolean;
}

export type FigureRolloutStatus =
  | "published_extraction"
  | "published_bootstrap"
  | "extraction_only_unpublished"
  | "bootstrap_only_unpublished"
  | "legacy_only"
  | "no_figure_state";

interface RolloutStatusInput {
  activeProvenanceKind: string | null;
  extractionRunCount: number;
  bootstrapRunCount: number;
  primaryFigureCount: number;
}

interface FigureSurfaceSummary {
  primaryFigures: number;
  figuresWithImages: number;
  gapFigures: number;
  withPublishedHandle: number;
  bySourceMethod: Record<string, number>;
  byGapReason: Record<string, number>;
  byType: Record<string, number>;
}

function countBy(values: Array<string | null | undefined>, fallback = "unknown"): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = value && value.length > 0 ? value : fallback;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function addCount(counts: Record<string, number>, key: string | null | undefined): void {
  const normalized = key && key.length > 0 ? key : "unknown";
  counts[normalized] = (counts[normalized] ?? 0) + 1;
}

function buildPaperWhere(selection: FigureRolloutSelection) {
  if (selection.paperIds && selection.paperIds.length > 0) {
    return { id: { in: selection.paperIds } };
  }

  switch (selection.bucket ?? "all") {
    case "structured":
      return {
        filePath: { not: null },
        OR: [
          { arxivId: { not: null } },
          { doi: { not: null } },
        ],
      };
    case "arxiv":
      return {
        filePath: { not: null },
        arxivId: { not: null },
      };
    case "doi":
      return {
        filePath: { not: null },
        doi: { not: null },
      };
    case "all":
    default:
      return {
        filePath: { not: null },
      };
  }
}

export function classifyFigureRolloutStatus(input: RolloutStatusInput): FigureRolloutStatus {
  if (input.activeProvenanceKind === "extraction") {
    return "published_extraction";
  }
  if (input.activeProvenanceKind === "legacy_bootstrap") {
    return "published_bootstrap";
  }
  if (input.extractionRunCount > 0) {
    return "extraction_only_unpublished";
  }
  if (input.bootstrapRunCount > 0) {
    return "bootstrap_only_unpublished";
  }
  if (input.primaryFigureCount > 0) {
    return "legacy_only";
  }
  return "no_figure_state";
}

function summarizePaperFigures(
  figures: Array<{
    imagePath: string | null;
    gapReason: string | null;
    sourceMethod: string;
    type: string;
    publishedFigureHandleId: string | null;
  }>,
): FigureSurfaceSummary {
  return {
    primaryFigures: figures.length,
    figuresWithImages: figures.filter((row) => !!row.imagePath).length,
    gapFigures: figures.filter((row) => !row.imagePath).length,
    withPublishedHandle: figures.filter((row) => !!row.publishedFigureHandleId).length,
    bySourceMethod: countBy(figures.map((row) => row.sourceMethod)),
    byGapReason: countBy(figures.filter((row) => !row.imagePath).map((row) => row.gapReason), "none"),
    byType: countBy(figures.map((row) => row.type)),
  };
}

export async function inspectFigurePaperState(paperId: string) {
  const paper = await prisma.paper.findUnique({
    where: { id: paperId },
    select: {
      id: true,
      title: true,
      arxivId: true,
      doi: true,
      filePath: true,
      sourceUrl: true,
      publicationState: {
        select: {
          activeProjectionRunId: true,
          activeIdentityResolutionId: true,
          activePreviewSelectionRunId: true,
          activeProjectionRun: {
            select: {
              id: true,
              status: true,
              projectionVersion: true,
              comparisonStatus: true,
              comparisonSummary: true,
              publicationMode: true,
              createdAt: true,
              publishedAt: true,
              identityResolution: {
                select: {
                  id: true,
                  provenanceKind: true,
                  resolverVersion: true,
                  extractionRunId: true,
                  bootstrapRunId: true,
                },
              },
            },
          },
          activeIdentityResolution: {
            select: {
              id: true,
              provenanceKind: true,
              resolverVersion: true,
              status: true,
              createdAt: true,
              promotedAt: true,
              extractionRunId: true,
              bootstrapRunId: true,
            },
          },
          activePreviewSelectionRun: {
            select: {
              id: true,
              selectionKind: true,
              status: true,
              comparisonStatus: true,
              comparisonSummary: true,
              publicationMode: true,
              createdAt: true,
              promotedAt: true,
              supersedesPreviewSelectionRunId: true,
            },
          },
        },
      },
      migrationState: {
        select: {
          migrationState: true,
          latestBootstrapRunId: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!paper) {
    throw new Error(`paper ${paperId} not found`);
  }

  const [
    latestCapabilitySnapshot,
    extractionRuns,
    bootstrapRuns,
    identityResolutionCount,
    projectionRunCount,
    previewSelectionRunCount,
    renderRuns,
    renderedPreviewCount,
    candidateCount,
    assetCount,
    activeOverrideCount,
    publishedHandleCount,
    primaryPaperFigures,
    activeProjectionFigures,
    activePreviewSelectionFigures,
    activeIdentityMembers,
  ] = await Promise.all([
    prisma.capabilitySnapshot.findFirst({
      where: { paperId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        snapshotVersion: true,
        coverageClass: true,
        inputsHash: true,
        createdAt: true,
        entries: {
          orderBy: [{ source: "asc" }],
          select: {
            id: true,
            source: true,
            status: true,
            reasonCode: true,
            sourceCapabilityEvaluation: {
              select: {
                id: true,
                checkedAt: true,
                evaluatorVersion: true,
                status: true,
                reasonCode: true,
              },
            },
          },
        },
      },
    }),
    prisma.extractionRun.findMany({
      where: { paperId },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        status: true,
        capabilitySnapshotId: true,
        createdAt: true,
        completedAt: true,
        sourceAttempts: {
          orderBy: [{ source: "asc" }],
          select: {
            source: true,
            status: true,
            figuresFound: true,
            errorSummary: true,
          },
        },
      },
    }),
    prisma.legacyPublicationBootstrapRun.findMany({
      where: { paperId },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        status: true,
        createdAt: true,
        completedAt: true,
      },
    }),
    prisma.identityResolution.count({ where: { paperId } }),
    prisma.projectionRun.count({ where: { paperId } }),
    prisma.previewSelectionRun.count({ where: { paperId } }),
    prisma.renderRun.findMany({
      where: { paperId },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        projectionRunId: true,
        status: true,
        rendererVersion: true,
        templateVersion: true,
        browserVersion: true,
        createdAt: true,
        completedAt: true,
      },
    }),
    prisma.renderedPreview.count({
      where: {
        renderRun: { paperId },
      },
    }),
    prisma.figureCandidate.count({ where: { paperId } }),
    prisma.asset.count({ where: { paperId } }),
    prisma.figureOverride.count({ where: { paperId, status: "active" } }),
    prisma.publishedFigureHandle.count({ where: { paperId } }),
    prisma.paperFigure.findMany({
      where: { paperId, isPrimaryExtraction: true },
      orderBy: [{ pdfPage: "asc" }, { figureIndex: "asc" }, { id: "asc" }],
      select: {
        id: true,
        publishedFigureHandleId: true,
        figureLabel: true,
        sourceMethod: true,
        imageSourceMethod: true,
        imagePath: true,
        gapReason: true,
        confidence: true,
        pdfPage: true,
        type: true,
      },
    }),
    paper.publicationState?.activeProjectionRunId
      ? prisma.projectionFigure.findMany({
        where: { projectionRunId: paper.publicationState.activeProjectionRunId },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: {
          id: true,
          sortOrder: true,
          figureIdentityId: true,
          publishedFigureHandleId: true,
          sourceMethod: true,
          imageSourceMethod: true,
          pageSourceMethod: true,
          contentCandidateId: true,
          basePreviewCandidateId: true,
          pageAnchorCandidateId: true,
          figureLabel: true,
          captionText: true,
          structuredContentType: true,
          confidence: true,
          imagePath: true,
          pdfPage: true,
          bbox: true,
          type: true,
          gapReason: true,
          figureIdentity: {
            select: {
              identityKey: true,
              canonicalLabelNormalized: true,
              identityNamespace: true,
            },
          },
          publishedFigureHandle: {
            select: {
              id: true,
              publicKey: true,
              status: true,
              retiredAt: true,
            },
          },
        },
      })
      : Promise.resolve([]),
    paper.publicationState?.activePreviewSelectionRunId
      ? prisma.previewSelectionFigure.findMany({
        where: { previewSelectionRunId: paper.publicationState.activePreviewSelectionRunId },
        select: {
          id: true,
          projectionFigureId: true,
          selectedPreviewSource: true,
          selectedPreviewSourceMethod: true,
          selectedAssetId: true,
          selectedRenderedPreviewId: true,
          selectedNativeCandidateId: true,
          selectedAsset: {
            select: {
              id: true,
              storagePath: true,
              contentHash: true,
            },
          },
          selectedRenderedPreview: {
            select: {
              id: true,
              renderMode: true,
              inputHash: true,
              renderRun: {
                select: {
                  id: true,
                  status: true,
                  rendererVersion: true,
                  templateVersion: true,
                  createdAt: true,
                },
              },
            },
          },
          selectedNativeCandidate: {
            select: {
              id: true,
              candidateOrigin: true,
              sourceMethod: true,
              figureLabelRaw: true,
              figureLabelNormalized: true,
              sourceNamespace: true,
              nativePreviewTrust: true,
            },
          },
        },
      })
      : Promise.resolve([]),
    paper.publicationState?.activeIdentityResolutionId
      ? prisma.figureIdentityMember.findMany({
        where: {
          figureIdentity: {
            identityResolutionId: paper.publicationState.activeIdentityResolutionId,
          },
        },
        select: {
          figureIdentityId: true,
          figureCandidate: {
            select: {
              id: true,
              candidateOrigin: true,
              sourceMethod: true,
              type: true,
              sourceNamespace: true,
              sourceOrder: true,
              sourceLocalLocator: true,
              figureLabelRaw: true,
              figureLabelNormalized: true,
              captionTextRaw: true,
              nativePreviewTrust: true,
              confidence: true,
              extractionRunId: true,
              bootstrapRunId: true,
            },
          },
        },
      })
      : Promise.resolve([]),
  ]);

  const figureSurface = summarizePaperFigures(primaryPaperFigures);
  const rolloutStatus = classifyFigureRolloutStatus({
    activeProvenanceKind: paper.publicationState?.activeProjectionRun?.identityResolution.provenanceKind ?? null,
    extractionRunCount: extractionRuns.length,
    bootstrapRunCount: bootstrapRuns.length,
    primaryFigureCount: primaryPaperFigures.length,
  });

  const primaryPaperFigureByHandleId = new Map(
    primaryPaperFigures
      .filter((row) => !!row.publishedFigureHandleId)
      .map((row) => [row.publishedFigureHandleId as string, row]),
  );
  const previewByProjectionFigureId = new Map(
    activePreviewSelectionFigures.map((row) => [row.projectionFigureId, row]),
  );
  const membersByIdentityId = new Map<string, Array<(typeof activeIdentityMembers)[number]["figureCandidate"]>>();
  for (const member of activeIdentityMembers) {
    const existing = membersByIdentityId.get(member.figureIdentityId);
    if (existing) {
      existing.push(member.figureCandidate);
    } else {
      membersByIdentityId.set(member.figureIdentityId, [member.figureCandidate]);
    }
  }

  return {
    paper,
    rolloutStatus,
    latestCapabilitySnapshot,
    migrationState: paper.migrationState,
    counts: {
      extractionRuns: extractionRuns.length,
      bootstrapRuns: bootstrapRuns.length,
      identityResolutions: identityResolutionCount,
      projectionRuns: projectionRunCount,
      previewSelectionRuns: previewSelectionRunCount,
      renderRuns: renderRuns.length,
      renderedPreviews: renderedPreviewCount,
      figureCandidates: candidateCount,
      assets: assetCount,
      activeOverrides: activeOverrideCount,
      publishedFigureHandles: publishedHandleCount,
    },
    figureSurface,
    runs: {
      extractionRuns,
      bootstrapRuns,
      renderRuns,
    },
    activeLineage: activeProjectionFigures.map((figure) => ({
      projectionFigureId: figure.id,
      sortOrder: figure.sortOrder,
      identity: {
        figureIdentityId: figure.figureIdentityId,
        identityKey: figure.figureIdentity.identityKey,
        canonicalLabelNormalized: figure.figureIdentity.canonicalLabelNormalized,
        identityNamespace: figure.figureIdentity.identityNamespace,
      },
      publishedHandle: figure.publishedFigureHandle,
      canonical: {
        sourceMethod: figure.sourceMethod,
        imageSourceMethod: figure.imageSourceMethod,
        pageSourceMethod: figure.pageSourceMethod,
        contentCandidateId: figure.contentCandidateId,
        basePreviewCandidateId: figure.basePreviewCandidateId,
        pageAnchorCandidateId: figure.pageAnchorCandidateId,
        figureLabel: figure.figureLabel,
        captionText: figure.captionText,
        structuredContentType: figure.structuredContentType,
        confidence: figure.confidence,
        imagePath: figure.imagePath,
        pdfPage: figure.pdfPage,
        bbox: figure.bbox,
        type: figure.type,
        gapReason: figure.gapReason,
      },
      selectedPreview: previewByProjectionFigureId.get(figure.id) ?? null,
      identityMembers: membersByIdentityId.get(figure.figureIdentityId) ?? [],
      paperFigure: figure.publishedFigureHandleId
        ? primaryPaperFigureByHandleId.get(figure.publishedFigureHandleId) ?? null
        : null,
    })),
  };
}

export async function summarizeFigureRollout(selection: FigureRolloutSelection = {}) {
  const where = buildPaperWhere(selection);
  const papers = await prisma.paper.findMany({
    where,
    orderBy: [{ title: "asc" }],
    take: selection.limit ?? undefined,
    select: {
      id: true,
      title: true,
      arxivId: true,
      doi: true,
      filePath: true,
      publicationState: {
        select: {
          activeProjectionRunId: true,
          activePreviewSelectionRunId: true,
          activeProjectionRun: {
            select: {
              comparisonStatus: true,
              publicationMode: true,
              identityResolution: {
                select: {
                  provenanceKind: true,
                },
              },
            },
          },
          activePreviewSelectionRun: {
            select: {
              selectionKind: true,
              comparisonStatus: true,
            },
          },
        },
      },
      migrationState: {
        select: {
          migrationState: true,
        },
      },
      capabilitySnapshots: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          id: true,
          coverageClass: true,
        },
      },
    },
  });

  const paperIds = papers.map((paper) => paper.id);
  const [
    extractionRunCounts,
    bootstrapRunCounts,
    activeOverrideCounts,
    primaryPaperFigures,
  ] = await Promise.all([
    paperIds.length > 0
      ? prisma.extractionRun.groupBy({
        by: ["paperId"],
        where: { paperId: { in: paperIds } },
        _count: { _all: true },
      })
      : Promise.resolve([]),
    paperIds.length > 0
      ? prisma.legacyPublicationBootstrapRun.groupBy({
        by: ["paperId"],
        where: { paperId: { in: paperIds } },
        _count: { _all: true },
      })
      : Promise.resolve([]),
    paperIds.length > 0
      ? prisma.figureOverride.groupBy({
        by: ["paperId"],
        where: { paperId: { in: paperIds }, status: "active" },
        _count: { _all: true },
      })
      : Promise.resolve([]),
    paperIds.length > 0
      ? prisma.paperFigure.findMany({
        where: { paperId: { in: paperIds }, isPrimaryExtraction: true },
        select: {
          paperId: true,
          imagePath: true,
          gapReason: true,
          sourceMethod: true,
          type: true,
          publishedFigureHandleId: true,
        },
      })
      : Promise.resolve([]),
  ]);

  const extractionRunCountByPaperId = new Map<string, number>(extractionRunCounts.map((row) => [row.paperId, row._count._all]));
  const bootstrapRunCountByPaperId = new Map<string, number>(bootstrapRunCounts.map((row) => [row.paperId, row._count._all]));
  const overrideCountByPaperId = new Map<string, number>(activeOverrideCounts.map((row) => [row.paperId, row._count._all]));
  type RolloutPrimaryPaperFigure = (typeof primaryPaperFigures)[number];
  const paperFiguresByPaperId = new Map<string, RolloutPrimaryPaperFigure[]>();
  for (const figure of primaryPaperFigures) {
    const existing = paperFiguresByPaperId.get(figure.paperId);
    if (existing) {
      existing.push(figure);
    } else {
      paperFiguresByPaperId.set(figure.paperId, [figure]);
    }
  }

  const byCoverageClass: Record<string, number> = {};
  const byMigrationState: Record<string, number> = {};
  const byRolloutStatus: Record<string, number> = {};
  const byProjectionComparisonStatus: Record<string, number> = {};
  const byPreviewSelectionKind: Record<string, number> = {};
  const byPreviewComparisonStatus: Record<string, number> = {};
  const byOverridePresence: Record<string, number> = {};

  let totalPrimaryFigures = 0;
  let totalFiguresWithImages = 0;
  let totalGapFigures = 0;

  const perPaper = papers.map((paper) => {
    const extractionRunCount = extractionRunCountByPaperId.get(paper.id) ?? 0;
    const bootstrapRunCount = bootstrapRunCountByPaperId.get(paper.id) ?? 0;
    const figures = paperFiguresByPaperId.get(paper.id) ?? [];
    const figureSurface = summarizePaperFigures(figures);
    const activeProvenanceKind = paper.publicationState?.activeProjectionRun?.identityResolution.provenanceKind ?? null;
    const rolloutStatus = classifyFigureRolloutStatus({
      activeProvenanceKind,
      extractionRunCount,
      bootstrapRunCount,
      primaryFigureCount: figures.length,
    });

    addCount(byCoverageClass, paper.capabilitySnapshots[0]?.coverageClass ?? "none");
    addCount(byMigrationState, paper.migrationState?.migrationState ?? "none");
    addCount(byRolloutStatus, rolloutStatus);
    addCount(byProjectionComparisonStatus, paper.publicationState?.activeProjectionRun?.comparisonStatus ?? "none");
    addCount(byPreviewSelectionKind, paper.publicationState?.activePreviewSelectionRun?.selectionKind ?? "none");
    addCount(byPreviewComparisonStatus, paper.publicationState?.activePreviewSelectionRun?.comparisonStatus ?? "none");
    addCount(byOverridePresence, (overrideCountByPaperId.get(paper.id) ?? 0) > 0 ? "with_active_overrides" : "without_active_overrides");

    totalPrimaryFigures += figureSurface.primaryFigures;
    totalFiguresWithImages += figureSurface.figuresWithImages;
    totalGapFigures += figureSurface.gapFigures;

    return {
      paperId: paper.id,
      title: paper.title,
      arxivId: paper.arxivId,
      doi: paper.doi,
      coverageClass: paper.capabilitySnapshots[0]?.coverageClass ?? null,
      migrationState: paper.migrationState?.migrationState ?? null,
      rolloutStatus,
      activeProvenanceKind,
      activeProjectionRunId: paper.publicationState?.activeProjectionRunId ?? null,
      activePreviewSelectionRunId: paper.publicationState?.activePreviewSelectionRunId ?? null,
      projectionComparisonStatus: paper.publicationState?.activeProjectionRun?.comparisonStatus ?? null,
      previewSelectionKind: paper.publicationState?.activePreviewSelectionRun?.selectionKind ?? null,
      previewComparisonStatus: paper.publicationState?.activePreviewSelectionRun?.comparisonStatus ?? null,
      extractionRunCount,
      bootstrapRunCount,
      activeOverrideCount: overrideCountByPaperId.get(paper.id) ?? 0,
      figureSurface,
    };
  });

  return {
    selection: {
      bucket: selection.paperIds && selection.paperIds.length > 0 ? "paper_ids" : (selection.bucket ?? "all"),
      paperIds: selection.paperIds ?? [],
      limit: selection.limit ?? null,
      totalSelectedPapers: papers.length,
    },
    counts: {
      papers: papers.length,
      withPublicationState: perPaper.filter((row) => !!row.activeProjectionRunId || !!row.activePreviewSelectionRunId).length,
      withActiveProjection: perPaper.filter((row) => !!row.activeProjectionRunId).length,
      withActivePreviewSelection: perPaper.filter((row) => !!row.activePreviewSelectionRunId).length,
      withCapabilitySnapshot: perPaper.filter((row) => !!row.coverageClass).length,
      withExtractionRuns: perPaper.filter((row) => row.extractionRunCount > 0).length,
      withBootstrapRuns: perPaper.filter((row) => row.bootstrapRunCount > 0).length,
      withActiveOverrides: perPaper.filter((row) => row.activeOverrideCount > 0).length,
      totalPrimaryFigures,
      totalFiguresWithImages,
      totalGapFigures,
    },
    byCoverageClass,
    byMigrationState,
    byRolloutStatus,
    byProjectionComparisonStatus,
    byPreviewSelectionKind,
    byPreviewComparisonStatus,
    byOverridePresence,
    laggingPapers: perPaper.filter((row) => row.rolloutStatus !== "published_extraction" && row.rolloutStatus !== "published_bootstrap"),
    papers: selection.includePapers ? perPaper : undefined,
  };
}

export const figureAuditInternals = {
  classifyFigureRolloutStatus,
  summarizePaperFigures,
};
