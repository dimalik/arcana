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
  searchSharedPaperRepresentationsByQuery,
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
const relatedRerankCache = new Map<
  string,
  { expiresAt: number; result: RelatedRerankResult }
>();
const GENERIC_RELATEDNESS_TOKENS = new Set([
  "approach",
  "attention",
  "based",
  "context",
  "efficient",
  "generation",
  "language",
  "languages",
  "learning",
  "llm",
  "llms",
  "model",
  "models",
  "neural",
  "using",
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
  return `${paperId}:${userId}:${rows
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

async function loadContentCandidateRows(
  paperId: string,
  userId: string,
  graphRows: GraphRelationRow[],
  db: RelatedRerankDb,
): Promise<GraphRelationRow[]> {
  const seedPaper = await db.paper.findUnique({
    where: { id: paperId },
    select: {
      title: true,
      abstract: true,
      summary: true,
    },
  });
  if (!seedPaper) {
    return [];
  }

  const graphCandidateIds = new Set(graphRows.map((row) => row.relatedPaper.id));
  const queryText = [seedPaper.title, seedPaper.abstract]
    .filter(Boolean)
    .join("\n");
  const contentMatches = await searchSharedPaperRepresentationsByQuery(
    {
      userId,
      queryText,
      limit: 50,
      excludePaperIds: [paperId],
    },
    db,
  );

  const missingCandidateIds = contentMatches
    .map((match) => match.paperId)
    .filter((candidatePaperId) => !graphCandidateIds.has(candidatePaperId));

  if (missingCandidateIds.length === 0) {
    return [];
  }

  const contexts = await loadPaperContexts(missingCandidateIds, db);
  const rows: GraphRelationRow[] = [];

  for (const match of contentMatches) {
    if (graphCandidateIds.has(match.paperId)) continue;
    const context = contexts.get(match.paperId);
    if (!context) continue;
    rows.push({
      id: `content::${match.paperId}`,
      relatedPaper: {
        id: context.id,
        entityId: context.entityId,
        title: context.title,
        year: context.year,
        authors: context.authors,
        duplicateState: context.duplicateState,
      },
      relationType: "related",
      description: "Semantic content neighbor",
      confidence: Number(Math.max(match.score, 0).toFixed(6)),
      isAutoGenerated: true,
    });
  }

  return rows;
}

async function loadLexicalCandidateRows(
  paperId: string,
  userId: string,
  graphRows: GraphRelationRow[],
  db: RelatedRerankDb,
): Promise<GraphRelationRow[]> {
  const seedPaper = await db.paper.findUnique({
    where: { id: paperId },
    select: {
      title: true,
      abstract: true,
    },
  });
  if (!seedPaper) {
    return [];
  }

  const lexicalTokens = stableUnique(
    tokenizeInformativeText(
      [seedPaper.title, seedPaper.abstract].filter(Boolean).join(" "),
    ),
  ).slice(0, 8);

  if (lexicalTokens.length === 0) {
    return [];
  }

  const graphCandidateIds = new Set(graphRows.map((row) => row.relatedPaper.id));
  const lexicalCandidates = await db.paper.findMany({
    where: {
      userId,
      duplicateState: "ACTIVE",
      id: { not: paperId },
      OR: lexicalTokens.map((token) => ({
        title: { contains: token },
      })),
    },
    select: {
      id: true,
      entityId: true,
      title: true,
      authors: true,
      year: true,
      duplicateState: true,
    },
    take: 50,
  });

  return lexicalCandidates
    .filter((candidate) => !graphCandidateIds.has(candidate.id))
    .map((candidate) => {
      const queryTitleOverlap = containmentOverlap(
        lexicalTokens,
        tokenizeInformativeText(candidate.title),
      );
      const titleSimilarity = computeDeterministicTitleSimilarity(
        seedPaper.title,
        candidate.title,
      );

      return {
        id: `lexical::${candidate.id}`,
        relatedPaper: {
          id: candidate.id,
          entityId: candidate.entityId,
          title: candidate.title,
          year: candidate.year,
          authors: candidate.authors,
          duplicateState: candidate.duplicateState,
        },
        relationType: "related",
        description: "Lexical topic neighbor",
        confidence: Number(
          Math.max(queryTitleOverlap * 0.8, titleSimilarity * 0.7).toFixed(6),
        ),
        isAutoGenerated: true,
      } satisfies GraphRelationRow;
    })
    .filter((candidate) => candidate.confidence > 0.12);
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

function candidateSourcePriority(row: GraphRelationRow): number {
  if (row.id.startsWith("lexical::")) return 2;
  if (row.id.startsWith("content::")) return 1;
  return 3;
}

function dedupeCandidateRows(rows: GraphRelationRow[]): GraphRelationRow[] {
  const bestByPaperId = new Map<string, GraphRelationRow>();

  for (const row of rows) {
    const existing = bestByPaperId.get(row.relatedPaper.id);
    if (!existing) {
      bestByPaperId.set(row.relatedPaper.id, row);
      continue;
    }

    const existingPriority = candidateSourcePriority(existing);
    const candidatePriority = candidateSourcePriority(row);
    if (candidatePriority > existingPriority) {
      bestByPaperId.set(row.relatedPaper.id, row);
      continue;
    }
    if (
      candidatePriority === existingPriority &&
      row.confidence > existing.confidence
    ) {
      bestByPaperId.set(row.relatedPaper.id, row);
    }
  }

  return Array.from(bestByPaperId.values());
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

  const contentCandidateRows = await loadContentCandidateRows(
    paperId,
    userId,
    baselineRows,
    db,
  );
  const lexicalCandidateRows = await loadLexicalCandidateRows(
    paperId,
    userId,
    baselineRows,
    db,
  );
  const candidateRows = sortRelatedRowsBaseline(
    dedupeCandidateRows([
      ...baselineRows,
      ...contentCandidateRows,
      ...lexicalCandidateRows,
    ]),
  );
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
    const contentOnlyPenalty =
      row.id.startsWith("content::") &&
      queryTitleOverlap < 0.12 &&
      titleSimilarity < 0.08
        ? 0.18
        : 0;
    rerankScore -= citationOnlyPenalty + contentOnlyPenalty;
    rerankScore = Number(Math.max(rerankScore, 0).toFixed(6));

    return {
      paperId: row.relatedPaper.id,
      title: row.relatedPaper.title,
      baselineConfidence: row.confidence,
      rerankScore,
      semanticSimilarity,
      titleSimilarity,
      queryTitleOverlap: Number(queryTitleOverlap.toFixed(6)),
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

  const diversified = diversifyCandidates(
    diagnostics.map((diagnostic) => ({
      id: diagnostic.paperId,
      relevanceScore: diagnostic.rerankScore,
      hubScore: diagnostic.hubScore,
      noveltyScore: 0,
      subtopics: diagnostic.subtopics,
      vector: representationMap.get(diagnostic.paperId)?.vector ?? [],
    })),
    {
      task: "related",
      limit: baselineRows.length,
    },
  );

  const order = new Map(diversified.map((candidate, index) => [candidate.id, index]));
  const rerankedRows = [...candidateRows].sort((left, right) => {
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
