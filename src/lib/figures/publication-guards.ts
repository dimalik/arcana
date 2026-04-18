import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";

type FigurePublicationTx = Prisma.TransactionClient;

export class FigurePublicationGuardConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigurePublicationGuardConflictError";
  }
}

interface RenderedPreviewCompatibilityInput {
  currentProjectionFigureId: string;
  currentIdentityKey: string;
  currentSourceMethod: string;
  currentStructuredContent: string | null;
  currentProjectionRunId: string;
  renderedProjectionFigureId: string;
  renderedIdentityKey: string;
  renderedSourceMethod: string;
  renderedStructuredContent: string | null;
  renderedProjectionRunId: string;
}

export const PAPER_WORK_LEASE_TTL_MS = 5 * 60 * 1000;

function isCompatibleCarryForwardRenderedPreview(
  input: RenderedPreviewCompatibilityInput,
): boolean {
  if (
    input.renderedProjectionFigureId === input.currentProjectionFigureId
    && input.renderedProjectionRunId === input.currentProjectionRunId
  ) {
    return true;
  }

  return input.currentIdentityKey === input.renderedIdentityKey
    && input.currentSourceMethod === input.renderedSourceMethod
    && input.currentStructuredContent === input.renderedStructuredContent;
}

interface ProjectionValidationInput {
  paperId: string;
  identityResolutionId: string;
  projectionRunId: string;
}

interface PreviewSelectionValidationInput {
  paperId: string;
  previewSelectionRunId: string;
  expectedProjectionRunId?: string | null;
}

export async function acquirePaperWorkLease(
  tx: FigurePublicationTx,
  paperId: string,
  holder: string,
  ttlMs: number = PAPER_WORK_LEASE_TTL_MS,
): Promise<string> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const leaseToken = randomUUID();

  const existing = await tx.paperWorkLease.findUnique({
    where: { paperId },
    select: {
      holder: true,
      expiresAt: true,
    },
  });

  if (existing && existing.expiresAt > now && existing.holder !== holder) {
    throw new FigurePublicationGuardConflictError(`paper ${paperId} is already leased by ${existing.holder}`);
  }

  await tx.paperWorkLease.upsert({
    where: { paperId },
    create: {
      paperId,
      leaseToken,
      holder,
      expiresAt,
    },
    update: {
      leaseToken,
      holder,
      expiresAt,
    },
  });

  return leaseToken;
}

export async function assertPaperWorkLease(
  tx: FigurePublicationTx,
  paperId: string,
  leaseToken: string,
): Promise<void> {
  const lease = await tx.paperWorkLease.findUnique({
    where: { paperId },
    select: {
      leaseToken: true,
      expiresAt: true,
    },
  });

  if (!lease) {
    throw new FigurePublicationGuardConflictError(`paper ${paperId} has no active work lease`);
  }
  if (lease.leaseToken !== leaseToken) {
    throw new FigurePublicationGuardConflictError(`paper ${paperId} lease token mismatch`);
  }
  if (lease.expiresAt <= new Date()) {
    throw new FigurePublicationGuardConflictError(`paper ${paperId} work lease expired`);
  }
}

export async function releasePaperWorkLease(
  tx: FigurePublicationTx,
  paperId: string,
  leaseToken: string,
): Promise<void> {
  await tx.paperWorkLease.deleteMany({
    where: {
      paperId,
      leaseToken,
    },
  });
}

