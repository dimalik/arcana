import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authorBucketKey,
  parsePaperAuthorsJson,
} from "@/lib/papers/authors";
import {
  diversifyCandidates,
  parsePaperRepresentationVector,
  searchSharedPaperRepresentationsByQuery,
  SHARED_RAW_PAPER_REPRESENTATION_KIND,
} from "@/lib/papers/retrieval";

type SearchDb = Pick<
  typeof prisma,
  "paper" | "author" | "paperAuthor" | "paperRepresentation"
>;

type SearchSort = "newest" | "oldest" | "title" | "year" | "engagement";

type SearchMatchField =
  | "doi"
  | "arxiv"
  | "title"
  | "authors"
  | "abstract"
  | "summary"
  | "tags";

interface SearchCandidateSeed {
  paperId: string;
  lexicalMatchKinds: Set<SearchMatchField>;
  authorIndexHits: number;
  semanticScore: number;
}

interface SearchQueryInfo {
  raw: string;
  normalizedText: string;
  normalizedAuthorText: string;
  tokens: string[];
  doiExact: string | null;
  arxivExact: string | null;
  likelyAuthorQuery: boolean;
  likelyExactTitleQuery: boolean;
  broadQuery: boolean;
}

interface SearchPaperRow {
  id: string;
  title: string;
  abstract: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  sourceType: string;
  sourceUrl: string | null;
  summary: string | null;
  citationCount: number | null;
  engagementScore: number;
  createdAt: Date;
  updatedAt: Date;
  duplicateState: string;
  tags: Array<{ tag: { id: string; name: string; color: string } }>;
  collections: Array<{ collection: { id: string; name: string } }>;
  paperAuthors: Array<{
    orderIndex: number;
    rawName: string;
    author: {
      id: string;
      canonicalName: string;
      normalizedName: string;
      orcid: string | null;
      semanticScholarAuthorId: string | null;
    };
  }>;
}

export interface SearchDiagnostics {
  lexicalMatchKinds: SearchMatchField[];
  semanticScore: number;
  rerankScore: number;
  diversificationPenalty: number;
  authorIndexHits: number;
}

export interface SearchPaperResult {
  id: string;
  title: string;
  abstract: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  sourceType: string;
  sourceUrl: string | null;
  arxivId: string | null;
  summary: string | null;
  citationCount: number | null;
  engagementScore: number;
  createdAt: string;
  updatedAt: string;
  tags: Array<{ tag: { id: string; name: string; color: string } }>;
  collections: Array<{ collection: { id: string; name: string } }>;
  matchFields: SearchMatchField[];
  searchDiagnostics: SearchDiagnostics;
}

export interface SearchLibraryPapersResult {
  papers: SearchPaperResult[];
  total: number;
  page: number;
  totalPages: number;
  degraded: boolean;
}

const SEARCH_RERANK_WEIGHTS = {
  exactIdentifier: 1.2,
  exactTitle: 0.9,
  titleContainment: 0.42,
  titleTokenOverlap: 0.28,
  authorIndex: 0.52,
  semantic: 0.24,
  abstractOverlap: 0.14,
  summaryOverlap: 0.08,
  tagOverlap: 0.09,
  citationPrior: 0.03,
} as const;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSearchText(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  return normalizeWhitespace(value).toLowerCase();
}

