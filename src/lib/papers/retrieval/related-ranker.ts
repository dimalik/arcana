import { prisma } from "../../prisma";
import {
  DETERMINISTIC_RELATEDNESS_PROVENANCE,
  computeDeterministicTitleSimilarity,
  parseDeterministicSignalPayload,
  type DeterministicSignalName,
} from "../../assertions/deterministic-relatedness";
import type { GraphRelationRow } from "../../assertions/relation-reader";
import { getDefaultModel } from "../../llm/auto-process";
import { PAPER_INTERACTIVE_LLM_OPERATIONS, withPaperLlmContext } from "../../llm/paper-llm-context";
import { SYSTEM_PROMPTS } from "../../llm/prompts";
import { generateStructuredObject } from "../../llm/provider";

import {
  SHARED_RAW_PAPER_REPRESENTATION_KIND,
  encodeTextToVector,
  cosineSimilarity,
  getPaperRepresentation,
  parsePaperRepresentationMetadata,
  parsePaperRepresentationVector,
  searchSharedPaperRepresentationsByVector,
  upsertSharedPaperRepresentation,
} from "./embeddings";
import { diversifyCandidates } from "./diversify";
import {
  rerankRelatedPapersRuntimeOutputSchema,
  scoreRelatedPapersPointwiseRuntimeOutputSchema,
  type RelatedPaperListwiseSelection,
  type RelatedPaperPointwiseAssessment,
} from "./related-rerank-schema";

type RelatedRerankDb = Pick<
  typeof prisma,
  "paper" | "paperRelation" | "relationAssertion" | "paperRepresentation"
>;

interface RelatedPaperContext {
  id: string;
  entityId: string | null;
  title: string;
  abstract: string | null;
  summary: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  citationCount: number | null;
  duplicateState: string | null;
}

interface DeterministicSignalSummary {
  direct_citation: number;
  reverse_citation: number;
  bibliographic_coupling: number;
  co_citation: number;
  title_similarity: number;
}

export interface RelatedRerankCandidateDiagnostics {
  paperId: string;
  title: string;
  baselineConfidence: number;
  rerankScore: number;
  semanticSimilarity: number;
  titleSimilarity: number;
  queryTitleOverlap: number;
  queryTitleOverlapCount: number;
  bodyTokenOverlap: number;
  tagOverlap: number;
  lexicalAuthorOverlap: number;
  identityAuthorOverlap: number;
  venueOverlap: number;
  yearProximity: number;
  hubScore: number;
  citationPrior: number;
  relationTypePrior: number;
  deterministicSignals: DeterministicSignalSummary;
  subtopics: string[];
}

export interface RelatedRerankResult {
  backend: RelatedRerankerBackendDescriptor;
  baselineRows: GraphRelationRow[];
  rerankedRows: GraphRelationRow[];
  diagnostics: RelatedRerankCandidateDiagnostics[];
}

interface PreparedFeatureRelatedRerankState {
  baselineRows: GraphRelationRow[];
  seedPaper: RelatedPaperContext | null;
  paperContexts: Map<string, RelatedPaperContext>;
  representationMap: Map<
    string,
    {
      vector: number[];
      metadata: ReturnType<typeof parsePaperRepresentationMetadata>;
    }
  >;
  candidateRows: GraphRelationRow[];
  diagnostics: RelatedRerankCandidateDiagnostics[];
  diagnosticsByPaperId: Map<string, RelatedRerankCandidateDiagnostics>;
}

export type RelatedRerankerBackendId =
  | "baseline_v1"
  | "feature_v1"
  | "llm_listwise_v1"
  | "llm_pointwise_v1";

export type RelatedRerankerFamily =
  | "baseline"
  | "feature-ranker"
  | "cross-encoder"
  | "distilled-reranker"
  | "llm-listwise"
  | "llm-pointwise";

export interface RelatedRerankerBackendDescriptor {
  id: RelatedRerankerBackendId;
  family: RelatedRerankerFamily;
}

export interface BuildRelatedRerankOptions {
  backendId?: RelatedRerankerBackendId;
}

const RELATED_RELATION_TYPE_PRIORS: Array<[RegExp, number]> = [
  [/same paper|identical paper|duplicate/i, -0.25],
  [/addresses same problem|related problem/i, 0.18],
  [/related methodology|related approach|same methodology|same method/i, 0.16],
  [/builds upon|extends methodology|extends/i, 0.12],
  [/uses same dataset|same evaluation/i, 0.1],
  [/survey|review/i, 0.05],
  [/related/i, 0.08],
  [/cites/i, -0.04],
];

const RELATED_SIGNAL_WEIGHTS = {
  graphConfidence: 0.26,
  semanticSimilarity: 0.04,
  titleSimilarity: 0.14,
  queryTitleOverlap: 0.16,
  bodyTokenOverlap: 0.08,
  tagOverlap: 0.04,
  lexicalAuthorOverlap: 0.05,
  identityAuthorOverlap: 0.03,
  venueOverlap: 0.04,
  yearProximity: 0.04,
  directCitation: 0.08,
  reverseCitation: 0.06,
  bibliographicCoupling: 0.08,
  coCitation: 0.04,
  relationTypePrior: 0.03,
  citationPrior: 0.02,
} as const;

const RELATED_RERANK_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RELATED_RERANK_CACHE_VERSION = "2026-04-21-hub-filter-v4-bm25";
const RELATED_LLM_LISTWISE_CANDIDATE_LIMIT = 16;
const RELATED_LLM_LISTWISE_RESULT_LIMIT = 8;
const RELATED_LLM_LISTWISE_MAX_TOKENS = 2_200;
const RELATED_LLM_POINTWISE_CANDIDATE_LIMIT = 18;
const RELATED_LLM_POINTWISE_RESULT_LIMIT = 10;
const RELATED_LLM_POINTWISE_MAX_TOKENS = 2_800;
const RELATED_LLM_ABSTRACT_SNIPPET_CHARS = 260;
const RELATED_CONTENT_EXPANSION_LIMIT = 80;
const RELATED_CONTENT_EXPANSION_SCORE_FLOOR = 0.18;
const RELATED_LLM_SELECTION_BOOST_WEIGHT = 0.14;
const RELATED_LLM_POINTWISE_SCORE_WEIGHT = 0.22;
const RELATED_BM25_K1 = 1.35;
const RELATED_BM25_B = 0.72;
const RELATED_BM25_FIELD_WEIGHTS = {
  title: 2.6,
  abstract: 1.15,
  summary: 0.95,
} as const;
const relatedRerankCache = new Map<
  string,
  { expiresAt: number; result: RelatedRerankResult }
>();
const GENERIC_RELATEDNESS_TOKENS = new Set([
  "all",
  "approach",
  "attention",
  "based",
  "capable",
  "context",
  "efficient",
  "generation",
  "highly",
  "language",
  "languages",
  "learning",
  "llm",
  "llms",
  "locally",
  "model",
  "models",
  "need",
  "neural",
  "paper",
  "phone",
  "report",
  "study",
  "technical",
  "using",
  "you",
]);

const RELATED_SIGNATURE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "assistant",
  "at",
  "benchmarking",
  "beyond",
  "bullet",
  "capable",
  "fast",
  "for",
  "from",
  "generation",
  "highly",
  "in",
  "into",
  "is",
  "language",
  "languages",
  "large",
  "model",
  "models",
  "need",
  "new",
  "no",
  "of",
  "on",
  "or",
  "propose",
  "report",
  "solely",
  "technical",
  "the",
  "to",
  "using",
  "via",
  "with",
]);

const RELATED_SIGNATURE_SHORT_TOKEN_ALLOWLIST = new Set([
  "io",
  "kv",
  "lc",
  "rag",
]);

const RELATED_LEXICAL_EXPANSION_LIMIT = 120;
const RELATED_LEXICAL_QUERY_TERMS = 6;

function supportsRelatedRerankDb(db: unknown): db is RelatedRerankDb {
  if (!db || typeof db !== "object") return false;
  const candidate = db as Record<string, unknown>;
  return (
    Boolean(candidate.paper) &&
    Boolean(candidate.paperRelation) &&
    Boolean(candidate.relationAssertion) &&
    Boolean(candidate.paperRepresentation)
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeText(value: string | null | undefined): string {
  if (!value) return "";
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateSnippet(
  value: string | null | undefined,
  maxChars = RELATED_LLM_ABSTRACT_SNIPPET_CHARS,
): string | null {
  if (!value) return null;
  const normalized = normalizeWhitespace(value);
  if (!normalized) return null;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function tokenizeInformativeText(value: string | null | undefined): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) => token.length >= 3 && !GENERIC_RELATEDNESS_TOKENS.has(token),
    );
}

function tokenizeRelatedSignatureText(
  value: string | null | undefined,
): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => {
      if (!token) return false;
      if (RELATED_SIGNATURE_SHORT_TOKEN_ALLOWLIST.has(token)) return true;
      return token.length >= 4 && !RELATED_SIGNATURE_STOPWORDS.has(token);
    });
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => normalizeText(item))
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function collectSignaturePhrases(
  value: string | null | undefined,
): string[] {
  const tokens = tokenizeRelatedSignatureText(value);
  if (tokens.length < 2) return [];

  const phrases: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const bigram = `${tokens[index]} ${tokens[index + 1]}`;
    phrases.push(bigram);
    if (index < tokens.length - 2) {
      phrases.push(`${bigram} ${tokens[index + 2]}`);
    }
  }

  return stableUnique(
    phrases.filter((phrase) => phrase.split(" ").length >= 2),
  ).slice(0, 6);
}

function stableUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function jaccardOverlap(left: string[], right: string[]): number {
  const leftSet = new Set(left.filter(Boolean));
  const rightSet = new Set(right.filter(Boolean));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let overlap = 0;
  for (const value of Array.from(leftSet)) {
    if (rightSet.has(value)) overlap += 1;
  }
  const union = new Set([...Array.from(leftSet), ...Array.from(rightSet)]).size;
  return union > 0 ? overlap / union : 0;
}

function containmentOverlap(source: string[], candidate: string[]): number {
  const sourceSet = new Set(source.filter(Boolean));
  const candidateSet = new Set(candidate.filter(Boolean));
  if (sourceSet.size === 0 || candidateSet.size === 0) return 0;
  let overlap = 0;
  for (const token of Array.from(candidateSet)) {
    if (sourceSet.has(token)) overlap += 1;
  }
  return candidateSet.size > 0 ? overlap / candidateSet.size : 0;
}

function tokenOverlapScore(
  tokens: string[],
  haystack: string | null | undefined,
): number {
  if (tokens.length === 0 || !haystack) return 0;
  const normalized = normalizeText(haystack);
  if (!normalized) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (normalized.includes(token)) hits += 1;
  }
  return Number((hits / tokens.length).toFixed(6));
}

function phraseContainmentScore(
  phrases: string[],
  haystack: string | null | undefined,
): number {
  if (phrases.length === 0 || !haystack) return 0;
  const normalized = normalizeText(haystack);
  if (!normalized) return 0;
  const matched = phrases.filter((phrase) => normalized.includes(phrase)).length;
  if (matched <= 0) return 0;
  return Number((matched / phrases.length).toFixed(6));
}

function sharedTokenCount(source: string[], candidate: string[]): number {
  const sourceSet = new Set(source.filter(Boolean));
  const candidateSet = new Set(candidate.filter(Boolean));
  if (sourceSet.size === 0 || candidateSet.size === 0) return 0;
  let overlap = 0;
  for (const token of Array.from(candidateSet)) {
    if (sourceSet.has(token)) overlap += 1;
  }
  return overlap;
}

function buildTermFrequency(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

function computeBm25InverseDocumentFrequency(
  documentCount: number,
  documentFrequency: number,
): number {
  if (documentCount <= 0) return 0;
  return Math.log(
    1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
  );
}

function computeBm25TermWeight(params: {
  term: string;
  termWeight: number;
  fields: Array<{
    weight: number;
    frequencies: Map<string, number>;
    fieldLength: number;
    averageFieldLength: number;
  }>;
  documentCount: number;
  documentFrequency: Map<string, number>;
}): number {
  let weightedFrequency = 0;
  for (const field of params.fields) {
    const termFrequency = field.frequencies.get(params.term) ?? 0;
    if (termFrequency <= 0) continue;
    const normalizedFieldLength =
      1 -
      RELATED_BM25_B +
      RELATED_BM25_B *
        (field.fieldLength / Math.max(1, field.averageFieldLength));
    weightedFrequency +=
      (field.weight * termFrequency) /
      Math.max(0.1, normalizedFieldLength);
  }
  if (weightedFrequency <= 0) return 0;

  const inverseDocumentFrequency = computeBm25InverseDocumentFrequency(
    params.documentCount,
    params.documentFrequency.get(params.term) ?? 0,
  );

  return (
    params.termWeight *
    inverseDocumentFrequency *
    ((weightedFrequency * (RELATED_BM25_K1 + 1)) /
      (weightedFrequency + RELATED_BM25_K1))
  );
}

function normalizeVenue(value: string | null | undefined): string {
  return normalizeText(value);
}

function mergeSignalSummary(
  primary: DeterministicSignalSummary,
  secondary: DeterministicSignalSummary,
): DeterministicSignalSummary {
  return {
    direct_citation: Math.max(
      primary.direct_citation,
      secondary.direct_citation,
    ),
    reverse_citation: Math.max(
      primary.reverse_citation,
      secondary.reverse_citation,
    ),
    bibliographic_coupling: Math.max(
      primary.bibliographic_coupling,
      secondary.bibliographic_coupling,
    ),
    co_citation: Math.max(primary.co_citation, secondary.co_citation),
    title_similarity: Math.max(
      primary.title_similarity,
      secondary.title_similarity,
    ),
  };
}

function accumulateWeightedTerms(
  weights: Map<string, number>,
  tokens: string[],
  weight: number,
): void {
  for (const token of tokens) {
    weights.set(token, (weights.get(token) ?? 0) + weight);
  }
}

function computeVenueOverlap(
  leftVenue: string | null | undefined,
  rightVenue: string | null | undefined,
): number {
  const left = normalizeVenue(leftVenue);
  const right = normalizeVenue(rightVenue);
  if (!left || !right) return 0;
  return left === right ? 1 : 0;
}

function computeYearProximity(
  leftYear: number | null | undefined,
  rightYear: number | null | undefined,
): number {
  if (!leftYear || !rightYear) return 0;
  const delta = Math.abs(leftYear - rightYear);
  return Math.max(0, Number((1 - Math.min(delta, 10) / 10).toFixed(6)));
}

function computeRelationTypePrior(relationType: string): number {
  for (const [pattern, value] of RELATED_RELATION_TYPE_PRIORS) {
    if (pattern.test(relationType)) return value;
  }
  return 0;
}

function emptyDeterministicSignals(): DeterministicSignalSummary {
  return {
    direct_citation: 0,
    reverse_citation: 0,
    bibliographic_coupling: 0,
    co_citation: 0,
    title_similarity: 0,
  };
}

function parseSignalSummary(
  evidenceRows: Array<{ type: string; excerpt: string | null }>,
): DeterministicSignalSummary {
  const summary = emptyDeterministicSignals();
  for (const evidence of evidenceRows) {
    if (!evidence.type.startsWith("deterministic_signal:")) continue;
    const signal = evidence.type.replace(
      "deterministic_signal:",
      "",
    ) as DeterministicSignalName;
    const payload = parseDeterministicSignalPayload(evidence.excerpt);
    if (!payload) continue;
    summary[signal] = Number(
      Math.max(summary[signal], payload.rawValue).toFixed(6),
    );
  }
  return summary;
}

function buildCacheKey(
  backendId: RelatedRerankerBackendId,
  paperId: string,
  userId: string,
  rows: GraphRelationRow[],
): string {
  return `${RELATED_RERANK_CACHE_VERSION}:${backendId}:${paperId}:${userId}:${rows
    .map((row) => `${row.id}:${row.confidence.toFixed(6)}`)
    .join("|")}`;
}

function describeRelatedRerankerBackend(
  backendId: RelatedRerankerBackendId,
): RelatedRerankerBackendDescriptor {
  if (backendId === "baseline_v1") {
    return {
      id: "baseline_v1",
      family: "baseline",
    };
  }

  if (backendId === "llm_listwise_v1") {
    return {
      id: "llm_listwise_v1",
      family: "llm-listwise",
    };
  }

  if (backendId === "llm_pointwise_v1") {
    return {
      id: "llm_pointwise_v1",
      family: "llm-pointwise",
    };
  }

  return {
    id: "feature_v1",
    family: "feature-ranker",
  };
}

export function resolveRelatedRerankerBackendId(
  value: string | null | undefined = process.env.ARCANA_RELATED_RERANKER_BACKEND,
): RelatedRerankerBackendId {
  if (value === "baseline_v1") return "baseline_v1";
  if (value === "llm_listwise_v1") return "llm_listwise_v1";
  if (value === "llm_pointwise_v1") return "llm_pointwise_v1";
  return "feature_v1";
}

function normalizeCitationPrior(
  citationCount: number | null,
  maxCitationCount: number,
): number {
  if (!citationCount || maxCitationCount <= 0) return 0;
  return Number(
    (
      Math.log1p(citationCount) /
      Math.max(1, Math.log1p(maxCitationCount))
    ).toFixed(6),
  );
}

async function ensureRepresentations(
  paperIds: string[],
  db: RelatedRerankDb,
): Promise<void> {
  for (const paperId of paperIds) {
    const current = await getPaperRepresentation(
      db,
      paperId,
      SHARED_RAW_PAPER_REPRESENTATION_KIND,
    );
    if (!current) {
      await upsertSharedPaperRepresentation(paperId, db);
    }
  }
}

async function loadPaperContexts(
  paperIds: string[],
  db: RelatedRerankDb,
): Promise<Map<string, RelatedPaperContext>> {
  const rows = await db.paper.findMany({
    where: { id: { in: paperIds } },
    select: {
      id: true,
      entityId: true,
      title: true,
      abstract: true,
      summary: true,
      authors: true,
      year: true,
      venue: true,
      citationCount: true,
      duplicateState: true,
    },
  });

  return new Map(rows.map((row) => [row.id, row]));
}

async function loadRepresentationVectors(
  paperIds: string[],
  db: RelatedRerankDb,
): Promise<
  Map<string, { vector: number[]; metadata: ReturnType<typeof parsePaperRepresentationMetadata> }>
> {
  const rows = await db.paperRepresentation.findMany({
    where: {
      paperId: { in: paperIds },
      representationKind: SHARED_RAW_PAPER_REPRESENTATION_KIND,
    },
    select: {
      paperId: true,
      vectorJson: true,
      metadataJson: true,
    },
  });

  return new Map(
    rows.map((row) => [
      row.paperId,
      {
        vector: parsePaperRepresentationVector(row.vectorJson),
        metadata: parsePaperRepresentationMetadata(row.metadataJson),
      },
    ]),
  );
}

async function loadCandidateDegrees(
  candidatePaperIds: string[],
  db: RelatedRerankDb,
): Promise<Map<string, number>> {
  const papers = await db.paper.findMany({
    where: {
      id: { in: candidatePaperIds },
    },
    select: {
      id: true,
      _count: {
        select: {
          sourceRelations: true,
          targetRelations: true,
        },
      },
    },
  });

  return new Map(
    papers.map((paper) => [
      paper.id,
      paper._count.sourceRelations + paper._count.targetRelations,
    ]),
  );
}

async function loadDeterministicSignalMap(
  paperId: string,
  rows: GraphRelationRow[],
  db: RelatedRerankDb,
): Promise<Map<string, DeterministicSignalSummary>> {
  const entityIds = rows
    .map((row) => row.relatedPaper.entityId)
    .filter((entityId): entityId is string => Boolean(entityId));

  if (entityIds.length === 0) return new Map();

  const assertions = await db.relationAssertion.findMany({
    where: {
      sourcePaperId: paperId,
      targetEntityId: { in: entityIds },
      provenance: DETERMINISTIC_RELATEDNESS_PROVENANCE,
    },
    include: {
      evidence: {
        select: {
          type: true,
          excerpt: true,
        },
      },
    },
  });

  return new Map(
    assertions.map((assertion) => [
      assertion.targetEntityId,
      parseSignalSummary(assertion.evidence),
    ]),
  );
}

function collectSeedSignature(
  seedPaper: RelatedPaperContext,
  seedMetadata: ReturnType<typeof parsePaperRepresentationMetadata> | undefined,
): {
  terms: string[];
  queryTerms: string[];
  phrases: string[];
} {
  const titleTerms = stableUnique(tokenizeRelatedSignatureText(seedPaper.title));
  const tagTerms = stableUnique(
    (seedMetadata?.tagNames ?? []).flatMap((tagName) =>
      tokenizeRelatedSignatureText(tagName),
    ),
  );
  const abstractTerms = stableUnique(tokenizeRelatedSignatureText(seedPaper.abstract));
  const summaryTerms = stableUnique(tokenizeRelatedSignatureText(seedPaper.summary));
  const termWeights = new Map<string, number>();
  accumulateWeightedTerms(termWeights, titleTerms, 3);
  accumulateWeightedTerms(termWeights, tagTerms, 2.5);
  accumulateWeightedTerms(termWeights, abstractTerms, 1.25);
  accumulateWeightedTerms(termWeights, summaryTerms, 1);

  const terms = Array.from(termWeights.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      if (right[0].length !== left[0].length) {
        return right[0].length - left[0].length;
      }
      return left[0].localeCompare(right[0]);
    })
    .map(([term]) => term)
    .slice(0, 8);
  const phrases = stableUnique([
    ...collectSignaturePhrases(seedPaper.title),
    ...(seedMetadata?.tagNames ?? []).map((tagName) => normalizeText(tagName)),
    ...collectSignaturePhrases(seedPaper.abstract),
  ]).slice(0, 8);

  return {
    terms,
    queryTerms: terms.slice(0, RELATED_LEXICAL_QUERY_TERMS),
    phrases,
  };
}

