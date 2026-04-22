import { createHash } from "crypto";
import { readFile } from "fs/promises";
import path from "path";

import type {
  ConversationArtifactKind,
  PaperClaimEvidenceType,
} from "@/generated/prisma/client";
import { FIGURE_VIEW_SELECT, mapPaperFiguresToView, type PaperFigureView } from "@/lib/figures/read-model";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import {
  generateStructuredObject,
  streamLLMResponse,
} from "@/lib/llm/provider";
import {
  paperAnswerAgentActionRuntimeOutputSchema,
  paperAnswerCodeArtifactRuntimeOutputSchema,
  type PaperAnswerAgentActionRuntimeOutput,
  type PaperAnswerCodeArtifactRuntimeOutput,
} from "@/lib/llm/runtime-output-schemas";
import type { LLMProvider } from "@/lib/llm/models";
import type { ProxyConfig } from "@/lib/llm/proxy-settings";
import { normalizeAnalysisText } from "@/lib/papers/analysis/normalization/text";
import { parseSummarySections } from "@/lib/papers/parse-sections";
import { prisma } from "@/lib/prisma";
import { withCachedLookup } from "@/lib/references/resolver-cache";
import { resolveStorageCandidates } from "@/lib/storage-paths";

import type { PaperClaimView } from "../analysis/store";

import type {
  AgentActionSummary,
  AnswerCitation,
  PaperAnswerIntent,
} from "./metadata";

const NON_ASSERTIVE_EVIDENCE_TYPES = new Set<PaperClaimEvidenceType>(["CITING"]);
const STOP_WORDS = new Set([
  "a",
  "about",
  "am",
  "an",
  "are",
  "after",
  "be",
  "been",
  "being",
  "before",
  "can",
  "could",
  "does",
  "from",
  "give",
  "have",
  "how",
  "i",
  "is",
  "into",
  "just",
  "like",
  "me",
  "more",
  "most",
  "paper",
  "papers",
  "please",
  "show",
  "that",
  "the",
  "their",
  "them",
  "this",
  "to",
  "us",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "you",
]);
const RESULT_TABLE_FOCUS_TERMS = [
  "rai",
  "responsible ai",
  "safety",
  "harm",
  "harmful",
  "jailbreak",
  "bias",
  "fairness",
  "ungroundedness",
  "hallucination",
  "toxicity",
  "privacy",
  "robustness",
  "ablation",
  "mmlu",
  "bbh",
  "gsm8k",
  "arena",
];

const MAX_AGENT_STEPS = 5;
const MAX_SECTION_CHARS = 1800;
const MAX_CITATION_SNIPPET_CHARS = 320;
const MAX_TABLE_ROWS = 60;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_CELL_CHARS = 120;
const MAX_VISUAL_MATCHES = 3;
const PAPER_AGENT_EVIDENCE_CACHE_VERSION = "v1";
const PAPER_AGENT_EVIDENCE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PaperAgentPaperContext {
  id: string;
  title: string;
  year: number | null;
  abstract: string | null;
  summary: string | null;
  keyFindings: string | null;
  fullText: string | null;
  claims: PaperClaimView[];
}

export interface PaperAgentArtifactDraft {
  kind: ConversationArtifactKind;
  title: string;
  payloadJson: string;
}

export interface PreparedPaperAgentEvidence {
  citations: AnswerCitation[];
  artifacts: PaperAgentArtifactDraft[];
  actions: AgentActionSummary[];
}

type SummarySectionName = "overview" | "methodology" | "results";
type PassageSearchScope = "results" | "full_text" | "all";

type PaperAgentAction =
  | {
      type: "read_section";
      section: SummarySectionName;
    }
  | {
      type: "search_passages";
      scope: PassageSearchScope;
      query: string;
    }
  | {
      type: "search_claims";
      query: string;
      limit: number;
    }
  | {
      type: "list_figures";
      kind: "figure" | "table" | "any";
      query?: string;
      limit: number;
    }
  | {
      type: "inspect_table";
      query?: string;
      target?: string;
    }
  | {
      type: "open_figure";
      target: string;
    }
  | {
      type: "finish";
      answerPlan: string;
    };

interface SectionSnapshot {
  section: SummarySectionName;
  text: string;
}

interface AgentObservation {
  step: number;
  action: string;
  detail: string;
  phase: "retrieve" | "inspect" | "synthesize";
  status: "completed" | "missing";
  source: "planner" | "fallback" | "system";
  tool: string;
  input?: string | null;
  outputPreview?: string | null;
  citationsAdded?: number;
  artifactsAdded?: number;
}

interface ChosenPaperAgentAction {
  action: PaperAgentAction;
  source: "planner" | "fallback";
}

interface CodeSnippetArtifactPayload {
  summary: string;
  filename: string;
  language: string;
  code: string;
  assumptions: string[];
}

interface ParsedTableData {
  columns: string[];
  rows: string[][];
}

interface TableQueryMatch {
  rowIndex: number;
  score: number;
  values: string[];
}

interface QueryAnalysis {
  targetTerms: string[];
  expandedTerms: string[];
  searchTerms: string[];
  focusQuery: string | null;
  requiresExactEvidence: boolean;
}

interface QueryTextMatch {
  text: string;
  score: number;
  matchedTerms: string[];
}

interface FigureVisualInspectionPayload {
  found: boolean;
  matches: Array<{
    text?: string | null;
    matchedTerms?: unknown;
  }>;
  note?: string | null;
}

const QUERY_STRUCTURAL_TERMS = new Set([
  "result",
  "results",
  "metric",
  "metrics",
  "score",
  "scores",
  "benchmark",
  "benchmarks",
  "table",
  "tables",
  "figure",
  "figures",
  "show",
  "tell",
  "about",
  "paper",
  "performance",
]);

const QUERY_EXPANSION_MAP: Record<string, string[]> = {
  rai: ["responsible ai", "safety"],
  "responsible ai": ["rai", "safety"],
  multilingual: ["mmlu multilingual", "language"],
  latex: ["tex"],
  tex: ["latex"],
};

function tokenize(value: string): string[] {
  return normalizeAnalysisText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );
}

function mergeEvidenceBlocks(...values: Array<string | null | undefined>): string {
  const merged = uniqueStrings(values).join("\n\n").trim();
  return merged ? truncate(merged, MAX_SECTION_CHARS) : "";
}

function expandQueryTerm(term: string): string[] {
  const normalized = normalizeAnalysisText(term);
  const expansions = [
    normalized,
    ...(QUERY_EXPANSION_MAP[normalized] ?? []),
  ];
  if (normalized.includes("-")) {
    expansions.push(normalized.replace(/-/g, " "));
  }
  if (
    /^[a-z]+ian$/.test(normalized)
    || /^[a-z]+ese$/.test(normalized)
    || /^[a-z]+ish$/.test(normalized)
  ) {
    expansions.push(`${normalized} language`);
  }
  return uniqueStrings(expansions);
}

function analyzeQuery(question: string, intent: PaperAnswerIntent): QueryAnalysis {
  const normalizedQuestion = normalizeAnalysisText(question);
  const quotedPhrases = Array.from(question.matchAll(/"([^"]+)"/g), (match) =>
    normalizeAnalysisText(match[1] ?? ""),
  ).filter(Boolean);
  const contentTokens = tokenize(question).filter(
    (token) => !QUERY_STRUCTURAL_TERMS.has(token),
  );
  const targetTerms = uniqueStrings([...quotedPhrases, ...contentTokens]).slice(0, 6);
  const expandedTerms = uniqueStrings(targetTerms.flatMap((term) => expandQueryTerm(term)));
  const searchTerms = uniqueStrings([...expandedTerms, ...contentTokens]);
  const requiresExactEvidence =
    targetTerms.length > 0
    && (
      intent === "results"
      || /\bwhat\b|\bwhich\b|\bhow\b|\bscore\b|\bmetric\b|\bresult\b/.test(normalizedQuestion)
    );

  return {
    targetTerms,
    expandedTerms,
    searchTerms,
    focusQuery: expandedTerms.length > 0 ? expandedTerms.join(" ") : null,
    requiresExactEvidence,
  };
}

