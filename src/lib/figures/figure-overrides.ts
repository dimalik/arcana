import { Prisma } from "@prisma/client";

import { prisma } from "../prisma";

export const FIGURE_OVERRIDE_STAGE_PROJECTION = "projection_publication";
export const FIGURE_OVERRIDE_STAGE_PREVIEW = "preview_publication";

export const FIGURE_OVERRIDE_TYPE_FORCE_GAP_REASON = "force_gap_reason";
export const FIGURE_OVERRIDE_TYPE_SUPPRESS_PREVIEW = "suppress_preview";

export const FIGURE_OVERRIDE_SELECTOR_IDENTITY_KEY = "identity_key";

type FigureOverrideTx = Prisma.TransactionClient;

interface FigureOverrideRecord {
  id: string;
  overrideType: string;
  selectorType: string;
  selectorValue: string;
  payload: string | null;
}

interface ProjectionOverrideDraft {
  identityKey: string;
  imageSourceMethod: string | null;
  basePreviewCandidateId: string | null;
  imagePath: string | null;
  assetHash: string | null;
  width: number | null;
  height: number | null;
  gapReason: string | null;
}

interface PreviewOverrideFigure {
  projectionFigureId: string;
  identityKey: string;
}

interface PreviewSelectionDraft {
  projectionFigureId: string;
  selectedPreviewSource: string;
  selectedPreviewSourceMethod: string | null;
  selectedAssetId: string | null;
  selectedRenderedPreviewId: string | null;
  selectedNativeCandidateId: string | null;
}

interface ForceGapReasonPayload {
  gapReason?: string;
}

function parsePayload<T>(payload: string | null): T {
  if (!payload) return {} as T;
  return JSON.parse(payload) as T;
}

function assertIdentityKeyOverride(record: FigureOverrideRecord): void {
  if (record.selectorType !== FIGURE_OVERRIDE_SELECTOR_IDENTITY_KEY) {
    throw new Error(`figure override ${record.id} uses unsupported selector ${record.selectorType}`);
  }
}

export async function loadActiveFigureOverrides(
  tx: FigureOverrideTx,
  paperId: string,
  overrideStage: string,
): Promise<FigureOverrideRecord[]> {
  return tx.figureOverride.findMany({
    where: {
      paperId,
      overrideStage,
      status: "active",
    },
    select: {
      id: true,
      overrideType: true,
      selectorType: true,
      selectorValue: true,
      payload: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export function applyProjectionFigureOverrides<T extends ProjectionOverrideDraft>(
  drafts: T[],
  overrides: FigureOverrideRecord[],
): T[] {
  const draftsByIdentityKey = new Map(
    drafts.map((draft) => [draft.identityKey, draft]),
  );

  for (const override of overrides) {
    assertIdentityKeyOverride(override);
    const draft = draftsByIdentityKey.get(override.selectorValue);
    if (!draft) continue;

    if (override.overrideType === FIGURE_OVERRIDE_TYPE_FORCE_GAP_REASON) {
      const payload = parsePayload<ForceGapReasonPayload>(override.payload);
      draft.imageSourceMethod = null;
      draft.basePreviewCandidateId = null;
      draft.imagePath = null;
      draft.assetHash = null;
      draft.width = null;
      draft.height = null;
      draft.gapReason = payload.gapReason?.trim() || "manual_override";
      continue;
    }

    throw new Error(`figure override ${override.id} has unsupported projection override type ${override.overrideType}`);
  }

  return drafts;
}

export function applyPreviewSelectionOverrides<T extends PreviewSelectionDraft>(
  figures: PreviewOverrideFigure[],
  drafts: T[],
  overrides: FigureOverrideRecord[],
): T[] {
  const identityKeyByProjectionFigureId = new Map(
    figures.map((figure) => [figure.projectionFigureId, figure.identityKey]),
  );

  for (const override of overrides) {
    assertIdentityKeyOverride(override);
    if (override.overrideType !== FIGURE_OVERRIDE_TYPE_SUPPRESS_PREVIEW) {
      throw new Error(`figure override ${override.id} has unsupported preview override type ${override.overrideType}`);
    }

    for (const draft of drafts) {
      const identityKey = identityKeyByProjectionFigureId.get(draft.projectionFigureId);
      if (identityKey !== override.selectorValue) continue;
      draft.selectedPreviewSource = "none";
      draft.selectedPreviewSourceMethod = null;
      draft.selectedAssetId = null;
      draft.selectedRenderedPreviewId = null;
      draft.selectedNativeCandidateId = null;
    }
  }

  return drafts;
}

export interface CreateFigureOverrideInput {
  paperId: string;
  overrideType: string;
  overrideStage: string;
  selectorType: string;
  selectorValue: string;
  payload?: Record<string, unknown> | null;
  reason?: string | null;
  createdBy?: string | null;
}

export async function createFigureOverride(input: CreateFigureOverrideInput) {
  return prisma.figureOverride.create({
    data: {
      paperId: input.paperId,
      overrideType: input.overrideType,
      overrideStage: input.overrideStage,
      selectorType: input.selectorType,
      selectorValue: input.selectorValue,
      payload: input.payload ? JSON.stringify(input.payload) : null,
      reason: input.reason ?? null,
      createdBy: input.createdBy ?? null,
      status: "active",
    },
  });
}

export async function disableFigureOverride(overrideId: string) {
  return prisma.figureOverride.update({
    where: { id: overrideId },
    data: {
      status: "disabled",
      disabledAt: new Date(),
    },
  });
}

export async function listFigureOverrides(paperId: string) {
  return prisma.figureOverride.findMany({
    where: { paperId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export const figureOverrideInternals = {
  parsePayload,
  applyProjectionFigureOverrides,
  applyPreviewSelectionOverrides,
};