async function loadLocalCitationSignalMap(
  paperId: string,
  candidatePaperIds: string[],
  db: RelatedRerankDb,
): Promise<Map<string, DeterministicSignalSummary>> {
  if (candidatePaperIds.length === 0) return new Map();

  const [outgoingRows, incomingRows] = await Promise.all([
    db.paperRelation.findMany({
      where: {
        OR: [
          { sourcePaperId: paperId },
          { sourcePaperId: { in: candidatePaperIds } },
        ],
      },
      select: {
        sourcePaperId: true,
        targetPaperId: true,
      },
    }),
    db.paperRelation.findMany({
      where: {
        OR: [
          { targetPaperId: paperId },
          { targetPaperId: { in: candidatePaperIds } },
        ],
      },
      select: {
        sourcePaperId: true,
        targetPaperId: true,
      },
    }),
  ]);

  const outgoingByPaper = new Map<string, Set<string>>();
  for (const row of outgoingRows) {
    const current = outgoingByPaper.get(row.sourcePaperId) ?? new Set<string>();
    current.add(row.targetPaperId);
    outgoingByPaper.set(row.sourcePaperId, current);
  }

  const incomingByPaper = new Map<string, Set<string>>();
  for (const row of incomingRows) {
    const current = incomingByPaper.get(row.targetPaperId) ?? new Set<string>();
    current.add(row.sourcePaperId);
    incomingByPaper.set(row.targetPaperId, current);
  }

  const seedOutgoing = outgoingByPaper.get(paperId) ?? new Set<string>();
  const seedIncoming = incomingByPaper.get(paperId) ?? new Set<string>();

  const signalMap = new Map<string, DeterministicSignalSummary>();
  for (const candidatePaperId of candidatePaperIds) {
    const candidateOutgoing =
      outgoingByPaper.get(candidatePaperId) ?? new Set<string>();
    const candidateIncoming =
      incomingByPaper.get(candidatePaperId) ?? new Set<string>();

    let sharedOutgoing = 0;
    for (const targetId of Array.from(candidateOutgoing)) {
      if (seedOutgoing.has(targetId)) sharedOutgoing += 1;
    }

    let sharedIncoming = 0;
    for (const sourceId of Array.from(candidateIncoming)) {
      if (seedIncoming.has(sourceId)) sharedIncoming += 1;
    }

    signalMap.set(candidatePaperId, {
      direct_citation: seedOutgoing.has(candidatePaperId) ? 1 : 0,
      reverse_citation: seedIncoming.has(candidatePaperId) ? 1 : 0,
      bibliographic_coupling:
        Math.min(
          1,
          sharedOutgoing / Math.max(1, Math.min(seedOutgoing.size, candidateOutgoing.size)),
        ) || 0,
      co_citation:
        Math.min(
          1,
          sharedIncoming / Math.max(1, Math.min(seedIncoming.size, candidateIncoming.size)),
        ) || 0,
      title_similarity: 0,
    });
  }

  return signalMap;
}

