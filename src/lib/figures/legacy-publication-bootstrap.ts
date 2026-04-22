import { createHash } from "crypto";
import { stat } from "fs/promises";
import path from "path";
import { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import type { MergedFigure } from "./source-merger";
import { normalizeLabel } from "./label-utils";
import { extractionFoundationInternals } from "./extraction-foundation";
import { createIdentityResolutionSnapshot } from "./identity-resolution";
import {
  createProjectionRunSnapshot,
  publishProjectionRun,
} from "./projection-publication";
import {
  acquirePaperWorkLease,
  releasePaperWorkLease,
} from "./publication-guards";

export const LEGACY_PUBLICATION_BOOTSTRAP_VERSION = "legacy-publication-bootstrap-v1";

type LegacyBootstrapTx = Prisma.TransactionClient;

interface LegacyPaperFigureRow {
  id: string;
  publishedFigureHandleId: string | null;
  figureLabel: string | null;
  captionText: string | null;
  captionSource: string;
  description: string | null;
  sourceMethod: string;
  sourceUrl: string | null;
  confidence: string;
  imagePath: string | null;
  assetHash: string | null;
  pdfPage: number | null;
  bbox: string | null;
  type: string;
  width: number | null;
  height: number | null;
  gapReason: string | null;
  imageSourceMethod: string | null;
  figureIndex: number;
  isPrimaryExtraction: boolean;
}

function guessMimeType(storagePath: string): string | null {
  const ext = path.extname(storagePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

function stripCompatibilityFigureLabel(label: string | null): string | null {
  if (!label) return null;
  return label.startsWith("uncaptioned-") ? null : label;
}

function deriveLegacyAssetHash(paperId: string, figure: LegacyPaperFigureRow): string | null {
  if (!figure.imagePath) return null;
  if (figure.assetHash) return figure.assetHash;
  return createHash("sha1")
    .update(JSON.stringify({
      paperId,
      legacyPaperFigureId: figure.id,
      imagePath: figure.imagePath,
    }))
    .digest("hex");
}

function buildLegacySourceLocalLocator(
  paperId: string,
  figure: LegacyPaperFigureRow,
  sourceOrder: number,
): string {
  if (figure.publishedFigureHandleId) {
    return `legacy_bootstrap:handle:${figure.publishedFigureHandleId}`;
  }
  const normalizedLabel = normalizeLabel(stripCompatibilityFigureLabel(figure.figureLabel));
  if (normalizedLabel) {
    return `legacy_bootstrap:label:${normalizedLabel}:idx:${sourceOrder}`;
  }
  const assetHash = deriveLegacyAssetHash(paperId, figure);
  if (assetHash) {
    return `legacy_bootstrap:asset:${assetHash}`;
  }
  return `legacy_bootstrap:paper_figure:${figure.id}`;
}

function inferLegacyNativePreviewTrust(figure: LegacyPaperFigureRow): string {
  if (!figure.imagePath) return "none";
  const previewSource = figure.imageSourceMethod ?? figure.sourceMethod;
  if (
    previewSource === "pdf_render_crop"
    || previewSource === "pdf_structural"
    || previewSource === "pdf_table_rows"
    || previewSource === "pdf_embedded"
  ) {
    return "untrusted_native";
  }
  return "trusted_native";
}

function buildLegacyPageAnchorCandidate(figure: LegacyPaperFigureRow): string | null {
  if (figure.pdfPage == null && !figure.bbox) return null;
  return JSON.stringify({
    pdfPage: figure.pdfPage ?? null,
    bbox: figure.bbox ?? null,
  });
}

function legacyFigureToMergeable(figure: LegacyPaperFigureRow): MergedFigure {
  return {
    figureLabel: stripCompatibilityFigureLabel(figure.figureLabel),
    captionText: figure.captionText,
    captionSource: figure.captionSource,
    description: figure.description,
    sourceMethod: figure.sourceMethod,
    sourceUrl: figure.sourceUrl,
    confidence: figure.confidence,
    imagePath: figure.imagePath,
    assetHash: figure.assetHash,
    pdfPage: figure.pdfPage,
    bbox: figure.bbox,
    type: figure.type,
    width: figure.width,
    height: figure.height,
    gapReason: figure.gapReason,
    imageSourceMethod: figure.imageSourceMethod,
    isPrimaryExtraction: figure.isPrimaryExtraction,
  };
}

async function ensureLegacyBootstrapAsset(
  tx: LegacyBootstrapTx,
  paperId: string,
  figure: LegacyPaperFigureRow,
  cache: Map<string, string>,
): Promise<string | null> {
  if (!figure.imagePath) return null;

  const contentHash = deriveLegacyAssetHash(paperId, figure);
  if (!contentHash) return null;

  const cacheKey = `${paperId}:${contentHash}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const absolutePath = path.isAbsolute(figure.imagePath)
    ? figure.imagePath
    : path.join(process.cwd(), figure.imagePath);

  let byteSize: number | null = null;
  try {
    const fileStat = await stat(absolutePath);
    byteSize = Math.min(fileStat.size, 2_147_483_647);
  } catch {
    byteSize = null;
  }

  const previewSourceMethod = figure.imageSourceMethod ?? figure.sourceMethod;
  const asset = await tx.asset.upsert({
    where: {
      paperId_contentHash: {
        paperId,
        contentHash,
      },
    },
    create: {
      paperId,
      contentHash,
      storagePath: figure.imagePath,
      mimeType: guessMimeType(figure.imagePath),
      byteSize,
      width: figure.width,
      height: figure.height,
      assetKind: extractionFoundationInternals.inferAssetKind(previewSourceMethod),
      producerType: "ingester",
      producerVersion: LEGACY_PUBLICATION_BOOTSTRAP_VERSION,
    },
    update: {
      storagePath: figure.imagePath,
      mimeType: guessMimeType(figure.imagePath),
      byteSize,
      width: figure.width,
      height: figure.height,
      assetKind: extractionFoundationInternals.inferAssetKind(previewSourceMethod),
      producerType: "ingester",
      producerVersion: LEGACY_PUBLICATION_BOOTSTRAP_VERSION,
    },
    select: { id: true },
  });

  cache.set(cacheKey, asset.id);
  return asset.id;
}

async function createBootstrapCandidates(
  tx: LegacyBootstrapTx,
  paperId: string,
  bootstrapRunId: string,
  figures: LegacyPaperFigureRow[],
): Promise<void> {
  const createdAt = new Date();
  const assetCache = new Map<string, string>();

  for (let sourceOrder = 0; sourceOrder < figures.length; sourceOrder += 1) {
    const figure = figures[sourceOrder];
    const nativeAssetId = await ensureLegacyBootstrapAsset(tx, paperId, figure, assetCache);
    const mergeable = legacyFigureToMergeable(figure);
    const diagnostics = {
      captionSource: figure.captionSource,
      sourceUrl: figure.sourceUrl ?? null,
      cropOutcome: null,
      imagePath: figure.imagePath ?? null,
      width: figure.width ?? null,
      height: figure.height ?? null,
      legacyPaperFigureId: figure.id,
      legacyPublishedFigureHandleId: figure.publishedFigureHandleId,
      legacyImageSourceMethod: figure.imageSourceMethod,
      legacyIsPrimaryExtraction: figure.isPrimaryExtraction,
    };

    await tx.figureCandidate.create({
      data: {
        paperId,
        extractionRunId: null,
        bootstrapRunId,
        candidateOrigin: "legacy_bootstrap",
        sourceMethod: figure.sourceMethod,
        type: figure.type,
        sourceLocalLocator: buildLegacySourceLocalLocator(paperId, figure, sourceOrder),
        locatorSupport: "derived",
        sourceNamespace: null,
        sourceOrder,
        figureLabelRaw: stripCompatibilityFigureLabel(figure.figureLabel),
        figureLabelNormalized: normalizeLabel(stripCompatibilityFigureLabel(figure.figureLabel)),
        captionTextRaw: figure.captionText,
        structuredContentRaw: figure.description,
        structuredContentType: extractionFoundationInternals.inferStructuredContentType(mergeable),
        nativeAssetId,
        nativePreviewTrust: inferLegacyNativePreviewTrust(figure),
        pageAnchorCandidate: buildLegacyPageAnchorCandidate(figure),
        confidence: figure.confidence,
        diagnostics: JSON.stringify(diagnostics),
        createdAt,
      },
    });
  }
}

export interface LegacyBootstrapResult {
  bootstrapRunId: string;
  identityResolutionId: string;
  projectionRunId: string;
  candidateCount: number;
}

export async function bootstrapLegacyPublication(
  paperId: string,
): Promise<LegacyBootstrapResult> {
  return prisma.$transaction(async (tx) => {
    const paper = await tx.paper.findUnique({
      where: { id: paperId },
      select: {
        id: true,
        title: true,
      },
    });

    if (!paper) {
      throw new Error(`paper ${paperId} not found`);
    }

    const figures = await tx.paperFigure.findMany({
      where: { paperId },
      select: {
        id: true,
        publishedFigureHandleId: true,
        figureLabel: true,
        captionText: true,
        captionSource: true,
        description: true,
        sourceMethod: true,
        sourceUrl: true,
        confidence: true,
        imagePath: true,
        assetHash: true,
        pdfPage: true,
        bbox: true,
        type: true,
        width: true,
        height: true,
        gapReason: true,
        imageSourceMethod: true,
        figureIndex: true,
        isPrimaryExtraction: true,
      },
      orderBy: [
        { isPrimaryExtraction: "desc" },
        { figureIndex: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
    });

    if (figures.length === 0) {
      throw new Error(`paper ${paperId} has no PaperFigure rows to bootstrap`);
    }

    const publicationState = await tx.paperPublicationState.findUnique({
      where: { paperId },
      select: {
        activeProjectionRunId: true,
      },
    });

    if (publicationState?.activeProjectionRunId) {
      throw new Error(`paper ${paperId} already has an active projection; bootstrap is only for legacy papers`);
    }

    const leaseToken = await acquirePaperWorkLease(
      tx,
      paperId,
      "bootstrap-legacy-publication",
    );

    try {
      const bootstrapRun = await tx.legacyPublicationBootstrapRun.create({
        data: {
          paperId,
          status: "running",
          metadata: JSON.stringify({
            paperTitle: paper.title,
            legacyPaperFigureCount: figures.length,
          }),
        },
        select: { id: true },
      });

      await createBootstrapCandidates(tx, paperId, bootstrapRun.id, figures);

      const identityResolutionId = await createIdentityResolutionSnapshot(tx, {
        paperId,
        provenanceKind: "legacy_bootstrap",
        bootstrapRunId: bootstrapRun.id,
      });
      const projectionRunId = await createProjectionRunSnapshot(tx, paperId, identityResolutionId);
      const mergedAlternates = figures
        .filter((figure) => !figure.isPrimaryExtraction)
        .map(legacyFigureToMergeable);

      await publishProjectionRun(
        tx,
        paperId,
        identityResolutionId,
        projectionRunId,
        mergedAlternates,
        leaseToken,
      );

      await tx.legacyPublicationBootstrapRun.update({
        where: { id: bootstrapRun.id },
        data: {
          status: "completed",
          completedAt: new Date(),
        },
      });

      await tx.paperMigrationState.upsert({
        where: { paperId },
        create: {
          paperId,
          latestBootstrapRunId: bootstrapRun.id,
          migrationState: "bootstrapped",
        },
        update: {
          latestBootstrapRunId: bootstrapRun.id,
          migrationState: "bootstrapped",
        },
      });

      return {
        bootstrapRunId: bootstrapRun.id,
        identityResolutionId,
        projectionRunId,
        candidateCount: figures.length,
      };
    } finally {
      await releasePaperWorkLease(tx, paperId, leaseToken);
    }
  });
}

export const legacyPublicationBootstrapInternals = {
  stripCompatibilityFigureLabel,
  deriveLegacyAssetHash,
  buildLegacySourceLocalLocator,
  inferLegacyNativePreviewTrust,
  legacyFigureToMergeable,
};