export function parseSearchQuery(query: string): SearchQueryInfo {
  const raw = normalizeWhitespace(query);
  const normalizedText = normalizeSearchText(raw);
  const normalizedAuthorText = authorBucketKey(raw);
  const tokens = tokenizeSearchText(raw);
  const doiMatch = raw.match(/10\.\d{4,9}\/\S+/i);
  const arxivMatch = raw.match(
    /\b(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+\/\d{7}(?:v\d+)?)\b/i,
  );
  const hasAuthorLikeCasing = /[A-Z]/.test(raw);
  const likelyAuthorQuery =
    !doiMatch
    && !arxivMatch
    && tokens.length >= 2
    && tokens.length <= 4
    && !/[0-9:]/.test(raw)
    && hasAuthorLikeCasing;
  const likelyExactTitleQuery =
    !doiMatch
    && !arxivMatch
    && !likelyAuthorQuery
    && (tokens.length >= 5 || /[:\-]/.test(raw));
  const broadQuery = tokens.length <= 1;

  return {
    raw,
    normalizedText,
    normalizedAuthorText,
    tokens,
    doiExact: normalizeIdentifier(doiMatch?.[0] ?? null),
    arxivExact: normalizeIdentifier(arxivMatch?.[1] ?? null),
    likelyAuthorQuery,
    likelyExactTitleQuery,
    broadQuery,
  };
}

function tokenOverlapScore(tokens: string[], haystack: string | null | undefined): number {
  if (tokens.length === 0 || !haystack) return 0;
  const normalized = normalizeSearchText(haystack);
  if (!normalized) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (normalized.includes(token)) hits += 1;
  }
  return Number((hits / tokens.length).toFixed(6));
}

function exactTitleMatch(query: SearchQueryInfo, title: string): number {
  return normalizeSearchText(title) === query.normalizedText ? 1 : 0;
}

function titleContainmentScore(query: SearchQueryInfo, title: string): number {
  const normalizedTitle = normalizeSearchText(title);
  if (!query.normalizedText || !normalizedTitle) return 0;
  if (normalizedTitle.includes(query.normalizedText)) return 1;
  return tokenOverlapScore(query.tokens, title);
}

function authorOverlapSignals(
  query: SearchQueryInfo,
  paper: SearchPaperRow,
): { lexical: number; hits: number } {
  if (query.tokens.length === 0) {
    return { lexical: 0, hits: 0 };
  }

  const authorRows = paper.paperAuthors
    .map((row) => ({
      normalizedName: row.author.normalizedName,
      rawName: row.rawName,
    }));

  if (authorRows.length === 0) {
    const parsed = parsePaperAuthorsJson(paper.authors);
    return {
      lexical: parsed.length > 0 ? Math.max(...parsed.map((name) => tokenOverlapScore(query.tokens, name))) : 0,
      hits: 0,
    };
  }

  let best = 0;
  let hits = 0;
  for (const row of authorRows) {
    const lexical = row.normalizedName === query.normalizedAuthorText
      ? 1
      : tokenOverlapScore(query.tokens, row.rawName);
    if (lexical > 0) hits += 1;
    best = Math.max(best, lexical);
  }

  return {
    lexical: Number(best.toFixed(6)),
    hits,
  };
}

function citationPrior(paper: SearchPaperRow): number {
  if (!paper.citationCount || paper.citationCount <= 0) return 0;
  return Number((Math.log1p(paper.citationCount) / 10).toFixed(6));
}

function buildSearchOrderBy(sort: SearchSort): Prisma.PaperOrderByWithRelationInput {
  if (sort === "oldest") return { createdAt: "asc" };
  if (sort === "title") return { title: "asc" };
  if (sort === "year") return { year: "desc" };
  if (sort === "engagement") return { engagementScore: "desc" };
  return { createdAt: "desc" };
}

