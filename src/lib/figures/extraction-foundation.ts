import path from "path";
import { Prisma } from "@prisma/client";
import type { FigureCandidateCreateManyInput } from "@/generated/prisma/models/FigureCandidate";

import { normalizeLabel } from "./label-utils";
import type { MergeableFigure } from "./source-merger";

export interface ExtractionSourceBatch {
  method: string;
  attempted: boolean;
  figures: MergeableFigure[];
  error?: string;
}

export const FIGURE_EXTRACTION_FOUNDATION_VERSION = "figure-extraction-foundation-v1";

type FigureFoundationTx = Prisma.TransactionClient;

function classifyAttemptStatus(batch: ExtractionSourceBatch): string {
  if (!batch.attempted) return "skipped";
  if (batch.error) return batch.figures.length > 0 ? "partial" : "failed";
  return "succeeded";
}

function inferAssetKind(sourceMethod: string): string {
  if (sourceMethod === "pdf_render_crop") return "pdf_crop";
  if (sourceMethod === "html_table_render") return "rendered_preview";
  return "native_source";
}

function inferNativePreviewTrust(fig: MergeableFigure): string {
  if (!fig.imagePath) return "none";
  if (
    fig.sourceMethod === "grobid_tei"
    || fig.sourceMethod === "pdf_render_crop"
    || fig.sourceMethod === "pdf_structural"
  ) {
    return "untrusted_native";
  }
  return "trusted_native";
}

function inferStructuredContentType(fig: MergeableFigure): string | null {
  if (!fig.description) return null;
  if (/<table\b/i.test(fig.description)) return "html_table";
  if (/ltx_tabular/i.test(fig.description)) return "latex_table";
  return fig.type === "table" ? "table_structured" : "structured_text";
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

function buildSourceLocalLocator(fig: MergeableFigure, sourceOrder: number): string {
  const normalizedLabel = normalizeLabel(fig.figureLabel);
  if (fig.assetHash) return `${fig.sourceMethod}:asset:${fig.assetHash}`;
  if (normalizedLabel) return `${fig.sourceMethod}:label:${normalizedLabel}:idx:${sourceOrder}`;
  if (fig.pdfPage != null) return `${fig.sourceMethod}:page:${fig.pdfPage}:idx:${sourceOrder}`;
  return `${fig.sourceMethod}:idx:${sourceOrder}`;
}

function buildPageAnchorCandidate(fig: MergeableFigure): string | null {
  if (fig.pdfPage == null && !fig.bbox) return null;
  return JSON.stringify({
    pdfPage: fig.pdfPage ?? null,
    bbox: fig.bbox ?? null,
  });
}

async function ensureAsset(
  tx: FigureFoundationTx,
  paperId: string,
  fig: MergeableFigure,
  cache: Map<string, string>,
): Promise<string | null> {
  if (!fig.imagePath || !fig.assetHash) return null;

  const cacheKey = `${paperId}:${fig.assetHash}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  let byteSize: number | null = null;
  try {
    // Dynamic imports avoid Turbopack TP1004 path-analysis warnings for fs access.
    const fs = await import("fs/promises");
    const pathModule = await import("path");
    const absolutePath = pathModule.resolve(process.cwd(), fig.imagePath);
    const fileStat = await fs.stat(absolutePath);
    byteSize = Math.min(fileStat.size, 2_147_483_647);
  } catch {
    byteSize = null;
  }

  const asset = await tx.asset.upsert({
    where: {
      paperId_contentHash: {
        paperId,
        contentHash: fig.assetHash,
      },
    },
    create: {
      paperId,
      contentHash: fig.assetHash,
      storagePath: fig.imagePath,
      mimeType: guessMimeType(fig.imagePath),
      byteSize,
      width: fig.width,
      height: fig.height,
      assetKind: inferAssetKind(fig.sourceMethod),
      producerType: "extractor",
      producerVersion: FIGURE_EXTRACTION_FOUNDATION_VERSION,
    },
    update: {
      storagePath: fig.imagePath,
      mimeType: guessMimeType(fig.imagePath),
      byteSize,
      width: fig.width,
      height: fig.height,
      assetKind: inferAssetKind(fig.sourceMethod),
      producerType: "extractor",
      producerVersion: FIGURE_EXTRACTION_FOUNDATION_VERSION,
    },
    select: { id: true },
  });

  cache.set(cacheKey, asset.id);
  return asset.id;
}

export async function persistExtractionEvidence(
  tx: FigureFoundationTx,
  paperId: string,
  capabilitySnapshotId: string,
  sourceBatches: ExtractionSourceBatch[],
  metadata?: Record<string, unknown>,
): Promise<string> {
  const extractionRun = await tx.extractionRun.create({
    data: {
      paperId,
      capabilitySnapshotId,
      extractorVersion: FIGURE_EXTRACTION_FOUNDATION_VERSION,
      status: "running",
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
    select: { id: true },
  });

  const createdAt = new Date();
  await tx.extractionSourceAttempt.createMany({
    data: sourceBatches.map((batch) => ({
      extractionRunId: extractionRun.id,
      source: batch.method,
      status: classifyAttemptStatus(batch),
      figuresFound: batch.figures.length,
      errorSummary: batch.error ?? null,
      metadata: JSON.stringify({ attempted: batch.attempted }),
      createdAt,
    })),
  });

  const assetCache = new Map<string, string>();
  const candidateData: FigureCandidateCreateManyInput[] = [];

  for (const batch of sourceBatches) {
    for (let sourceOrder = 0; sourceOrder < batch.figures.length; sourceOrder += 1) {
      const fig = batch.figures[sourceOrder];
      const nativeAssetId = await ensureAsset(tx, paperId, fig, assetCache);
      const diagnostics = {
        captionSource: fig.captionSource,
        sourceUrl: fig.sourceUrl ?? null,
        cropOutcome: fig.cropOutcome ?? null,
        imagePath: fig.imagePath ?? null,
        width: fig.width ?? null,
        height: fig.height ?? null,
      };

      candidateData.push({
        paperId,
        extractionRunId: extractionRun.id,
        candidateOrigin: "extracted",
        sourceMethod: fig.sourceMethod,
        type: fig.type,
        sourceLocalLocator: buildSourceLocalLocator(fig, sourceOrder),
        locatorSupport: "derived",
        sourceNamespace: null,
        sourceOrder,
        figureLabelRaw: fig.figureLabel,
        figureLabelNormalized: normalizeLabel(fig.figureLabel),
        captionTextRaw: fig.captionText,
        structuredContentRaw: fig.description ?? null,
        structuredContentType: inferStructuredContentType(fig),
        nativeAssetId,
        nativePreviewTrust: inferNativePreviewTrust(fig),
        pageAnchorCandidate: buildPageAnchorCandidate(fig),
        confidence: fig.confidence,
        diagnostics: JSON.stringify(diagnostics),
        createdAt,
      });
    }
  }

  if (candidateData.length > 0) {
    await tx.figureCandidate.createMany({ data: candidateData });
  }

  await tx.extractionRun.update({
    where: { id: extractionRun.id },
    data: {
      status: "completed",
      completedAt: new Date(),
    },
  });

  return extractionRun.id;
}

export const extractionFoundationInternals = {
  classifyAttemptStatus,
  inferAssetKind,
  inferNativePreviewTrust,
  inferStructuredContentType,
  buildSourceLocalLocator,
  buildPageAnchorCandidate,
};