async function loadLexicalExpansionRows(
  params: {
    paperId: string;
    userId: string;
    seedSignature: {
      terms: string[];
      queryTerms: string[];
      phrases: string[];
    };
    excludePaperIds: string[];
  },
  db: RelatedRerankDb,
): Promise<GraphRelationRow[]> {
  if (params.seedSignature.terms.length === 0) return [];

  const rows = await db.paper.findMany({
    where: {
      userId: params.userId,
      duplicateState: "ACTIVE",
      id: { notIn: [params.paperId, ...params.excludePaperIds] },
    },
    select: {
      id: true,
      entityId: true,
      title: true,
      year: true,
      authors: true,
      abstract: true,
      summary: true,
    },
  });

  if (rows.length === 0) return [];

  const queryTerms = params.seedSignature.terms;
  const queryTermWeights = new Map<string, number>(
    queryTerms.map((term, index) => [
      term,
      Number(Math.max(0.8, 1.6 - index * 0.12).toFixed(3)),
    ]),
  );

  const documents = rows.map((row) => {
    const titleTokens = tokenizeRelatedSignatureText(row.title);
    const abstractTokens = tokenizeRelatedSignatureText(row.abstract);
    const summaryTokens = tokenizeRelatedSignatureText(row.summary);
    const uniqueTerms = new Set([
      ...titleTokens,
      ...abstractTokens,
      ...summaryTokens,
    ]);

    return {
      row,
      titleTokens,
      abstractTokens,
      summaryTokens,
      titleFrequencies: buildTermFrequency(titleTokens),
      abstractFrequencies: buildTermFrequency(abstractTokens),
      summaryFrequencies: buildTermFrequency(summaryTokens),
      uniqueTerms,
    };
  });

  const averageTitleLength =
    documents.reduce((sum, document) => sum + document.titleTokens.length, 0) /
      Math.max(1, documents.length) || 1;
  const averageAbstractLength =
    documents.reduce((sum, document) => sum + document.abstractTokens.length, 0) /
      Math.max(1, documents.length) || 1;
  const averageSummaryLength =
    documents.reduce((sum, document) => sum + document.summaryTokens.length, 0) /
      Math.max(1, documents.length) || 1;

  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of Array.from(document.uniqueTerms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const scoredCandidates = documents
    .map((document) => {
      let bm25Score = 0;
      for (const [term, termWeight] of Array.from(queryTermWeights.entries())) {
        bm25Score += computeBm25TermWeight({
          term,
          termWeight,
          fields: [
            {
              weight: RELATED_BM25_FIELD_WEIGHTS.title,
              frequencies: document.titleFrequencies,
              fieldLength: document.titleTokens.length,
              averageFieldLength: averageTitleLength,
            },
            {
              weight: RELATED_BM25_FIELD_WEIGHTS.abstract,
              frequencies: document.abstractFrequencies,
              fieldLength: document.abstractTokens.length,
              averageFieldLength: averageAbstractLength,
            },
            {
              weight: RELATED_BM25_FIELD_WEIGHTS.summary,
              frequencies: document.summaryFrequencies,
              fieldLength: document.summaryTokens.length,
              averageFieldLength: averageSummaryLength,
            },
          ],
          documentCount: documents.length,
          documentFrequency,
        });
      }

      const titleOverlap = tokenOverlapScore(queryTerms, document.row.title);
      const bodyOverlap = Math.max(
        tokenOverlapScore(queryTerms, document.row.abstract),
        tokenOverlapScore(queryTerms, document.row.summary),
      );
      const phraseTitleHit = phraseContainmentScore(
        params.seedSignature.phrases,
        document.row.title,
      );
      const phraseBodyHit = Math.max(
        phraseContainmentScore(params.seedSignature.phrases, document.row.abstract),
        phraseContainmentScore(params.seedSignature.phrases, document.row.summary),
      );

      return {
        ...document.row,
        bm25Score,
        titleOverlap,
        bodyOverlap,
        phraseTitleHit,
        phraseBodyHit,
      };
    })
    .filter(
      (candidate) =>
        candidate.bm25Score > 0 ||
        candidate.phraseTitleHit > 0 ||
        candidate.phraseBodyHit > 0,
    );

  if (scoredCandidates.length === 0) return [];

  const maxBm25Score = Math.max(
    1e-6,
    ...scoredCandidates.map((candidate) => candidate.bm25Score),
  );

  const candidates = scoredCandidates
    .map((candidate) => {
      const normalizedBm25 = Number(
        (candidate.bm25Score / maxBm25Score).toFixed(6),
      );
      const lexicalScore = Number(
        (
          normalizedBm25 * 0.62 +
          candidate.titleOverlap * 0.16 +
          candidate.bodyOverlap * 0.08 +
          candidate.phraseTitleHit * 0.1 +
          candidate.phraseBodyHit * 0.04
        ).toFixed(6),
      );
      return {
        ...candidate,
        lexicalScore,
      };
    })
    .filter(
      (candidate) =>
        candidate.lexicalScore >= 0.14 &&
        (candidate.titleOverlap >= 0.12 ||
          candidate.phraseTitleHit > 0 ||
          candidate.phraseBodyHit > 0 ||
          candidate.bodyOverlap >= 0.18),
    );

  return candidates
    .sort((left, right) => {
      if (right.lexicalScore !== left.lexicalScore) {
        return right.lexicalScore - left.lexicalScore;
      }
      return left.title.localeCompare(right.title);
    })
    .slice(0, RELATED_LEXICAL_EXPANSION_LIMIT)
    .map((candidate) => ({
      id: `lex::${candidate.id}`,
      relatedPaper: {
        id: candidate.id,
        entityId: candidate.entityId,
        title: candidate.title,
        year: candidate.year,
        authors: candidate.authors,
        duplicateState: "ACTIVE",
      },
      relationType: "related",
      description:
        "Recovered by sparse lexical relatedness over title, abstract, and summary terms.",
      confidence: Number((0.18 + candidate.lexicalScore * 0.52).toFixed(6)),
      isAutoGenerated: true,
    }));
}

async function loadContentExpansionRows(
  params: {
    userId: string;
    seedVector: number[];
    excludePaperIds: string[];
  },
  db: RelatedRerankDb,
): Promise<GraphRelationRow[]> {
  if (params.seedVector.length === 0) return [];

  const matches = await searchSharedPaperRepresentationsByVector(
    {
      userId: params.userId,
      vector: params.seedVector,
      limit: RELATED_CONTENT_EXPANSION_LIMIT,
      excludePaperIds: params.excludePaperIds,
    },
    db,
  );

  return matches
    .filter(
      (match) =>
        match.score >= RELATED_CONTENT_EXPANSION_SCORE_FLOOR &&
        !params.excludePaperIds.includes(match.paperId),
    )
    .map((match) => ({
      id: `dense::${match.paperId}`,
      relatedPaper: {
        id: match.paperId,
        entityId: null,
        title: match.title,
        year: null,
        authors: null,
        duplicateState: "ACTIVE",
      },
      relationType: "related",
      description:
        "Recovered from shared representation similarity; requires stronger topical evidence downstream.",
      confidence: Number((0.08 + match.score * 0.28).toFixed(6)),
      isAutoGenerated: true,
    }));
}

function computeHubScores(
  candidates: Array<{
    paperId: string;
    citationCount: number | null;
    degree: number;
  }>,
): Map<string, number> {
  const maxCitationCount = Math.max(
    1,
    ...candidates.map((candidate) => candidate.citationCount ?? 0),
  );
  const maxDegree = Math.max(1, ...candidates.map((candidate) => candidate.degree));

  return new Map(
    candidates.map((candidate) => {
      const citationComponent = normalizeCitationPrior(
        candidate.citationCount,
        maxCitationCount,
      );
      const degreeComponent = Number(
        (candidate.degree / maxDegree).toFixed(6),
      );
      return [
        candidate.paperId,
        Number(Math.max(citationComponent, degreeComponent).toFixed(6)),
      ];
    }),
  );
}

export function sortRelatedRowsBaseline(
  rows: GraphRelationRow[],
): GraphRelationRow[] {
  return [...rows].sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return left.relatedPaper.title.localeCompare(right.relatedPaper.title);
  });
}

function hasSharedCitationEvidence(
  signals: DeterministicSignalSummary,
): boolean {
  return (
    signals.bibliographic_coupling >= 0.04 ||
    signals.co_citation >= 0.03
  );
}

function hasTopicalLexicalEvidence(
  diagnostics: Pick<
    RelatedRerankCandidateDiagnostics,
    | "titleSimilarity"
    | "queryTitleOverlap"
    | "queryTitleOverlapCount"
    | "bodyTokenOverlap"
    | "tagOverlap"
    | "lexicalAuthorOverlap"
    | "identityAuthorOverlap"
    | "venueOverlap"
  >,
  {
    allowTitleSimilarity,
  }: {
    allowTitleSimilarity: boolean;
  },
): boolean {
  return (
    (allowTitleSimilarity && diagnostics.titleSimilarity >= 0.12) ||
    (diagnostics.queryTitleOverlap >= 0.18 &&
      diagnostics.queryTitleOverlapCount >= 1) ||
    diagnostics.bodyTokenOverlap >= 0.2 ||
    diagnostics.tagOverlap >= 0.2 ||
    diagnostics.lexicalAuthorOverlap >= 0.2 ||
    diagnostics.identityAuthorOverlap >= 0.1 ||
    diagnostics.venueOverlap >= 1
  );
}

function passesTopicalityFloor(
  row: GraphRelationRow,
  diagnostics: RelatedRerankCandidateDiagnostics,
  seedPaper: RelatedPaperContext,
): boolean {
  if (!row.isAutoGenerated) return true;

  const seedIsHub = (seedPaper.citationCount ?? 0) >= 1000;
  const hasLexicalEvidence = hasTopicalLexicalEvidence(diagnostics, {
    allowTitleSimilarity: !seedIsHub,
  });
  const hasCitationNeighborhoodEvidence = hasSharedCitationEvidence(
    diagnostics.deterministicSignals,
  );
  const hasDenseCitationEvidence =
    diagnostics.deterministicSignals.direct_citation >= 1 ||
    diagnostics.deterministicSignals.reverse_citation >= 1;
  const hasHubLexicalEvidence =
    (diagnostics.queryTitleOverlapCount >= 1 &&
      (diagnostics.titleSimilarity >= 0.12 || diagnostics.tagOverlap >= 0.18)) ||
    (diagnostics.queryTitleOverlapCount >= 2 &&
      diagnostics.bodyTokenOverlap >= 0.12) ||
    diagnostics.titleSimilarity >= 0.22 ||
    diagnostics.tagOverlap >= 0.24;

  if (seedIsHub) {
    return hasCitationNeighborhoodEvidence || hasHubLexicalEvidence;
  }

  if (hasLexicalEvidence || hasCitationNeighborhoodEvidence) {
    return true;
  }

  if (!seedIsHub && hasDenseCitationEvidence && diagnostics.rerankScore >= 0.2) {
    return true;
  }

  return false;
}

function buildLlmShortlistRows(
  prepared: PreparedFeatureRelatedRerankState,
): GraphRelationRow[] {
  const seedPaper = prepared.seedPaper;
  if (!seedPaper) return [];

  return prepared.candidateRows.filter((row) => {
    const diagnostics = prepared.diagnosticsByPaperId.get(row.relatedPaper.id);
    if (!diagnostics) return false;
    if (passesTopicalityFloor(row, diagnostics, seedPaper)) return true;

    return (
      hasSharedCitationEvidence(diagnostics.deterministicSignals) ||
      diagnostics.titleSimilarity >= 0.12 ||
      diagnostics.tagOverlap >= 0.14 ||
      diagnostics.queryTitleOverlapCount >= 1 ||
      (diagnostics.bodyTokenOverlap >= 0.12 &&
        diagnostics.semanticSimilarity >= 0.24)
    );
  });
}

