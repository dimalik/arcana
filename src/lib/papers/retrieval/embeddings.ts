import { createHash } from "crypto";
import { z } from "zod";

import type { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../prisma";
import { paperVisibilityWhere } from "../visibility";

import { parsePaperClaimEvaluationContext } from "../analysis/types";

export const SHARED_RAW_PAPER_REPRESENTATION_KIND = "shared_raw_features_v1";
export const SHARED_RAW_PAPER_ENCODER_VERSION = "feature_hash_256_v1";
export const SHARED_RAW_PAPER_VECTOR_DIMENSIONS = 256;
const MAX_CLAIM_FEATURES = 24;

const paperRepresentationMetadataSchema = z.object({
  title: z.string(),
  authorNames: z.array(z.string()),
  tagNames: z.array(z.string()),
  claimCount: z.number().int().nonnegative(),
  sections: z.array(z.string()),
});

const paperRepresentationVectorSchema = z.array(z.number());

export type PaperRepresentationMetadata = z.infer<
  typeof paperRepresentationMetadataSchema
>;

export interface RetrievalFeatureSection {
  label: string;
  text: string;
  weight: number;
}

export interface PaperRepresentationFeatureDocument {
  featureText: string;
  sections: RetrievalFeatureSection[];
  metadata: PaperRepresentationMetadata;
}

export interface PaperRepresentationRecord {
  paperId: string;
  representationKind: string;
  encoderVersion: string;
  sourceFingerprint: string;
  dimensions: number;
  featureText: string;
  vector: number[];
  metadata: PaperRepresentationMetadata | null;
}

export interface PaperRepresentationMatch {
  paperId: string;
  title: string;
  score: number;
  representationKind: string;
  encoderVersion: string;
  metadata: PaperRepresentationMetadata | null;
}

export interface RepresentationUpsertResult {
  status: "created" | "updated" | "unchanged";
  representation: PaperRepresentationRecord;
}

export type PaperRepresentationDb = Pick<
  typeof prisma,
  "paper" | "paperRepresentation"
>;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeRetrievalText(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAuthorName(value: string): string {
  return normalizeRetrievalText(value);
}

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => normalizeWhitespace(item))
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

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return normalizeRetrievalText(text)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function l2Normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector.map(() => 0);
  return vector.map((value) => Number((value / magnitude).toFixed(8)));
}

function serializeMetadata(
  metadata: PaperRepresentationMetadata,
): string {
  return JSON.stringify(metadata);
}

export function parsePaperRepresentationMetadata(
  value: string | null | undefined,
): PaperRepresentationMetadata | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    const result = paperRepresentationMetadataSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parsePaperRepresentationVector(
  value: string | null | undefined,
): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    const result = paperRepresentationVectorSchema.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function serializePaperRepresentationVector(vector: number[]): string {
  return JSON.stringify(vector);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (!leftNorm || !rightNorm) return 0;
  return Number((dot / Math.sqrt(leftNorm * rightNorm)).toFixed(6));
}

export function encodeFeatureSectionsToVector(
  sections: RetrievalFeatureSection[],
  dimensions = SHARED_RAW_PAPER_VECTOR_DIMENSIONS,
): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);

  for (const section of sections) {
    const tokens = tokenize(section.text);
    if (tokens.length === 0) continue;

    const normalizedWeight = section.weight / Math.sqrt(tokens.length);
    for (const token of tokens) {
      const hash = hashToken(`${section.label}:${token}`);
      const bucket = hash % dimensions;
      const sign = hash & 1 ? 1 : -1;
      vector[bucket] += normalizedWeight * sign;
    }
  }

  return l2Normalize(vector);
}

export function encodeTextToVector(
  text: string,
  dimensions = SHARED_RAW_PAPER_VECTOR_DIMENSIONS,
): number[] {
  return encodeFeatureSectionsToVector(
    [{ label: "query", text, weight: 1 }],
    dimensions,
  );
}

