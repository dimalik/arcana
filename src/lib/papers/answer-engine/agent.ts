import "server-only";

import { readFile } from "fs/promises";
import path from "path";

import type {
  ConversationArtifactKind,
  PaperClaimEvidenceType,
} from "@/generated/prisma/client";
import {
  FIGURE_VIEW_SELECT,
  mapPaperFiguresToView,
  type PaperFigureView,
} from "@/lib/figures/read-model";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import {
  generateStructuredObject,
  streamLLMResponse,
} from "@/lib/llm/provider";
import { paperAnswerCodeArtifactRuntimeOutputSchema } from "@/lib/llm/runtime-output-schemas";
import type { LLMProvider } from "@/lib/llm/models";
import type { ProxyConfig } from "@/lib/llm/proxy-settings";
import { normalizeAnalysisText } from "@/lib/papers/analysis/normalization/text";
import { parseSummarySections } from "@/lib/papers/parse-sections";
import { prisma } from "@/lib/prisma";
import { resolveStorageCandidates } from "@/lib/storage-paths";

import type { PaperClaimView } from "../analysis/store";
import type { AnswerCitation } from "./metadata";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_CITATION_SNIPPET_CHARS = 320;
const MAX_SECTION_CHARS = 1800;
const MAX_TABLE_ROWS = 60;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_CELL_CHARS = 120;
const MAX_VISUAL_MATCHES = 3;

const NON_ASSERTIVE_EVIDENCE_TYPES = new Set<PaperClaimEvidenceType>(["CITING"]);

const STOP_WORDS = new Set([
  "a", "about", "am", "an", "are", "after", "be", "been", "being", "before",
  "can", "could", "does", "from", "give", "have", "how", "i", "is", "into",
  "just", "like", "me", "more", "most", "paper", "papers", "please", "show",
  "that", "the", "their", "them", "this", "to", "us", "was", "were", "what",
  "when", "where", "which", "with", "would", "you",
]);

// ---------------------------------------------------------------------------
// Public types (consumed by agent/loop.ts, agent/tools/*, agent/types.ts)
// ---------------------------------------------------------------------------

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
  actions: AgentObservation[];
}

export interface AgentObservation {
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

export type SummarySectionName = "overview" | "methodology" | "results";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedTableData {
  columns: string[];
  rows: string[][];
}

interface TableQueryMatch {
  rowIndex: number;
  score: number;
  values: string[];
}

interface TableValueMatch {
  rowIndex: number;
  columnIndex: number;
  rowLabel: string;
  columnLabel: string;
  value: string;
  score: number;
  matchedTerms: string[];
}

interface CodeSnippetArtifactPayload {
  summary: string;
  filename: string;
  language: string;
  code: string;
  assumptions: string[];
}

interface QueryTextMatch {
  text: string;
  score: number;
  matchedTerms: string[];
}

interface FigureVisualInspectionPayload {
  found: boolean;
  matches: Array<{ text?: string | null; matchedTerms?: unknown }>;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Small string utilities
// ---------------------------------------------------------------------------

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
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
        .map((value) => value.trim()),
    ),
  );
}

function mergeEvidenceBlocks(
  ...values: Array<string | null | undefined>
): string {
  const merged = uniqueStrings(values).join("\n\n").trim();
  return merged ? truncate(merged, MAX_SECTION_CHARS) : "";
}