function buildBaselineRelatedRerankResult(
  rows: GraphRelationRow[],
  backendId: RelatedRerankerBackendId = "baseline_v1",
): RelatedRerankResult {
  const baselineRows = sortRelatedRowsBaseline(rows);

  return {
    backend: describeRelatedRerankerBackend(backendId),
    baselineRows,
    rerankedRows: baselineRows,
    diagnostics: baselineRows.map((row) => ({
      paperId: row.relatedPaper.id,
      title: row.relatedPaper.title,
      baselineConfidence: row.confidence,
      rerankScore: row.confidence,
      semanticSimilarity: 0,
      titleSimilarity: 0,
      queryTitleOverlap: 0,
      queryTitleOverlapCount: 0,
      bodyTokenOverlap: 0,
      tagOverlap: 0,
      lexicalAuthorOverlap: 0,
      identityAuthorOverlap: 0,
      venueOverlap: 0,
      yearProximity: 0,
      hubScore: 0,
      citationPrior: 0,
      relationTypePrior: 0,
      deterministicSignals: emptyDeterministicSignals(),
      subtopics: [],
    })),
  };
}

async function buildFeatureRelatedRerankResult(
  paperId: string,
  userId: string,
  rows: GraphRelationRow[],
  db: RelatedRerankDb = prisma,
): Promise<RelatedRerankResult> {
  const baselineRows = sortRelatedRowsBaseline(rows);
  const cacheKey = buildCacheKey("feature_v1", paperId, userId, baselineRows);
  const cached = relatedRerankCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const prepared = await prepareFeatureRelatedRerankState(
    paperId,
    userId,
    baselineRows,
    db,
  );
  if (!prepared.seedPaper) {
    return {
      backend: describeRelatedRerankerBackend("feature_v1"),
      baselineRows,
      rerankedRows: baselineRows,
      diagnostics: [],
    };
  }

  const result = buildFeatureRelatedRerankResultFromPrepared(prepared);
  relatedRerankCache.set(cacheKey, {
    expiresAt: Date.now() + RELATED_RERANK_CACHE_TTL_MS,
    result,
  });
  return result;
}

async function prepareFeatureRelatedRerankState(
  paperId: string,
  userId: string,
  baselineRows: GraphRelationRow[],
  db: RelatedRerankDb,
): Promise<PreparedFeatureRelatedRerankState> {
  const seedPaperMap = await loadPaperContexts([paperId], db);
  const seedPaper = seedPaperMap.get(paperId) ?? null;
  if (!seedPaper) {
    return {
      baselineRows,
      seedPaper: null,
      paperContexts: new Map(),
      representationMap: new Map(),
      candidateRows: [],
      diagnostics: [],
      diagnosticsByPaperId: new Map(),
    };
  }

  await ensureRepresentations([paperId], db);
  const seedRepresentation = await getPaperRepresentation(
    db,
    paperId,
    SHARED_RAW_PAPER_REPRESENTATION_KIND,
  );
  const seedSignature = collectSeedSignature(
    seedPaper,
    seedRepresentation?.metadata,
  );

  const lexicalExpansionRows = await loadLexicalExpansionRows(
    {
      paperId,
      userId,
      seedSignature,
      excludePaperIds: baselineRows.map((row) => row.relatedPaper.id),
    },
    db,
  );
  const contentExpansionRows = await loadContentExpansionRows(
    {
      userId,
      seedVector: seedRepresentation?.vector ?? [],
      excludePaperIds: [paperId, ...baselineRows.map((row) => row.relatedPaper.id)],
    },
    db,
  );

  const candidateRowsByPaperId = new Map<string, GraphRelationRow>();
  for (const row of [
    ...baselineRows,
    ...lexicalExpansionRows,
    ...contentExpansionRows,
  ]) {
    const current = candidateRowsByPaperId.get(row.relatedPaper.id);
    if (!current || row.confidence > current.confidence) {
      candidateRowsByPaperId.set(row.relatedPaper.id, row);
    }
  }

  const candidateRows = sortRelatedRowsBaseline(
    Array.from(candidateRowsByPaperId.values()),
  );
  if (candidateRows.length === 0) {
    return {
      baselineRows,
      seedPaper,
      paperContexts: new Map([[paperId, seedPaper]]),
      representationMap: new Map(),
      candidateRows: [],
      diagnostics: [],
      diagnosticsByPaperId: new Map(),
    };
  }

  const paperIds = [paperId, ...candidateRows.map((row) => row.relatedPaper.id)];
  await ensureRepresentations(paperIds, db);

  const [
    paperContexts,
    representationMap,
    candidateDegrees,
    deterministicSignalMap,
    localCitationSignalMap,
  ] = await Promise.all([
    loadPaperContexts(paperIds, db),
    loadRepresentationVectors(paperIds, db),
    loadCandidateDegrees(
      candidateRows.map((row) => row.relatedPaper.id),
      db,
    ),
    loadDeterministicSignalMap(paperId, candidateRows, db),
    loadLocalCitationSignalMap(
      paperId,
      candidateRows.map((row) => row.relatedPaper.id),
      db,
    ),
  ]);

  const seedAuthors = parseStringArray(seedPaper.authors);
  const seedQueryTokens = seedSignature.terms;
  const seedQueryVector = encodeTextToVector(
    [
      seedPaper.title,
      seedPaper.abstract ?? "",
      seedPaper.venue ?? "",
      String(seedPaper.year ?? ""),
    ]
      .filter(Boolean)
      .join(" "),
  );

  const hubScores = computeHubScores(
    candidateRows.map((row) => ({
      paperId: row.relatedPaper.id,
      citationCount:
        paperContexts.get(row.relatedPaper.id)?.citationCount ?? null,
      degree: candidateDegrees.get(row.relatedPaper.id) ?? 0,
    })),
  );

  const diagnostics = candidateRows.map((row) => {
    const candidateContext = paperContexts.get(row.relatedPaper.id);
    const candidateAuthors = parseStringArray(candidateContext?.authors ?? null);
    const queryTitleOverlap = containmentOverlap(
      seedQueryTokens,
      tokenizeRelatedSignatureText(row.relatedPaper.title),
    );
    const queryTitleOverlapCount = sharedTokenCount(
      seedQueryTokens,
      tokenizeRelatedSignatureText(row.relatedPaper.title),
    );
    const bodyTokenOverlap = Math.max(
      tokenOverlapScore(seedQueryTokens, candidateContext?.abstract ?? null),
      tokenOverlapScore(seedQueryTokens, candidateContext?.summary ?? null),
    );
    const lexicalAuthorOverlap = jaccardOverlap(seedAuthors, candidateAuthors);
    const identityAuthorOverlap = 0;
    const candidateRepresentation = representationMap.get(row.relatedPaper.id);
    const tagOverlap = jaccardOverlap(
      seedRepresentation?.metadata?.tagNames ?? [],
      candidateRepresentation?.metadata?.tagNames ?? [],
    );
    const semanticSimilarity =
      seedQueryVector.length > 0 && candidateRepresentation?.vector?.length
        ? cosineSimilarity(seedQueryVector, candidateRepresentation.vector)
        : 0;
    const titleSimilarity = computeDeterministicTitleSimilarity(
      seedPaper.title,
      row.relatedPaper.title,
    );
    const venueOverlap = computeVenueOverlap(
      seedPaper.venue,
      candidateContext?.venue ?? null,
    );
    const yearProximity = computeYearProximity(
      seedPaper.year,
      candidateContext?.year ?? null,
    );
    const assertionSignals =
      (row.relatedPaper.entityId
        ? deterministicSignalMap.get(row.relatedPaper.entityId)
        : null) ?? emptyDeterministicSignals();
    const deterministicSignals = mergeSignalSummary(
      assertionSignals,
      localCitationSignalMap.get(row.relatedPaper.id) ??
        emptyDeterministicSignals(),
    );
    const relationTypePrior = computeRelationTypePrior(row.relationType);
    const citationPrior = normalizeCitationPrior(
      candidateContext?.citationCount ?? null,
      Math.max(1, ...Array.from(hubScores.values(), (value) => value * 100)),
    );
    const hubScore = hubScores.get(row.relatedPaper.id) ?? 0;
    const metadata = candidateRepresentation?.metadata;
    const subtopics = Array.from(
      new Set(
        [...(metadata?.tagNames ?? []), row.relationType.toLowerCase()].filter(
          Boolean,
        ),
      ),
    );

    let rerankScore =
      row.confidence * RELATED_SIGNAL_WEIGHTS.graphConfidence +
      semanticSimilarity * RELATED_SIGNAL_WEIGHTS.semanticSimilarity +
      titleSimilarity * RELATED_SIGNAL_WEIGHTS.titleSimilarity +
      queryTitleOverlap * RELATED_SIGNAL_WEIGHTS.queryTitleOverlap +
      bodyTokenOverlap * RELATED_SIGNAL_WEIGHTS.bodyTokenOverlap +
      tagOverlap * RELATED_SIGNAL_WEIGHTS.tagOverlap +
      lexicalAuthorOverlap * RELATED_SIGNAL_WEIGHTS.lexicalAuthorOverlap +
      identityAuthorOverlap * RELATED_SIGNAL_WEIGHTS.identityAuthorOverlap +
      venueOverlap * RELATED_SIGNAL_WEIGHTS.venueOverlap +
      yearProximity * RELATED_SIGNAL_WEIGHTS.yearProximity +
      deterministicSignals.direct_citation *
        RELATED_SIGNAL_WEIGHTS.directCitation +
      deterministicSignals.reverse_citation *
        RELATED_SIGNAL_WEIGHTS.reverseCitation +
      deterministicSignals.bibliographic_coupling *
        RELATED_SIGNAL_WEIGHTS.bibliographicCoupling +
      deterministicSignals.co_citation * RELATED_SIGNAL_WEIGHTS.coCitation +
      relationTypePrior * RELATED_SIGNAL_WEIGHTS.relationTypePrior +
      citationPrior * RELATED_SIGNAL_WEIGHTS.citationPrior;

    const isCitationOnlyRow =
      row.relationType.toLowerCase() === "cites" &&
      deterministicSignals.direct_citation === 0 &&
      deterministicSignals.reverse_citation === 0 &&
      deterministicSignals.bibliographic_coupling === 0 &&
      deterministicSignals.co_citation === 0;
    const citationOnlyPenalty =
      isCitationOnlyRow &&
      semanticSimilarity < 0.32 &&
      titleSimilarity < 0.12
        ? 0.24
        : isCitationOnlyRow && titleSimilarity < 0.06
          ? 0.12
          : 0;
    rerankScore -= citationOnlyPenalty;
    rerankScore = Number(Math.max(rerankScore, 0).toFixed(6));

    return {
      paperId: row.relatedPaper.id,
      title: row.relatedPaper.title,
      baselineConfidence: row.confidence,
      rerankScore,
      semanticSimilarity,
      titleSimilarity,
      queryTitleOverlap: Number(queryTitleOverlap.toFixed(6)),
      queryTitleOverlapCount,
      bodyTokenOverlap,
      tagOverlap: Number(tagOverlap.toFixed(6)),
      lexicalAuthorOverlap: Number(lexicalAuthorOverlap.toFixed(6)),
      identityAuthorOverlap,
      venueOverlap,
      yearProximity,
      hubScore,
      citationPrior,
      relationTypePrior: Number(relationTypePrior.toFixed(6)),
      deterministicSignals,
      subtopics,
    } satisfies RelatedRerankCandidateDiagnostics;
  });

  return {
    baselineRows,
    seedPaper,
    paperContexts,
    representationMap,
    candidateRows,
    diagnostics,
    diagnosticsByPaperId: new Map(
      diagnostics.map((diagnostic) => [diagnostic.paperId, diagnostic]),
    ),
  };
}

