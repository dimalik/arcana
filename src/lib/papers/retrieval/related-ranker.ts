import { prisma } from "../../prisma";
import {
  DETERMINISTIC_RELATEDNESS_PROVENANCE,
  computeDeterministicTitleSimilarity,
  parseDeterministicSignalPayload,
  type DeterministicSignalName,
} from "../../assertions/deterministic-relatedness";
import type { GraphRelationRow } from "../../assertions/relation-reader";

import {
  SHARED_RAW_PAPER_REPRESENTATION_KIND,
  encodeTextToVector,
  cosineSimilarity,
  getPaperRepresentation,
  parsePaperRepresentationMetadata,
  parsePaperRepresentationVector,
  upsertSharedPaperRepresentation,
} from "./embeddings";
import { diversifyCandidates } from "./diversify";

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
  baselineRows: GraphRelationRow[];
  rerankedRows: GraphRelationRow[];
  diagnostics: RelatedRerankCandidateDiagnostics[];
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
  graphConfidence: 0.24,
  semanticSimilarity: 0.2,
  titleSimilarity: 0.1,
  queryTitleOverlap: 0.12,
  lexicalAuthorOverlap: 0.05,
  identityAuthorOverlap: 0.03,
  venueOverlap: 0.04,
  yearProximity: 0.04,
  directCitation: 0.08,
  reverseCitation: 0.04,
  bibliographicCoupling: 0.05,
  coCitation: 0.03,
  relationTypePrior: 0.05,
  citationPrior: 0.02,
} as const;

const RELATED_RERANK_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RELATED_RERANK_CACHE_VERSION = "2026-04-20-hub-filter-v3";
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

function tokenizeInformativeText(value: string | null | undefined): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) => token.length >= 3 && !GENERIC_RELATEDNESS_TOKENS.has(token),
    );
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

function normalizeVenue(value: string | null | undefined): string {
  return normalizeText(value);
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
      Math.max(summary[signal], payload.contribution).toFixed(6),
    );
  }
  return summary;
}

function buildCacheKey(
  paperId: string,
  userId: string,
  rows: GraphRelationRow[],
): string {
  return `${RELATED_RERANK_CACHE_VERSION}:${paperId}:${userId}:${rows
    .map((row) => `${row.id}:${row.confidence.toFixed(6)}`)
    .join("|")}`;
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
    diagnostics.deterministicSignals.direct_citation >= 0.08 ||
    diagnostics.deterministicSignals.reverse_citation >= 0.08;

  if (seedIsHub) {
    return hasCitationNeighborhoodEvidence;
  }

  if (hasLexicalEvidence || hasCitationNeighborhoodEvidence) {
    return true;
  }

  if (!seedIsHub && hasDenseCitationEvidence && diagnostics.rerankScore >= 0.2) {
    return true;
  }

  return false;
}

