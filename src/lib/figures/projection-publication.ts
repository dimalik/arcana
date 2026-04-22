import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";

import { normalizeLabel } from "./label-utils";
import {
  applyPreviewSelectionOverrides,
  applyProjectionFigureOverrides,
  FIGURE_OVERRIDE_STAGE_PREVIEW,
  FIGURE_OVERRIDE_STAGE_PROJECTION,
  loadActiveFigureOverrides,
} from "./figure-overrides";
import {
  comparePreviewSelections,
  compareProjectionRuns,
  type PublicationMode,
} from "./publication-comparison";
import {
  assertPaperWorkLease,
  validatePreviewSelectionRunForPublication,
  validateProjectionRunForPublication,
} from "./publication-guards";
import { getPriority, type MergedFigure } from "./source-merger";

export const FIGURE_PROJECTION_VERSION = "figure-projection-v1";
export const FIGURE_PREVIEW_SELECTION_VERSION = "figure-preview-selection-v1";
export const FIGURE_HANDLE_ASSIGNMENT_VERSION = "figure-handle-assignment-v1";

type FigurePublicationTx = Prisma.TransactionClient;

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

interface ProjectableCandidate {
  id: string;
  sourceMethod: string;
  sourceOrder: number;
  figureLabel: string | null;
  captionText: string | null;
  captionSource: string;
  sourceUrl: string | null;
  confidence: string;
  imagePath: string | null;
  assetHash: string | null;
  pdfPage: number | null;
  bbox: string | null;
  type: string;
  width: number | null;
  height: number | null;
  description: string | null;
  structuredContentType: string | null;
  cropOutcome: "success" | "rejected" | "failed" | null;
}

interface ProjectionFigureDraft {
  figureIdentityId: string;
  identityKey: string;
  sourceMethod: string;
  imageSourceMethod: string | null;
  pageSourceMethod: string | null;
  contentCandidateId: string;
  basePreviewCandidateId: string | null;
  pageAnchorCandidateId: string | null;
  figureLabel: string | null;
  captionText: string | null;
  captionSource: string;
  structuredContent: string | null;
  structuredContentType: string | null;
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
  sortHintPage: number | null;
  sortHintOrder: number;
  sortHintLabel: string;
}

interface PreviewSelectionDraft {
  projectionFigureId: string;
  identityKey: string;
  selectedPreviewSource: string;
  selectedPreviewSourceMethod: string | null;
  selectedAssetId: string | null;
  selectedRenderedPreviewId: string | null;
  selectedNativeCandidateId: string | null;
}

interface PreviewProjectionFigure {
  id: string;
  figureIdentityId: string;
  identityKey: string;
  publishedFigureHandleId: string | null;
  sourceMethod: string;
  imageSourceMethod: string | null;
  basePreviewCandidateId: string | null;
  figureLabel: string | null;
  captionText: string | null;
  captionSource: string;
  structuredContent: string | null;
  structuredContentType: string | null;
  sourceUrl: string | null;
  confidence: string | null;
  pdfPage: number | null;
  bbox: string | null;
  type: string;
  width: number | null;
  height: number | null;
  gapReason: string | null;
}

interface PreviousPreviewSelection {
  projectionFigureId: string;
  identityKey: string;
  selectedPreviewSource: string;
  selectedPreviewSourceMethod: string | null;
  selectedAssetId: string | null;
  selectedRenderedPreviewId: string | null;
  selectedNativeCandidateId: string | null;
  type: string;
  sourceMethod: string;
  structuredContent: string | null;
}

interface PreviewSelectionReplacement {
  projectionFigureId: string;
  assetId: string;
  renderedPreviewId: string;
  sourceMethod: string;
}

interface CurrentProjectionHandleInput {
  projectionFigureId: string;
  identityKey: string;
}

interface PreviousPublishedHandleInput {
  projectionFigureId: string;
  identityKey: string;
  publishedFigureHandleId: string;
}

interface PlannedHandleAssignment {
  projectionFigureId: string;
  assignmentDecision: "reuse" | "new";
  predecessorProjectionFigureId: string | null;
  publishedFigureHandleId: string | null;
  handleAssignmentEvidenceType: string;
  handleAssignmentEvidenceIds: string;
}

interface ExistingPrimaryPaperFigureRow {
  id: string;
  publishedFigureHandleId: string | null;
}

interface CurrentProjectionHandleRow {
  id: string;
  figureIdentity: {
    identityKey: string;
  };
}

interface PreviousProjectionHandleRow {
  id: string;
  publishedFigureHandleId: string | null;
  figureIdentity: {
    identityKey: string;
  };
}

interface RenderedPreviewAssetInput {
  storagePath: string;
  contentHash: string;
  width: number | null;
  height: number | null;
  byteSize: number | null;
}

function safeParseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function candidateToProjectable(
  candidate: {
    id: string;
    sourceMethod: string;
    sourceOrder: number;
    figureLabelRaw: string | null;
    captionTextRaw: string | null;
    structuredContentRaw: string | null;
    structuredContentType: string | null;
    pageAnchorCandidate: string | null;
    diagnostics: string | null;
    type: string;
    confidence: string | null;
    nativeAsset: {
      storagePath: string;
      contentHash: string;
      width: number | null;
      height: number | null;
    } | null;
  },
): ProjectableCandidate {
  const diagnostics = safeParseJson<CandidateDiagnostics>(candidate.diagnostics);
  const pageAnchor = safeParseJson<PageAnchorCandidate>(candidate.pageAnchorCandidate);

  return {
    id: candidate.id,
    sourceMethod: candidate.sourceMethod,
    sourceOrder: candidate.sourceOrder,
    figureLabel: candidate.figureLabelRaw,
    captionText: candidate.captionTextRaw,
    captionSource: diagnostics?.captionSource ?? "none",
    sourceUrl: diagnostics?.sourceUrl ?? null,
    confidence: candidate.confidence ?? "medium",
    imagePath: candidate.nativeAsset?.storagePath ?? diagnostics?.imagePath ?? null,
    assetHash: candidate.nativeAsset?.contentHash ?? null,
    pdfPage: pageAnchor?.pdfPage ?? null,
    bbox: pageAnchor?.bbox ?? null,
    type: candidate.type,
    width: candidate.nativeAsset?.width ?? diagnostics?.width ?? null,
    height: candidate.nativeAsset?.height ?? diagnostics?.height ?? null,
    description: candidate.structuredContentRaw,
    structuredContentType: candidate.structuredContentType,
    cropOutcome: diagnostics?.cropOutcome ?? null,
  };
}