function finalizeRelatedRows(params: {
  rows: GraphRelationRow[];
  diagnosticsByPaperId: Map<string, RelatedRerankCandidateDiagnostics>;
  representationMap: PreparedFeatureRelatedRerankState["representationMap"];
  scoreForPaperId: (paperId: string) => number;
  limit: number;
}): {
  rerankedRows: GraphRelationRow[];
  rerankedDiagnostics: RelatedRerankCandidateDiagnostics[];
} {
  if (params.rows.length === 0) {
    return { rerankedRows: [], rerankedDiagnostics: [] };
  }

  const diversified = diversifyCandidates(
    params.rows.map((row) => {
      const diagnostic = params.diagnosticsByPaperId.get(row.relatedPaper.id);
      if (!diagnostic) {
        throw new Error(
          `Missing related-paper diagnostics for ${row.relatedPaper.id}`,
        );
      }
      return {
        id: diagnostic.paperId,
        relevanceScore: params.scoreForPaperId(diagnostic.paperId),
        hubScore: diagnostic.hubScore,
        noveltyScore: 0,
        subtopics: diagnostic.subtopics,
        vector: params.representationMap.get(diagnostic.paperId)?.vector ?? [],
      };
    }),
    {
      task: "related",
      limit: params.limit,
    },
  );

  const order = new Map(
    diversified.map((candidate, index) => [candidate.id, index]),
  );
  const rerankedRows = [...params.rows].sort((left, right) => {
    const leftOrder = order.get(left.relatedPaper.id);
    const rightOrder = order.get(right.relatedPaper.id);
    if (
      leftOrder != null &&
      rightOrder != null &&
      leftOrder !== rightOrder
    ) {
      return leftOrder - rightOrder;
    }

    const leftScore = params.scoreForPaperId(left.relatedPaper.id);
    const rightScore = params.scoreForPaperId(right.relatedPaper.id);
    if (rightScore !== leftScore) return rightScore - leftScore;
    return left.relatedPaper.title.localeCompare(right.relatedPaper.title);
  });

  return {
    rerankedRows,
    rerankedDiagnostics: rerankedRows
      .map((row) => params.diagnosticsByPaperId.get(row.relatedPaper.id))
      .filter(
        (
          diagnostic,
        ): diagnostic is RelatedRerankCandidateDiagnostics => Boolean(diagnostic),
      ),
  };
}

function buildFeatureRelatedRerankResultFromPrepared(
  prepared: PreparedFeatureRelatedRerankState,
): RelatedRerankResult {
  if (!prepared.seedPaper) {
    return {
      backend: describeRelatedRerankerBackend("feature_v1"),
      baselineRows: prepared.baselineRows,
      rerankedRows: prepared.baselineRows,
      diagnostics: [],
    };
  }

  const filteredRows = rerankedTopicalRows(
    prepared.candidateRows,
    prepared.diagnosticsByPaperId,
    prepared.seedPaper,
  );
  const finalized = finalizeRelatedRows({
    rows: filteredRows,
    diagnosticsByPaperId: prepared.diagnosticsByPaperId,
    representationMap: prepared.representationMap,
    scoreForPaperId: (paperId) =>
      prepared.diagnosticsByPaperId.get(paperId)?.rerankScore ?? 0,
    limit: Math.min(
      Math.max(
        prepared.baselineRows.length,
        Math.min(prepared.candidateRows.length, 10),
      ),
      prepared.candidateRows.length,
    ),
  });

  const topDiagnostic = finalized.rerankedDiagnostics[0] ?? null;
  const shouldFailClosed =
    Boolean(topDiagnostic) &&
    topDiagnostic.rerankScore < 0.4 &&
    topDiagnostic.queryTitleOverlap < 0.2 &&
    topDiagnostic.titleSimilarity < 0.18 &&
    topDiagnostic.tagOverlap < 0.2;

  const finalRows = shouldFailClosed
    ? finalized.rerankedRows.slice(0, 2)
    : finalized.rerankedRows;
  const finalDiagnostics = shouldFailClosed
    ? finalized.rerankedDiagnostics.slice(0, 2)
    : finalized.rerankedDiagnostics;
  const seedIsHub = (prepared.seedPaper.citationCount ?? 0) >= 1000;
  const hubPrecisionDiagnostics = seedIsHub
    ? finalDiagnostics.filter(
        (diagnostic) =>
          hasSharedCitationEvidence(diagnostic.deterministicSignals) ||
          diagnostic.titleSimilarity >= 0.2 ||
          diagnostic.queryTitleOverlapCount >= 2 ||
          diagnostic.tagOverlap >= 0.24,
      )
    : finalDiagnostics;
  const hubPrecisionRows = seedIsHub
    ? finalRows.filter((row) =>
        hubPrecisionDiagnostics.some(
          (diagnostic) => diagnostic.paperId === row.relatedPaper.id,
        ),
      )
    : finalRows;

  return {
    backend: describeRelatedRerankerBackend("feature_v1"),
    baselineRows: prepared.baselineRows,
    rerankedRows:
      seedIsHub && hubPrecisionRows.length > 0
        ? hubPrecisionRows.slice(0, 2)
        : finalRows,
    diagnostics:
      seedIsHub && hubPrecisionDiagnostics.length > 0
        ? hubPrecisionDiagnostics.slice(0, 2)
        : finalDiagnostics,
  };
}