export function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dimensions = vectors[0]?.length ?? 0;
  if (!dimensions) return [];
  const accumulator = Array.from({ length: dimensions }, () => 0);

  for (const vector of vectors) {
    if (vector.length !== dimensions) continue;
    for (let index = 0; index < dimensions; index += 1) {
      accumulator[index] += vector[index];
    }
  }

  return l2Normalize(accumulator);
}

function buildClaimFeatureText(
  claim: {
    normalizedText: string;
    rhetoricalRole: string;
    facet: string;
    polarity: string;
    sectionPath: string;
    evaluationContext: string | null;
  },
): string {
  const evaluationContext = parsePaperClaimEvaluationContext(
    claim.evaluationContext,
  );
  const fragments = [
    claim.normalizedText,
    claim.rhetoricalRole,
    claim.facet,
    claim.polarity,
    claim.sectionPath,
    evaluationContext?.task,
    evaluationContext?.dataset,
    evaluationContext?.metric,
    evaluationContext?.comparator,
  ].filter((value): value is string => Boolean(value));
  return fragments.join(" ");
}

export function buildSharedPaperFeatureDocument(paper: {
  title: string;
  abstract: string | null;
  summary: string | null;
  keyFindings: string | null;
  authors: string | null;
  venue: string | null;
  year: number | null;
  tags?: Array<{ tag: { name: string } }>;
  claims?: Array<{
    normalizedText: string;
    rhetoricalRole: string;
    facet: string;
    polarity: string;
    sectionPath: string;
    evaluationContext: string | null;
  }>;
}): PaperRepresentationFeatureDocument {
  const sections: RetrievalFeatureSection[] = [];
  const authorNames = stableUnique(
    parseJsonStringArray(paper.authors).map(normalizeAuthorName),
  );
  const keyFindings = stableUnique(parseJsonStringArray(paper.keyFindings));
  const tagNames = stableUnique(
    (paper.tags ?? []).map(({ tag }) => normalizeRetrievalText(tag.name)).filter(Boolean),
  );
  const claims = (paper.claims ?? [])
    .map(buildClaimFeatureText)
    .filter(Boolean)
    .slice(0, MAX_CLAIM_FEATURES);

  sections.push({ label: "title", text: paper.title, weight: 3 });

  if (paper.abstract) {
    sections.push({ label: "abstract", text: paper.abstract, weight: 2 });
  }
  if (paper.summary) {
    sections.push({ label: "summary", text: paper.summary, weight: 2 });
  }
  for (const finding of keyFindings) {
    sections.push({ label: "finding", text: finding, weight: 1.75 });
  }
  for (const tagName of tagNames) {
    sections.push({ label: "tag", text: tagName, weight: 1.5 });
  }
  for (const authorName of authorNames) {
    sections.push({ label: "author", text: authorName, weight: 1.25 });
  }
  if (paper.venue) {
    sections.push({ label: "venue", text: paper.venue, weight: 1 });
  }
  if (paper.year) {
    sections.push({ label: "year", text: String(paper.year), weight: 0.5 });
  }
  for (const claim of claims) {
    sections.push({ label: "claim", text: claim, weight: 1.5 });
  }

  const normalizedSections = sections
    .map((section) => ({
      ...section,
      text: normalizeWhitespace(section.text),
    }))
    .filter((section) => section.text.length > 0);

  const featureText = normalizedSections
    .map((section) => `${section.label}: ${section.text}`)
    .join("\n");

  return {
    featureText,
    sections: normalizedSections,
    metadata: {
      title: paper.title,
      authorNames,
      tagNames,
      claimCount: claims.length,
      sections: normalizedSections.map((section) => section.label),
    },
  };
}

function computeSourceFingerprint(featureText: string): string {
  return createHash("sha256").update(featureText).digest("hex");
}