function sortProjectableCandidates(candidates: ProjectableCandidate[]): ProjectableCandidate[] {
  return [...candidates].sort((a, b) => {
    const priorityDelta = getPriority(a.sourceMethod) - getPriority(b.sourceMethod);
    if (priorityDelta !== 0) return priorityDelta;
    const orderDelta = a.sourceOrder - b.sourceOrder;
    if (orderDelta !== 0) return orderDelta;
    return a.id.localeCompare(b.id);
  });
}

function isUnlabeledPdfOnlyGroup(candidates: ProjectableCandidate[]): boolean {
  return candidates.every(
    (candidate) => !normalizeLabel(candidate.figureLabel)
      && (candidate.sourceMethod === "pdf_embedded"
        || candidate.sourceMethod === "grobid_tei"
        || candidate.sourceMethod === "pdf_render_crop"
        || candidate.sourceMethod === "pdf_structural"
        || candidate.sourceMethod === "pdf_table_rows"),
  );
}

function selectProjectionCanonicalMember(
  candidates: ProjectableCandidate[],
  isTable: boolean,
): ProjectableCandidate {
  if (isTable) {
    // Any present table description is real HTML markup (extractors filter layout tables); 20 is the minimum plausible <table>...</table>.
    return candidates.find((member) => member.description && member.description.length > 20)
      || candidates.find((member) => normalizeLabel(member.figureLabel) || member.captionText)
      || candidates.find((member) => member.imagePath)
      || candidates[0];
  }

  return candidates.find((member) => normalizeLabel(member.figureLabel) || member.captionText)
    || candidates.find((member) => member.imagePath)
    || candidates[0];
}

function buildProjectionFigureDraft(
  figureIdentityId: string,
  identityKey: string,
  members: ProjectableCandidate[],
): ProjectionFigureDraft | null {
  const sorted = sortProjectableCandidates(members);
  if (sorted.length === 0 || isUnlabeledPdfOnlyGroup(sorted)) {
    return null;
  }

  const isTable = sorted.some((member) => member.type === "table");
  const canonicalMember = selectProjectionCanonicalMember(sorted, isTable);

  const bestCaptionMember = sorted.find((member) => member.captionText) ?? null;
  const descriptionContributor = canonicalMember.description
    ? canonicalMember
    : (sorted.find((member) => member.description) ?? null);
  const finalDescription = descriptionContributor?.description ?? null;
  // Any present table description is real HTML markup (extractors filter layout tables); 20 is the minimum plausible <table>...</table>.
  const isStructuredTable = isTable && finalDescription != null && finalDescription.length > 20;

  let bestImageMember: ProjectableCandidate | null = null;
  if (canonicalMember.imagePath) {
    bestImageMember = canonicalMember;
  } else if (!isStructuredTable) {
    bestImageMember = sorted.find((member) => member.imagePath) ?? null;
  } else {
    const unsafeSources = new Set(["grobid_tei", "pdf_embedded", "pdf_render_crop", "pdf_structural", "pdf_table_rows"]);
    bestImageMember = sorted.find(
      (member) => member.imagePath && !unsafeSources.has(member.sourceMethod),
    ) ?? null;
  }

  const pageAnchorMember = canonicalMember.pdfPage != null || canonicalMember.bbox
    ? canonicalMember
    : (sorted.find((member) => member.pdfPage != null || member.bbox) ?? null);

  let gapReason: string | null = null;
  if (!bestImageMember?.imagePath) {
    if (isStructuredTable) {
      gapReason = "structured_content_no_preview";
    } else {
      const cropMember = sorted.find(
        (member) => member.cropOutcome === "failed" || member.cropOutcome === "rejected",
      );
      if (cropMember?.cropOutcome === "failed") {
        gapReason = "crop_failed";
      } else if (cropMember?.cropOutcome === "rejected") {
        gapReason = "crop_rejected";
      } else {
        gapReason = "no_image_candidate";
      }
    }
  }

  return {
    figureIdentityId,
    identityKey,
    sourceMethod: canonicalMember.sourceMethod,
    imageSourceMethod: bestImageMember?.sourceMethod ?? null,
    pageSourceMethod: pageAnchorMember?.sourceMethod ?? null,
    contentCandidateId: canonicalMember.id,
    basePreviewCandidateId: bestImageMember?.id ?? null,
    pageAnchorCandidateId: pageAnchorMember?.id ?? null,
    figureLabel: canonicalMember.figureLabel,
    captionText: bestCaptionMember?.captionText ?? null,
    captionSource: bestCaptionMember?.captionSource ?? canonicalMember.captionSource,
    structuredContent: finalDescription,
    structuredContentType: descriptionContributor?.structuredContentType ?? null,
    sourceUrl: canonicalMember.sourceUrl,
    confidence: canonicalMember.confidence,
    imagePath: bestImageMember?.imagePath ?? null,
    assetHash: bestImageMember?.assetHash ?? null,
    pdfPage: pageAnchorMember?.pdfPage ?? null,
    bbox: pageAnchorMember?.bbox ?? null,
    type: canonicalMember.type,
    width: bestImageMember?.width ?? null,
    height: bestImageMember?.height ?? null,
    gapReason,
    sortHintPage: pageAnchorMember?.pdfPage ?? null,
    sortHintOrder: canonicalMember.sourceOrder,
    sortHintLabel: normalizeLabel(canonicalMember.figureLabel) ?? `${canonicalMember.type}:${canonicalMember.id}`,
  };
}