function buildRelatedCandidateBlocks(params: {
  seedPaper: RelatedPaperContext;
  candidateRows: GraphRelationRow[];
  paperContexts: Map<string, RelatedPaperContext>;
  diagnosticsByPaperId: Map<string, RelatedRerankCandidateDiagnostics>;
  representationMap: PreparedFeatureRelatedRerankState["representationMap"];
}): { seedLines: string[]; candidateBlocks: string[] } {
  const seedMetadata =
    params.representationMap.get(params.seedPaper.id)?.metadata ?? null;
  const seedLines = [
    `Seed paper`,
    `- paperId: ${params.seedPaper.id}`,
    `- title: ${params.seedPaper.title}`,
    `- year: ${params.seedPaper.year ?? "unknown"}`,
    `- venue: ${params.seedPaper.venue ?? "unknown"}`,
    `- citationCount: ${params.seedPaper.citationCount ?? 0}`,
    `- tags: ${(seedMetadata?.tagNames ?? []).slice(0, 8).join(", ") || "none"}`,
    `- abstract: ${truncateSnippet(params.seedPaper.abstract) ?? "none"}`,
    `- summary: ${truncateSnippet(params.seedPaper.summary) ?? "none"}`,
  ];

  const candidateBlocks = params.candidateRows.map((row, index) => {
    const context = params.paperContexts.get(row.relatedPaper.id);
    const diagnostic = params.diagnosticsByPaperId.get(row.relatedPaper.id);
    const metadata = params.representationMap.get(row.relatedPaper.id)?.metadata;
    return [
      `Candidate ${index + 1}`,
      `- paperId: ${row.relatedPaper.id}`,
      `- title: ${row.relatedPaper.title}`,
      `- year: ${context?.year ?? row.relatedPaper.year ?? "unknown"}`,
      `- venue: ${context?.venue ?? "unknown"}`,
      `- authors: ${parseStringArray(context?.authors ?? row.relatedPaper.authors).join(", ") || "unknown"}`,
      `- relationType: ${row.relationType}`,
      `- relationDescription: ${row.description ?? "none"}`,
      `- candidateTags: ${(metadata?.tagNames ?? []).slice(0, 8).join(", ") || "none"}`,
      `- abstract: ${truncateSnippet(context?.abstract) ?? "none"}`,
      `- summary: ${truncateSnippet(context?.summary) ?? "none"}`,
      `- featureSignals: baseline=${row.confidence.toFixed(3)}, feature=${(diagnostic?.rerankScore ?? row.confidence).toFixed(3)}, titleSimilarity=${(diagnostic?.titleSimilarity ?? 0).toFixed(3)}, titleOverlap=${(diagnostic?.queryTitleOverlap ?? 0).toFixed(3)}, bodyOverlap=${(diagnostic?.bodyTokenOverlap ?? 0).toFixed(3)}, tagOverlap=${(diagnostic?.tagOverlap ?? 0).toFixed(3)}, lexicalAuthorOverlap=${(diagnostic?.lexicalAuthorOverlap ?? 0).toFixed(3)}`,
      `- citationSignals: direct=${diagnostic?.deterministicSignals.direct_citation ?? 0}, reverse=${diagnostic?.deterministicSignals.reverse_citation ?? 0}, bibliographicCoupling=${(diagnostic?.deterministicSignals.bibliographic_coupling ?? 0).toFixed(3)}, coCitation=${(diagnostic?.deterministicSignals.co_citation ?? 0).toFixed(3)}`,
      `- denseSimilarity: ${(diagnostic?.semanticSimilarity ?? 0).toFixed(3)} (weak evidence only)`,
    ].join("\n");
  });

  return { seedLines, candidateBlocks };
}

function buildRelatedListwisePrompt(params: {
  seedPaper: RelatedPaperContext;
  candidateRows: GraphRelationRow[];
  paperContexts: Map<string, RelatedPaperContext>;
  diagnosticsByPaperId: Map<string, RelatedRerankCandidateDiagnostics>;
  representationMap: PreparedFeatureRelatedRerankState["representationMap"];
}): string {
  const { seedLines, candidateBlocks } = buildRelatedCandidateBlocks(params);

  return `${seedLines.join("\n")}\n\nCandidates\n${candidateBlocks.join(
    "\n\n",
  )}\n\nThis is a recall-oriented shortlist built from citation, lexical, and representation signals. Some candidates are genuine hits; others are near misses. You are the final precision gate: keep only the papers an expert would actually open next, and prefer precision over recall.`;
}

function buildRelatedPointwisePrompt(params: {
  seedPaper: RelatedPaperContext;
  candidateRows: GraphRelationRow[];
  paperContexts: Map<string, RelatedPaperContext>;
  diagnosticsByPaperId: Map<string, RelatedRerankCandidateDiagnostics>;
  representationMap: PreparedFeatureRelatedRerankState["representationMap"];
}): string {
  const { seedLines, candidateBlocks } = buildRelatedCandidateBlocks(params);

  return `${seedLines.join("\n")}\n\nCandidates\n${candidateBlocks.join(
    "\n\n",
  )}\n\nThis is a recall-oriented shortlist built from citation, lexical, and representation signals. Judge every candidate independently. A paper is only genuinely related if it overlaps with the seed on the actual technical problem, method lineage, evaluation setting, deployment setting, or strong citation neighborhood. Broad adjacency alone is a rejection signal.`;
}

function sanitizeListwiseSelections(
  selections: RelatedPaperListwiseSelection[],
  candidateRows: GraphRelationRow[],
): RelatedPaperListwiseSelection[] {
  const validIds = new Set(candidateRows.map((row) => row.relatedPaper.id));
  const seen = new Set<string>();
  const sanitized: RelatedPaperListwiseSelection[] = [];

  for (const selection of selections) {
    const paperId = selection.paperId.trim();
    if (!paperId || !validIds.has(paperId) || seen.has(paperId)) continue;
    const rationale = selection.rationale.trim();
    if (!rationale) continue;
    seen.add(paperId);
    sanitized.push({
      ...selection,
      paperId,
      rationale,
      relevanceScore: Number(
        Math.max(0, Math.min(selection.relevanceScore, 1)).toFixed(6),
      ),
      primarySignals: (selection.primarySignals ?? [])
        .map((signal) => signal.trim())
        .filter(Boolean)
        .slice(0, 4),
    });
  }

  return sanitized.slice(0, RELATED_LLM_LISTWISE_RESULT_LIMIT);
}

function sanitizePointwiseAssessments(
  assessments: RelatedPaperPointwiseAssessment[],
  candidateRows: GraphRelationRow[],
): RelatedPaperPointwiseAssessment[] {
  const validIds = new Set(candidateRows.map((row) => row.relatedPaper.id));
  const seen = new Set<string>();
  const sanitized: RelatedPaperPointwiseAssessment[] = [];

  for (const assessment of assessments) {
    const paperId = assessment.paperId.trim();
    if (!paperId || !validIds.has(paperId) || seen.has(paperId)) continue;
    const rationale = assessment.rationale.trim();
    if (!rationale) continue;
    seen.add(paperId);
    sanitized.push({
      ...assessment,
      paperId,
      rationale,
      relevanceScore: Number(
        Math.max(0, Math.min(assessment.relevanceScore, 1)).toFixed(6),
      ),
      primarySignals: (assessment.primarySignals ?? [])
        .map((signal) => signal.trim())
        .filter(Boolean)
        .slice(0, 4),
      exclusionSignals: (assessment.exclusionSignals ?? [])
        .map((signal) => signal.trim())
        .filter(Boolean)
        .slice(0, 4),
    });
  }

  return sanitized;
}

async function buildLlmListwiseRelatedRerankResult(
  paperId: string,
  userId: string,
  rows: GraphRelationRow[],
  db: RelatedRerankDb = prisma,
): Promise<RelatedRerankResult> {
  const baselineRows = sortRelatedRowsBaseline(rows);
  const cacheKey = buildCacheKey("llm_listwise_v1", paperId, userId, baselineRows);
  const cached = relatedRerankCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const prepared = await prepareFeatureRelatedRerankState(
    paperId,
    userId,
    baselineRows,
    db,
  );
  const featureResult = buildFeatureRelatedRerankResultFromPrepared(prepared);
  if (!prepared.seedPaper || prepared.candidateRows.length === 0) {
    return {
      backend: describeRelatedRerankerBackend("llm_listwise_v1"),
      baselineRows,
      rerankedRows: [],
      diagnostics: [],
    };
  }

  const llmShortlistRows = buildLlmShortlistRows(prepared);
  const sortedCandidates = [...llmShortlistRows]
    .sort((left, right) => {
      const leftScore =
        prepared.diagnosticsByPaperId.get(left.relatedPaper.id)?.rerankScore ??
        left.confidence;
      const rightScore =
        prepared.diagnosticsByPaperId.get(right.relatedPaper.id)?.rerankScore ??
        right.confidence;
      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.relatedPaper.title.localeCompare(right.relatedPaper.title);
    })
    .slice(0, RELATED_LLM_LISTWISE_CANDIDATE_LIMIT);

  if (sortedCandidates.length <= 2) {
    return {
      backend: describeRelatedRerankerBackend("llm_listwise_v1"),
      baselineRows,
      rerankedRows: featureResult.rerankedRows,
      diagnostics: featureResult.diagnostics,
    };
  }

  try {
    const { provider, modelId, proxyConfig } = await getDefaultModel();
    const prompt = buildRelatedListwisePrompt({
      seedPaper: prepared.seedPaper,
      candidateRows: sortedCandidates,
      paperContexts: prepared.paperContexts,
      diagnosticsByPaperId: prepared.diagnosticsByPaperId,
      representationMap: prepared.representationMap,
    });
    const { object } = await withPaperLlmContext(
      {
        operation: PAPER_INTERACTIVE_LLM_OPERATIONS.RELATED_RERANK,
        paperId,
        userId,
        runtime: "interactive",
        source: "papers.retrieval.related_listwise",
        metadata: {
          backendId: "llm_listwise_v1",
          candidateCount: sortedCandidates.length,
        },
      },
      () =>
        generateStructuredObject({
          provider,
          modelId,
          proxyConfig: proxyConfig ?? undefined,
          system: SYSTEM_PROMPTS.rerankRelatedPapers,
          prompt,
          schemaName: "rerankRelatedPapers",
          schema: rerankRelatedPapersRuntimeOutputSchema,
          maxTokens: RELATED_LLM_LISTWISE_MAX_TOKENS,
        }),
    );

    const selections = sanitizeListwiseSelections(
      object.selectedPapers,
      sortedCandidates,
    );
    const diagnosticsByPaperId = new Map(
      prepared.diagnostics.map((diagnostic) => [diagnostic.paperId, diagnostic]),
    );
    const llmScoreByPaperId = new Map(
      selections.map((selection) => [
        selection.paperId,
        Number(selection.relevanceScore.toFixed(6)),
      ]),
    );
    const finalized = finalizeRelatedRows({
      rows: sortedCandidates,
      diagnosticsByPaperId,
      representationMap: prepared.representationMap,
      scoreForPaperId: (candidatePaperId) =>
        Number(
          Math.min(
            1,
            (diagnosticsByPaperId.get(candidatePaperId)?.rerankScore ?? 0) +
              (llmScoreByPaperId.get(candidatePaperId) ?? 0) *
                RELATED_LLM_SELECTION_BOOST_WEIGHT,
          ).toFixed(6),
        ),
      limit: Math.min(RELATED_LLM_LISTWISE_RESULT_LIMIT, sortedCandidates.length),
    });

    const diagnostics = finalized.rerankedDiagnostics.map((diagnostic) => ({
      ...diagnostic,
      rerankScore: Number(
        Math.min(
          1,
          diagnostic.rerankScore +
            (llmScoreByPaperId.get(diagnostic.paperId) ?? 0) *
              RELATED_LLM_SELECTION_BOOST_WEIGHT,
        ).toFixed(6),
      ),
    }));

    const result = {
      backend: describeRelatedRerankerBackend("llm_listwise_v1"),
      baselineRows,
      rerankedRows: finalized.rerankedRows,
      diagnostics,
    } satisfies RelatedRerankResult;

    relatedRerankCache.set(cacheKey, {
      expiresAt: Date.now() + RELATED_RERANK_CACHE_TTL_MS,
      result,
    });
    return result;
  } catch (error) {
    console.warn(
      "[related-ranker] LLM listwise backend fell back to feature ranking:",
      error,
    );
    return featureResult;
  }
}