function scorePaper(
  query: SearchQueryInfo,
  paper: SearchPaperRow,
  seed: SearchCandidateSeed,
): { rerankScore: number; lexicalMatchKinds: SearchMatchField[] } {
  const lexicalMatchKinds = new Set<SearchMatchField>(seed.lexicalMatchKinds);
  const doiMatch =
    query.doiExact
    && normalizeIdentifier(paper.doi) === query.doiExact
      ? 1
      : 0;
  const arxivMatch =
    query.arxivExact
    && normalizeIdentifier(paper.arxivId) === query.arxivExact
      ? 1
      : 0;
  const exactTitle = exactTitleMatch(query, paper.title);
  const titleContainment = titleContainmentScore(query, paper.title);
  const abstractOverlap = tokenOverlapScore(query.tokens, paper.abstract);
  const summaryOverlap = tokenOverlapScore(query.tokens, paper.summary);
  const tagOverlap = Math.max(
    0,
    ...paper.tags.map((entry) => tokenOverlapScore(query.tokens, entry.tag.name)),
  );
  const authorSignals = authorOverlapSignals(query, paper);

  if (doiMatch) lexicalMatchKinds.add("doi");
  if (arxivMatch) lexicalMatchKinds.add("arxiv");
  if (exactTitle || titleContainment > 0) lexicalMatchKinds.add("title");
  if (abstractOverlap > 0) lexicalMatchKinds.add("abstract");
  if (summaryOverlap > 0) lexicalMatchKinds.add("summary");
  if (tagOverlap > 0) lexicalMatchKinds.add("tags");
  if (authorSignals.lexical > 0 || seed.authorIndexHits > 0) lexicalMatchKinds.add("authors");

  let rerankScore =
    (doiMatch + arxivMatch) * SEARCH_RERANK_WEIGHTS.exactIdentifier +
    exactTitle * SEARCH_RERANK_WEIGHTS.exactTitle +
    titleContainment * SEARCH_RERANK_WEIGHTS.titleContainment +
    tokenOverlapScore(query.tokens, paper.title) * SEARCH_RERANK_WEIGHTS.titleTokenOverlap +
    Math.max(authorSignals.lexical, seed.authorIndexHits > 0 ? 1 : 0)
      * SEARCH_RERANK_WEIGHTS.authorIndex +
    seed.semanticScore * SEARCH_RERANK_WEIGHTS.semantic +
    abstractOverlap * SEARCH_RERANK_WEIGHTS.abstractOverlap +
    summaryOverlap * SEARCH_RERANK_WEIGHTS.summaryOverlap +
    tagOverlap * SEARCH_RERANK_WEIGHTS.tagOverlap +
    citationPrior(paper) * SEARCH_RERANK_WEIGHTS.citationPrior;

  if (query.likelyAuthorQuery && (authorSignals.lexical > 0 || seed.authorIndexHits > 0)) {
    rerankScore += 0.12;
  }

  return {
    rerankScore: Number(rerankScore.toFixed(6)),
    lexicalMatchKinds: Array.from(lexicalMatchKinds),
  };
}

function mergeWhereInputs(
  left: Prisma.PaperWhereInput,
  right: Prisma.PaperWhereInput,
): Prisma.PaperWhereInput {
  return {
    AND: [left, right],
  };
}

