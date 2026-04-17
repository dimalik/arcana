import type { Prisma } from "@prisma/client";

export const FIGURE_VIEW_SELECT = {
  id: true,
  paperId: true,
  publishedFigureHandleId: true,
  figureLabel: true,
  captionText: true,
  captionSource: true,
  description: true,
  sourceMethod: true,
  sourceUrl: true,
  sourceVersion: true,
  confidence: true,
  imagePath: true,
  assetHash: true,
  pdfPage: true,
  sourcePage: true,
  figureIndex: true,
  bbox: true,
  type: true,
  parentFigureId: true,
  isPrimaryExtraction: true,
  width: true,
  height: true,
  gapReason: true,
  imageSourceMethod: true,
  createdAt: true,
} satisfies Prisma.PaperFigureSelect;

type PaperFigureViewRecord = Prisma.PaperFigureGetPayload<{
  select: typeof FIGURE_VIEW_SELECT;
}>;

export interface PaperFigureView {
  id: string;
  paperId: string;
  publishedFigureHandleId: string | null;
  figureLabel: string | null;
  captionText: string | null;
  captionSource: string;
  description: string | null;
  sourceMethod: string;
  sourceUrl: string | null;
  sourceVersion: string | null;
  confidence: string;
  imagePath: string | null;
  assetHash: string | null;
  pdfPage: number | null;
  sourcePage: number | null;
  figureIndex: number;
  bbox: string | null;
  type: string;
  parentFigureId: string | null;
  isPrimaryExtraction: boolean;
  width: number | null;
  height: number | null;
  gapReason: string | null;
  imageSourceMethod: string | null;
  createdAt: Date;
}

export function mapPaperFigureToView(row: PaperFigureViewRecord): PaperFigureView {
  return {
    id: row.id,
    paperId: row.paperId,
    publishedFigureHandleId: row.publishedFigureHandleId,
    figureLabel: row.figureLabel,
    captionText: row.captionText,
    captionSource: row.captionSource,
    description: row.description,
    sourceMethod: row.sourceMethod,
    sourceUrl: row.sourceUrl,
    sourceVersion: row.sourceVersion,
    confidence: row.confidence,
    imagePath: row.imagePath,
    assetHash: row.assetHash,
    pdfPage: row.pdfPage,
    sourcePage: row.sourcePage,
    figureIndex: row.figureIndex,
    bbox: row.bbox,
    type: row.type,
    parentFigureId: row.parentFigureId,
    isPrimaryExtraction: row.isPrimaryExtraction,
    width: row.width,
    height: row.height,
    gapReason: row.gapReason,
    imageSourceMethod: row.imageSourceMethod,
    createdAt: row.createdAt,
  };
}

export function mapPaperFiguresToView(rows: PaperFigureViewRecord[]): PaperFigureView[] {
  return rows.map(mapPaperFigureToView);
}