function truncate(value: string | null | undefined, maxChars: number): string {
  if (!value) return "";
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

function buildContextSnippet(
  text: string,
  start: number,
  end: number,
  leftRadius = 20,
  rightRadius = 420,
): string {
  const leftBound = Math.max(0, start - leftRadius);
  const rightBound = Math.min(text.length, end + rightRadius);
  let left = leftBound;
  let right = rightBound;

  while (left > leftBound && !/[\n.!?]/.test(text[left - 1] ?? "")) {
    left -= 1;
  }
  while (right < rightBound && !/[\n.!?]/.test(text[right] ?? "")) {
    right += 1;
  }

  return text.slice(left, right).replace(/\s+/g, " ").trim();
}

function scoreTextMatch(text: string, analysis: QueryAnalysis): number {
  const haystack = normalizeAnalysisText(text);
  let score = 0;
  for (const term of analysis.targetTerms) {
    if (haystack.includes(term)) score += 4;
  }
  for (const term of analysis.expandedTerms) {
    if (!analysis.targetTerms.includes(term) && haystack.includes(term)) score += 2;
  }
  if (analysis.requiresExactEvidence && /\d/.test(text)) score += 1;
  return score;
}

function findTextMatches(
  text: string | null | undefined,
  analysis: QueryAnalysis,
  limit = 3,
): QueryTextMatch[] {
  const cleanText = decodeHtmlEntities(stripHtml(text ?? "")).replace(/\s+/g, " ").trim();
  if (!cleanText || analysis.searchTerms.length === 0) return [];

  const lowerText = cleanText.toLowerCase();
  const matches: QueryTextMatch[] = [];

  for (const term of analysis.searchTerms) {
    const lowerTerm = term.toLowerCase();
    if (!lowerTerm) continue;
    let cursor = 0;
    while (cursor < lowerText.length) {
      const index = lowerText.indexOf(lowerTerm, cursor);
      if (index < 0) break;
      const snippet = buildContextSnippet(cleanText, index, index + lowerTerm.length);
      const matchedTerms = analysis.searchTerms.filter((candidate) =>
        normalizeAnalysisText(snippet).includes(candidate),
      );
      matches.push({
        text: snippet,
        score: scoreTextMatch(snippet, analysis),
        matchedTerms,
      });
      cursor = index + lowerTerm.length;
    }
  }

  const deduped = new Map<string, QueryTextMatch>();
  for (const match of matches) {
    const existing = deduped.get(match.text);
    if (!existing || existing.score < match.score) {
      deduped.set(match.text, match);
    }
  }

  return Array.from(deduped.values())
    .sort((left, right) => right.score - left.score || right.text.length - left.text.length)
    .slice(0, limit);
}

function citationForMatchedText(
  paper: PaperAgentPaperContext,
  sectionPath: string | null,
  match: QueryTextMatch,
): AnswerCitation {
  return {
    paperId: paper.id,
    paperTitle: paper.title,
    snippet: truncate(match.text, MAX_CITATION_SNIPPET_CHARS),
    sectionPath,
    sourceKind: "artifact",
  };
}

function textMatchesAnalysis(
  value: string | null | undefined,
  analysis: QueryAnalysis,
): boolean {
  if (!value) return false;
  const haystack = normalizeAnalysisText(value);
  if (analysis.targetTerms.length === 0) {
    return analysis.expandedTerms.length === 0
      ? haystack.length > 0
      : analysis.expandedTerms.some((term) => haystack.includes(term));
  }
  return analysis.targetTerms.some((term) => haystack.includes(term))
    || analysis.expandedTerms.some((term) => haystack.includes(term));
}

function citationMatchesAnalysis(
  citation: AnswerCitation,
  analysis: QueryAnalysis,
): boolean {
  return textMatchesAnalysis(
    [citation.snippet, citation.sectionPath].filter(Boolean).join(" "),
    analysis,
  );
}

function hasExactEvidence(
  citations: AnswerCitation[],
  analysis: QueryAnalysis,
): boolean {
  if (!analysis.requiresExactEvidence || analysis.targetTerms.length === 0) {
    return citations.length > 0;
  }
  return citations.some((citation) => {
    const haystack = normalizeAnalysisText(citation.snippet);
    return analysis.targetTerms.some((term) => haystack.includes(term))
      || analysis.expandedTerms.some((term) => haystack.includes(term));
  });
}

function matchesContainExactEvidence(
  matches: QueryTextMatch[],
  analysis: QueryAnalysis,
): boolean {
  if (!analysis.requiresExactEvidence || analysis.targetTerms.length === 0) {
    return matches.length > 0;
  }
  return matches.some((match) => {
    const haystack = normalizeAnalysisText(match.text);
    return analysis.targetTerms.some((term) => haystack.includes(term))
      || analysis.expandedTerms.some((term) => haystack.includes(term));
  });
}

function mergeQueryAnalysis(
  base: QueryAnalysis,
  query: string | null | undefined,
): QueryAnalysis {
  const normalizedQuery = query?.trim();
  if (!normalizedQuery) {
    return base;
  }
  const extra = analyzeQuery(normalizedQuery, "results");
  return {
    targetTerms: uniqueStrings([...base.targetTerms, ...extra.targetTerms]),
    expandedTerms: uniqueStrings([...base.expandedTerms, ...extra.expandedTerms]),
    searchTerms: uniqueStrings([...base.searchTerms, ...extra.searchTerms]),
    focusQuery: extra.focusQuery ?? base.focusQuery,
    requiresExactEvidence: base.requiresExactEvidence || extra.requiresExactEvidence,
  };
}

function inferImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function extractJsonObject(rawText: string): string | null {
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = (fenced ?? rawText).trim();
  const start = source.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (!char) continue;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseKeyFindings(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function buildSectionSnapshots(paper: PaperAgentPaperContext): Record<SummarySectionName, string> {
  const fromSummary = paper.summary ? parseSummarySections(paper.summary) : {
    overview: "",
    methodology: "",
    results: "",
  };

  const overviewFromFullText = extractFullTextSection(paper.fullText, [
    "abstract",
    "introduction",
    "overview",
  ]);
  const methodologyFromFullText = extractFullTextSection(paper.fullText, [
    "method",
    "methods",
    "methodology",
    "approach",
    "implementation",
  ]);
  const resultsFromFullText = extractFullTextSection(paper.fullText, [
    "results",
    "experiments",
    "evaluation",
    "analysis",
    "ablation",
  ]);

  return {
    overview: mergeEvidenceBlocks(
      fromSummary.overview,
      paper.abstract,
      parseKeyFindings(paper.keyFindings).join("\n"),
      overviewFromFullText,
    ),
    methodology: mergeEvidenceBlocks(
      fromSummary.methodology,
      methodologyFromFullText,
    ),
    results: mergeEvidenceBlocks(
      resultsFromFullText,
      fromSummary.results,
    ),
  };
}

function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const normalized = trimmed.replace(/^[\d.\s]+/, "").toLowerCase();
  return [
    "abstract",
    "introduction",
    "background",
    "related work",
    "method",
    "methods",
    "methodology",
    "approach",
    "implementation",
    "results",
    "experiments",
    "evaluation",
    "analysis",
    "discussion",
    "limitations",
    "conclusion",
    "appendix",
    "references",
    "acknowledgments",
    "ablation",
  ].some((heading) => normalized === heading || normalized.startsWith(`${heading} `));
}

function extractFullTextSection(
  fullText: string | null,
  headings: string[],
  maxChars = MAX_SECTION_CHARS,
): string {
  if (!fullText) return "";
  const lines = fullText.split(/\r?\n/);
  const normalizedTargets = new Set(headings.map((heading) => heading.toLowerCase()));

  let startIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const normalized = lines[i]?.trim().replace(/^[\d.\s]+/, "").toLowerCase() ?? "";
    if (normalizedTargets.has(normalized)) {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    return "";
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (looksLikeHeading(lines[i] ?? "")) {
      endIndex = i;
      break;
    }
  }

  const section = lines.slice(startIndex, endIndex).join("\n").trim();
  return truncate(section, maxChars);
}

function rankClaimsForQuery(
  claims: PaperClaimView[],
  query: string,
  limit: number,
): PaperClaimView[] {
  const queryTokens = new Set(tokenize(query));
  return claims
    .filter((claim) => !NON_ASSERTIVE_EVIDENCE_TYPES.has(claim.evidenceType))
    .map((claim) => {
      const text = `${claim.text} ${claim.sourceExcerpt} ${claim.sectionPath}`.trim();
      const tokens = tokenize(text);
      let score = claim.confidence;
      for (const token of Array.from(queryTokens)) {
        if (tokens.includes(token)) {
          score += 2;
        } else if (text.toLowerCase().includes(token)) {
          score += 1;
        }
      }

      if (claim.sectionPath?.includes("results")) score += 0.35;
      if (claim.sectionPath?.includes("method")) score += 0.35;
      if (claim.evidenceType === "PRIMARY") score += 0.5;
      return { claim, score };
    })
    .sort((left, right) => right.score - left.score || left.claim.orderIndex - right.claim.orderIndex)
    .slice(0, limit)
    .map((entry) => entry.claim);
}

function citationForSection(
  paper: PaperAgentPaperContext,
  section: SummarySectionName,
  text: string,
): AnswerCitation {
  return {
    paperId: paper.id,
    paperTitle: paper.title,
    snippet: truncate(text, MAX_CITATION_SNIPPET_CHARS),
    sectionPath: section,
    sourceKind: "summary",
  };
}

function citationForClaim(
  paper: PaperAgentPaperContext,
  claim: PaperClaimView,
): AnswerCitation {
  return {
    paperId: paper.id,
    paperTitle: paper.title,
    snippet: truncate(claim.sourceExcerpt || claim.text, MAX_CITATION_SNIPPET_CHARS),
    sectionPath: claim.sectionPath,
    sourceKind: "claim",
  };
}

function citationForFigure(
  paper: PaperAgentPaperContext,
  figure: PaperFigureView,
): AnswerCitation {
  return {
    paperId: paper.id,
    paperTitle: paper.title,
    snippet: truncate(
      [figure.figureLabel, figure.captionText, figure.description]
        .filter(Boolean)
        .join(" — "),
      MAX_CITATION_SNIPPET_CHARS,
    ),
    sectionPath: figure.figureLabel,
    sourceKind: "artifact",
  };
}

function normalizeFigureTarget(value: string): string {
  return normalizeAnalysisText(value)
    .replace(/\bfig\b/g, "figure")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFigureReference(
  value: string | null | undefined,
): { kind: "figure" | "table"; ordinal: string } | null {
  if (!value) return null;
  const normalized = normalizeFigureTarget(value);
  const match = normalized.match(/\b(figure|table)\s+([a-z0-9][a-z0-9.-]*)\b/);
  if (!match?.[1] || !match[2]) return null;
  return {
    kind: match[1] === "table" ? "table" : "figure",
    ordinal: match[2],
  };
}

function extractFigureReferences(
  value: string | null | undefined,
): Array<{ kind: "figure" | "table"; ordinal: string; label: string }> {
  if (!value) return [];
  const seen = new Set<string>();
  const matches = Array.from(
    value.matchAll(/\b(Figure|Fig(?:ure)?\.?|Table)\s+([A-Za-z0-9][A-Za-z0-9.-]*)\b/gi),
  );
  return matches
    .map((match) => {
      const kind = match[1]?.toLowerCase().startsWith("table") ? "table" as const : "figure" as const;
      const ordinal = match[2] ?? "";
      const label = `${kind === "table" ? "Table" : "Figure"} ${ordinal}`;
      return { kind, ordinal, label };
    })
    .filter((reference) => {
      if (!reference.ordinal) return false;
      const key = `${reference.kind}:${reference.ordinal}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function filterFigures(
  figures: PaperFigureView[],
  kind: "figure" | "table" | "any",
  query?: string,
): PaperFigureView[] {
  const filteredKind = kind === "any"
    ? figures
    : figures.filter((figure) => (kind === "table" ? figure.type === "table" : figure.type !== "table"));

  if (!query) {
    return filteredKind;
  }

  const scored = filteredKind.map((figure) => ({
    figure,
    score: scoreFigureQuery(figure, kind, query),
  }));

  const matching = scored.filter((entry) => entry.score > 0);
  return (matching.length > 0 ? matching : scored)
    .sort((left, right) => right.score - left.score || left.figure.figureIndex - right.figure.figureIndex)
    .map((entry) => entry.figure);
}

function scoreFigureQuery(
  figure: PaperFigureView,
  kind: "figure" | "table" | "any",
  query: string,
): number {
  const queryTokens = tokenize(query);
  const haystack = normalizeAnalysisText(
    `${figure.figureLabel ?? ""} ${figure.captionText ?? ""} ${figure.description ?? ""}`,
  );
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 2;
  }
  if (
    kind === "table"
    && /result|metric|benchmark|ablation|score|safety|rai|harm|jailbreak/i.test(query)
  ) {
    score += 1;
  }
  return score;
}

function buildFocusedFigureQuery(
  question: string,
  focusQuery: string | null,
  analysis: QueryAnalysis,
): string {
  const normalizedQuestion = normalizeAnalysisText(question);
  const extraTerms = new Set<string>();

  if (
    /\brai\b|\bresponsible ai\b|\bsafety\b|\bharm\b|\bharmful\b|\bjailbreak\b|\bungroundedness\b/.test(
      normalizedQuestion,
    )
  ) {
    [
      "red",
      "team",
      "alignment",
      "safety",
      "harmful",
      "response",
      "evaluation",
    ].forEach((term) => extraTerms.add(term));
  }

  return Array.from(
    new Set([
      ...analysis.searchTerms,
      ...tokenize(focusQuery ?? ""),
      ...tokenize(question),
      ...Array.from(extraTerms),
    ]),
  ).join(" ");
}

function collectObservedFigureKeys(observations: AgentObservation[]): Set<string> {
  const keys = new Set<string>();

  for (const observation of observations) {
    if (
      observation.tool !== "inspect_table"
      && observation.tool !== "open_figure"
    ) {
      continue;
    }

    for (const value of [
      observation.action,
      observation.input ?? null,
      observation.outputPreview ?? null,
      observation.detail,
    ]) {
      if (!value) continue;
      for (const reference of extractFigureReferences(value)) {
        keys.add(`${reference.kind}:${reference.ordinal}`);
      }
    }

    if (observation.input) {
      keys.add(`target:${normalizeFigureTarget(observation.input)}`);
    }
  }

  return keys;
}

function collectReferencedFiguresFromCitations(
  figures: PaperFigureView[],
  citations: AnswerCitation[],
  kind?: "figure" | "table",
): PaperFigureView[] {
  const seen = new Set<string>();
  const resolved: PaperFigureView[] = [];

  for (const citation of citations) {
    for (const reference of extractFigureReferences(citation.snippet)) {
      const figure = resolveFigureTarget(figures, reference.label);
      if (!figure) continue;
      if (kind === "figure" && figure.type === "table") continue;
      if (kind === "table" && figure.type !== "table") continue;
      if (seen.has(figure.id)) continue;
      seen.add(figure.id);
      resolved.push(figure);
    }
  }

  return resolved;
}

function collectReferencedFiguresFromObservations(
  figures: PaperFigureView[],
  observations: AgentObservation[],
  analysis: QueryAnalysis,
  kind?: "figure" | "table",
): PaperFigureView[] {
  const seen = new Set<string>();
  const resolved: PaperFigureView[] = [];

  for (const observation of observations) {
    const evidenceText = [
      observation.detail,
      observation.outputPreview ?? null,
      observation.input ?? null,
      observation.action,
    ]
      .filter(Boolean)
      .join("\n");
    if (!textMatchesAnalysis(evidenceText, analysis)) {
      continue;
    }

    for (const reference of extractFigureReferences(evidenceText)) {
      const figure = resolveFigureTarget(figures, reference.label);
      if (!figure) continue;
      if (kind === "figure" && figure.type === "table") continue;
      if (kind === "table" && figure.type !== "table") continue;
      if (seen.has(figure.id)) continue;
      seen.add(figure.id);
      resolved.push(figure);
    }
  }

  return resolved;
}

function hasObservedFigure(
  figure: PaperFigureView,
  observedFigureKeys: Set<string>,
): boolean {
  const figureReference = parseFigureReference(figure.figureLabel);
  if (
    figureReference
    && observedFigureKeys.has(`${figureReference.kind}:${figureReference.ordinal}`)
  ) {
    return true;
  }

  return observedFigureKeys.has(`target:${normalizeFigureTarget(figure.figureLabel ?? figure.id)}`);
}

function extractResultTableFocusQuery(question: string): string | null {
  const normalized = normalizeAnalysisText(question);
  const matchedTerms = RESULT_TABLE_FOCUS_TERMS.filter((term) =>
    normalized.includes(term),
  );
  const acronymTerms = Array.from(
    question.matchAll(/\b[A-Z][A-Z0-9-]{1,7}\b/g),
    (match) => match[0]?.toLowerCase() ?? "",
  ).filter(Boolean);
  const focusTerms = Array.from(new Set([...matchedTerms, ...acronymTerms]));
  if (focusTerms.length === 0) return null;
  return focusTerms.join(" ");
}

function buildFocusedEvidenceQuery(
  question: string,
  analysis: QueryAnalysis,
): string | null {
  const domainFocus = extractResultTableFocusQuery(question);
  return uniqueStrings([
    ...analysis.targetTerms,
    domainFocus,
  ]).join(" ") || null;
}

type ResultTableCategory = "core" | "multimodal" | "safety" | "other";

function classifyResultTableCategory(figure: PaperFigureView): ResultTableCategory {
  const haystack = normalizeAnalysisText(
    `${figure.figureLabel ?? ""} ${figure.captionText ?? ""} ${figure.description ?? ""}`,
  );

  if (
    /\brai\b|\bsafety\b|\bharm\b|\bharmful\b|\bjailbreak\b|\bungroundedness\b|\bvlguard\b/.test(
      haystack,
    )
  ) {
    return "safety";
  }

  if (
    /\bmultimodal\b|\bmllm\b|\bvision\b|\bvideo\b|\bmulti image\b|\bmulti-image\b|\bimage\b/.test(
      haystack,
    )
  ) {
    return "multimodal";
  }

  if (
    /\bbenchmark\b|\bmodel quality\b|\brepresentative\b|\bcomparison results\b|\bpublic\b/.test(
      haystack,
    )
  ) {
    return "core";
  }

  return "other";
}

function scoreGenericResultsTable(
  figure: PaperFigureView,
  question: string,
): number {
  const haystack = normalizeAnalysisText(
    `${figure.figureLabel ?? ""} ${figure.captionText ?? ""} ${figure.description ?? ""}`,
  );
  const category = classifyResultTableCategory(figure);
  let score = scoreFigureQuery(figure, "table", question);

  if (category === "core") score += 4;
  if (category === "multimodal") score += 3;
  if (category === "safety") score += 2;
  if (/\brepoqa\b|\bruler\b/.test(haystack)) score -= 3;
  if (/\bpublic\b/.test(haystack)) score += 1;
  if (/\brepresentative\b|\bmodel quality\b/.test(haystack)) score += 2;

  return score;
}

function chooseGenericResultsTable(
  candidates: PaperFigureView[],
  question: string,
  preferredCategories?: ResultTableCategory[],
): PaperFigureView | null {
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((figure) => {
      const category = classifyResultTableCategory(figure);
      let score = scoreGenericResultsTable(figure, question);

      if (preferredCategories?.length) {
        const categoryRank = preferredCategories.indexOf(category);
        score += categoryRank >= 0 ? (preferredCategories.length - categoryRank) * 3 : 0;
      }

      return { figure, score, category };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.figure.figureIndex - right.figure.figureIndex,
    );

  return scored[0]?.figure ?? null;
}

function chooseDeterministicAction(params: {
  paper: PaperAgentPaperContext;
  question: string;
  intent: PaperAnswerIntent;
  sections: Record<SummarySectionName, string>;
  figures: PaperFigureView[];
  observations: AgentObservation[];
  citations: AnswerCitation[];
  artifacts: PaperAgentArtifactDraft[];
  analysis: QueryAnalysis;
}): PaperAgentAction | null {
  const alreadyReadResults = params.observations.some(
    (observation) =>
      observation.tool === "read_section" && observation.input === "results",
  );
  const alreadySearchedFullText = params.observations.some(
    (observation) =>
      observation.tool === "search_passages" && observation.input === "full_text",
  );
  const wantsVisualArtifact = /\btable\b|\bfigure\b|\bchart\b|\bplot\b|\bgraph\b/i.test(
    params.question,
  );
  const focusQuery = buildFocusedEvidenceQuery(params.question, params.analysis);
  const observedFigureKeys = collectObservedFigureKeys(params.observations);
  const summarySections = params.paper.summary
    ? parseSummarySections(params.paper.summary)
    : {
        overview: "",
        methodology: "",
        results: "",
      };
  const extendedResultsSection = extractFullTextSection(
    params.paper.fullText,
    ["results", "experiments", "evaluation", "analysis", "ablation"],
    12000,
  );
  const resultsReferences = extractFigureReferences(
    [params.sections.results, summarySections.results, extendedResultsSection]
      .filter(Boolean)
      .join("\n"),
  );
  const tableFigures = params.figures.filter((figure) => figure.type === "table");
  const nonTableFigures = params.figures.filter((figure) => figure.type !== "table");
  const matchingFocusedTables =
    focusQuery
      ? tableFigures.filter((figure) => scoreFigureQuery(figure, "table", focusQuery) > 0)
      : [];
  const inspectedTables = tableFigures.filter((figure) =>
    hasObservedFigure(figure, observedFigureKeys),
  );
  const openedFigures = nonTableFigures.filter((figure) =>
    hasObservedFigure(figure, observedFigureKeys),
  );
  const alreadyInspectedTable = inspectedTables.length > 0;
  const alreadyOpenedFigure = openedFigures.length > 0;
  const exactEvidenceSatisfied = hasExactEvidence(params.citations, params.analysis);
  const exactEvidenceCitations = exactEvidenceSatisfied
    ? params.citations.filter((citation) => citationMatchesAnalysis(citation, params.analysis))
    : [];
  const sectionReferencedFigures = [
    ...collectReferencedFiguresFromObservations(
      params.figures,
      params.observations.filter((observation) => observation.tool === "read_section"),
      params.analysis,
      "figure",
    ),
    ...resultsReferences
      .filter((reference) => reference.kind === "figure")
      .map((reference) => resolveFigureTarget(params.figures, reference.label))
      .filter((figure): figure is PaperFigureView => Boolean(figure)),
  ];
  const sectionReferencedTables = [
    ...collectReferencedFiguresFromObservations(
      params.figures,
      params.observations.filter((observation) => observation.tool === "read_section"),
      params.analysis,
      "table",
    ),
    ...resultsReferences
      .filter((reference) => reference.kind === "table")
      .map((reference) => resolveFigureTarget(params.figures, reference.label))
      .filter((figure): figure is PaperFigureView => Boolean(figure)),
  ];
  const groundedReferencedFigures = exactEvidenceSatisfied
    ? [
        ...collectReferencedFiguresFromCitations(
          params.figures,
          exactEvidenceCitations,
          "figure",
        ),
        ...collectReferencedFiguresFromObservations(
          params.figures,
          params.observations,
          params.analysis,
          "figure",
        ),
        ...sectionReferencedFigures,
      ].filter((figure, index, figures) =>
        figures.findIndex((candidate) => candidate.id === figure.id) === index
        && !hasObservedFigure(figure, observedFigureKeys),
      )
    : [];
  const groundedReferencedTables = exactEvidenceSatisfied
    ? [
        ...collectReferencedFiguresFromCitations(
          params.figures,
          exactEvidenceCitations,
          "table",
        ),
        ...collectReferencedFiguresFromObservations(
          params.figures,
          params.observations,
          params.analysis,
          "table",
        ),
        ...sectionReferencedTables,
      ].filter((figure, index, figures) =>
        figures.findIndex((candidate) => candidate.id === figure.id) === index
        && !hasObservedFigure(figure, observedFigureKeys),
      )
    : [];
  const prioritizedGroundedFigure = groundedReferencedFigures
    .map((figure) => ({
      figure,
      score: scoreFigureQuery(
        figure,
        "figure",
        buildFocusedFigureQuery(
          params.question,
          focusQuery ?? params.analysis.focusQuery,
          params.analysis,
        ),
      ),
    }))
    .sort((left, right) => right.score - left.score || left.figure.figureIndex - right.figure.figureIndex)[0]?.figure;
  const prioritizedGroundedTable = groundedReferencedTables
    .map((figure) => ({
      figure,
      score: scoreFigureQuery(
        figure,
        "table",
        focusQuery ?? params.analysis.focusQuery ?? params.question,
      ),
    }))
    .sort((left, right) => right.score - left.score || left.figure.figureIndex - right.figure.figureIndex)[0]?.figure;
  const visibleArtifacts = params.artifacts.filter((artifact) =>
    artifact.kind === "TABLE_CARD" || artifact.kind === "FIGURE_CARD" || artifact.kind === "RESULT_SUMMARY",
  );

  if (params.intent === "results" && !alreadyReadResults) {
    return { type: "read_section", section: "results" };
  }

  if (
    params.intent === "results"
    && params.analysis.requiresExactEvidence
    && !alreadySearchedFullText
    && Boolean(params.paper.fullText?.trim())
  ) {
    return {
      type: "search_passages",
      scope: "full_text",
      query: focusQuery ?? params.question.slice(0, 180),
    };
  }

  if (
    params.intent === "results"
    && exactEvidenceSatisfied
    && groundedReferencedFigures.length > 0
    && !alreadyOpenedFigure
  ) {
    const nextFigure = prioritizedGroundedFigure;
    if (nextFigure) {
      return {
        type: "open_figure",
        target: nextFigure.figureLabel ?? nextFigure.id,
      };
    }
  }

  if (
    params.intent === "results"
    && exactEvidenceSatisfied
    && groundedReferencedTables.length > 0
    && !alreadyInspectedTable
  ) {
    const nextTable = prioritizedGroundedTable;
    if (nextTable) {
      return {
        type: "inspect_table",
        target: nextTable.figureLabel ?? nextTable.id,
        query: focusQuery ?? params.question.slice(0, 160),
      };
    }
  }

  if (
    params.intent === "results"
    && exactEvidenceSatisfied
    && alreadyInspectedTable
    && !alreadyOpenedFigure
  ) {
    const figureQuery = buildFocusedFigureQuery(
      params.question,
      focusQuery ?? params.analysis.focusQuery,
      params.analysis,
    );
    const complementaryFigure =
      prioritizedGroundedFigure
      ?? nonTableFigures
        .filter((figure) => !hasObservedFigure(figure, observedFigureKeys))
        .map((figure) => ({
          figure,
          score: scoreFigureQuery(figure, "figure", figureQuery),
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || left.figure.figureIndex - right.figure.figureIndex,
        )[0]?.figure;

    if (complementaryFigure) {
      return {
        type: "open_figure",
        target: complementaryFigure.figureLabel ?? complementaryFigure.id,
      };
    }
  }

  if (
    params.intent === "results"
    && exactEvidenceSatisfied
    && groundedReferencedFigures.length === 0
    && groundedReferencedTables.length === 0
    && !wantsVisualArtifact
  ) {
    return {
      type: "finish",
      answerPlan:
        "Answer from the exact matched evidence already gathered. Do not infer beyond the matched spans.",
    };
  }

  if (
    params.intent === "results"
    && (!exactEvidenceSatisfied || wantsVisualArtifact)
    && focusQuery
    && !alreadyInspectedTable
  ) {
    const bestTable = tableFigures
      .map((figure) => ({
        figure,
        score: scoreFigureQuery(figure, "table", focusQuery),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.figure.figureIndex - right.figure.figureIndex,
      )[0];

    if (bestTable) {
      return {
        type: "inspect_table",
        target: bestTable.figure.figureLabel ?? bestTable.figure.id,
        query: focusQuery,
      };
    }
  }

  if (params.intent === "tables" && !alreadyInspectedTable) {
    if (tableFigures.length === 0) return null;
    const target =
      filterFigures(tableFigures, "table", params.question)[0]?.figureLabel
      ?? filterFigures(tableFigures, "table", params.question)[0]?.id
      ?? null;
    if (target) {
      return {
        type: "inspect_table",
        target,
        query: params.question.slice(0, 160),
      };
    }
  }

  if (params.intent !== "results" || !alreadyReadResults) {
    return null;
  }

  const referencedTables = resultsReferences
    .filter((reference) => reference.kind === "table")
    .map((reference) => resolveFigureTarget(params.figures, reference.label))
    .filter((figure): figure is PaperFigureView => Boolean(figure))
    .filter((figure) => figure.type === "table" && !hasObservedFigure(figure, observedFigureKeys));

  if (
    (!exactEvidenceSatisfied || wantsVisualArtifact)
    && focusQuery
    && inspectedTables.length < 2
    && referencedTables.length > 0
  ) {
    const nextReferencedTable = referencedTables
      .map((figure) => ({
        figure,
        score: scoreFigureQuery(figure, "table", focusQuery),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.figure.figureIndex - right.figure.figureIndex,
      )[0]?.figure;

    if (nextReferencedTable) {
      return {
        type: "inspect_table",
        target: nextReferencedTable.figureLabel ?? nextReferencedTable.id,
        query: focusQuery,
      };
    }
  }

  if ((!exactEvidenceSatisfied || wantsVisualArtifact) && !focusQuery && inspectedTables.length < 2) {
    const remainingTables = tableFigures.filter((figure) =>
      !hasObservedFigure(figure, observedFigureKeys),
    );

    if (remainingTables.length > 0) {
      const preferredCategories =
        inspectedTables.length === 0
          ? (["core", "multimodal", "safety", "other"] as ResultTableCategory[])
          : ((): ResultTableCategory[] => {
              const firstCategory = classifyResultTableCategory(inspectedTables[0]!);
              if (firstCategory === "core") {
                return ["multimodal", "safety", "other", "core"];
              }
              if (firstCategory === "multimodal") {
                return ["core", "safety", "other", "multimodal"];
              }
              if (firstCategory === "safety") {
                return ["core", "multimodal", "other", "safety"];
              }
              return ["core", "multimodal", "safety", "other"];
            })();

      const genericTable = chooseGenericResultsTable(
        remainingTables,
        params.question,
        preferredCategories,
      );

      if (genericTable) {
        return {
          type: "inspect_table",
          target: genericTable.figureLabel ?? genericTable.id,
          query: params.question.slice(0, 160),
        };
      }
    }
  }

  if ((!exactEvidenceSatisfied || wantsVisualArtifact) && !alreadyOpenedFigure) {
    const figureQuery = buildFocusedFigureQuery(params.question, focusQuery, params.analysis);
    const referencedFigures = resultsReferences
      .filter((reference) => reference.kind === "figure")
      .map((reference) => resolveFigureTarget(params.figures, reference.label))
      .filter((figure): figure is PaperFigureView => Boolean(figure))
      .filter((figure) => figure.type !== "table" && !hasObservedFigure(figure, observedFigureKeys));

    const bestReferencedFigure = referencedFigures
      .map((figure) => ({
        figure,
        score: figureQuery ? scoreFigureQuery(figure, "figure", figureQuery) : 0,
      }))
      .sort(
        (left, right) =>
          right.score - left.score || left.figure.figureIndex - right.figure.figureIndex,
      )[0]?.figure;

    const fallbackFigure =
      bestReferencedFigure
      ?? (figureQuery
        ? nonTableFigures
            .filter((figure) => !hasObservedFigure(figure, observedFigureKeys))
            .map((figure) => ({
              figure,
              score: scoreFigureQuery(figure, "figure", figureQuery),
            }))
            .filter((entry) => entry.score > 0)
            .sort(
              (left, right) =>
                right.score - left.score || left.figure.figureIndex - right.figure.figureIndex,
            )[0]?.figure
        : null);

    if (fallbackFigure) {
      return {
        type: "open_figure",
        target: fallbackFigure.figureLabel ?? fallbackFigure.id,
      };
    }
  }

  if (
    params.intent === "results"
    && exactEvidenceSatisfied
    && (
      visibleArtifacts.length > 0
      || (tableFigures.length === 0 && nonTableFigures.length === 0)
    )
  ) {
    return {
      type: "finish",
      answerPlan:
        "Answer from the exact matched evidence already gathered, citing the query-specific spans and attached artifacts.",
    };
  }

  return null;
}

function resolveFigureTarget(
  figures: PaperFigureView[],
  target: string,
): PaperFigureView | null {
  const normalizedTarget = normalizeFigureTarget(target);
  const targetReference = parseFigureReference(target);
  if (targetReference) {
    const exactLabel = figures.find((figure) => {
      const figureReference = parseFigureReference(figure.figureLabel);
      return (
        figureReference?.kind === targetReference.kind
        && figureReference.ordinal === targetReference.ordinal
      );
    });
    if (exactLabel) return exactLabel;
  }

  const exact = figures.find((figure) =>
    normalizeFigureTarget(
      `${figure.figureLabel ?? ""} ${figure.captionText ?? ""}`,
    ) === normalizedTarget
    || figure.id === target,
  );
  if (exact) return exact;

  const candidates = figures
    .map((figure) => {
      const figureReference = parseFigureReference(figure.figureLabel);
      if (
        targetReference
        && (
          figureReference?.kind !== targetReference.kind
          || figureReference.ordinal !== targetReference.ordinal
        )
      ) {
        return { figure, score: -1 };
      }

      const labelHaystack = normalizeFigureTarget(figure.figureLabel ?? "");
      const contextHaystack = normalizeFigureTarget(
        `${figure.captionText ?? ""} ${figure.description ?? ""}`,
      );
      let score = 0;
      for (const token of normalizedTarget.split(" ")) {
        if (!token) continue;
        if (labelHaystack.includes(token)) score += 3;
        else if (contextHaystack.includes(token)) score += 1;
      }
      return { figure, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.figure.figureIndex - right.figure.figureIndex);

  return candidates[0]?.figure ?? null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    );
}

function sanitizeTableCell(value: string): string {
  return truncate(decodeHtmlEntities(stripHtml(value)), MAX_TABLE_CELL_CHARS);
}

function toCsvRow(values: string[]): string {
  return values.map((value) => `"${value.replace(/"/g, '""')}"`).join(",");
}

function isNumericLikeCell(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[,()%]/g, "")
    .replace(/\s+/g, " ");
  if (!normalized) return false;
  return /^[-+]?(\d+(\.\d+)?|\.\d+)(e[-+]?\d+)?([a-z]+)?$/i.test(normalized);
}

function shouldUseFirstRowAsHeader(rows: Array<{ cells: string[]; hasHeader: boolean }>): boolean {
  if (rows.length < 2) return false;
  const first = rows[0]?.cells.filter(Boolean) ?? [];
  const second = rows[1]?.cells.filter(Boolean) ?? [];
  if (first.length === 0 || second.length === 0) return false;

  const firstNumericRatio =
    first.filter(isNumericLikeCell).length / Math.max(first.length, 1);
  const secondNumericRatio =
    second.filter(isNumericLikeCell).length / Math.max(second.length, 1);

  return firstNumericRatio < 0.5 && secondNumericRatio >= firstNumericRatio;
}

function buildParsedTableData(
  parsedRows: Array<{ cells: string[]; hasHeader: boolean }>,
): ParsedTableData | null {
  if (parsedRows.length === 0) return null;

  const headerRow =
    parsedRows[0]?.hasHeader || shouldUseFirstRowAsHeader(parsedRows)
      ? parsedRows[0]
      : null;
  const columns =
    headerRow?.cells.length
      ? headerRow.cells.map((value, index) => value || `Column ${index + 1}`)
      : Array.from(
          { length: parsedRows[0]?.cells.length ?? 0 },
          (_, index) => `Column ${index + 1}`,
        );

  const rows = (headerRow ? parsedRows.slice(1) : parsedRows)
    .slice(0, MAX_TABLE_ROWS)
    .map((row) => columns.map((_, index) => row.cells[index] ?? ""));

  if (columns.length === 0 || rows.length === 0) return null;

  return { columns, rows };
}

function extractElementsByClass(
  html: string,
  classToken: string,
): string[] {
  const results: string[] = [];
  const openTagRegex = /<(span|div)\b[^>]*class=(["'])([^"']*)\2[^>]*>/gi;
  let openMatch: RegExpExecArray | null;

  while ((openMatch = openTagRegex.exec(html)) !== null) {
    const classValue = openMatch[3] ?? "";
    const classTokens = classValue.split(/\s+/).filter(Boolean);
    if (!classTokens.includes(classToken)) {
      continue;
    }

    const tagName = openMatch[1] ?? "span";
    const scanRegex = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}>`, "gi");
    scanRegex.lastIndex = openTagRegex.lastIndex;
    let depth = 1;
    let scanMatch: RegExpExecArray | null;

    while ((scanMatch = scanRegex.exec(html)) !== null) {
      const token = scanMatch[0] ?? "";
      if (token.startsWith(`</${tagName}`)) {
        depth -= 1;
      } else if (!token.endsWith("/>")) {
        depth += 1;
      }

      if (depth === 0) {
        results.push(html.slice(openTagRegex.lastIndex, scanMatch.index));
        openTagRegex.lastIndex = scanRegex.lastIndex;
        break;
      }
    }
  }

  return results;
}

function parseLtxTable(description: string): ParsedTableData | null {
  if (!/\bltx_tabular\b/i.test(description)) {
    return null;
  }

  const tabularContent = extractElementsByClass(description, "ltx_tabular")[0];
  if (!tabularContent) return null;

  const parsedRows = extractElementsByClass(tabularContent, "ltx_tr")
    .map((rowHtml) => {
      const cells = extractElementsByClass(rowHtml, "ltx_td")
        .map((cellHtml) => sanitizeTableCell(cellHtml))
        .filter(Boolean)
        .slice(0, MAX_TABLE_COLUMNS);
      return {
        cells,
        hasHeader: /class=(["'])[^"']*\bltx_th\b/i.test(rowHtml),
      };
    })
    .filter((row) => row.cells.length > 0);

  return buildParsedTableData(parsedRows);
}

function parseHtmlTable(description: string | null): ParsedTableData | null {
  if (!description) {
    return null;
  }

  if (!/<table[\s>]/i.test(description)) {
    return parseLtxTable(description);
  }

  const rowMatches = Array.from(
    description.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi),
  );
  if (rowMatches.length === 0) return null;

  const parsedRows = rowMatches
    .map((match) => {
      const rowHtml = match[1] ?? "";
      const hasHeader = /<th\b/i.test(rowHtml);
      const cells = Array.from(
        rowHtml.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi),
      )
        .map((cellMatch) => sanitizeTableCell(cellMatch[2] ?? ""))
        .filter(Boolean)
        .slice(0, MAX_TABLE_COLUMNS);
      return { cells, hasHeader };
    })
    .filter((row) => row.cells.length > 0);

  return buildParsedTableData(parsedRows);
}

function queryParsedTable(
  table: ParsedTableData,
  query?: string,
): TableQueryMatch[] {
  const queryTokens = query ? tokenize(query) : [];
  const scored = table.rows
    .map((row, rowIndex) => {
      if (queryTokens.length === 0) {
        return { rowIndex, score: 1, values: row };
      }
      const haystack = normalizeAnalysisText(
        `${table.columns.join(" ")} ${row.join(" ")}`,
      );
      let score = 0;
      for (const token of queryTokens) {
        if (haystack.includes(token)) score += 1;
      }
      return { rowIndex, score, values: row };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.rowIndex - right.rowIndex);

  if (scored.length > 0) {
    return scored.slice(0, 4);
  }

  return table.rows.slice(0, 4).map((row, rowIndex) => ({
    rowIndex,
    score: 0,
    values: row,
  }));
}

function buildResultArtifact(
  paper: PaperAgentPaperContext,
  resultsText: string,
  supportingClaims: PaperClaimView[],
  options?: {
    query?: string | null;
    matches?: QueryTextMatch[];
  },
): PaperAgentArtifactDraft {
  return {
    kind: "RESULT_SUMMARY",
    title: "Results section",
    payloadJson: JSON.stringify({
      paperId: paper.id,
      paperTitle: paper.title,
      excerpt: truncate(options?.matches?.[0]?.text ?? resultsText, 1200),
      query: options?.query ?? null,
      matches: (options?.matches ?? []).map((match) => ({
        text: match.text,
        score: match.score,
        matchedTerms: match.matchedTerms,
      })),
      claims: supportingClaims.slice(0, 3).map((claim) => ({
        text: claim.text,
        sectionPath: claim.sectionPath,
      })),
    }),
  };
}

function buildFigureArtifact(
  figure: PaperFigureView,
  options?: {
    tableQuery?: string;
    figureQuery?: string;
    textMatches?: QueryTextMatch[];
  },
): PaperAgentArtifactDraft {
  const parsedTable =
    figure.type === "table" ? parseHtmlTable(figure.description) : null;
  const matches =
    parsedTable && figure.type === "table"
      ? queryParsedTable(parsedTable, options?.tableQuery)
      : [];
  return {
    kind: figure.type === "table" ? "TABLE_CARD" : "FIGURE_CARD",
    title: figure.figureLabel || (figure.type === "table" ? "Table" : "Figure"),
    payloadJson: JSON.stringify({
      figureId: figure.id,
      paperId: figure.paperId,
      figureLabel: figure.figureLabel,
      captionText: figure.captionText,
      description:
        figure.type === "table"
          ? truncate(stripHtml(figure.description || ""), 1200)
          : truncate(figure.description, 600),
      type: figure.type,
      table:
        parsedTable && figure.type === "table"
          ? {
              columns: parsedTable.columns,
              rows: parsedTable.rows,
              query: options?.tableQuery,
              matches,
              csvPreview: [
                toCsvRow(parsedTable.columns),
                ...parsedTable.rows.map((row) => toCsvRow(row)),
              ].join("\n"),
            }
          : null,
      matches:
        figure.type !== "table"
          ? (options?.textMatches ?? []).map((match) => ({
              text: match.text,
              score: match.score,
              matchedTerms: match.matchedTerms,
            }))
          : null,
      query:
        figure.type === "table"
          ? options?.tableQuery ?? null
          : options?.figureQuery ?? null,
      imagePath: figure.imagePath,
      pdfPage: figure.pdfPage,
      sourceUrl: figure.sourceUrl,
    }),
  };
}

function buildCodeArtifact(
  payload: CodeSnippetArtifactPayload,
): PaperAgentArtifactDraft {
  return {
    kind: "CODE_SNIPPET",
    title: payload.filename,
    payloadJson: JSON.stringify(payload),
  };
}

function formatFigureInventory(figures: PaperFigureView[]): string {
  if (figures.length === 0) return "none";
  return figures
    .slice(0, 12)
    .map((figure) =>
      `${figure.figureLabel || figure.id} (${figure.type}${figure.pdfPage ? `, p.${figure.pdfPage}` : ""})${figure.captionText ? ` — ${truncate(figure.captionText, 120)}` : ""}`,
    )
    .join("\n");
}

function formatObservations(observations: AgentObservation[]): string {
  if (observations.length === 0) {
    return "No tool observations yet.";
  }
  return observations
    .map(
      (observation) =>
        `Step ${observation.step}: ${observation.action}\n${truncate(observation.detail, 500)}`,
    )
    .join("\n\n");
}

function buildPlannerPrompt(params: {
  paper: PaperAgentPaperContext;
  question: string;
  intent: PaperAnswerIntent;
  selectedText: string | null;
  sections: Record<SummarySectionName, string>;
  figures: PaperFigureView[];
  observations: AgentObservation[];
  analysis: QueryAnalysis;
}): string {
  const sectionAvailability = (["overview", "methodology", "results"] as const)
    .map((section) => `${section}: ${params.sections[section] ? "available" : "missing"}`)
    .join(", ");
  const figureInventory = formatFigureInventory(
    params.figures.filter((figure) => figure.type !== "table"),
  );
  const tableInventory = formatFigureInventory(
    params.figures.filter((figure) => figure.type === "table"),
  );

  return `You are a bounded paper-chat agent. Decide the next best tool call to answer the user's question about a single paper.

Paper: ${params.paper.title}${params.paper.year ? ` (${params.paper.year})` : ""}
Intent: ${params.intent}
Question: ${params.question}
${params.selectedText ? `Selected text:\n${truncate(params.selectedText, 800)}\n` : ""}
Target terms: ${params.analysis.targetTerms.join(", ") || "none"}
Expanded search terms: ${params.analysis.searchTerms.join(", ") || "none"}
Requires exact evidence: ${params.analysis.requiresExactEvidence ? "yes" : "no"}

Available tools:
- read_section(section): use for overview, methodology, or results; when the query has a concrete target, hunt for exact matched spans inside the section instead of only summarizing it
- search_passages(scope, query): search query-matched spans across results/full text when section summaries are insufficient
- search_claims(query, limit): use to recover grounded claim excerpts
- list_figures(kind, query, limit): use to inspect available figures or tables
- inspect_table(query, target): use to extract structured rows from a specific or inferred table
- open_figure(target): use to open one figure/table by label, id, or descriptive target; for concrete targets, recover matching caption/description evidence, and visually inspect the figure only if text evidence is still insufficient
- finish(answerPlan): use only after enough evidence is gathered

Tool-use policy:
- Prefer results and tables for metric/performance questions.
- Prefer inspect_table when the question asks for a specific number, row, column, metric, or ablation detail.
- Prefer exact query matches over generic summaries. If the question names a concrete target, do not finish until you have either found that target in the evidence or exhausted the relevant section/table/figure searches.
- Prefer methodology and claims for implementation or snippet questions.
- Prefer figures when the user asks to show, inspect, or explain a figure/diagram/table.
- Do not loop. Gather the minimum evidence required, then finish.

Section availability: ${sectionAvailability}

Available figures:
${figureInventory}

Available tables:
${tableInventory}

Current observations:
${formatObservations(params.observations)}`;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(value);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

function normalizeOptionalText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxChars);
}

function fallbackAgentAction(params: {
  intent: PaperAnswerIntent;
  observations: AgentObservation[];
  question: string;
  analysis: QueryAnalysis;
}): PaperAgentAction {
  if (params.observations.length > 0) {
    return {
      type: "finish",
      answerPlan: "Use the gathered evidence to answer directly and keep the response grounded.",
    };
  }

  switch (params.intent) {
    case "results":
      return { type: "read_section", section: "results" };
    case "figures":
      return { type: "list_figures", kind: "figure", limit: 4 };
    case "tables":
      return {
        type: "inspect_table",
        query: (params.analysis.focusQuery ?? params.question).slice(0, 160),
      };
    case "generated_artifact":
      return { type: "read_section", section: "methodology" };
    case "claims":
      return {
        type: "search_claims",
        query: params.question.slice(0, 160),
        limit: 4,
      };
    default:
      return { type: "read_section", section: "overview" };
  }
}

function normalizePlannerAction(
  raw: PaperAnswerAgentActionRuntimeOutput,
  params: {
    intent: PaperAnswerIntent;
    observations: AgentObservation[];
    question: string;
    analysis: QueryAnalysis;
  },
): PaperAgentAction {
  switch (raw.type) {
    case "read_section":
      if (
        raw.section === "overview" ||
        raw.section === "methodology" ||
        raw.section === "results"
      ) {
        return { type: "read_section", section: raw.section };
      }
      break;
    case "search_passages": {
      const query = normalizeOptionalText(raw.query, 180);
      if (query) {
        return {
          type: "search_passages",
          scope:
            raw.scope === "results" || raw.scope === "full_text" || raw.scope === "all"
              ? raw.scope
              : "full_text",
          query,
        };
      }
      break;
    }
    case "search_claims": {
      const query = normalizeOptionalText(raw.query, 160);
      if (query) {
        return {
          type: "search_claims",
          query,
          limit: clampInteger(raw.limit, 1, 6, 4),
        };
      }
      break;
    }
    case "list_figures":
      return {
        type: "list_figures",
        kind:
          raw.kind === "figure" || raw.kind === "table" || raw.kind === "any"
            ? raw.kind
            : "any",
        query: normalizeOptionalText(raw.query, 120),
        limit: clampInteger(raw.limit, 1, 8, 5),
      };
    case "inspect_table":
      return {
        type: "inspect_table",
        query: normalizeOptionalText(raw.query, 160),
        target: normalizeOptionalText(raw.target, 120),
      };
    case "open_figure": {
      const target = normalizeOptionalText(raw.target, 120);
      if (target) {
        return { type: "open_figure", target };
      }
      break;
    }
    case "finish":
      return {
        type: "finish",
        answerPlan:
          normalizeOptionalText(raw.answerPlan, 240) ??
          "Use the gathered evidence to answer directly.",
      };
  }

  return fallbackAgentAction(params);
}

async function chooseNextAgentAction(params: {
  paper: PaperAgentPaperContext;
  question: string;
  intent: PaperAnswerIntent;
  selectedText: string | null;
  sections: Record<SummarySectionName, string>;
  figures: PaperFigureView[];
  observations: AgentObservation[];
  citations: AnswerCitation[];
  artifacts: PaperAgentArtifactDraft[];
  analysis: QueryAnalysis;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
}): Promise<ChosenPaperAgentAction> {
  const deterministicAction = chooseDeterministicAction({
    paper: params.paper,
    question: params.question,
    intent: params.intent,
    sections: params.sections,
    figures: params.figures,
    observations: params.observations,
    citations: params.citations,
    artifacts: params.artifacts,
    analysis: params.analysis,
  });
  if (deterministicAction) {
    return { action: deterministicAction, source: "fallback" };
  }

  try {
    const action = await withPaperLlmContext(
    {
      operation: PAPER_INTERACTIVE_LLM_OPERATIONS.CHAT_AGENT_PLAN,
      paperId: params.paper.id,
      userId: params.userId,
      runtime: "interactive",
      source: "papers.answer_engine.agent",
      metadata: {
        intent: params.intent,
        observationCount: params.observations.length,
      },
    },
    async () => {
      const { object } = await generateStructuredObject({
        provider: params.provider,
        modelId: params.modelId,
        proxyConfig: params.proxyConfig ?? undefined,
        schema: paperAnswerAgentActionRuntimeOutputSchema,
        schemaName: "paperAnswerAgentAction",
        maxTokens: 400,
        system:
          "Return only the next tool action as structured output. Never answer the user directly here.",
        prompt: buildPlannerPrompt(params),
      });
      return normalizePlannerAction(object, {
        intent: params.intent,
        observations: params.observations,
        question: params.question,
        analysis: params.analysis,
      });
    },
  );
    return { action, source: "planner" };
  } catch (error) {
    console.warn("[answer-engine] planner fallback:", error);
    return {
      action: fallbackAgentAction({
        intent: params.intent,
        observations: params.observations,
        question: params.question,
        analysis: params.analysis,
      }),
      source: "fallback",
    };
  }
}

async function loadPaperFigures(paperId: string): Promise<PaperFigureView[]> {
  const figures = await prisma.paperFigure.findMany({
    select: FIGURE_VIEW_SELECT,
    where: {
      paperId,
      isPrimaryExtraction: true,
    },
    orderBy: [{ pdfPage: "asc" }, { figureIndex: "asc" }],
  });
  return mapPaperFiguresToView(figures);
}

function getPassageSearchText(params: {
  paper: PaperAgentPaperContext;
  sections: Record<SummarySectionName, string>;
  scope: PassageSearchScope;
}): string {
  switch (params.scope) {
    case "results":
      return params.sections.results;
    case "all":
      return mergeEvidenceBlocks(
        params.sections.results,
        params.sections.overview,
        params.paper.fullText,
      );
    case "full_text":
    default:
      return params.paper.fullText ?? "";
  }
}

async function inspectFigureWithVision(params: {
  figure: PaperFigureView;
  question: string;
  analysis: QueryAnalysis;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
}): Promise<{ matches: QueryTextMatch[]; note: string | null }> {
  if (!params.figure.imagePath) {
    return { matches: [], note: null };
  }

  let imageBuffer: Buffer | null = null;
  let imagePathUsed: string | null = null;
  for (const candidate of resolveStorageCandidates(params.figure.imagePath)) {
    try {
      imageBuffer = await readFile(candidate);
      imagePathUsed = candidate;
      break;
    } catch {
      continue;
    }
  }

  if (!imageBuffer || !imagePathUsed) {
    return { matches: [], note: "Figure image was unavailable on disk." };
  }

  try {
    return await withPaperLlmContext(
      {
        operation: PAPER_INTERACTIVE_LLM_OPERATIONS.CHAT_AGENT_FIGURE,
        paperId: params.figure.paperId,
        userId: params.userId,
        runtime: "interactive",
        source: "papers.answer_engine.figure_inspection",
        metadata: {
          figureId: params.figure.id,
          figureLabel: params.figure.figureLabel,
        },
      },
      async () => {
        const result = await streamLLMResponse({
          provider: params.provider,
          modelId: params.modelId,
          proxyConfig: params.proxyConfig ?? undefined,
          system: [
            "You are inspecting one paper figure image to recover exact evidence for a user question.",
            "Return JSON only.",
            "Do not infer unseen values or generalize from the caption.",
            "Use only text or values visible in the image or explicitly present in the caption.",
            "Schema:",
            '{"found": boolean, "matches": [{"text": string, "matchedTerms": string[]}], "note": string | null}',
          ].join("\n"),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    `Question: ${params.question}`,
                    `Target terms: ${params.analysis.targetTerms.join(", ") || "none"}`,
                    `Expanded terms: ${params.analysis.searchTerms.join(", ") || "none"}`,
                    `Figure label: ${params.figure.figureLabel ?? params.figure.id}`,
                    `Caption: ${params.figure.captionText ?? "none"}`,
                    "Task: recover up to three short exact evidence snippets from the figure that answer the question.",
                    "If the figure only supports a weaker statement, return that exact visible statement instead of inventing a number.",
                  ].join("\n"),
                },
                {
                  type: "image",
                  image: new Uint8Array(imageBuffer),
                  mimeType: inferImageMimeType(imagePathUsed),
                },
              ],
            },
          ],
        });

        const rawText = await result.text;
        const jsonText = extractJsonObject(rawText);
        if (!jsonText) {
          return { matches: [], note: "Figure analysis did not return JSON." };
        }

        const parsed = JSON.parse(jsonText) as FigureVisualInspectionPayload;
        const matches = Array.isArray(parsed.matches)
          ? parsed.matches
              .map((match) => {
                const text = typeof match?.text === "string" ? match.text.trim() : "";
                if (!text) return null;
                const matchedTerms = Array.isArray(match.matchedTerms)
                  ? match.matchedTerms.filter((term): term is string => typeof term === "string")
                  : params.analysis.searchTerms.filter((term) =>
                      normalizeAnalysisText(text).includes(term),
                    );
                return {
                  text,
                  matchedTerms,
                  score: scoreTextMatch(text, params.analysis),
                } satisfies QueryTextMatch;
              })
              .filter((match): match is QueryTextMatch => Boolean(match))
              .sort((left, right) => right.score - left.score || right.text.length - left.text.length)
              .slice(0, MAX_VISUAL_MATCHES)
          : [];

        return {
          matches,
          note: typeof parsed.note === "string" ? parsed.note.trim() || null : null,
        };
      },
    );
  } catch (error) {
    console.warn("[answer-engine] figure vision fallback failed:", error);
    return { matches: [], note: "Lazy figure analysis failed." };
  }
}

function buildCodeArtifactPrompt(params: {
  paper: PaperAgentPaperContext;
  question: string;
  selectedText: string | null;
  citations: AnswerCitation[];
  artifacts: PaperAgentArtifactDraft[];
  observations: AgentObservation[];
}): string {
  const evidenceLines = params.citations
    .slice(0, 8)
    .map(
      (citation, index) =>
        `[S${index + 1}] ${citation.paperTitle}${citation.sectionPath ? ` / ${citation.sectionPath}` : ""}\n${citation.snippet}`,
    )
    .join("\n\n");
  const artifactLines = params.artifacts
    .map((artifact, index) => `Artifact ${index + 1} (${artifact.kind}): ${artifact.title}\n${artifact.payloadJson}`)
    .join("\n\n");

  return `Create a concise, useful code snippet artifact derived from the paper evidence below.

Paper: ${params.paper.title}${params.paper.year ? ` (${params.paper.year})` : ""}
Question: ${params.question}
${params.selectedText ? `Selected text:\n${truncate(params.selectedText, 800)}\n\n` : ""}Rules:
- The code must be a derived implementation sketch, not a claim of verbatim paper code.
- Keep it compact and runnable-looking.
- Reference the method or result the snippet is based on in the summary.
- If critical details are missing, make assumptions explicit in the assumptions array.
- Prefer Python unless the request strongly implies another language.
- If the user explicitly asks for a specific output format or language, honor that request in the artifact.

Observations:
${formatObservations(params.observations)}

Retrieved sources:
${evidenceLines || "No grounded citations were available."}

Structured artifacts:
${artifactLines || "No structured artifacts attached."}`;
}

async function generateCodeSnippetArtifact(params: {
  paper: PaperAgentPaperContext;
  question: string;
  selectedText: string | null;
  citations: AnswerCitation[];
  artifacts: PaperAgentArtifactDraft[];
  observations: AgentObservation[];
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
}): Promise<CodeSnippetArtifactPayload | null> {
  return withPaperLlmContext(
    {
      operation: PAPER_INTERACTIVE_LLM_OPERATIONS.CHAT_AGENT_CODE,
      paperId: params.paper.id,
      userId: params.userId,
      runtime: "interactive",
      source: "papers.answer_engine.code_artifact",
    },
    async () => {
      const { object } = await generateStructuredObject({
        provider: params.provider,
        modelId: params.modelId,
        proxyConfig: params.proxyConfig ?? undefined,
        schema: paperAnswerCodeArtifactRuntimeOutputSchema,
        schemaName: "paperAnswerCodeArtifact",
        maxTokens: 1200,
        system:
          "Return one compact code artifact as structured output. Do not add prose outside the schema.",
        prompt: buildCodeArtifactPrompt(params),
      });

      if (!object.code?.trim()) {
        return null;
      }
      return object;
    },
  );
}

function dedupeCitations(citations: AnswerCitation[]): AnswerCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = [
      citation.paperId,
      citation.sourceKind,
      citation.sectionPath ?? "",
      citation.snippet,
    ].join("::");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeArtifacts(artifacts: PaperAgentArtifactDraft[]): PaperAgentArtifactDraft[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.kind}::${artifact.title}::${artifact.payloadJson}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function updateHash(hash: ReturnType<typeof createHash>, value: string | number | null | undefined): void {
  hash.update(String(value ?? ""));
  hash.update("\u001f");
}

function buildPaperAgentEvidenceCacheKey(params: {
  paper: PaperAgentPaperContext;
  question: string;
  intent: PaperAnswerIntent;
  selectedText: string | null;
  provider: LLMProvider;
  modelId: string;
  analysis: QueryAnalysis;
  figures: PaperFigureView[];
}): string {
  const hash = createHash("sha1");
  updateHash(hash, PAPER_AGENT_EVIDENCE_CACHE_VERSION);
  updateHash(hash, params.paper.id);
  updateHash(hash, params.intent);
  updateHash(hash, params.provider);
  updateHash(hash, params.modelId);

  const queryFingerprint = uniqueStrings([
    params.analysis.focusQuery,
    ...params.analysis.targetTerms,
    ...params.analysis.expandedTerms,
  ]).join("|") || normalizeAnalysisText(params.question);
  updateHash(hash, queryFingerprint);
  updateHash(hash, normalizeAnalysisText(params.selectedText ?? ""));

  updateHash(hash, params.paper.title);
  updateHash(hash, params.paper.year ?? "");
  updateHash(hash, params.paper.abstract ?? "");
  updateHash(hash, params.paper.summary ?? "");
  updateHash(hash, params.paper.keyFindings ?? "");
  updateHash(hash, params.paper.fullText ?? "");

  for (const figure of params.figures) {
    updateHash(hash, figure.id);
    updateHash(hash, figure.figureLabel ?? "");
    updateHash(hash, figure.captionText ?? "");
    updateHash(hash, figure.description ?? "");
    updateHash(hash, figure.type);
    updateHash(hash, figure.figureIndex);
    updateHash(hash, figure.pdfPage ?? "");
    updateHash(hash, figure.imagePath ?? "");
  }

  return `${params.paper.id}:${hash.digest("hex")}`;
}

function parsePreparedPaperAgentEvidence(
  responsePayload: string | null,
): PreparedPaperAgentEvidence | null {
  if (!responsePayload) return null;
  try {
    const parsed = JSON.parse(responsePayload) as PreparedPaperAgentEvidence;
    if (
      !parsed
      || !Array.isArray(parsed.citations)
      || !Array.isArray(parsed.artifacts)
      || !Array.isArray(parsed.actions)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function preparePaperAgentEvidenceUncached(params: {
  paper: PaperAgentPaperContext;
  question: string;
  intent: PaperAnswerIntent;
  selectedText: string | null;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
  sections: Record<SummarySectionName, string>;
  figures: PaperFigureView[];
  queryAnalysis: QueryAnalysis;
}): Promise<PreparedPaperAgentEvidence> {
  const sections = params.sections;
  const figures = params.figures;
  const queryAnalysis = params.queryAnalysis;
  const citations: AnswerCitation[] = [];
  const artifacts: PaperAgentArtifactDraft[] = [];
  const observations: AgentObservation[] = [];

  for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
    const chosen = await chooseNextAgentAction({
      paper: params.paper,
      question: params.question,
      intent: params.intent,
      selectedText: params.selectedText,
      sections,
      figures,
      observations,
      citations,
      artifacts,
      analysis: queryAnalysis,
      provider: params.provider,
      modelId: params.modelId,
      proxyConfig: params.proxyConfig,
      userId: params.userId,
    });
    const action = chosen.action;

    if (action.type === "finish") {
      observations.push({
        step,
        action: "Finish answer",
        detail: action.answerPlan,
        phase: "synthesize",
        status: "completed",
        source: chosen.source,
        tool: "finish",
        outputPreview: action.answerPlan,
      });
      break;
    }

    if (action.type === "read_section") {
      const citationsBefore = citations.length;
      const artifactsBefore = artifacts.length;
      const sectionText = sections[action.section];
      if (!sectionText) {
        observations.push({
          step,
          action: `Read ${action.section} section`,
          detail: "Section was not available.",
          phase: "retrieve",
          status: "missing",
          source: chosen.source,
          tool: "read_section",
          input: action.section,
          outputPreview: "Section not available in extracted paper text.",
        });
        continue;
      }

      const sectionMatches =
        action.section === "results"
          ? findTextMatches(sectionText, queryAnalysis, 2)
          : [];
      if (sectionMatches.length > 0) {
        citations.push(
          ...sectionMatches.map((match) =>
            citationForMatchedText(params.paper, action.section, match),
          ),
        );
      } else {
        citations.push(citationForSection(params.paper, action.section, sectionText));
      }
      const supportingClaims = rankClaimsForQuery(
        params.paper.claims,
        `${params.question} ${action.section}`,
        3,
      );

      if (action.section === "results") {
        artifacts.push(
          buildResultArtifact(params.paper, sectionText, supportingClaims, {
            query: queryAnalysis.focusQuery,
            matches: sectionMatches,
          }),
        );
      }

      observations.push({
        step,
        action: `Read ${action.section} section`,
        detail:
          sectionMatches.length > 0
            ? sectionMatches.map((match) => `- ${match.text}`).join("\n")
            : truncate(sectionText, 600),
        phase: "retrieve",
        status: "completed",
        source: chosen.source,
        tool: "read_section",
        input: action.section,
        outputPreview:
          sectionMatches.length > 0
            ? `${sectionMatches.length} exact span${sectionMatches.length === 1 ? "" : "s"} matched in ${action.section}.`
            : `Loaded ${action.section} evidence.`,
        citationsAdded: citations.length - citationsBefore,
        artifactsAdded: artifacts.length - artifactsBefore,
      });
      continue;
    }

    if (action.type === "search_passages") {
      const citationsBefore = citations.length;
      const searchAnalysis = mergeQueryAnalysis(queryAnalysis, action.query);
      const searchText = getPassageSearchText({
        paper: params.paper,
        sections,
        scope: action.scope,
      });
      const exactTargetAnalysis =
        searchAnalysis.targetTerms.length > 0
          ? {
              ...searchAnalysis,
              expandedTerms: [],
              searchTerms: searchAnalysis.targetTerms,
            }
          : searchAnalysis;
      const matches =
        findTextMatches(searchText, exactTargetAnalysis, 3).length > 0
          ? findTextMatches(searchText, exactTargetAnalysis, 3)
          : findTextMatches(searchText, searchAnalysis, 3);
      if (matches.length === 0) {
        observations.push({
          step,
          action: "Search passages",
          detail: "No exact passage matches were found.",
          phase: "retrieve",
          status: "missing",
          source: chosen.source,
          tool: "search_passages",
          input: action.scope,
          outputPreview: "No query-matched passages were found in the requested scope.",
        });
        continue;
      }

      citations.push(
        ...matches.map((match) =>
          citationForMatchedText(
            params.paper,
            action.scope === "full_text" ? "full_text" : action.scope,
            match,
          ),
        ),
      );
      observations.push({
        step,
        action: "Search passages",
        detail: matches.map((match) => `- ${match.text}`).join("\n"),
        phase: "retrieve",
        status: "completed",
        source: chosen.source,
        tool: "search_passages",
        input: action.scope,
        outputPreview: `${matches.length} exact passage match${matches.length === 1 ? "" : "es"} found in ${action.scope}.`,
        citationsAdded: citations.length - citationsBefore,
      });
      continue;
    }

    if (action.type === "search_claims") {
      const citationsBefore = citations.length;
      const rankedClaims = rankClaimsForQuery(
        params.paper.claims,
        action.query,
        action.limit,
      );
      if (rankedClaims.length === 0) {
        observations.push({
          step,
          action: "Search claims",
          detail: "No relevant claims found.",
          phase: "retrieve",
          status: "missing",
          source: chosen.source,
          tool: "search_claims",
          input: action.query,
          outputPreview: "No relevant claims matched the question.",
        });
        continue;
      }

      citations.push(
        ...rankedClaims.map((claim) => citationForClaim(params.paper, claim)),
      );
      observations.push({
        step,
        action: "Search claims",
        detail: rankedClaims.map((claim) => `- ${claim.text}`).join("\n"),
        phase: "retrieve",
        status: "completed",
        source: chosen.source,
        tool: "search_claims",
        input: action.query,
        outputPreview: `${rankedClaims.length} grounded claim${rankedClaims.length === 1 ? "" : "s"} matched.`,
        citationsAdded: citations.length - citationsBefore,
      });
      continue;
    }

    if (action.type === "list_figures") {
      const visibleFigures = filterFigures(
        figures,
        action.kind,
        action.query,
      ).slice(0, action.limit);
      observations.push({
        step,
        action: `List ${action.kind === "any" ? "visual artifacts" : `${action.kind}s`}`,
        detail:
          visibleFigures.length > 0
            ? visibleFigures
                .map(
                  (figure) =>
                    `- ${figure.figureLabel || figure.id} (${figure.type})${figure.captionText ? ` — ${truncate(figure.captionText, 140)}` : ""}`,
                )
                .join("\n")
            : "No matching figures or tables were found.",
        phase: "retrieve",
        status: visibleFigures.length > 0 ? "completed" : "missing",
        source: chosen.source,
        tool: "list_figures",
        input: action.query ?? action.kind,
        outputPreview:
          visibleFigures.length > 0
            ? `${visibleFigures.length} candidate ${action.kind === "any" ? "artifacts" : `${action.kind}${visibleFigures.length === 1 ? "" : "s"}`} found.`
            : "No matching figures or tables were found.",
      });
      continue;
    }

    if (action.type === "inspect_table") {
      const citationsBefore = citations.length;
      const artifactsBefore = artifacts.length;
      const tableFigures = figures.filter((figure) => figure.type === "table");
      const figure = action.target
        ? resolveFigureTarget(tableFigures, action.target)
        : filterFigures(tableFigures, "table", action.query)[0] ?? null;
      if (!figure) {
        observations.push({
          step,
          action: "Inspect table",
          detail: "No matching table was found.",
          phase: "inspect",
          status: "missing",
          source: chosen.source,
          tool: "inspect_table",
          input: action.target ?? action.query ?? "table",
          outputPreview: "No matching table was found.",
        });
        continue;
      }

      const parsedTable = parseHtmlTable(figure.description);
      const matches = parsedTable
        ? queryParsedTable(
            parsedTable,
            action.query ?? queryAnalysis.focusQuery ?? params.question,
          )
        : [];

      citations.push(citationForFigure(params.paper, figure));
      if (matches[0]) {
        citations.push({
          paperId: params.paper.id,
          paperTitle: params.paper.title,
          snippet: `${figure.figureLabel || "Table"} row ${matches[0].rowIndex + 1}: ${matches[0].values.join(" | ")}`,
          sectionPath: figure.figureLabel,
          sourceKind: "artifact",
        });
      }
      artifacts.push(
        buildFigureArtifact(figure, {
          tableQuery: action.query ?? queryAnalysis.focusQuery ?? params.question,
        }),
      );
      observations.push({
        step,
        action: `Inspect ${figure.figureLabel || "table"}`,
        detail: parsedTable
          ? `${figure.figureLabel || figure.id}: ${parsedTable.rows.length} extracted rows, ${matches.length} matched preview rows.`
          : `${figure.figureLabel || figure.id}: table opened, but no structured rows were extracted.`,
        phase: "inspect",
        status: "completed",
        source: chosen.source,
        tool: "inspect_table",
        input: action.target ?? action.query ?? "table",
        outputPreview: parsedTable
          ? `${matches.length} matched row${matches.length === 1 ? "" : "s"} from ${figure.figureLabel || "the table"}.`
          : `Opened ${figure.figureLabel || "table"}, but structured rows were unavailable.`,
        citationsAdded: citations.length - citationsBefore,
        artifactsAdded: artifacts.length - artifactsBefore,
      });
      continue;
    }

    if (action.type === "open_figure") {
      const citationsBefore = citations.length;
      const artifactsBefore = artifacts.length;
      const figure = resolveFigureTarget(figures, action.target);
      if (!figure) {
        observations.push({
          step,
          action: "Open figure",
          detail: "No matching figure or table was found.",
          phase: "inspect",
          status: "missing",
          source: chosen.source,
          tool: "open_figure",
          input: action.target,
          outputPreview: "No matching figure or table was found.",
        });
        continue;
      }

      const figureSearchAnalysis = mergeQueryAnalysis(queryAnalysis, queryAnalysis.focusQuery ?? params.question);
      let figureMatches = findTextMatches(
        [figure.captionText, figure.description].filter(Boolean).join("\n"),
        figureSearchAnalysis,
        2,
      );
      let visionNote: string | null = null;
      if (
        figure.type !== "table"
        && params.intent === "results"
        && figure.imagePath
        && figureSearchAnalysis.requiresExactEvidence
      ) {
        const visualInspection = await inspectFigureWithVision({
          figure,
          question: params.question,
          analysis: figureSearchAnalysis,
          provider: params.provider,
          modelId: params.modelId,
          proxyConfig: params.proxyConfig,
          userId: params.userId,
        });
        if (visualInspection.matches.length > 0) {
          const combinedMatches = Array.from(
            new Map(
              [...figureMatches, ...visualInspection.matches].map((match) => [match.text, match]),
            ).values(),
          )
            .sort((left, right) => right.score - left.score || right.text.length - left.text.length)
            .slice(0, MAX_VISUAL_MATCHES);
          const exactMatches = combinedMatches.filter((match) =>
            matchesContainExactEvidence([match], figureSearchAnalysis),
          );
          figureMatches = exactMatches.length > 0 ? exactMatches : combinedMatches;
        }
        visionNote = visualInspection.note;
      }
      citations.push(citationForFigure(params.paper, figure));
      if (figureMatches.length > 0) {
        citations.push(
          ...figureMatches.map((match) =>
            citationForMatchedText(
              params.paper,
              figure.figureLabel ?? null,
              match,
            ),
          ),
        );
      }
      artifacts.push(
        buildFigureArtifact(figure, {
          tableQuery:
            figure.type === "table"
              ? queryAnalysis.focusQuery ?? params.question
              : undefined,
          figureQuery:
            figure.type !== "table"
              ? queryAnalysis.focusQuery ?? params.question
              : undefined,
          textMatches: figure.type !== "table" ? figureMatches : undefined,
        }),
      );
      observations.push({
        step,
        action: `Open ${figure.figureLabel || figure.id}`,
        detail:
          figureMatches.length > 0
            ? figureMatches.map((match) => `- ${match.text}`).join("\n")
            : `${figure.figureLabel || figure.id}: ${visionNote ?? figure.captionText ?? figure.description ?? "Opened without caption."}`,
        phase: "inspect",
        status: "completed",
        source: chosen.source,
        tool: "open_figure",
        input: action.target,
        outputPreview:
          figureMatches.length > 0
            ? `${figureMatches.length} exact figure match${figureMatches.length === 1 ? "" : "es"} recovered from ${figure.figureLabel || figure.id}.`
            : `${figure.figureLabel || figure.id} opened for inspection.`,
        citationsAdded: citations.length - citationsBefore,
        artifactsAdded: artifacts.length - artifactsBefore,
      });
    }
  }

  if (citations.length === 0) {
    const fallbackClaims = rankClaimsForQuery(params.paper.claims, params.question, 4);
    if (fallbackClaims.length > 0) {
      citations.push(...fallbackClaims.map((claim) => citationForClaim(params.paper, claim)));
    } else if (sections.results) {
      citations.push(citationForSection(params.paper, "results", sections.results));
      artifacts.push(buildResultArtifact(params.paper, sections.results, []));
    } else if (sections.overview) {
      citations.push(citationForSection(params.paper, "overview", sections.overview));
    } else if (params.paper.abstract) {
      citations.push({
        paperId: params.paper.id,
        paperTitle: params.paper.title,
        snippet: truncate(params.paper.abstract, MAX_CITATION_SNIPPET_CHARS),
        sectionPath: "overview",
        sourceKind: "summary",
      });
    }
  }

  if (params.intent === "generated_artifact") {
    const codeArtifact = await generateCodeSnippetArtifact({
      paper: params.paper,
      question: params.question,
      selectedText: params.selectedText,
      citations,
      artifacts,
      observations,
      provider: params.provider,
      modelId: params.modelId,
      proxyConfig: params.proxyConfig,
      userId: params.userId,
    });
    if (codeArtifact) {
      const artifactsBefore = artifacts.length;
      artifacts.push(buildCodeArtifact(codeArtifact));
      observations.push({
        step: observations.length + 1,
        action: "Generate code snippet",
        detail: `${codeArtifact.filename}: ${codeArtifact.summary}`,
        phase: "synthesize",
        status: "completed",
        source: "system",
        tool: "generate_code_snippet",
        outputPreview: `${codeArtifact.filename} is ready to download.`,
        artifactsAdded: artifacts.length - artifactsBefore,
      });
    }
  }

  return {
    citations: dedupeCitations(citations).slice(0, 8),
    artifacts: dedupeArtifacts(artifacts),
    actions: observations.map((observation) => ({
      step: observation.step,
      action: observation.action,
      detail: observation.detail,
      phase: observation.phase,
      status: observation.status,
      source: observation.source,
      tool: observation.tool,
      input: observation.input ?? null,
      outputPreview: observation.outputPreview ?? null,
      citationsAdded: observation.citationsAdded,
      artifactsAdded: observation.artifactsAdded,
    })),
  };
}

export async function preparePaperAgentEvidence(params: {
  paper: PaperAgentPaperContext;
  question: string;
  intent: PaperAnswerIntent;
  selectedText: string | null;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
}): Promise<PreparedPaperAgentEvidence> {
  const sections = buildSectionSnapshots(params.paper);
  const figures = await loadPaperFigures(params.paper.id);
  const queryAnalysis = analyzeQuery(params.question, params.intent);

  if (params.intent === "generated_artifact") {
    return preparePaperAgentEvidenceUncached({
      ...params,
      sections,
      figures,
      queryAnalysis,
    });
  }

  const lookupKey = buildPaperAgentEvidenceCacheKey({
    paper: params.paper,
    question: params.question,
    intent: params.intent,
    selectedText: params.selectedText,
    provider: params.provider,
    modelId: params.modelId,
    analysis: queryAnalysis,
    figures,
  });

  const cached = await withCachedLookup(
    {
      lookupKey,
      lookupType: "paper_agent_evidence",
      provider: "paper_agent",
    },
    async () => {
      const prepared = await preparePaperAgentEvidenceUncached({
        ...params,
        sections,
        figures,
        queryAnalysis,
      });
      return {
        responsePayload: JSON.stringify(prepared),
        resolvedEntityId: params.paper.id,
        httpStatus: 200,
      };
    },
    PAPER_AGENT_EVIDENCE_CACHE_TTL_MS,
  );

  const parsed = parsePreparedPaperAgentEvidence(cached.responsePayload);
  if (parsed) {
    return parsed;
  }

  return preparePaperAgentEvidenceUncached({
    ...params,
    sections,
    figures,
    queryAnalysis,
  });
}