async function collectLexicalCandidateSeeds(
  query: SearchQueryInfo,
  where: Prisma.PaperWhereInput,
  db: SearchDb,
): Promise<Map<string, SearchCandidateSeed>> {
  const seeds = new Map<string, SearchCandidateSeed>();

  const register = (
    paperId: string,
    kind: SearchMatchField,
    authorHits = 0,
  ) => {
    const current = seeds.get(paperId);
    if (current) {
      current.lexicalMatchKinds.add(kind);
      current.authorIndexHits = Math.max(current.authorIndexHits, authorHits);
      return;
    }
    seeds.set(paperId, {
      paperId,
      lexicalMatchKinds: new Set<SearchMatchField>([kind]),
      authorIndexHits: authorHits,
      semanticScore: 0,
    });
  };

  const baseTextMatches = await db.paper.findMany({
    where: mergeWhereInputs(where, {
      OR: [
        { title: { contains: query.raw } },
        { doi: { contains: query.raw } },
        { arxivId: { contains: query.raw } },
        { sourceUrl: { contains: query.raw } },
        { tags: { some: { tag: { name: { contains: query.raw } } } } },
      ],
    }),
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      abstract: true,
      summary: true,
      doi: true,
      arxivId: true,
      tags: {
        select: { tag: { select: { name: true } } },
      },
    },
  });

  for (const paper of baseTextMatches) {
    if (
      query.doiExact
      && normalizeIdentifier(paper.doi) === query.doiExact
    ) {
      register(paper.id, "doi");
    }
    if (
      query.arxivExact
      && normalizeIdentifier(paper.arxivId) === query.arxivExact
    ) {
      register(paper.id, "arxiv");
    }
    if (tokenOverlapScore(query.tokens, paper.title) > 0 || exactTitleMatch(query, paper.title)) {
      register(paper.id, "title");
    }
    if (tokenOverlapScore(query.tokens, paper.abstract) > 0) {
      register(paper.id, "abstract");
    }
    if (tokenOverlapScore(query.tokens, paper.summary) > 0) {
      register(paper.id, "summary");
    }
    if (
      paper.tags.some((entry) => tokenOverlapScore(query.tokens, entry.tag.name) > 0)
    ) {
      register(paper.id, "tags");
    }
  }

  const shouldProbeBodyText =
    !query.doiExact
    && !query.arxivExact
    && !query.likelyAuthorQuery
    && !query.broadQuery
    && !query.likelyExactTitleQuery;

  if (shouldProbeBodyText && seeds.size < 25) {
    const bodyMatches = await db.paper.findMany({
      where: mergeWhereInputs(where, {
        OR: [
          { abstract: { contains: query.raw } },
          { summary: { contains: query.raw } },
        ],
      }),
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        title: true,
        abstract: true,
        summary: true,
        doi: true,
        arxivId: true,
        tags: {
          select: { tag: { select: { name: true } } },
        },
      },
    });

    for (const paper of bodyMatches) {
      if (tokenOverlapScore(query.tokens, paper.abstract) > 0) {
        register(paper.id, "abstract");
      }
      if (tokenOverlapScore(query.tokens, paper.summary) > 0) {
        register(paper.id, "summary");
      }
    }
  }

  if (query.tokens.length >= 1) {
    const matchingAuthors = await db.author.findMany({
      where: {
        AND: query.tokens.map((token) => ({
          normalizedName: { contains: token },
        })),
      },
      take: 25,
      select: {
        id: true,
        normalizedName: true,
      },
    });

    if (matchingAuthors.length > 0) {
      const paperAuthors = await db.paperAuthor.findMany({
        where: {
          authorId: { in: matchingAuthors.map((author) => author.id) },
          paper: where,
        },
        take: 100,
        select: {
          paperId: true,
          author: {
            select: { normalizedName: true },
          },
        },
      });

      for (const row of paperAuthors) {
        const authorHits =
          row.author.normalizedName === query.normalizedAuthorText ? 2 : 1;
        register(row.paperId, "authors", authorHits);
      }
    }
  }

  return seeds;
}

export function shouldRunSemanticSearch(
  query: SearchQueryInfo,
  lexicalSeeds: Map<string, SearchCandidateSeed>,
): boolean {
  if (query.doiExact || query.arxivExact || query.likelyAuthorQuery || query.broadQuery) {
    return false;
  }

  for (const seed of Array.from(lexicalSeeds.values())) {
    if (seed.lexicalMatchKinds.has("authors")) {
      return false;
    }
  }

  if (query.likelyExactTitleQuery && lexicalSeeds.size > 0) {
    return false;
  }

  return lexicalSeeds.size < 8;
}

async function collectSemanticCandidateSeeds(
  params: {
    query: SearchQueryInfo;
    userId: string;
    where: Prisma.PaperWhereInput;
    limit: number;
    excludePaperIds: string[];
  },
  db: SearchDb,
): Promise<Map<string, SearchCandidateSeed>> {
  const semanticMatches = await searchSharedPaperRepresentationsByQuery(
    {
      userId: params.userId,
      queryText: params.query.raw,
      limit: params.limit,
      excludePaperIds: params.excludePaperIds,
    },
    db,
  );

  const permittedIds = new Set(
    (
      await db.paper.findMany({
        where: mergeWhereInputs(params.where, {
          id: { in: semanticMatches.map((match) => match.paperId) },
        }),
        select: { id: true },
      })
    ).map((paper) => paper.id),
  );

  const seeds = new Map<string, SearchCandidateSeed>();
  for (const match of semanticMatches) {
    if (!permittedIds.has(match.paperId)) continue;
    seeds.set(match.paperId, {
      paperId: match.paperId,
      lexicalMatchKinds: new Set<SearchMatchField>(),
      authorIndexHits: 0,
      semanticScore: Number(match.score.toFixed(6)),
    });
  }

  return seeds;
}

