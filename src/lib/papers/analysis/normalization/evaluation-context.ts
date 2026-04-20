import type { PaperClaimEvaluationContext } from "../types";

import { normalizeIdentifierLikeText } from "./text";

export interface NormalizedEvaluationContext {
  task: string;
  dataset: string;
  metric: string;
  comparator: string;
  setting: string;
  split: string;
}

export function normalizeEvaluationContext(
  value: PaperClaimEvaluationContext | null | undefined,
): NormalizedEvaluationContext | null {
  if (!value?.task || !value?.dataset || !value?.metric) return null;
  return {
    task: normalizeIdentifierLikeText(value.task),
    dataset: normalizeIdentifierLikeText(value.dataset),
    metric: normalizeIdentifierLikeText(value.metric),
    comparator: normalizeIdentifierLikeText(value.comparator),
    setting: normalizeIdentifierLikeText(value.setting),
    split: normalizeIdentifierLikeText(value.split),
  };
}

export function evaluationContextsAlign(
  left: PaperClaimEvaluationContext | null | undefined,
  right: PaperClaimEvaluationContext | null | undefined,
): boolean {
  const leftNormalized = normalizeEvaluationContext(left);
  const rightNormalized = normalizeEvaluationContext(right);
  if (!leftNormalized || !rightNormalized) return false;
  return (
    leftNormalized.task === rightNormalized.task &&
    leftNormalized.dataset === rightNormalized.dataset &&
    leftNormalized.metric === rightNormalized.metric
  );
}