export async function validateProjectionRunForPublication(
  tx: FigurePublicationTx,
  input: ProjectionValidationInput,
): Promise<void> {
  const projectionRun = await tx.projectionRun.findUnique({
    where: { id: input.projectionRunId },
    select: {
      id: true,
      paperId: true,
      identityResolutionId: true,
      comparisonStatus: true,
      publicationMode: true,
      identityResolution: {
        select: {
          provenanceKind: true,
          extractionRun: {
            select: {
              capabilitySnapshotId: true,
            },
          },
          bootstrapRun: {
            select: {
              id: true,
            },
          },
        },
      },
      figures: {
        select: {
          id: true,
          publishedFigureHandleId: true,
          imagePath: true,
          imageSourceMethod: true,
          gapReason: true,
          predecessorProjectionFigureId: true,
          handleAssignmentDecision: true,
          handleAssignmentVersion: true,
          handleAssignmentEvidenceType: true,
          handleAssignmentEvidenceIds: true,
          contentCandidateId: true,
          basePreviewCandidateId: true,
          pageAnchorCandidateId: true,
          publishedFigureHandle: {
            select: {
              paperId: true,
            },
          },
          figureIdentity: {
            select: {
              identityResolutionId: true,
              members: {
                select: {
                  figureCandidateId: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!projectionRun) {
    throw new Error(`projection run ${input.projectionRunId} not found`);
  }
  if (projectionRun.paperId !== input.paperId) {
    throw new Error(`projection run ${input.projectionRunId} does not belong to paper ${input.paperId}`);
  }
  if (projectionRun.identityResolutionId !== input.identityResolutionId) {
    throw new Error(
      `projection run ${input.projectionRunId} does not belong to identity resolution ${input.identityResolutionId}`,
    );
  }
  if (
    projectionRun.comparisonStatus !== "safe_to_replace"
    && projectionRun.publicationMode !== "forced"
  ) {
    throw new FigurePublicationGuardConflictError(
      `projection run ${input.projectionRunId} is not safe to publish (${projectionRun.comparisonStatus})`,
    );
  }
  if (projectionRun.identityResolution.provenanceKind === "extraction") {
    if (!projectionRun.identityResolution.extractionRun?.capabilitySnapshotId) {
      throw new Error(`projection run ${input.projectionRunId} is rooted in an extraction run without capability snapshot provenance`);
    }
  } else if (projectionRun.identityResolution.provenanceKind === "legacy_bootstrap") {
    if (!projectionRun.identityResolution.bootstrapRun?.id) {
      throw new Error(`projection run ${input.projectionRunId} is rooted in a bootstrap resolution without bootstrap provenance`);
    }
  } else {
    throw new Error(`projection run ${input.projectionRunId} has unsupported provenance kind ${projectionRun.identityResolution.provenanceKind}`);
  }

  const activeHandleIds = new Set<string>();
  for (const figure of projectionRun.figures) {
    if (figure.figureIdentity.identityResolutionId !== input.identityResolutionId) {
      throw new Error(`projection figure ${figure.id} references an identity from a different resolution`);
    }
    if (!figure.publishedFigureHandleId || !figure.publishedFigureHandle) {
      throw new Error(`projection figure ${figure.id} is missing a published figure handle`);
    }
    if (figure.publishedFigureHandle.paperId !== input.paperId) {
      throw new Error(`projection figure ${figure.id} references a handle from a different paper`);
    }
    if (activeHandleIds.has(figure.publishedFigureHandleId)) {
      throw new Error(`projection run ${input.projectionRunId} reuses handle ${figure.publishedFigureHandleId} more than once`);
    }
    activeHandleIds.add(figure.publishedFigureHandleId);
    if (
      !figure.handleAssignmentDecision
      || !figure.handleAssignmentVersion
      || !figure.handleAssignmentEvidenceType
      || !figure.handleAssignmentEvidenceIds
    ) {
      throw new Error(`projection figure ${figure.id} is missing handle assignment provenance`);
    }
    if (
      figure.handleAssignmentDecision === "reuse"
      && !figure.predecessorProjectionFigureId
    ) {
      throw new Error(`projection figure ${figure.id} is marked reused without a predecessor`);
    }
    if (
      figure.handleAssignmentDecision === "new"
      && figure.predecessorProjectionFigureId
    ) {
      throw new Error(`projection figure ${figure.id} is marked new but still references a predecessor`);
    }

    const memberIds = new Set(
      figure.figureIdentity.members.map(
        (member: (typeof figure.figureIdentity.members)[number]) => member.figureCandidateId,
      ),
    );

    if (!memberIds.has(figure.contentCandidateId)) {
      throw new Error(`projection figure ${figure.id} content candidate is outside the identity membership`);
    }
    if (figure.basePreviewCandidateId && !memberIds.has(figure.basePreviewCandidateId)) {
      throw new Error(`projection figure ${figure.id} preview candidate is outside the identity membership`);
    }
    if (figure.pageAnchorCandidateId && !memberIds.has(figure.pageAnchorCandidateId)) {
      throw new Error(`projection figure ${figure.id} page anchor candidate is outside the identity membership`);
    }
    if (figure.imagePath && !figure.imageSourceMethod) {
      throw new Error(`projection figure ${figure.id} has an imagePath without imageSourceMethod`);
    }
    if (!figure.imagePath && figure.imageSourceMethod) {
      throw new Error(`projection figure ${figure.id} has imageSourceMethod without an imagePath`);
    }
    if (figure.imagePath && figure.gapReason) {
      throw new Error(`projection figure ${figure.id} has both an imagePath and a gapReason`);
    }
    if (!figure.imagePath && !figure.gapReason) {
      throw new Error(`projection figure ${figure.id} has neither imagePath nor gapReason`);
    }
  }
}

export async function validatePreviewSelectionRunForPublication(
  tx: FigurePublicationTx,
  input: PreviewSelectionValidationInput,
): Promise<{ projectionRunId: string }> {
  const previewSelectionRun = await tx.previewSelectionRun.findUnique({
    where: { id: input.previewSelectionRunId },
    select: {
      id: true,
      paperId: true,
      projectionRunId: true,
      comparisonStatus: true,
      publicationMode: true,
      figures: {
        select: {
          id: true,
          projectionFigureId: true,
          selectedPreviewSource: true,
          selectedPreviewSourceMethod: true,
          selectedAssetId: true,
          selectedRenderedPreviewId: true,
          selectedNativeCandidateId: true,
          projectionFigure: {
            select: {
              projectionRunId: true,
              sourceMethod: true,
              structuredContent: true,
              figureIdentity: {
                select: {
                  identityKey: true,
                },
              },
            },
          },
          selectedRenderedPreview: {
            select: {
              assetId: true,
              projectionFigureId: true,
              renderRun: {
                select: {
                  projectionRunId: true,
                },
              },
              projectionFigure: {
                select: {
                  sourceMethod: true,
                  structuredContent: true,
                  figureIdentity: {
                    select: {
                      identityKey: true,
                    },
                  },
                },
              },
            },
          },
          selectedNativeCandidate: {
            select: {
              nativeAssetId: true,
            },
          },
        },
      },
    },
  });

  if (!previewSelectionRun) {
    throw new Error(`preview selection run ${input.previewSelectionRunId} not found`);
  }
  if (previewSelectionRun.paperId !== input.paperId) {
    throw new Error(
      `preview selection run ${input.previewSelectionRunId} does not belong to paper ${input.paperId}`,
    );
  }
  if (
    input.expectedProjectionRunId
    && previewSelectionRun.projectionRunId !== input.expectedProjectionRunId
  ) {
    throw new Error(
      `preview selection run ${input.previewSelectionRunId} does not target projection run ${input.expectedProjectionRunId}`,
    );
  }
  if (
    previewSelectionRun.comparisonStatus !== "safe_to_replace"
    && previewSelectionRun.publicationMode !== "forced"
  ) {
    throw new FigurePublicationGuardConflictError(
      `preview selection run ${input.previewSelectionRunId} is not safe to publish (${previewSelectionRun.comparisonStatus})`,
    );
  }

  const projectionFigureCount = await tx.projectionFigure.count({
    where: { projectionRunId: previewSelectionRun.projectionRunId },
  });
  if (projectionFigureCount !== previewSelectionRun.figures.length) {
    throw new Error(
      `preview selection run ${input.previewSelectionRunId} does not cover every projection figure`,
    );
  }

  for (const figure of previewSelectionRun.figures) {
    if (figure.projectionFigure.projectionRunId !== previewSelectionRun.projectionRunId) {
      throw new Error(`preview selection figure ${figure.id} points at a projection figure from another run`);
    }

    if (figure.selectedPreviewSource === "none") {
      if (
        figure.selectedAssetId
        || figure.selectedRenderedPreviewId
        || figure.selectedNativeCandidateId
        || figure.selectedPreviewSourceMethod
      ) {
        throw new Error(`preview selection figure ${figure.id} is 'none' but still carries preview lineage`);
      }
      continue;
    }

    if (!figure.selectedAssetId || !figure.selectedPreviewSourceMethod) {
      throw new Error(`preview selection figure ${figure.id} is missing asset or source method`);
    }

    if (figure.selectedPreviewSource === "native") {
      if (!figure.selectedNativeCandidateId || figure.selectedRenderedPreviewId) {
        throw new Error(`preview selection figure ${figure.id} has invalid native selection lineage`);
      }
      if (figure.selectedNativeCandidate?.nativeAssetId !== figure.selectedAssetId) {
        throw new Error(`preview selection figure ${figure.id} native candidate does not match selected asset`);
      }
      continue;
    }

    if (figure.selectedPreviewSource === "rendered") {
      if (!figure.selectedRenderedPreviewId || figure.selectedNativeCandidateId) {
        throw new Error(`preview selection figure ${figure.id} has invalid rendered selection lineage`);
      }
      if (!figure.selectedRenderedPreview) {
        throw new Error(`preview selection figure ${figure.id} missing rendered preview row`);
      }
      if (figure.selectedRenderedPreview.assetId !== figure.selectedAssetId) {
        throw new Error(`preview selection figure ${figure.id} rendered preview asset mismatch`);
      }
      if (!isCompatibleCarryForwardRenderedPreview({
        currentProjectionFigureId: figure.projectionFigureId,
        currentIdentityKey: figure.projectionFigure.figureIdentity.identityKey,
        currentSourceMethod: figure.projectionFigure.sourceMethod,
        currentStructuredContent: figure.projectionFigure.structuredContent,
        currentProjectionRunId: previewSelectionRun.projectionRunId,
        renderedProjectionFigureId: figure.selectedRenderedPreview.projectionFigureId,
        renderedIdentityKey: figure.selectedRenderedPreview.projectionFigure.figureIdentity.identityKey,
        renderedSourceMethod: figure.selectedRenderedPreview.projectionFigure.sourceMethod,
        renderedStructuredContent: figure.selectedRenderedPreview.projectionFigure.structuredContent,
        renderedProjectionRunId: figure.selectedRenderedPreview.renderRun.projectionRunId,
      })) {
        throw new Error(`preview selection figure ${figure.id} rendered preview is incompatible with the target projection figure`);
      }
      continue;
    }

    throw new Error(`preview selection figure ${figure.id} has unsupported preview source ${figure.selectedPreviewSource}`);
  }

  return { projectionRunId: previewSelectionRun.projectionRunId };
}

export const publicationGuardsInternals = {
  isCompatibleCarryForwardRenderedPreview,
};