function stripInternalFields(
  paper: SearchPaperRow,
): SearchPaperResult {
  return {
    id: paper.id,
    title: paper.title,
    abstract: paper.abstract,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    doi: paper.doi,
    sourceType: paper.sourceType,
    sourceUrl: paper.sourceUrl,
    arxivId: paper.arxivId,
    summary: paper.summary,
    citationCount: paper.citationCount,
    engagementScore: paper.engagementScore,
    createdAt: paper.createdAt.toISOString(),
    updatedAt: paper.updatedAt.toISOString(),
    tags: paper.tags,
    collections: paper.collections,
    matchFields: [],
    searchDiagnostics: {
      lexicalMatchKinds: [],
      semanticScore: 0,
      rerankScore: 0,
      diversificationPenalty: 0,
      authorIndexHits: 0,
    },
  };
}

async function loadSearchVectors(
  paperIds: string[],
  db: SearchDb,
): Promise<Map<string, number[]>> {
  const rows = await db.paperRepresentation.findMany({
    where: {
      paperId: { in: paperIds },
      representationKind: SHARED_RAW_PAPER_REPRESENTATION_KIND,
    },
    select: {
      paperId: true,
      vectorJson: true,
    },
  });

  return new Map(
    rows.map((row) => [row.paperId, parsePaperRepresentationVector(row.vectorJson)]),
  );
}