function toRepresentationRecord(
  row: {
    paperId: string;
    representationKind: string;
    encoderVersion: string;
    sourceFingerprint: string;
    dimensions: number;
    featureText: string;
    vectorJson: string;
    metadataJson: string | null;
  },
): PaperRepresentationRecord {
  return {
    paperId: row.paperId,
    representationKind: row.representationKind,
    encoderVersion: row.encoderVersion,
    sourceFingerprint: row.sourceFingerprint,
    dimensions: row.dimensions,
    featureText: row.featureText,
    vector: parsePaperRepresentationVector(row.vectorJson),
    metadata: parsePaperRepresentationMetadata(row.metadataJson),
  };
}

export async function getPaperRepresentation(
  db: PaperRepresentationDb,
  paperId: string,
  representationKind = SHARED_RAW_PAPER_REPRESENTATION_KIND,
): Promise<PaperRepresentationRecord | null> {
  const row = await db.paperRepresentation.findUnique({
    where: {
      paperId_representationKind: {
        paperId,
        representationKind,
      },
    },
  });

  return row ? toRepresentationRecord(row) : null;
}

async function loadPaperForRepresentation(
  db: PaperRepresentationDb,
  paperId: string,
) {
  return db.paper.findUnique({
    where: { id: paperId },
    select: {
      id: true,
      title: true,
      abstract: true,
      summary: true,
      keyFindings: true,
      authors: true,
      venue: true,
      year: true,
      tags: {
        select: {
          tag: {
            select: {
              name: true,
            },
          },
        },
      },
      claims: {
        orderBy: {
          orderIndex: "asc",
        },
        select: {
          normalizedText: true,
          rhetoricalRole: true,
          facet: true,
          polarity: true,
          sectionPath: true,
          evaluationContext: true,
        },
      },
    },
  });
}

export async function upsertSharedPaperRepresentation(
  paperId: string,
  db: PaperRepresentationDb = prisma,
): Promise<RepresentationUpsertResult> {
  const paper = await loadPaperForRepresentation(db, paperId);
  if (!paper) {
    throw new Error(`Paper not found: ${paperId}`);
  }

  const featureDocument = buildSharedPaperFeatureDocument(paper);
  const vector = encodeFeatureSectionsToVector(featureDocument.sections);
  const sourceFingerprint = computeSourceFingerprint(featureDocument.featureText);
  const current = await getPaperRepresentation(
    db,
    paperId,
    SHARED_RAW_PAPER_REPRESENTATION_KIND,
  );

  if (
    current &&
    current.sourceFingerprint === sourceFingerprint &&
    current.encoderVersion === SHARED_RAW_PAPER_ENCODER_VERSION
  ) {
    return {
      status: "unchanged",
      representation: current,
    };
  }

  const row = await db.paperRepresentation.upsert({
    where: {
      paperId_representationKind: {
        paperId,
        representationKind: SHARED_RAW_PAPER_REPRESENTATION_KIND,
      },
    },
    create: {
      paperId,
      representationKind: SHARED_RAW_PAPER_REPRESENTATION_KIND,
      encoderVersion: SHARED_RAW_PAPER_ENCODER_VERSION,
      sourceFingerprint,
      dimensions: SHARED_RAW_PAPER_VECTOR_DIMENSIONS,
      featureText: featureDocument.featureText,
      vectorJson: serializePaperRepresentationVector(vector),
      metadataJson: serializeMetadata(featureDocument.metadata),
    },
    update: {
      encoderVersion: SHARED_RAW_PAPER_ENCODER_VERSION,
      sourceFingerprint,
      dimensions: SHARED_RAW_PAPER_VECTOR_DIMENSIONS,
      featureText: featureDocument.featureText,
      vectorJson: serializePaperRepresentationVector(vector),
      metadataJson: serializeMetadata(featureDocument.metadata),
    },
  });

  return {
    status: current ? "updated" : "created",
    representation: toRepresentationRecord(row),
  };
}

