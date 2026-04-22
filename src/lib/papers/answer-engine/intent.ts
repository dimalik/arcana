import { normalizeAnalysisText } from "../analysis/normalization/text";

import type { PaperAnswerIntent } from "./metadata";

function hasAnyToken(haystack: string, tokens: string[]): boolean {
  return tokens.some((token) => haystack.includes(token));
}

export function classifyPaperAnswerIntent(params: {
  question: string;
  additionalPaperCount?: number;
}): PaperAnswerIntent {
  const normalizedQuestion = normalizeAnalysisText(params.question);
  const additionalPaperCount = params.additionalPaperCount ?? 0;

  if (
    hasAnyToken(normalizedQuestion, [
      "contradict",
      "contradiction",
      "conflict",
      "disagree",
      "oppos",
      "tension",
    ])
  ) {
    return "contradictions";
  }

  if (
    hasAnyToken(normalizedQuestion, [
      "gap",
      "gaps",
      "future work",
      "open question",
      "unexplored",
      "next step",
      "limitation",
      "limitations",
    ])
  ) {
    return "gaps";
  }

  if (
    hasAnyToken(normalizedQuestion, [
      "compare",
      "versus",
      "vs ",
      "difference",
      "methodolog",
      "approach",
      "baseline",
    ]) &&
    (additionalPaperCount > 0 ||
      hasAnyToken(normalizedQuestion, ["paper", "papers", "method", "methods"]))
  ) {
    return "compare_methodologies";
  }

  if (
    hasAnyToken(normalizedQuestion, [
      "result",
      "results",
      "performance",
      "value",
      "values",
      "row",
      "rows",
      "column",
      "columns",
      "metric",
      "metrics",
      "benchmark",
      "ablation",
      "accuracy",
      "f1",
      "bleu",
      "rouge",
      "score",
      "scores",
    ])
  ) {
    return "results";
  }

  if (
    hasAnyToken(normalizedQuestion, [
      "figure",
      "fig.",
      "diagram",
      "plot",
      "visual",
      "architecture figure",
      "show me the figure",
    ])
  ) {
    return "figures";
  }

  if (
    hasAnyToken(normalizedQuestion, [
      "table",
      "tab.",
      "show me the row",
      "which row",
      "which column",
      "ablation table",
      "results table",
    ])
  ) {
    return "tables";
  }

  if (
    hasAnyToken(normalizedQuestion, [
      "code",
      "snippet",
      "implementation",
      "implement",
      "pseudo",
      "pseudocode",
      "latex",
      "write it as tex",
      "write it as latex",
      "write this as tex",
      "write this as latex",
      "tex file",
      "latex file",
    ])
  ) {
    return "generated_artifact";
  }

  if (
    hasAnyToken(normalizedQuestion, [
      "timeline",
      "history",
      "evolution",
      "chronolog",
      "progression",
      "how did this develop",
    ])
  ) {
    return "timeline";
  }

  if (
    hasAnyToken(normalizedQuestion, [
      "claim",
      "claims",
      "contribution",
      "contributions",
      "takeaway",
      "takeaways",
      "finding",
      "findings",
      "limitation",
      "limitations",
    ])
  ) {
    return "claims";
  }

  return "direct_qa";
}