export async function searchLibraryPapers(
  params: {
    userId: string;
    queryText?: string;
    where: Prisma.PaperWhereInput;
    sort?: SearchSort;
    page?: number;
    limit?: number;
  },
  db: SearchDb = prisma,
): Promise<SearchLibraryPapersResult> {
  const queryText = normalizeWhitespace(params.queryText ?? "");
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.max(1, params.limit ?? 20);
  const skip = (page - 1) * limit;
  const sort = params.sort ?? "newest";

  if (!queryText) {
    const [papers, total] = await Promise.all([
      db.paper.findMany({
        where: params.where,
        include: {
          tags: { include: { tag: true } },
          collections: { include: { collection: true } },
          paperAuthors: {
            include: {
              author: {
                select: {
                  id: true,
                  canonicalName: true,
                  normalizedName: true,
                  orcid: true,
                  semanticScholarAuthorId: true,
                },
              },
            },
            orderBy: { orderIndex: "asc" },
          },
        },
        orderBy: buildSearchOrderBy(sort),
        skip,
        take: limit,
      }),
      db.paper.count({ where: params.where }),
    ]);

    return {
      papers: papers.map(stripInternalFields),
      total,
      page,
      totalPages: Math.ceil(total / limit),
      degraded: false,
    };
  }

  const query = parseSearchQuery(queryText);
  const lexicalSeeds = await collectLexicalCandidateSeeds(query, params.where, db);
  const semanticSeeds = shouldRunSemanticSearch(query, lexicalSeeds)
    ? await collectSemanticCandidateSeeds(
        {
          query,
          userId: params.userId,
          where: params.where,
          limit: 35,
          excludePaperIds: Array.from(lexicalSeeds.keys()),
        },
        db,
      )
    : new Map<string, SearchCandidateSeed>();

  const mergedSeeds = new Map<string, SearchCandidateSeed>();
  for (const entry of [
    ...Array.from(lexicalSeeds.values()),
    ...Array.from(semanticSeeds.values()),
  ]) {
    const current = mergedSeeds.get(entry.paperId);
    if (!current) {
      mergedSeeds.set(entry.paperId, {
        paperId: entry.paperId,
        lexicalMatchKinds: new Set(entry.lexicalMatchKinds),
        authorIndexHits: entry.authorIndexHits,
        semanticScore: entry.semanticScore,
      });
      continue;
    }

    for (const matchKind of Array.from(entry.lexicalMatchKinds)) {
      current.lexicalMatchKinds.add(matchKind);
    }
    current.authorIndexHits = Math.max(current.authorIndexHits, entry.authorIndexHits);
    current.semanticScore = Math.max(current.semanticScore, entry.semanticScore);
  }

  const candidateIds = Array.from(mergedSeeds.keys());
  if (candidateIds.length === 0) {
    return {
      papers: [],
      total: 0,
      page,
      totalPages: 0,
      degraded: false,
    };
  }

  const papers = await db.paper.findMany({
    where: mergeWhereInputs(params.where, {
      id: { in: candidateIds },
    }),
    include: {
      tags: { include: { tag: true } },
      collections: { include: { collection: true } },
      paperAuthors: {
        include: {
          author: {
            select: {
              id: true,
              canonicalName: true,
              normalizedName: true,
              orcid: true,
              semanticScholarAuthorId: true,
            },
          },
        },
        orderBy: { orderIndex: "asc" },
      },
    },
  });

  const vectorByPaperId = await loadSearchVectors(
    papers.map((paper) => paper.id),
    db,
  );

  const scoredRows = await Promise.all(
    papers.map(async (paper) => {
      const seed = mergedSeeds.get(paper.id) ?? {
        paperId: paper.id,
        lexicalMatchKinds: new Set<SearchMatchField>(),
        authorIndexHits: 0,
        semanticScore: 0,
      };
      const scoring = scorePaper(query, paper as SearchPaperRow, seed);

      return {
        paper: stripInternalFields(paper as SearchPaperRow),
        rerankScore: scoring.rerankScore,
        lexicalMatchKinds: scoring.lexicalMatchKinds,
        semanticScore: seed.semanticScore,
        authorIndexHits: seed.authorIndexHits,
        vector: vectorByPaperId.get(paper.id) ?? [],
        subtopics: paper.tags.map((entry) => entry.tag.name),
        hubScore: Math.min(1, (paper.citationCount ?? 0) / 5000),
      };
    }),
  );

  const diversified = diversifyCandidates(
    scoredRows.map((row) => ({
      id: row.paper.id,
      relevanceScore: row.rerankScore,
      hubScore: row.hubScore,
      subtopics: row.subtopics,
      vector: row.vector,
    })),
    {
      task: "search",
      limit: 50,
    },
  );

  const diversifiedOrder = new Map(
    diversified.map((entry, index) => [entry.id, index]),
  );

  const ranked = scoredRows
    .map((row) => {
      const diversifiedRank = diversifiedOrder.get(row.paper.id) ?? 999;
      const diversificationPenalty =
        diversifiedRank === 999 ? 0.5 : Number((diversifiedRank / Math.max(diversified.length, 1)).toFixed(6));
      return {
        ...row,
        diversifiedRank,
        diversificationPenalty,
      };
    })
    .filter((row) => diversifiedOrder.has(row.paper.id))
    .sort((left, right) => {
      const leftScore = left.rerankScore - left.diversificationPenalty * 0.05;
      const rightScore = right.rerankScore - right.diversificationPenalty * 0.05;
      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.paper.id.localeCompare(right.paper.id);
    });

  const paged = ranked.slice(skip, skip + limit).map((row) => ({
    ...row.paper,
    matchFields: row.lexicalMatchKinds,
    searchDiagnostics: {
      lexicalMatchKinds: row.lexicalMatchKinds,
      semanticScore: row.semanticScore,
      rerankScore: row.rerankScore,
      diversificationPenalty: row.diversificationPenalty,
      authorIndexHits: row.authorIndexHits,
    },
  }));

  return {
    papers: paged,
    total: ranked.length,
    page,
    totalPages: Math.ceil(ranked.length / limit),
    degraded: false,
  };
}