async function buildLlmPointwiseRelatedRerankResult(
  paperId: string,
  userId: string,
  rows: GraphRelationRow[],
  db: RelatedRerankDb = prisma,
): Promise<RelatedRerankResult> {
  const baselineRows = sortRelatedRowsBaseline(rows);
  const cacheKey = buildCacheKey("llm_pointwise_v1", paperId, userId, baselineRows);
  const cached = relatedRerankCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const prepared = await prepareFeatureRelatedRerankState(
    paperId,
    userId,
    baselineRows,
    db,
  );
  const featureResult = buildFeatureRelatedRerankResultFromPrepared(prepared);
  if (!prepared.seedPaper || prepared.candidateRows.length === 0) {
    return {
      backend: describeRelatedRerankerBackend("llm_pointwise_v1"),
      baselineRows,
      rerankedRows: [],
      diagnostics: [],
    };
  }

  const llmShortlistRows = buildLlmShortlistRows(prepared);
  const sortedCandidates = [...llmShortlistRows]
    .sort((left, right) => {
      const leftScore =
        prepared.diagnosticsByPaperId.get(left.relatedPaper.id)?.rerankScore ??
        left.confidence;
      const rightScore =
        prepared.diagnosticsByPaperId.get(right.relatedPaper.id)?.rerankScore ??
        right.confidence;
      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.relatedPaper.title.localeCompare(right.relatedPaper.title);
    })
    .slice(0, RELATED_LLM_POINTWISE_CANDIDATE_LIMIT);

  if (sortedCandidates.length <= 2) {
    return {
      backend: describeRelatedRerankerBackend("llm_pointwise_v1"),
      baselineRows,
      rerankedRows: featureResult.rerankedRows,
      diagnostics: featureResult.diagnostics,
    };
  }

  try {
    const { provider, modelId, proxyConfig } = await getDefaultModel();
    const prompt = buildRelatedPointwisePrompt({
      seedPaper: prepared.seedPaper,
      candidateRows: sortedCandidates,
      paperContexts: prepared.paperContexts,
      diagnosticsByPaperId: prepared.diagnosticsByPaperId,
      representationMap: prepared.representationMap,
    });
    const { object } = await withPaperLlmContext(
      {
        operation: PAPER_INTERACTIVE_LLM_OPERATIONS.RELATED_RERANK,
        paperId,
        userId,
        runtime: "interactive",
        source: "papers.retrieval.related_pointwise",
        metadata: {
          backendId: "llm_pointwise_v1",
          candidateCount: sortedCandidates.length,
        },
      },
      () =>
        generateStructuredObject({
          provider,
          modelId,
          proxyConfig: proxyConfig ?? undefined,
          system: SYSTEM_PROMPTS.scoreRelatedPapersPointwise,
          prompt,
          schemaName: "scoreRelatedPapersPointwise",
          schema: scoreRelatedPapersPointwiseRuntimeOutputSchema,
          maxTokens: RELATED_LLM_POINTWISE_MAX_TOKENS,
        }),
    );

    const assessments = sanitizePointwiseAssessments(
      object.assessments,
      sortedCandidates,
    );
    if (assessments.length === 0) {
      return featureResult;
    }

    const diagnosticsByPaperId = new Map(
      prepared.diagnostics.map((diagnostic) => [diagnostic.paperId, diagnostic]),
    );
    const assessmentByPaperId = new Map(
      assessments.map((assessment) => [assessment.paperId, assessment]),
    );
    const includedRows = sortedCandidates.filter((row) => {
      const assessment = assessmentByPaperId.get(row.relatedPaper.id);
      if (!assessment) return false;
      if (assessment.include) return true;
      const diagnostics = diagnosticsByPaperId.get(row.relatedPaper.id);
      if (!diagnostics) return false;
      return (
        hasSharedCitationEvidence(diagnostics.deterministicSignals) &&
        diagnostics.rerankScore >= 0.48 &&
        assessment.relevanceScore >= 0.45
      );
    });
    if (includedRows.length === 0) {
      return featureResult;
    }

    const finalized = finalizeRelatedRows({
      rows: includedRows,
      diagnosticsByPaperId,
      representationMap: prepared.representationMap,
      scoreForPaperId: (candidatePaperId) => {
        const featureScore =
          diagnosticsByPaperId.get(candidatePaperId)?.rerankScore ?? 0;
        const llmScore =
          assessmentByPaperId.get(candidatePaperId)?.relevanceScore ?? 0;
        const llmAdjustment = (llmScore - 0.5) * RELATED_LLM_POINTWISE_SCORE_WEIGHT;
        return Number(
          Math.max(0, Math.min(1, featureScore + llmAdjustment)).toFixed(6),
        );
      },
      limit: Math.min(RELATED_LLM_POINTWISE_RESULT_LIMIT, includedRows.length),
    });

    const diagnostics = finalized.rerankedDiagnostics.map((diagnostic) => {
      const llmScore =
        assessmentByPaperId.get(diagnostic.paperId)?.relevanceScore ?? 0;
      const llmAdjustment = (llmScore - 0.5) * RELATED_LLM_POINTWISE_SCORE_WEIGHT;
      return {
        ...diagnostic,
        rerankScore: Number(
          Math.max(0, Math.min(1, diagnostic.rerankScore + llmAdjustment)).toFixed(
            6,
          ),
        ),
      };
    });

    const result = {
      backend: describeRelatedRerankerBackend("llm_pointwise_v1"),
      baselineRows,
      rerankedRows: finalized.rerankedRows,
      diagnostics,
    } satisfies RelatedRerankResult;

    relatedRerankCache.set(cacheKey, {
      expiresAt: Date.now() + RELATED_RERANK_CACHE_TTL_MS,
      result,
    });
    return result;
  } catch (error) {
    console.warn(
      "[related-ranker] LLM pointwise backend fell back to feature ranking:",
      error,
    );
    return featureResult;
  }
}

export async function buildRelatedRerankResult(
  paperId: string,
  userId: string,
  rows: GraphRelationRow[],
  db: RelatedRerankDb = prisma,
  options: BuildRelatedRerankOptions = {},
): Promise<RelatedRerankResult> {
  const backendId = options.backendId ?? resolveRelatedRerankerBackendId();

  if (backendId === "baseline_v1") {
    return buildBaselineRelatedRerankResult(rows, backendId);
  }

  if (backendId === "llm_listwise_v1") {
    return buildLlmListwiseRelatedRerankResult(paperId, userId, rows, db);
  }

  if (backendId === "llm_pointwise_v1") {
    return buildLlmPointwiseRelatedRerankResult(paperId, userId, rows, db);
  }

  return buildFeatureRelatedRerankResult(paperId, userId, rows, db);
}

function rerankedTopicalRows(
  candidateRows: GraphRelationRow[],
  diagnosticsByPaperId: Map<string, RelatedRerankCandidateDiagnostics>,
  seedPaper: RelatedPaperContext,
): GraphRelationRow[] {
  return candidateRows.filter((row) => {
    const diagnostics = diagnosticsByPaperId.get(row.relatedPaper.id);
    if (!diagnostics) return false;
    return passesTopicalityFloor(row, diagnostics, seedPaper);
  });
}

export async function rerankRelatedRelationRows(
  paperId: string,
  userId: string,
  rows: GraphRelationRow[],
  db: RelatedRerankDb = prisma,
): Promise<GraphRelationRow[]> {
  if (!supportsRelatedRerankDb(db)) {
    return sortRelatedRowsBaseline(rows);
  }

  try {
    const result = await buildRelatedRerankResult(paperId, userId, rows, db);
    return result.rerankedRows;
  } catch (error) {
    console.warn("[related-ranker] Falling back to baseline ordering:", error);
    return sortRelatedRowsBaseline(rows);
  }
}