export function truncate(
  value: string | null | undefined,
  maxChars: number,
): string {
  if (!value) return "";
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars - 1).trimEnd()}…`;
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

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const normalized = trimmed.replace(/^[\d.\s]+/, "").toLowerCase();
  return [
    "abstract", "introduction", "background", "related work", "method",
    "methods", "methodology", "approach", "implementation", "results",
    "experiments", "evaluation", "analysis", "discussion", "limitations",
    "conclusion", "appendix", "references", "acknowledgments", "ablation",
  ].some(
    (heading) => normalized === heading || normalized.startsWith(`${heading} `),
  );
}

function extractFullTextSection(
  fullText: string | null,
  headings: string[],
  maxChars = MAX_SECTION_CHARS,
): string {
  if (!fullText) return "";
  const lines = fullText.split(/\r?\n/);
  const normalizedTargets = new Set(
    headings.map((heading) => heading.toLowerCase()),
  );

  let startIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const normalized =
      lines[i]?.trim().replace(/^[\d.\s]+/, "").toLowerCase() ?? "";
    if (normalizedTargets.has(normalized)) {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) return "";

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

export function buildSectionSnapshots(
  paper: PaperAgentPaperContext,
): Record<SummarySectionName, string> {
  const fromSummary = paper.summary
    ? parseSummarySections(paper.summary)
    : { overview: "", methodology: "", results: "" };

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
    results: mergeEvidenceBlocks(resultsFromFullText, fromSummary.results),
  };
}

// ---------------------------------------------------------------------------
// Claim ranking
// ---------------------------------------------------------------------------

export function rankClaimsForQuery(
  claims: PaperClaimView[],
  query: string,
  limit: number,
): PaperClaimView[] {
  const queryTokens = new Set(tokenize(query));
  return claims
    .filter((claim) => !NON_ASSERTIVE_EVIDENCE_TYPES.has(claim.evidenceType))
    .map((claim) => {
      const text =
        `${claim.text} ${claim.sourceExcerpt} ${claim.sectionPath}`.trim();
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
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.claim.orderIndex - right.claim.orderIndex,
    )
    .slice(0, limit)
    .map((entry) => entry.claim);
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

export function citationForSection(
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

export function citationForClaim(
  paper: PaperAgentPaperContext,
  claim: PaperClaimView,
): AnswerCitation {
  return {
    paperId: paper.id,
    paperTitle: paper.title,
    snippet: truncate(
      claim.sourceExcerpt || claim.text,
      MAX_CITATION_SNIPPET_CHARS,
    ),
    sectionPath: claim.sectionPath,
    sourceKind: "claim",
  };
}

export function citationForFigure(
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

// ---------------------------------------------------------------------------
// Figure targeting
// ---------------------------------------------------------------------------

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
    kind === "table" &&
    /result|metric|benchmark|ablation|score|safety|rai|harm|jailbreak/i.test(
      query,
    )
  ) {
    score += 1;
  }
  return score;
}

export function filterFigures(
  figures: PaperFigureView[],
  kind: "figure" | "table" | "any",
  query?: string,
): PaperFigureView[] {
  const filteredKind =
    kind === "any"
      ? figures
      : figures.filter((figure) =>
          kind === "table" ? figure.type === "table" : figure.type !== "table",
        );

  if (!query) return filteredKind;

  const scored = filteredKind.map((figure) => ({
    figure,
    score: scoreFigureQuery(figure, kind, query),
  }));

  const matching = scored.filter((entry) => entry.score > 0);
  return (matching.length > 0 ? matching : scored)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.figure.figureIndex - right.figure.figureIndex,
    )
    .map((entry) => entry.figure);
}

export function resolveFigureTarget(
  figures: PaperFigureView[],
  target: string,
): PaperFigureView | null {
  const normalizedTarget = normalizeFigureTarget(target);
  const targetReference = parseFigureReference(target);
  if (targetReference) {
    const exactLabel = figures.find((figure) => {
      const figureReference = parseFigureReference(figure.figureLabel);
      return (
        figureReference?.kind === targetReference.kind &&
        figureReference.ordinal === targetReference.ordinal
      );
    });
    if (exactLabel) return exactLabel;
  }

  const exact = figures.find(
    (figure) =>
      normalizeFigureTarget(
        `${figure.figureLabel ?? ""} ${figure.captionText ?? ""}`,
      ) === normalizedTarget || figure.id === target,
  );
  if (exact) return exact;

  const candidates = figures
    .map((figure) => {
      const figureReference = parseFigureReference(figure.figureLabel);
      if (
        targetReference &&
        (figureReference?.kind !== targetReference.kind ||
          figureReference.ordinal !== targetReference.ordinal)
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
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.figure.figureIndex - right.figure.figureIndex,
    );

  return candidates[0]?.figure ?? null;
}

// ---------------------------------------------------------------------------
// HTML / table parsing
// ---------------------------------------------------------------------------

export function stripHtml(value: string): string {
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
  return values
    .map((value) => `"${value.replace(/"/g, '""')}"`)
    .join(",");
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

