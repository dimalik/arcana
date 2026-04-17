import { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { prepareCapabilitySnapshotForExtraction } from "./capability-substrate";
import { persistExtractionEvidence } from "./extraction-foundation";
import {
  collectFigureSourceBatches,
  type FigureExtractionPaperInput,
} from "./extract-all-figures";
import {
  bootstrapLegacyPublication,
  type LegacyBootstrapResult,
} from "./legacy-publication-bootstrap";
import { createIdentityResolutionSnapshot } from "./identity-resolution";
import {
  createProjectionRunSnapshot,
  publishPreviewSelectionRun,
  publishProjectionRun,
} from "./projection-publication";
import {
  acquirePaperWorkLease,
  releasePaperWorkLease,
} from "./publication-guards";
import { renderTablePreviews } from "./html-table-preview-renderer";
import { mergeFigureSources, type MergeableFigure } from "./source-merger";

type FigureOperatorTx = Prisma.TransactionClient;

type EvidenceRoot =
  | {
    provenanceKind: "extraction";
    extractionRunId: string;
  }
  | {
    provenanceKind: "legacy_bootstrap";
    bootstrapRunId: string;
  };

interface CandidateDiagnostics {
  captionSource?: string | null;
  sourceUrl?: string | null;
  cropOutcome?: "success" | "rejected" | "failed" | null;
  imagePath?: string | null;
  width?: number | null;
  height?: number | null;
}

interface PageAnchorCandidate {
  pdfPage?: number | null;
  bbox?: string | null;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function loadPaperExtractionInput(paperId: string): Promise<FigureExtractionPaperInput> {
  const paper = await prisma.paper.findUnique({
    where: { id: paperId },
    select: {
      id: true,
      title: true,
      filePath: true,
      doi: true,
      arxivId: true,
      sourceUrl: true,
    },
  });

  if (!paper) {
    throw new Error(`paper ${paperId} not found`);
  }

  return paper;
}

async function resolveEvidenceRoot(
  tx: FigureOperatorTx,
  paperId: string,
  input?: Partial<EvidenceRoot>,
): Promise<EvidenceRoot> {
  if (input?.provenanceKind === "extraction" && input.extractionRunId) {
    const extractionRun = await tx.extractionRun.findUnique({
      where: { id: input.extractionRunId },
      select: { paperId: true },
    });
    if (!extractionRun || extractionRun.paperId !== paperId) {
      throw new Error(`extraction run ${input.extractionRunId} does not belong to paper ${paperId}`);
    }
    return {
      provenanceKind: "extraction",
      extractionRunId: input.extractionRunId,
    };
  }

  if (input?.provenanceKind === "legacy_bootstrap" && input.bootstrapRunId) {
    const bootstrapRun = await tx.legacyPublicationBootstrapRun.findUnique({
      where: { id: input.bootstrapRunId },
      select: { paperId: true },
    });
    if (!bootstrapRun || bootstrapRun.paperId !== paperId) {
      throw new Error(`bootstrap run ${input.bootstrapRunId} does not belong to paper ${paperId}`);
    }
    return {
      provenanceKind: "legacy_bootstrap",
      bootstrapRunId: input.bootstrapRunId,
    };
  }

  const latestExtractionRun = await tx.extractionRun.findFirst({
    where: { paperId },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latestExtractionRun) {
    return {
      provenanceKind: "extraction",
      extractionRunId: latestExtractionRun.id,
    };
  }

  const latestBootstrapRun = await tx.legacyPublicationBootstrapRun.findFirst({
    where: { paperId },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latestBootstrapRun) {
    return {
      provenanceKind: "legacy_bootstrap",
      bootstrapRunId: latestBootstrapRun.id,
    };
  }

  throw new Error(`paper ${paperId} has no extraction or bootstrap evidence root`);
}

async function resolveEvidenceRootFromIdentityResolution(
  tx: FigureOperatorTx,
  identityResolutionId: string,
): Promise<{
  paperId: string;
  root: EvidenceRoot;
}> {
  const resolution = await tx.identityResolution.findUnique({
    where: { id: identityResolutionId },
    select: {
      paperId: true,
      provenanceKind: true,
      extractionRunId: true,
      bootstrapRunId: true,
    },
  });

  if (!resolution) {
    throw new Error(`identity resolution ${identityResolutionId} not found`);
  }

  if (resolution.provenanceKind === "extraction" && resolution.extractionRunId) {
    return {
      paperId: resolution.paperId,
      root: {
        provenanceKind: "extraction",
        extractionRunId: resolution.extractionRunId,
      },
    };
  }

  if (resolution.provenanceKind === "legacy_bootstrap" && resolution.bootstrapRunId) {
    return {
      paperId: resolution.paperId,
      root: {
        provenanceKind: "legacy_bootstrap",
        bootstrapRunId: resolution.bootstrapRunId,
      },
    };
  }

  throw new Error(`identity resolution ${identityResolutionId} is missing provenance root`);
}

function figureCandidateToMergeable(
  candidate: {
    sourceMethod: string;
    figureLabelRaw: string | null;
    captionTextRaw: string | null;
    structuredContentRaw: string | null;
    diagnostics: string | null;
    pageAnchorCandidate: string | null;
    type: string;
    confidence: string | null;
    nativeAsset: {
      storagePath: string;
      contentHash: string;
      width: number | null;
      height: number | null;
    } | null;
  },
): MergeableFigure {
  const diagnostics = parseJson<CandidateDiagnostics>(candidate.diagnostics);
  const pageAnchor = parseJson<PageAnchorCandidate>(candidate.pageAnchorCandidate);

  return {
    figureLabel: candidate.figureLabelRaw,
    captionText: candidate.captionTextRaw,
    captionSource: diagnostics?.captionSource ?? "none",
    sourceMethod: candidate.sourceMethod,
    sourceUrl: diagnostics?.sourceUrl ?? null,
    confidence: candidate.confidence ?? "medium",
    description: candidate.structuredContentRaw,
    imagePath: candidate.nativeAsset?.storagePath ?? diagnostics?.imagePath ?? null,
    assetHash: candidate.nativeAsset?.contentHash ?? null,
    pdfPage: pageAnchor?.pdfPage ?? null,
    bbox: pageAnchor?.bbox ?? null,
    type: candidate.type,
    width: candidate.nativeAsset?.width ?? diagnostics?.width ?? null,
    height: candidate.nativeAsset?.height ?? diagnostics?.height ?? null,
    cropOutcome: diagnostics?.cropOutcome ?? null,
  };
}

async function rebuildMergedFiguresFromEvidenceRoot(
  tx: FigureOperatorTx,
  paperId: string,
  root: EvidenceRoot,
) {
  const candidates = await tx.figureCandidate.findMany({
    where: root.provenanceKind === "extraction"
      ? {
        paperId,
        extractionRunId: root.extractionRunId,
      }
      : {
        paperId,
        bootstrapRunId: root.bootstrapRunId,
      },
    include: {
      nativeAsset: {
        select: {
          storagePath: true,
          contentHash: true,
          width: true,
          height: true,
        },
      },
    },
    orderBy: [{ sourceMethod: "asc" }, { sourceOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  const grouped = new Map<string, MergeableFigure[]>();
  for (const candidate of candidates) {
    const mergeable = figureCandidateToMergeable(candidate);
    const existing = grouped.get(candidate.sourceMethod);
    if (existing) {
      existing.push(mergeable);
    } else {
      grouped.set(candidate.sourceMethod, [mergeable]);
    }
  }

  return mergeFigureSources(...Array.from(grouped.values()));
}

export async function createFigureCapabilitySnapshotForPaper(paperId: string) {
  const paper = await loadPaperExtractionInput(paperId);
  return prisma.$transaction((tx) => prepareCapabilitySnapshotForExtraction(tx, paper));
}

export async function extractFigureEvidenceOnly(
  paperId: string,
  opts?: { maxPages?: number; skipPdf?: boolean },
) {
  const paper = await loadPaperExtractionInput(paperId);
  const capabilitySnapshot = await prisma.$transaction((tx) => prepareCapabilitySnapshotForExtraction(tx, paper));
  const { sourceBatches, sourceReport, allSources } = await collectFigureSourceBatches(
    paper,
    capabilitySnapshot,
    opts,
  );
  const merged = mergeFigureSources(...allSources);

  const extractionRunId = await prisma.$transaction((tx) => persistExtractionEvidence(
    tx,
    paperId,
    capabilitySnapshot.capabilitySnapshotId,
    sourceBatches,
    {
      coverageClass: capabilitySnapshot.coverageClass,
      mergedCount: merged.length,
      sourceReport,
      skipPdf: opts?.skipPdf ?? false,
      maxPages: opts?.maxPages || 50,
      mode: "evidence_only",
    },
  ));

  return {
    capabilitySnapshotId: capabilitySnapshot.capabilitySnapshotId,
    coverageClass: capabilitySnapshot.coverageClass,
    extractionRunId,
    sourceReport,
    mergedCount: merged.length,
  };
}

export async function resolveFigureIdentities(
  paperId: string,
  input?: Partial<EvidenceRoot>,
) {
  return prisma.$transaction(async (tx) => {
    const root = await resolveEvidenceRoot(tx, paperId, input);
    const identityResolutionId = await createIdentityResolutionSnapshot(tx, {
      paperId,
      ...root,
    });
    return {
      identityResolutionId,
      ...root,
    };
  });
}

export async function createFigureProjection(
  paperId: string,
  identityResolutionId: string,
) {
  return prisma.$transaction(async (tx) => {
    const identityResolution = await tx.identityResolution.findUnique({
      where: { id: identityResolutionId },
      select: { paperId: true },
    });
    if (!identityResolution || identityResolution.paperId !== paperId) {
      throw new Error(`identity resolution ${identityResolutionId} does not belong to paper ${paperId}`);
    }

    const projectionRunId = await createProjectionRunSnapshot(tx, paperId, identityResolutionId);
    return { projectionRunId };
  });
}

export async function publishFigureProjection(
  paperId: string,
  identityResolutionId: string,
  projectionRunId: string,
  force: boolean = false,
) {
  return prisma.$transaction(async (tx) => {
    const { paperId: resolutionPaperId, root } = await resolveEvidenceRootFromIdentityResolution(
      tx,
      identityResolutionId,
    );
    if (resolutionPaperId !== paperId) {
      throw new Error(`identity resolution ${identityResolutionId} does not belong to paper ${paperId}`);
    }

    const merged = await rebuildMergedFiguresFromEvidenceRoot(tx, paperId, root);
    const leaseToken = await acquirePaperWorkLease(tx, paperId, "figure-ops:publish-projection");

    try {
      await publishProjectionRun(
        tx,
        paperId,
        identityResolutionId,
        projectionRunId,
        merged,
        leaseToken,
        force ? "forced" : "normal",
      );
    } finally {
      await releasePaperWorkLease(tx, paperId, leaseToken);
    }

    return {
      projectionRunId,
      identityResolutionId,
      ...root,
    };
  });
}

export async function publishFigurePreviewSelection(
  paperId: string,
  previewSelectionRunId: string,
  expectedProjectionRunId?: string | null,
  force: boolean = false,
) {
  return prisma.$transaction(async (tx) => {
    const leaseToken = await acquirePaperWorkLease(tx, paperId, "figure-ops:publish-preview-selection");
    try {
      await publishPreviewSelectionRun(
        tx,
        paperId,
        previewSelectionRunId,
        leaseToken,
        expectedProjectionRunId ?? null,
        force ? "forced" : "normal",
      );
    } finally {
      await releasePaperWorkLease(tx, paperId, leaseToken);
    }
    return { previewSelectionRunId };
  });
}

export async function rebuildFiguresFromEvidence(
  paperId: string,
  input?: Partial<EvidenceRoot>,
  force: boolean = false,
) {
  return prisma.$transaction(async (tx) => {
    const root = await resolveEvidenceRoot(tx, paperId, input);
    const merged = await rebuildMergedFiguresFromEvidenceRoot(tx, paperId, root);
    const leaseToken = await acquirePaperWorkLease(tx, paperId, "figure-ops:rebuild-from-evidence");

    try {
      const identityResolutionId = await createIdentityResolutionSnapshot(tx, {
        paperId,
        ...root,
      });
      const projectionRunId = await createProjectionRunSnapshot(tx, paperId, identityResolutionId);
      await publishProjectionRun(
        tx,
        paperId,
        identityResolutionId,
        projectionRunId,
        merged,
        leaseToken,
        force ? "forced" : "normal",
      );
      return {
        identityResolutionId,
        projectionRunId,
        mergedCount: merged.length,
        ...root,
      };
    } finally {
      await releasePaperWorkLease(tx, paperId, leaseToken);
    }
  });
}

export async function renderFigurePreviews(paperId: string) {
  return renderTablePreviews(paperId);
}

export async function bootstrapLegacyFigurePublication(paperId: string): Promise<LegacyBootstrapResult> {
  return bootstrapLegacyPublication(paperId);
}

export const figureOperatorInternals = {
  figureCandidateToMergeable,
};
