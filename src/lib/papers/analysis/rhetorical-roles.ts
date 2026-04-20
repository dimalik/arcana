export const PAPER_CLAIM_RHETORICAL_ROLE_VALUES = [
  "background",
  "motivation",
  "research_question",
  "hypothesis",
  "definition",
  "assumption",
  "method",
  "dataset",
  "result",
  "evaluation",
  "limitation",
  "future_work",
  "contribution",
] as const;

export type PaperClaimRhetoricalRoleValue =
  (typeof PAPER_CLAIM_RHETORICAL_ROLE_VALUES)[number];

export interface RhetoricalRoleClassificationInput {
  claimText: string;
  sectionLabel?: string | null;
  sectionPath?: string | null;
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function containsAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

export function classifyRhetoricalRole(
  input: RhetoricalRoleClassificationInput,
): PaperClaimRhetoricalRoleValue {
  const claimText = normalize(input.claimText);
  const sectionLabel = normalize(input.sectionLabel);
  const sectionPath = normalize(input.sectionPath);
  const section = `${sectionPath} ${sectionLabel}`.trim();

  if (containsAny(section, ["appendix"])) return "background";
  if (containsAny(section, ["related_work", "related work", "prior work"])) {
    return "background";
  }
  if (containsAny(section, ["introduction", "background"])) return "background";
  if (containsAny(section, ["motivation"])) return "motivation";
  if (containsAny(section, ["limitation"])) return "limitation";
  if (containsAny(section, ["future_work", "future work"])) return "future_work";
  if (containsAny(section, ["method", "approach", "model", "experimental setup"])) {
    return "method";
  }
  if (containsAny(section, ["dataset", "data", "corpus"])) return "dataset";
  if (containsAny(section, ["evaluation"])) return "evaluation";
  if (containsAny(section, ["result", "experiment"])) return "result";
  if (containsAny(section, ["conclusion"])) {
    if (containsAny(claimText, ["future work", "we plan", "we leave", "next step"])) {
      return "future_work";
    }
    if (containsAny(claimText, ["contribution", "we contribute", "our contribution"])) {
      return "contribution";
    }
  }

  if (containsAny(claimText, ["we define", "is defined as", "refers to"])) {
    return "definition";
  }
  if (containsAny(claimText, ["we assume", "assuming that", "under the assumption"])) {
    return "assumption";
  }
  if (containsAny(claimText, ["we hypothesize", "our hypothesis"])) {
    return "hypothesis";
  }
  if (containsAny(claimText, ["question is whether", "research question"])) {
    return "research_question";
  }
  if (containsAny(claimText, ["our motivation", "motivated by", "challenge is"])) {
    return "motivation";
  }
  if (containsAny(claimText, ["we propose", "we introduce", "our contribution"])) {
    return "contribution";
  }
  if (containsAny(claimText, ["we evaluate on", "dataset", "benchmark"])) {
    return "dataset";
  }
  if (containsAny(claimText, ["outperform", "improves", "achieves", "results show"])) {
    return "result";
  }
  if (containsAny(claimText, ["we evaluate", "evaluation", "measured by"])) {
    return "evaluation";
  }
  if (containsAny(claimText, ["limitation", "fails when", "drawback"])) {
    return "limitation";
  }
  if (containsAny(claimText, ["future work", "we leave", "next step"])) {
    return "future_work";
  }

  return "background";
}
