import type { PaperClaimPolarity } from "@/generated/prisma/client";

import type { PaperClaimStance } from "../types";

import { normalizeIdentifierLikeText } from "./text";

const OPPOSING_PREDICATE_PAIRS = [
  ["improves", "degrades"],
  ["improves", "worsens"],
  ["outperforms", "underperforms"],
  ["increases", "decreases"],
  ["reduces", "increases"],
  ["helps", "harms"],
] as const;

function normalizePredicate(value: string | null | undefined): string {
  return normalizeIdentifierLikeText(value)
    .replace(/\b(does not|do not|not|no)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeStance(
  value: PaperClaimStance | null | undefined,
): {
  subject: string;
  predicate: string;
  object: string;
  qualifier: string;
} | null {
  if (!value?.subjectText || !value?.predicateText || !value?.objectText) {
    return null;
  }
  return {
    subject: normalizeIdentifierLikeText(value.subjectText),
    predicate: normalizePredicate(value.predicateText),
    object: normalizeIdentifierLikeText(value.objectText),
    qualifier: normalizeIdentifierLikeText(value.qualifierText),
  };
}

export function stancesAlign(
  left: PaperClaimStance | null | undefined,
  right: PaperClaimStance | null | undefined,
): boolean {
  const leftNormalized = normalizeStance(left);
  const rightNormalized = normalizeStance(right);
  if (!leftNormalized || !rightNormalized) return false;
  return (
    leftNormalized.subject === rightNormalized.subject &&
    leftNormalized.object === rightNormalized.object
  );
}

function predicatesAreOpposed(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return false;
  return OPPOSING_PREDICATE_PAIRS.some(
    ([a, b]) =>
      (left.includes(a) && right.includes(b)) ||
      (left.includes(b) && right.includes(a)),
  );
}

export function stancesContradict(
  left: {
    stance: PaperClaimStance | null | undefined;
    polarity: PaperClaimPolarity;
  },
  right: {
    stance: PaperClaimStance | null | undefined;
    polarity: PaperClaimPolarity;
  },
): { opposed: boolean; reason: "polarity_flip" | "predicate_opposition" | null } {
  const leftNormalized = normalizeStance(left.stance);
  const rightNormalized = normalizeStance(right.stance);
  if (!leftNormalized || !rightNormalized) {
    return { opposed: false, reason: null };
  }
  if (
    leftNormalized.subject !== rightNormalized.subject ||
    leftNormalized.object !== rightNormalized.object
  ) {
    return { opposed: false, reason: null };
  }

  if (
    leftNormalized.predicate === rightNormalized.predicate &&
    left.polarity !== right.polarity &&
    ((left.polarity === "NEGATED" && right.polarity === "ASSERTIVE") ||
      (left.polarity === "ASSERTIVE" && right.polarity === "NEGATED"))
  ) {
    return { opposed: true, reason: "polarity_flip" };
  }

  if (predicatesAreOpposed(leftNormalized.predicate, rightNormalized.predicate)) {
    return { opposed: true, reason: "predicate_opposition" };
  }

  return { opposed: false, reason: null };
}