export async function ensureSharedPaperRepresentations(
  paperIds: string[],
  db: PaperRepresentationDb = prisma,
): Promise<void> {
  for (const paperId of stableUnique(paperIds)) {
    await upsertSharedPaperRepresentation(paperId, db);
  }
}

export async function searchSharedPaperRepresentationsByVector(
  params: {
    userId: string;
    vector: number[];
    limit?: number;
    excludePaperIds?: string[];
  },
  db: PaperRepresentationDb = prisma,
): Promise<PaperRepresentationMatch[]> {
  const rows = await db.paper.findMany({
    where: {
      ...paperVisibilityWhere(params.userId),
      ...(params.excludePaperIds?.length
        ? { id: { notIn: params.excludePaperIds } }
        : {}),
      representations: {
        some: {
          representationKind: SHARED_RAW_PAPER_REPRESENTATION_KIND,
        },
      },
    },
    select: {
      id: true,
      title: true,
      representations: {
        where: {
          representationKind: SHARED_RAW_PAPER_REPRESENTATION_KIND,
        },
        take: 1,
        select: {
          paperId: true,
          representationKind: true,
          encoderVersion: true,
          sourceFingerprint: true,
          dimensions: true,
          featureText: true,
          vectorJson: true,
          metadataJson: true,
        },
      },
    },
  });

  return rows
    .map((paper) => {
      const representation = paper.representations[0];
      if (!representation) return null;
      const parsed = toRepresentationRecord(representation);
      return {
        paperId: paper.id,
        title: paper.title,
        score: cosineSimilarity(params.vector, parsed.vector),
        representationKind: parsed.representationKind,
        encoderVersion: parsed.encoderVersion,
        metadata: parsed.metadata,
      };
    })
    .filter((row): row is PaperRepresentationMatch => Boolean(row))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.paperId.localeCompare(right.paperId);
    })
    .slice(0, params.limit ?? 50);
}

export async function searchSharedPaperRepresentationsByQuery(
  params: {
    userId: string;
    queryText: string;
    limit?: number;
    excludePaperIds?: string[];
  },
  db: PaperRepresentationDb = prisma,
): Promise<PaperRepresentationMatch[]> {
  const vector = encodeTextToVector(params.queryText);
  return searchSharedPaperRepresentationsByVector(
    {
      userId: params.userId,
      vector,
      limit: params.limit,
      excludePaperIds: params.excludePaperIds,
    },
    db,
  );
}

export async function searchSharedPaperRepresentationsByPaper(
  params: {
    userId: string;
    paperId: string;
    limit?: number;
  },
  db: PaperRepresentationDb = prisma,
): Promise<PaperRepresentationMatch[]> {
  await ensureSharedPaperRepresentations([params.paperId], db);
  const representation = await getPaperRepresentation(db, params.paperId);
  if (!representation) return [];

  return searchSharedPaperRepresentationsByVector(
    {
      userId: params.userId,
      vector: representation.vector,
      limit: params.limit,
      excludePaperIds: [params.paperId],
    },
    db,
  );
}

export async function searchSharedPaperRepresentationsByProfile(
  params: {
    userId: string;
    paperIds: string[];
    limit?: number;
  },
  db: PaperRepresentationDb = prisma,
): Promise<PaperRepresentationMatch[]> {
  const paperIds = stableUnique(params.paperIds);
  await ensureSharedPaperRepresentations(paperIds, db);

  const representations = await Promise.all(
    paperIds.map((paperId) => getPaperRepresentation(db, paperId)),
  );
  const vectors = representations
    .filter((representation): representation is PaperRepresentationRecord =>
      Boolean(representation?.vector.length),
    )
    .map((representation) => representation.vector);

  const profileVector = averageVectors(vectors);
  if (profileVector.length === 0) return [];

  return searchSharedPaperRepresentationsByVector(
    {
      userId: params.userId,
      vector: profileVector,
      limit: params.limit,
      excludePaperIds: paperIds,
    },
    db,
  );
}