function sortProjectionFigureDrafts(drafts: ProjectionFigureDraft[]): ProjectionFigureDraft[] {
  return [...drafts].sort((a, b) => {
    const aPage = a.sortHintPage ?? Number.MAX_SAFE_INTEGER;
    const bPage = b.sortHintPage ?? Number.MAX_SAFE_INTEGER;
    if (aPage !== bPage) return aPage - bPage;
    if (a.sortHintOrder !== b.sortHintOrder) return a.sortHintOrder - b.sortHintOrder;
    const labelDelta = a.sortHintLabel.localeCompare(b.sortHintLabel);
    if (labelDelta !== 0) return labelDelta;
    return a.figureIdentityId.localeCompare(b.figureIdentityId);
  });
}

function buildCompatibilityFigureLabel(
  figureLabel: string | null,
  assetHash: string | null,
  pdfPage: number | null,
  figureIndex: number,
): string {
  if (figureLabel) return figureLabel;
  if (assetHash) return `uncaptioned-${assetHash.slice(0, 12)}`;
  return `uncaptioned-p${pdfPage || 0}-${figureIndex}`;
}

function toCompatibilityAlternate(
  paperId: string,
  fig: MergedFigure,
  figureIndex: number,
) {
  const figureLabel = buildCompatibilityFigureLabel(
    fig.figureLabel,
    fig.assetHash,
    fig.pdfPage,
    figureIndex,
  );

  return {
    paperId,
    figureLabel,
    captionText: fig.captionText,
    captionSource: fig.captionSource,
    description: fig.description ?? null,
    sourceMethod: fig.sourceMethod,
    sourceUrl: fig.sourceUrl ?? null,
    sourceVersion: FIGURE_PROJECTION_VERSION,
    confidence: fig.confidence,
    imagePath: fig.imagePath,
    assetHash: fig.assetHash,
    pdfPage: fig.pdfPage,
    sourcePage: null,
    figureIndex,
    bbox: fig.bbox,
    type: fig.type,
    isPrimaryExtraction: false,
    width: fig.width,
    height: fig.height,
    gapReason: null,
    imageSourceMethod: fig.imagePath ? fig.imageSourceMethod ?? fig.sourceMethod : null,
  };
}

function compareAlternateCompatibilityPreference(
  left: MergedFigure,
  right: MergedFigure,
): number {
  const score = (figure: MergedFigure) => [
    figure.figureLabel ? 1 : 0,
    figure.captionText ? 1 : 0,
    figure.imagePath ? 1 : 0,
    figure.sourceUrl ? 1 : 0,
  ];

  const leftScore = score(left);
  const rightScore = score(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) {
      return leftScore[index] - rightScore[index];
    }
  }
  return 0;
}

function dedupeCompatibilityAlternates(
  alternates: MergedFigure[],
  existingKeys: Set<string> = new Set(),
): MergedFigure[] {
  const deduped = new Map<string, { figure: MergedFigure; originalIndex: number }>();

  alternates.forEach((figure, index) => {
    const key = figure.assetHash ? `${figure.sourceMethod}:${figure.assetHash}` : `__index__:${index}`;
    if (figure.assetHash && existingKeys.has(key)) {
      return;
    }
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { figure, originalIndex: index });
      return;
    }

    if (compareAlternateCompatibilityPreference(figure, existing.figure) > 0) {
      deduped.set(key, { figure, originalIndex: existing.originalIndex });
    }
  });

  return Array.from(deduped.values())
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((entry) => entry.figure);
}

function planPublishedFigureHandleAssignments(
  currentFigures: CurrentProjectionHandleInput[],
  previousFigures: PreviousPublishedHandleInput[],
): PlannedHandleAssignment[] {
  const previousByIdentityKey = new Map<string, PreviousPublishedHandleInput>();
  for (const previousFigure of previousFigures) {
    if (!previousByIdentityKey.has(previousFigure.identityKey)) {
      previousByIdentityKey.set(previousFigure.identityKey, previousFigure);
    }
  }

  return currentFigures.map((currentFigure) => {
    const previousFigure = previousByIdentityKey.get(currentFigure.identityKey);
    if (previousFigure) {
      return {
        projectionFigureId: currentFigure.projectionFigureId,
        assignmentDecision: "reuse",
        predecessorProjectionFigureId: previousFigure.projectionFigureId,
        publishedFigureHandleId: previousFigure.publishedFigureHandleId,
        handleAssignmentEvidenceType: "identity_key",
        handleAssignmentEvidenceIds: JSON.stringify({
          identityKey: currentFigure.identityKey,
          predecessorProjectionFigureId: previousFigure.projectionFigureId,
          publishedFigureHandleId: previousFigure.publishedFigureHandleId,
        }),
      };
    }

    return {
      projectionFigureId: currentFigure.projectionFigureId,
      assignmentDecision: "new",
      predecessorProjectionFigureId: null,
      publishedFigureHandleId: null,
      handleAssignmentEvidenceType: "identity_key_new",
      handleAssignmentEvidenceIds: JSON.stringify({
        identityKey: currentFigure.identityKey,
      }),
    };
  });
}

function canCarryForwardRenderedPreview(
  currentFigure: Pick<PreviewProjectionFigure, "identityKey" | "type" | "sourceMethod" | "structuredContent">,
  previousSelection: PreviousPreviewSelection | null | undefined,
): boolean {
  if (!previousSelection) return false;
  if (previousSelection.selectedPreviewSource !== "rendered") return false;
  if (!previousSelection.selectedAssetId) return false;
  if (!previousSelection.selectedRenderedPreviewId) return false;
  return previousSelection.identityKey === currentFigure.identityKey
    && previousSelection.type === currentFigure.type
    && previousSelection.sourceMethod === currentFigure.sourceMethod
    && previousSelection.structuredContent === currentFigure.structuredContent;
}

function canCarryForwardNativePreview(
  currentFigure: Pick<PreviewProjectionFigure, "identityKey" | "type">,
  previousSelection: PreviousPreviewSelection | null | undefined,
): boolean {
  if (!previousSelection) return false;
  if (previousSelection.selectedPreviewSource !== "native") return false;
  if (!previousSelection.selectedAssetId) return false;
  if (!previousSelection.selectedNativeCandidateId) return false;
  return previousSelection.identityKey === currentFigure.identityKey
    && previousSelection.type === currentFigure.type;
}