export async function buildRelatedRerankResult(
  paperId: string,
  userId: string,
  rows: GraphRelationRow[],
  db: RelatedRerankDb = prisma,
): Promise<RelatedRerankResult> {
  const baselineRows = sortRelatedRowsBaseline(rows);

  const cacheKey = buildCacheKey(paperId, userId, baselineRows);
  const cached = relatedRerankCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const candidateRows = sortRelatedRowsBaseline(baselineRows);
  if (candidateRows.length <= 1) {
    return {
      baselineRows,
      rerankedRows: candidateRows,
      diagnostics: candidateRows.map((row) => ({
        paperId: row.relatedPaper.id,
        title: row.relatedPaper.title,
        baselineConfidence: row.confidence,
        rerankScore: row.confidence,
        semanticSimilarity: 0,
        titleSimilarity: 0,
        queryTitleOverlap: 0,
        queryTitleOverlapCount: 0,
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
  const paperIds = [paperId, ...candidateRows.map((row) => row.relatedPaper.id)];
  await ensureRepresentations(paperIds, db);

  const [paperContexts, representationMap, candidateDegrees, deterministicSignalMap] =
    await Promise.all([
      loadPaperContexts(paperIds, db),
      loadRepresentationVectors(paperIds, db),
      loadCandidateDegrees(
        candidateRows.map((row) => row.relatedPaper.id),
        db,
      ),
      loadDeterministicSignalMap(paperId, candidateRows, db),
    ]);

  const seedPaper = paperContexts.get(paperId);
  if (!seedPaper) {
    return { baselineRows, rerankedRows: baselineRows, diagnostics: [] };
  }

  const seedAuthors = parseStringArray(seedPaper.authors);
  const seedQueryTokens = tokenizeInformativeText(
    [seedPaper.title, seedPaper.abstract].filter(Boolean).join(" "),
  );
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
      citationCount: paperContexts.get(row.relatedPaper.id)?.citationCount ?? null,
      degree: candidateDegrees.get(row.relatedPaper.id) ?? 0,
    })),
  );

  const diagnostics = candidateRows.map((row) => {
    const candidateContext = paperContexts.get(row.relatedPaper.id);
    const candidateAuthors = parseStringArray(candidateContext?.authors ?? null);
    const queryTitleOverlap = containmentOverlap(
      seedQueryTokens,
      tokenizeInformativeText(row.relatedPaper.title),
    );
    const queryTitleOverlapCount = sharedTokenCount(
      seedQueryTokens,
      tokenizeInformativeText(row.relatedPaper.title),
    );
    const lexicalAuthorOverlap = jaccardOverlap(seedAuthors, candidateAuthors);
    const identityAuthorOverlap = 0;
    const candidateRepresentation = representationMap.get(row.relatedPaper.id);
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
    const deterministicSignals =
      (row.relatedPaper.entityId
        ? deterministicSignalMap.get(row.relatedPaper.entityId)
        : null) ?? emptyDeterministicSignals();
    const relationTypePrior = computeRelationTypePrior(row.relationType);
    const citationPrior = normalizeCitationPrior(
      candidateContext?.citationCount ?? null,
      Math.max(1, ...Array.from(hubScores.values(), (value) => value * 100)),
    );
    const hubScore = hubScores.get(row.relatedPaper.id) ?? 0;
    const metadata = candidateRepresentation?.metadata;
    const subtopics = Array.from(
      new Set(
        [
          ...(metadata?.tagNames ?? []),
          row.relationType.toLowerCase(),
        ].filter(Boolean),
      ),
    );

    let rerankScore =
      row.confidence * RELATED_SIGNAL_WEIGHTS.graphConfidence +
      semanticSimilarity * RELATED_SIGNAL_WEIGHTS.semanticSimilarity +
      titleSimilarity * RELATED_SIGNAL_WEIGHTS.titleSimilarity +
      queryTitleOverlap * RELATED_SIGNAL_WEIGHTS.queryTitleOverlap +
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
      isCitationOnlyRow && semanticSimilarity < 0.32 && titleSimilarity < 0.12
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

  const diagnosticsByPaperId = new Map(
    diagnostics.map((diagnostic) => [diagnostic.paperId, diagnostic]),
  );

  const filteredRows = rerankedTopicalRows(candidateRows, diagnosticsByPaperId, seedPaper);

  const diversified = diversifyCandidates(
    filteredRows.map((row) => {
      const diagnostic = diagnosticsByPaperId.get(row.relatedPaper.id);
      if (!diagnostic) {
        throw new Error(`Missing related-paper diagnostics for ${row.relatedPaper.id}`);
      }
      return {
        id: diagnostic.paperId,
        relevanceScore: diagnostic.rerankScore,
        hubScore: diagnostic.hubScore,
        noveltyScore: 0,
        subtopics: diagnostic.subtopics,
        vector: representationMap.get(diagnostic.paperId)?.vector ?? [],
      };
    }),
    {
      task: "related",
      limit: baselineRows.length,
    },
  );

  const order = new Map(diversified.map((candidate, index) => [candidate.id, index]));
  const rerankedRows = [...filteredRows].sort((left, right) => {
    const leftOrder = order.get(left.relatedPaper.id);
    const rightOrder = order.get(right.relatedPaper.id);
    if (leftOrder != null && rightOrder != null && leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    const leftScore = diagnosticsByPaperId.get(left.relatedPaper.id)?.rerankScore ?? left.confidence;
    const rightScore = diagnosticsByPaperId.get(right.relatedPaper.id)?.rerankScore ?? right.confidence;
    if (rightScore !== leftScore) return rightScore - leftScore;
    return left.relatedPaper.title.localeCompare(right.relatedPaper.title);
  });

  const result = {
    baselineRows,
    rerankedRows,
    diagnostics: rerankedRows
      .map((row) => diagnosticsByPaperId.get(row.relatedPaper.id))
      .filter((diagnostic): diagnostic is RelatedRerankCandidateDiagnostics =>
        Boolean(diagnostic),
      ),
  } satisfies RelatedRerankResult;

  relatedRerankCache.set(cacheKey, {
    expiresAt: Date.now() + RELATED_RERANK_CACHE_TTL_MS,
    result,
  });

  return result;
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