function shouldUseFirstRowAsHeader(
  rows: Array<{ cells: string[]; hasHeader: boolean }>,
): boolean {
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
  const columns = headerRow?.cells.length
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

function extractElementsByClass(html: string, classToken: string): string[] {
  const results: string[] = [];
  const openTagRegex = /<(span|div)\b[^>]*class=(["'])([^"']*)\2[^>]*>/gi;
  let openMatch: RegExpExecArray | null;

  while ((openMatch = openTagRegex.exec(html)) !== null) {
    const classValue = openMatch[3] ?? "";
    const classTokens = classValue.split(/\s+/).filter(Boolean);
    if (!classTokens.includes(classToken)) continue;

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
  if (!/\bltx_tabular\b/i.test(description)) return null;

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

export function parseHtmlTable(
  description: string | null,
): ParsedTableData | null {
  if (!description) return null;
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

// ---------------------------------------------------------------------------
// Table querying
// ---------------------------------------------------------------------------

function scoreQueryTokens(haystack: string, queryTokens: string[]): number {
  const normalized = normalizeAnalysisText(haystack);
  let score = 0;
  for (const token of queryTokens) {
    if (normalized.includes(token)) score += 1;
  }
  return score;
}

export function queryParsedTable(
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
    .sort(
      (left, right) => right.score - left.score || left.rowIndex - right.rowIndex,
    );

  if (scored.length > 0) return scored.slice(0, 4);

  return table.rows.slice(0, 4).map((row, rowIndex) => ({
    rowIndex,
    score: 0,
    values: row,
  }));
}

export function queryParsedTableRow(
  table: ParsedTableData,
  query?: string,
): TableQueryMatch | null {
  const queryTokens = query ? tokenize(query) : [];
  if (queryTokens.length === 0) return null;

  const scored = table.rows
    .map((row, rowIndex) => {
      const rowLabel = row[0] ?? "";
      const rowBody = row.slice(1).join(" ");
      const score =
        scoreQueryTokens(rowLabel, queryTokens) * 3 +
        scoreQueryTokens(rowBody, queryTokens);
      return { rowIndex, score, values: row } satisfies TableQueryMatch;
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.rowIndex - right.rowIndex,
    );

  return scored[0] ?? null;
}

export function queryParsedTableValue(
  table: ParsedTableData,
  query?: string,
): TableValueMatch | null {
  const queryTokens = query ? tokenize(query) : [];
  if (queryTokens.length === 0) return null;

  const rowMatch = queryParsedTableRow(table, query);
  if (!rowMatch) return null;

  const scoredColumns = table.columns
    .map((columnLabel, columnIndex) => {
      if (columnIndex === 0) {
        return { columnIndex, score: -1, columnLabel };
      }
      return {
        columnIndex,
        score: scoreQueryTokens(columnLabel, queryTokens),
        columnLabel,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.columnIndex - right.columnIndex,
    );

  const bestColumn = scoredColumns[0];
  if (!bestColumn) return null;

  const value = rowMatch.values[bestColumn.columnIndex] ?? "";
  if (!value) return null;

  return {
    rowIndex: rowMatch.rowIndex,
    columnIndex: bestColumn.columnIndex,
    rowLabel: rowMatch.values[0] ?? `Row ${rowMatch.rowIndex + 1}`,
    columnLabel: bestColumn.columnLabel,
    value,
    score: rowMatch.score + bestColumn.score,
    matchedTerms: queryTokens.filter((token) =>
      normalizeAnalysisText(
        `${rowMatch.values.join(" ")} ${bestColumn.columnLabel}`,
      ).includes(token),
    ),
  };
}

// ---------------------------------------------------------------------------
// Artifact builders
// ---------------------------------------------------------------------------

export function buildFigureArtifact(
  figure: PaperFigureView,
  options?: {
    tableQuery?: string;
    figureQuery?: string;
    textMatches?: QueryTextMatch[];
    exactRow?: TableQueryMatch | null;
    exactValue?: TableValueMatch | null;
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
              exactRow: options?.exactRow
                ? {
                    rowIndex: options.exactRow.rowIndex,
                    values: options.exactRow.values,
                  }
                : null,
              exactValue: options?.exactValue
                ? {
                    rowIndex: options.exactValue.rowIndex,
                    columnIndex: options.exactValue.columnIndex,
                    rowLabel: options.exactValue.rowLabel,
                    columnLabel: options.exactValue.columnLabel,
                    value: options.exactValue.value,
                    matchedTerms: options.exactValue.matchedTerms,
                  }
                : null,
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

export function buildCodeArtifact(
  payload: CodeSnippetArtifactPayload,
): PaperAgentArtifactDraft {
  return {
    kind: "CODE_SNIPPET",
    title: payload.filename,
    payloadJson: JSON.stringify(payload),
  };
}

// ---------------------------------------------------------------------------
// Figure loading + vision inspection
// ---------------------------------------------------------------------------

export async function loadPaperFigures(
  paperId: string,
): Promise<PaperFigureView[]> {
  const figures = await prisma.paperFigure.findMany({
    select: FIGURE_VIEW_SELECT,
    where: { paperId, isPrimaryExtraction: true },
    orderBy: [{ pdfPage: "asc" }, { figureIndex: "asc" }],
  });
  return mapPaperFiguresToView(figures);
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
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  return null;
}

function scoreBySearchTerms(text: string, searchTerms: string[]): number {
  const normalized = normalizeAnalysisText(text);
  let score = 0;
  for (const term of searchTerms) {
    if (normalized.includes(term.toLowerCase())) score += 2;
  }
  if (/\d/.test(text)) score += 1;
  return score;
}

/**
 * Vision-inspect one figure image. Takes a plain question and optional
 * `searchTerms` list (v2 callers build this from the user's question).
 */
export async function inspectFigureWithVision(params: {
  figure: PaperFigureView;
  question: string;
  searchTerms: string[];
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
}): Promise<{
  matches: QueryTextMatch[];
  note: string | null;
}> {
  if (!params.figure.imagePath) return { matches: [], note: null };

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
                    `Search terms: ${params.searchTerms.join(", ") || "(none)"}`,
                    `Figure label: ${params.figure.figureLabel ?? params.figure.id}`,
                    `Caption: ${params.figure.captionText ?? "(none)"}`,
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
        const matches: QueryTextMatch[] = Array.isArray(parsed.matches)
          ? parsed.matches
              .map((match) => {
                const text =
                  typeof match?.text === "string" ? match.text.trim() : "";
                if (!text) return null;
                const matchedTerms = Array.isArray(match.matchedTerms)
                  ? match.matchedTerms.filter(
                      (term): term is string => typeof term === "string",
                    )
                  : params.searchTerms.filter((term) =>
                      normalizeAnalysisText(text).includes(term.toLowerCase()),
                    );
                return {
                  text,
                  matchedTerms,
                  score: scoreBySearchTerms(text, params.searchTerms),
                } satisfies QueryTextMatch;
              })
              .filter((match): match is QueryTextMatch => Boolean(match))
              .sort(
                (left, right) =>
                  right.score - left.score ||
                  right.text.length - left.text.length,
              )
              .slice(0, MAX_VISUAL_MATCHES)
          : [];

        return {
          matches,
          note:
            typeof parsed.note === "string" ? parsed.note.trim() || null : null,
        };
      },
    );
  } catch (error) {
    console.warn("[answer-engine] figure vision fallback failed:", error);
    return { matches: [], note: "Lazy figure analysis failed." };
  }
}

// ---------------------------------------------------------------------------
// Code snippet generation (called by the generate_code_snippet tool)
// ---------------------------------------------------------------------------

function formatObservationsForPrompt(
  observations: AgentObservation[],
): string {
  if (observations.length === 0) return "No tool observations yet.";
  return observations
    .map(
      (observation) =>
        `Step ${observation.step}: ${observation.action}\n${truncate(observation.detail, 500)}`,
    )
    .join("\n\n");
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
        `[S${index + 1}] ${citation.paperTitle}${
          citation.sectionPath ? ` / ${citation.sectionPath}` : ""
        }\n${citation.snippet}`,
    )
    .join("\n\n");
  const artifactLines = params.artifacts
    .map(
      (artifact, index) =>
        `Artifact ${index + 1} (${artifact.kind}): ${artifact.title}\n${artifact.payloadJson}`,
    )
    .join("\n\n");

  return `Create a concise, useful code snippet artifact derived from the paper evidence below.

Paper: ${params.paper.title}${params.paper.year ? ` (${params.paper.year})` : ""}
Question: ${params.question}
${
  params.selectedText
    ? `Selected text:\n${truncate(params.selectedText, 800)}\n\n`
    : ""
}Rules:
- The code must be a derived implementation sketch, not a claim of verbatim paper code.
- Keep it compact and runnable-looking.
- Reference the method or result the snippet is based on in the summary.
- If critical details are missing, make assumptions explicit in the assumptions array.
- Prefer Python unless the request strongly implies another language.
- If the user explicitly asks for a specific output format or language, honor that request in the artifact.

Observations:
${formatObservationsForPrompt(params.observations)}

Retrieved sources:
${evidenceLines || "No grounded citations were available."}

Structured artifacts:
${artifactLines || "No structured artifacts attached."}`;
}

export async function generateCodeSnippetArtifact(params: {
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

      if (!object.code?.trim()) return null;
      return object;
    },
  );
}

// ---------------------------------------------------------------------------
// Dedupe helpers
// ---------------------------------------------------------------------------

export function dedupeCitations(
  citations: AnswerCitation[],
): AnswerCitation[] {
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

export function dedupeArtifacts(
  artifacts: PaperAgentArtifactDraft[],
): PaperAgentArtifactDraft[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.kind}::${artifact.title}::${artifact.payloadJson}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