function buildNativeOrNoneSelectionDraft(
  figure: PreviewProjectionFigure,
  candidateAssetMap: Map<string, string>,
): PreviewSelectionDraft {
  const assetId = figure.basePreviewCandidateId
    ? (candidateAssetMap.get(figure.basePreviewCandidateId) ?? null)
    : null;

  if (!assetId || !figure.basePreviewCandidateId) {
    return {
      projectionFigureId: figure.id,
      identityKey: figure.identityKey,
      selectedPreviewSource: "none",
      selectedPreviewSourceMethod: null,
      selectedAssetId: null,
      selectedRenderedPreviewId: null,
      selectedNativeCandidateId: null,
    };
  }

  return {
    projectionFigureId: figure.id,
    identityKey: figure.identityKey,
    selectedPreviewSource: "native",
    selectedPreviewSourceMethod: figure.imageSourceMethod ?? figure.sourceMethod,
    selectedAssetId: assetId,
    selectedRenderedPreviewId: null,
    selectedNativeCandidateId: figure.basePreviewCandidateId,
  };
}

function buildActivationSelectionDrafts(
  figures: PreviewProjectionFigure[],
  previousSelectionsByIdentity: Map<string, PreviousPreviewSelection>,
  candidateAssetMap: Map<string, string>,
): PreviewSelectionDraft[] {
  return figures.map((figure) => {
    const previousSelection = previousSelectionsByIdentity.get(figure.identityKey);
    if (canCarryForwardRenderedPreview(figure, previousSelection)) {
      return {
        projectionFigureId: figure.id,
        identityKey: figure.identityKey,
        selectedPreviewSource: "rendered",
        selectedPreviewSourceMethod: previousSelection?.selectedPreviewSourceMethod ?? "html_table_render",
        selectedAssetId: previousSelection?.selectedAssetId ?? null,
        selectedRenderedPreviewId: previousSelection?.selectedRenderedPreviewId ?? null,
        selectedNativeCandidateId: null,
      };
    }

    const nativeOrNoneDraft = buildNativeOrNoneSelectionDraft(figure, candidateAssetMap);
    if (
      nativeOrNoneDraft.selectedPreviewSource === "none"
      && canCarryForwardNativePreview(figure, previousSelection)
    ) {
      return {
        projectionFigureId: figure.id,
        identityKey: figure.identityKey,
        selectedPreviewSource: "native",
        selectedPreviewSourceMethod: previousSelection?.selectedPreviewSourceMethod ?? previousSelection?.sourceMethod ?? null,
        selectedAssetId: previousSelection?.selectedAssetId ?? null,
        selectedRenderedPreviewId: null,
        selectedNativeCandidateId: previousSelection?.selectedNativeCandidateId ?? null,
      };
    }

    return nativeOrNoneDraft;
  });
}

function buildEnrichmentSelectionDrafts(
  figures: PreviewProjectionFigure[],
  currentSelectionsByProjectionFigureId: Map<string, PreviewSelectionDraft>,
  replacements: Map<string, PreviewSelectionReplacement>,
  candidateAssetMap: Map<string, string>,
): PreviewSelectionDraft[] {
  return figures.map((figure) => {
    const replacement = replacements.get(figure.id);
    if (replacement) {
      return {
        projectionFigureId: figure.id,
        identityKey: figure.identityKey,
        selectedPreviewSource: "rendered",
        selectedPreviewSourceMethod: replacement.sourceMethod,
        selectedAssetId: replacement.assetId,
        selectedRenderedPreviewId: replacement.renderedPreviewId,
        selectedNativeCandidateId: null,
      };
    }

    const currentSelection = currentSelectionsByProjectionFigureId.get(figure.id);
    if (currentSelection) {
      return currentSelection;
    }

    return buildNativeOrNoneSelectionDraft(figure, candidateAssetMap);
  });
}

async function loadProjectionFigures(
  tx: FigurePublicationTx,
  projectionRunId: string,
): Promise<PreviewProjectionFigure[]> {
  const rows = await tx.projectionFigure.findMany({
    where: { projectionRunId },
    select: {
      id: true,
      figureIdentityId: true,
      figureIdentity: {
        select: {
          identityKey: true,
        },
      },
      publishedFigureHandleId: true,
      sourceMethod: true,
      imageSourceMethod: true,
      basePreviewCandidateId: true,
      figureLabel: true,
      captionText: true,
      captionSource: true,
      structuredContent: true,
      structuredContentType: true,
      sourceUrl: true,
      confidence: true,
      pdfPage: true,
      bbox: true,
      type: true,
      width: true,
      height: true,
      gapReason: true,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  return rows.map((row: (typeof rows)[number]) => ({
    ...row,
    identityKey: row.figureIdentity.identityKey,
  }));
}

async function loadCandidateAssetMap(
  tx: FigurePublicationTx,
  figures: PreviewProjectionFigure[],
): Promise<Map<string, string>> {
  const candidateIds = figures
    .map((figure) => figure.basePreviewCandidateId)
    .filter((candidateId): candidateId is string => !!candidateId);

  if (candidateIds.length === 0) {
    return new Map();
  }

  const candidates = await tx.figureCandidate.findMany({
    where: { id: { in: candidateIds } },
    select: {
      id: true,
      nativeAssetId: true,
    },
  });

  return new Map(
    candidates
      .filter((candidate: (typeof candidates)[number]) => !!candidate.nativeAssetId)
      .map((candidate: (typeof candidates)[number]) => [candidate.id, candidate.nativeAssetId as string]),
  );
}

async function loadPreviousSelectionsByIdentity(
  tx: FigurePublicationTx,
  previousPreviewSelectionRunId: string | null,
): Promise<Map<string, PreviousPreviewSelection>> {
  if (!previousPreviewSelectionRunId) {
    return new Map();
  }

  const rows = await tx.previewSelectionFigure.findMany({
    where: { previewSelectionRunId: previousPreviewSelectionRunId },
    select: {
      projectionFigureId: true,
      selectedPreviewSource: true,
      selectedPreviewSourceMethod: true,
      selectedAssetId: true,
      selectedRenderedPreviewId: true,
      selectedNativeCandidateId: true,
      projectionFigure: {
        select: {
          figureIdentity: {
            select: {
              identityKey: true,
            },
          },
          type: true,
          sourceMethod: true,
          structuredContent: true,
        },
      },
    },
  });

  const map = new Map<string, PreviousPreviewSelection>();
  for (const row of rows) {
    map.set(row.projectionFigure.figureIdentity.identityKey, {
      projectionFigureId: row.projectionFigureId,
      identityKey: row.projectionFigure.figureIdentity.identityKey,
      selectedPreviewSource: row.selectedPreviewSource,
      selectedPreviewSourceMethod: row.selectedPreviewSourceMethod,
      selectedAssetId: row.selectedAssetId,
      selectedRenderedPreviewId: row.selectedRenderedPreviewId,
      selectedNativeCandidateId: row.selectedNativeCandidateId,
      type: row.projectionFigure.type,
      sourceMethod: row.projectionFigure.sourceMethod,
      structuredContent: row.projectionFigure.structuredContent,
    });
  }

  return map;
}

async function loadCurrentSelectionsByProjectionFigureId(
  tx: FigurePublicationTx,
  previewSelectionRunId: string | null,
): Promise<Map<string, PreviewSelectionDraft>> {
  if (!previewSelectionRunId) {
    return new Map();
  }

  const rows = await tx.previewSelectionFigure.findMany({
    where: { previewSelectionRunId },
    select: {
      projectionFigureId: true,
      selectedPreviewSource: true,
      selectedPreviewSourceMethod: true,
      selectedAssetId: true,
      selectedRenderedPreviewId: true,
      selectedNativeCandidateId: true,
      projectionFigure: {
        select: {
          figureIdentity: {
            select: {
              identityKey: true,
            },
          },
        },
      },
    },
  });

  return new Map(
    rows.map((row: (typeof rows)[number]) => [
      row.projectionFigureId,
      {
        projectionFigureId: row.projectionFigureId,
        identityKey: row.projectionFigure.figureIdentity.identityKey,
        selectedPreviewSource: row.selectedPreviewSource,
        selectedPreviewSourceMethod: row.selectedPreviewSourceMethod,
        selectedAssetId: row.selectedAssetId,
        selectedRenderedPreviewId: row.selectedRenderedPreviewId,
        selectedNativeCandidateId: row.selectedNativeCandidateId,
      },
    ]),
  );
}

async function createPreviewSelectionRun(
  tx: FigurePublicationTx,
  paperId: string,
  projectionRunId: string,
  selectionKind: string,
  supersedesPreviewSelectionRunId: string | null,
  drafts: PreviewSelectionDraft[],
  comparison: {
    comparisonStatus: string;
    comparisonSummary: string;
  },
  metadata: Record<string, unknown>,
): Promise<string> {
  const previewSelectionRun = await tx.previewSelectionRun.create({
    data: {
      paperId,
      projectionRunId,
      selectionKind,
      status: "completed",
      comparisonStatus: comparison.comparisonStatus,
      comparisonSummary: comparison.comparisonSummary,
      publicationMode: "normal",
      metadata: JSON.stringify(metadata),
      supersedesPreviewSelectionRunId,
    },
    select: { id: true },
  });

  if (drafts.length > 0) {
    await tx.previewSelectionFigure.createMany({
      data: drafts.map((draft) => ({
        previewSelectionRunId: previewSelectionRun.id,
        projectionFigureId: draft.projectionFigureId,
        selectedPreviewSource: draft.selectedPreviewSource,
        selectedPreviewSourceMethod: draft.selectedPreviewSourceMethod,
        selectedAssetId: draft.selectedAssetId,
        selectedRenderedPreviewId: draft.selectedRenderedPreviewId,
        selectedNativeCandidateId: draft.selectedNativeCandidateId,
      })),
    });
  }

  return previewSelectionRun.id;
}

export async function createActivationPreviewSelectionRun(
  tx: FigurePublicationTx,
  paperId: string,
  projectionRunId: string,
  previousPreviewSelectionRunId: string | null,
): Promise<string> {
  const figures = await loadProjectionFigures(tx, projectionRunId);
  const candidateAssetMap = await loadCandidateAssetMap(tx, figures);
  const previousSelectionsByIdentity = await loadPreviousSelectionsByIdentity(
    tx,
    previousPreviewSelectionRunId,
  );
  const drafts = buildActivationSelectionDrafts(figures, previousSelectionsByIdentity, candidateAssetMap);
  const overrides = await loadActiveFigureOverrides(tx, paperId, FIGURE_OVERRIDE_STAGE_PREVIEW);
  const finalDrafts = applyPreviewSelectionOverrides(
    figures.map((figure) => ({
      projectionFigureId: figure.id,
      identityKey: figure.identityKey,
    })),
    drafts,
    overrides,
  );
  const comparison = comparePreviewSelections(
    Array.from(previousSelectionsByIdentity.values()).map((selection) => ({
      identityKey: selection.identityKey,
      selectedPreviewSource: selection.selectedPreviewSource,
    })),
    finalDrafts.map((draft) => ({
      identityKey: draft.identityKey,
      selectedPreviewSource: draft.selectedPreviewSource,
    })),
  );

  return createPreviewSelectionRun(
    tx,
    paperId,
    projectionRunId,
    "activation",
    previousPreviewSelectionRunId,
    finalDrafts,
    comparison,
    {
      figureCount: figures.length,
      carriedForwardRenderedCount: finalDrafts.filter((draft) => draft.selectedPreviewSource === "rendered").length,
    },
  );
}

export async function createEnrichmentPreviewSelectionRun(
  tx: FigurePublicationTx,
  paperId: string,
  projectionRunId: string,
  currentPreviewSelectionRunId: string | null,
  replacementsInput: PreviewSelectionReplacement[],
): Promise<string> {
  const figures = await loadProjectionFigures(tx, projectionRunId);
  const candidateAssetMap = await loadCandidateAssetMap(tx, figures);
  const currentSelections = await loadCurrentSelectionsByProjectionFigureId(
    tx,
    currentPreviewSelectionRunId,
  );
  const replacements = new Map(
    replacementsInput.map((replacement) => [replacement.projectionFigureId, replacement]),
  );
  const drafts = buildEnrichmentSelectionDrafts(
    figures,
    currentSelections,
    replacements,
    candidateAssetMap,
  );
  const overrides = await loadActiveFigureOverrides(tx, paperId, FIGURE_OVERRIDE_STAGE_PREVIEW);
  const finalDrafts = applyPreviewSelectionOverrides(
    figures.map((figure) => ({
      projectionFigureId: figure.id,
      identityKey: figure.identityKey,
    })),
    drafts,
    overrides,
  );
  const comparison = comparePreviewSelections(
    Array.from(currentSelections.values()).map((selection) => ({
      identityKey: selection.identityKey,
      selectedPreviewSource: selection.selectedPreviewSource,
    })),
    finalDrafts.map((draft) => ({
      identityKey: draft.identityKey,
      selectedPreviewSource: draft.selectedPreviewSource,
    })),
  );

  return createPreviewSelectionRun(
    tx,
    paperId,
    projectionRunId,
    "enrichment",
    currentPreviewSelectionRunId,
    finalDrafts,
    comparison,
    {
      figureCount: figures.length,
      replacementCount: replacementsInput.length,
    },
  );
}

async function syncPrimaryPaperFigureCacheFromPreviewSelection(
  tx: FigurePublicationTx,
  paperId: string,
  projectionRunId: string,
  previewSelectionRunId: string,
): Promise<void> {
  const projectionFigures = await loadProjectionFigures(tx, projectionRunId);
  const previewSelections = await tx.previewSelectionFigure.findMany({
    where: { previewSelectionRunId },
    select: {
      projectionFigureId: true,
      selectedPreviewSource: true,
      selectedPreviewSourceMethod: true,
      selectedAsset: {
        select: {
          storagePath: true,
          contentHash: true,
          width: true,
          height: true,
        },
      },
    },
  });

  const selectionMap = new Map<string, (typeof previewSelections)[number]>(
    previewSelections.map((selection: (typeof previewSelections)[number]) => [selection.projectionFigureId, selection]),
  );

  if (projectionFigures.length === 0) {
    await tx.paperFigure.deleteMany({
      where: {
        paperId,
        isPrimaryExtraction: true,
      },
    });
    return;
  }

  const activeHandleIds = projectionFigures
    .map((figure) => figure.publishedFigureHandleId)
    .filter((handleId): handleId is string => !!handleId);

  if (activeHandleIds.length === 0) {
    throw new Error(`projection run ${projectionRunId} has no published figure handles assigned`);
  }

  await tx.paperFigure.deleteMany({
    where: {
      paperId,
      isPrimaryExtraction: true,
      OR: [
        { publishedFigureHandleId: null },
        { publishedFigureHandleId: { notIn: activeHandleIds } },
      ],
    },
  });

  const existingRows = await tx.paperFigure.findMany({
    where: {
      paperId,
      isPrimaryExtraction: true,
      publishedFigureHandleId: { in: activeHandleIds },
    },
    select: {
      id: true,
      publishedFigureHandleId: true,
    },
  });
  const existingRowsByHandleId = new Map(
    existingRows.map((row: ExistingPrimaryPaperFigureRow) => [row.publishedFigureHandleId, row.id]),
  );

  for (let figureIndex = 0; figureIndex < projectionFigures.length; figureIndex += 1) {
    const figure = projectionFigures[figureIndex];
    if (!figure.publishedFigureHandleId) {
      throw new Error(`projection figure ${figure.id} is missing a published figure handle`);
    }

    const selection = selectionMap.get(figure.id);
    const selectedAsset = selection?.selectedAsset ?? null;
    const imagePath = selectedAsset?.storagePath ?? null;
    const assetHash = selectedAsset?.contentHash ?? null;
    const width = selectedAsset?.width ?? figure.width;
    const height = selectedAsset?.height ?? figure.height;
    const imageSourceMethod = imagePath
      ? (selection?.selectedPreviewSourceMethod ?? figure.imageSourceMethod ?? figure.sourceMethod)
      : null;
    const gapReason = imagePath ? null : figure.gapReason;
    const data = {
      publishedFigureHandleId: figure.publishedFigureHandleId,
      figureLabel: buildCompatibilityFigureLabel(
        figure.figureLabel,
        assetHash,
        figure.pdfPage,
        figureIndex,
      ),
      captionText: figure.captionText,
      captionSource: figure.captionSource,
      description: figure.structuredContent,
      sourceMethod: figure.sourceMethod,
      sourceUrl: figure.sourceUrl,
      sourceVersion: FIGURE_PREVIEW_SELECTION_VERSION,
      confidence: figure.confidence ?? "medium",
      imagePath,
      assetHash,
      pdfPage: figure.pdfPage,
      sourcePage: null,
      figureIndex,
      bbox: figure.bbox,
      type: figure.type,
      isPrimaryExtraction: true,
      width,
      height,
      gapReason,
      imageSourceMethod,
    };

    const existingRowId = existingRowsByHandleId.get(figure.publishedFigureHandleId);
    if (existingRowId) {
      await tx.paperFigure.update({
        where: { id: existingRowId },
        data,
      });
      continue;
    }

    await tx.paperFigure.create({
      data: {
        paperId,
        ...data,
      },
    });
  }
}

export async function publishPreviewSelectionRun(
  tx: FigurePublicationTx,
  paperId: string,
  previewSelectionRunId: string,
  leaseToken: string,
  expectedProjectionRunId?: string | null,
  publicationMode: PublicationMode = "normal",
): Promise<void> {
  await assertPaperWorkLease(tx, paperId, leaseToken);
  await tx.previewSelectionRun.update({
    where: { id: previewSelectionRunId },
    data: {
      publicationMode,
    },
  });
  const { projectionRunId } = await validatePreviewSelectionRunForPublication(tx, {
    paperId,
    previewSelectionRunId,
    expectedProjectionRunId,
  });

  const promotedAt = new Date();
  await tx.previewSelectionRun.update({
    where: { id: previewSelectionRunId },
    data: {
      status: "published",
      promotedAt,
    },
  });

  await tx.paperPublicationState.upsert({
    where: { paperId },
    create: {
      paperId,
      activePreviewSelectionRunId: previewSelectionRunId,
    },
    update: {
      activePreviewSelectionRunId: previewSelectionRunId,
    },
  });

  await syncPrimaryPaperFigureCacheFromPreviewSelection(
    tx,
    paperId,
    projectionRunId,
    previewSelectionRunId,
  );
}

export async function upsertRenderedPreviewAsset(
  tx: FigurePublicationTx,
  paperId: string,
  asset: RenderedPreviewAssetInput,
): Promise<string> {
  const row = await tx.asset.upsert({
    where: {
      paperId_contentHash: {
        paperId,
        contentHash: asset.contentHash,
      },
    },
    create: {
      paperId,
      contentHash: asset.contentHash,
      storagePath: asset.storagePath,
      mimeType: "image/png",
      byteSize: asset.byteSize,
      width: asset.width,
      height: asset.height,
      assetKind: "rendered_preview",
      producerType: "renderer",
      producerVersion: FIGURE_PREVIEW_SELECTION_VERSION,
    },
    update: {
      storagePath: asset.storagePath,
      mimeType: "image/png",
      byteSize: asset.byteSize,
      width: asset.width,
      height: asset.height,
      assetKind: "rendered_preview",
      producerType: "renderer",
      producerVersion: FIGURE_PREVIEW_SELECTION_VERSION,
    },
    select: { id: true },
  });

  return row.id;
}

export async function createRenderedPreview(
  tx: FigurePublicationTx,
  renderRunId: string,
  projectionFigureId: string,
  assetId: string,
  renderMode: string,
  inputHash: string,
): Promise<string> {
  const row = await tx.renderedPreview.create({
    data: {
      renderRunId,
      projectionFigureId,
      assetId,
      renderMode,
      inputHash,
    },
    select: { id: true },
  });

  return row.id;
}

async function assignPublishedFigureHandlesForProjection(
  tx: FigurePublicationTx,
  paperId: string,
  projectionRunId: string,
): Promise<void> {
  const publicationState = await tx.paperPublicationState.findUnique({
    where: { paperId },
    select: {
      activeProjectionRunId: true,
    },
  });

  const currentFigures = await tx.projectionFigure.findMany({
    where: { projectionRunId },
    select: {
      id: true,
      figureIdentity: {
        select: {
          identityKey: true,
        },
      },
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  const previousFigures = publicationState?.activeProjectionRunId
    ? await tx.projectionFigure.findMany({
      where: {
        projectionRunId: publicationState.activeProjectionRunId,
        publishedFigureHandleId: { not: null },
      },
      select: {
        id: true,
        publishedFigureHandleId: true,
        figureIdentity: {
          select: {
            identityKey: true,
          },
        },
      },
    })
    : [];

  const assignments = planPublishedFigureHandleAssignments(
    currentFigures.map((figure: CurrentProjectionHandleRow) => ({
      projectionFigureId: figure.id,
      identityKey: figure.figureIdentity.identityKey,
    })),
    previousFigures
      .filter((figure: PreviousProjectionHandleRow): figure is PreviousProjectionHandleRow & { publishedFigureHandleId: string } => !!figure.publishedFigureHandleId)
      .map((figure: PreviousProjectionHandleRow & { publishedFigureHandleId: string }) => ({
        projectionFigureId: figure.id,
        identityKey: figure.figureIdentity.identityKey,
        publishedFigureHandleId: figure.publishedFigureHandleId,
      })),
  );

  const activeHandleIds = new Set<string>();

  for (const assignment of assignments) {
    let publishedFigureHandleId = assignment.publishedFigureHandleId;
    if (!publishedFigureHandleId) {
      const handle = await tx.publishedFigureHandle.create({
        data: {
          paperId,
          publicKey: randomUUID(),
          status: "active",
        },
        select: { id: true },
      });
      publishedFigureHandleId = handle.id;
    }

    if (!publishedFigureHandleId) {
      throw new Error(`failed to assign a published figure handle for projection figure ${assignment.projectionFigureId}`);
    }

    activeHandleIds.add(publishedFigureHandleId);

    await tx.publishedFigureHandle.update({
      where: { id: publishedFigureHandleId },
      data: {
        status: "active",
        retiredAt: null,
      },
    });

    await tx.projectionFigure.update({
      where: { id: assignment.projectionFigureId },
      data: {
        publishedFigureHandleId,
        predecessorProjectionFigureId: assignment.predecessorProjectionFigureId,
        handleAssignmentDecision: assignment.assignmentDecision,
        handleAssignmentVersion: FIGURE_HANDLE_ASSIGNMENT_VERSION,
        handleAssignmentEvidenceType: assignment.handleAssignmentEvidenceType,
        handleAssignmentEvidenceIds: assignment.handleAssignmentEvidenceIds,
      },
    });
  }

  if (previousFigures.length > 0) {
    const previousHandleIds = previousFigures
      .map((figure: PreviousProjectionHandleRow) => figure.publishedFigureHandleId)
      .filter((handleId: string | null): handleId is string => !!handleId);
    const retiredHandleIds = previousHandleIds.filter((handleId: string) => !activeHandleIds.has(handleId));

    if (retiredHandleIds.length > 0) {
      await tx.publishedFigureHandle.updateMany({
        where: {
          id: { in: retiredHandleIds },
        },
        data: {
          status: "retired",
          retiredAt: new Date(),
        },
      });
    }
  }
}

export async function createProjectionRunSnapshot(
  tx: FigurePublicationTx,
  paperId: string,
  identityResolutionId: string,
): Promise<string> {
  const identities = await tx.figureIdentity.findMany({
    where: { paperId, identityResolutionId },
    include: {
      members: {
        include: {
          figureCandidate: {
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
          },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const drafts = sortProjectionFigureDrafts(
    identities
      .map((identity: (typeof identities)[number]) => buildProjectionFigureDraft(
        identity.id,
        identity.identityKey,
        identity.members.map((member: (typeof identity.members)[number]) => candidateToProjectable(member.figureCandidate)),
      ))
      .filter((draft: ProjectionFigureDraft | null): draft is ProjectionFigureDraft => draft != null),
  );
  const overrides = await loadActiveFigureOverrides(tx, paperId, FIGURE_OVERRIDE_STAGE_PROJECTION);
  const finalDrafts = applyProjectionFigureOverrides(drafts, overrides);

  const projectionRun = await tx.projectionRun.create({
    data: {
      paperId,
      identityResolutionId,
      projectionVersion: FIGURE_PROJECTION_VERSION,
      status: "completed",
      comparisonStatus: "not_compared",
      publicationMode: "normal",
      metadata: JSON.stringify({
        identityCount: identities.length,
        projectedCount: finalDrafts.length,
      }),
    },
    select: { id: true },
  });

  if (finalDrafts.length > 0) {
    await tx.projectionFigure.createMany({
      data: finalDrafts.map((draft, index) => ({
        projectionRunId: projectionRun.id,
        figureIdentityId: draft.figureIdentityId,
        sortOrder: index,
        sourceMethod: draft.sourceMethod,
        imageSourceMethod: draft.imageSourceMethod,
        pageSourceMethod: draft.pageSourceMethod,
        contentCandidateId: draft.contentCandidateId,
        basePreviewCandidateId: draft.basePreviewCandidateId,
        pageAnchorCandidateId: draft.pageAnchorCandidateId,
        figureLabel: draft.figureLabel,
        captionText: draft.captionText,
        captionSource: draft.captionSource,
        structuredContent: draft.structuredContent,
        structuredContentType: draft.structuredContentType,
        sourceUrl: draft.sourceUrl,
        confidence: draft.confidence,
        imagePath: draft.imagePath,
        assetHash: draft.assetHash,
        pdfPage: draft.pdfPage,
        bbox: draft.bbox,
        type: draft.type,
        width: draft.width,
        height: draft.height,
        gapReason: draft.gapReason,
      })),
    });
  }

  return projectionRun.id;
}

async function syncAlternatePaperFigures(
  tx: FigurePublicationTx,
  paperId: string,
  merged: MergedFigure[],
): Promise<void> {
  await tx.paperFigure.deleteMany({
    where: {
      paperId,
      isPrimaryExtraction: false,
    },
  });

  const primaryCompatibilityKeys = new Set<string>(
    (await tx.paperFigure.findMany({
      where: {
        paperId,
        isPrimaryExtraction: true,
        assetHash: { not: null },
      },
      select: {
        sourceMethod: true,
        assetHash: true,
      },
    })).map((figure: { sourceMethod: string; assetHash: string | null }) => `${figure.sourceMethod}:${figure.assetHash}`),
  );

  const alternates = dedupeCompatibilityAlternates(
    merged.filter((figure) => !figure.isPrimaryExtraction),
    primaryCompatibilityKeys,
  );
  if (alternates.length === 0) {
    return;
  }

  await tx.paperFigure.createMany({
    data: alternates.map((figure, index) => toCompatibilityAlternate(paperId, figure, index)),
  });
}

export async function publishProjectionRun(
  tx: FigurePublicationTx,
  paperId: string,
  identityResolutionId: string,
  projectionRunId: string,
  merged: MergedFigure[],
  leaseToken: string,
  publicationMode: PublicationMode = "normal",
): Promise<void> {
  await assertPaperWorkLease(tx, paperId, leaseToken);
  const publishedAt = new Date();
  const existingPublicationState = await tx.paperPublicationState.findUnique({
    where: { paperId },
    select: {
      activeProjectionRunId: true,
      activePreviewSelectionRunId: true,
    },
  });

  await assignPublishedFigureHandlesForProjection(tx, paperId, projectionRunId);

  const [previousProjectionFigures, currentProjectionFigures] = await Promise.all([
    existingPublicationState?.activeProjectionRunId
      ? loadProjectionFigures(tx, existingPublicationState.activeProjectionRunId)
      : Promise.resolve([]),
    loadProjectionFigures(tx, projectionRunId),
  ]);
  const comparison = compareProjectionRuns(
    previousProjectionFigures.map((figure) => ({
      figureLabel: figure.figureLabel,
      type: figure.type,
    })),
    currentProjectionFigures.map((figure) => ({
      figureLabel: figure.figureLabel,
      type: figure.type,
    })),
  );

  await tx.projectionRun.update({
    where: { id: projectionRunId },
    data: {
      comparisonStatus: comparison.comparisonStatus,
      comparisonSummary: comparison.comparisonSummary,
      publicationMode,
      status: "published",
      publishedAt,
    },
  });

  const activationPreviewSelectionRunId = await createActivationPreviewSelectionRun(
    tx,
    paperId,
    projectionRunId,
    existingPublicationState?.activePreviewSelectionRunId ?? null,
  );

  await validateProjectionRunForPublication(tx, {
    paperId,
    identityResolutionId,
    projectionRunId,
  });
  await validatePreviewSelectionRunForPublication(tx, {
    paperId,
    previewSelectionRunId: activationPreviewSelectionRunId,
    expectedProjectionRunId: projectionRunId,
  });

  await tx.previewSelectionRun.update({
    where: { id: activationPreviewSelectionRunId },
    data: {
      status: "published",
      promotedAt: publishedAt,
    },
  });

  await tx.paperPublicationState.upsert({
    where: { paperId },
    create: {
      paperId,
      activeProjectionRunId: projectionRunId,
      activeIdentityResolutionId: identityResolutionId,
      activePreviewSelectionRunId: activationPreviewSelectionRunId,
    },
    update: {
      activeProjectionRunId: projectionRunId,
      activeIdentityResolutionId: identityResolutionId,
      activePreviewSelectionRunId: activationPreviewSelectionRunId,
    },
  });

  await syncPrimaryPaperFigureCacheFromPreviewSelection(
    tx,
    paperId,
    projectionRunId,
    activationPreviewSelectionRunId,
  );
  await syncAlternatePaperFigures(tx, paperId, merged);
}

export const projectionPublicationInternals = {
  candidateToProjectable,
  buildProjectionFigureDraft,
  sortProjectableCandidates,
  sortProjectionFigureDrafts,
  buildCompatibilityFigureLabel,
  dedupeCompatibilityAlternates,
  planPublishedFigureHandleAssignments,
  canCarryForwardRenderedPreview,
  buildActivationSelectionDrafts,
  buildEnrichmentSelectionDrafts,
};
