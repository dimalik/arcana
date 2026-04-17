import { prisma } from "../prisma";
import { normalizeIdentifier, type IdentifierType } from "./normalize";

const SOURCE_PRIORITY: Record<string, number> = {
  graph_auto_heal: -1,
  llm_extraction: 0,
  import: 1,
  enrichment: 1,
  semantic_scholar: 2,
  discovery: 2,
  openalex: 3,
  crossref: 4,
  doi_registry: 5,
};

export interface IdentifierInput {
  type: IdentifierType;
  value: string;
  source: string;
  confidence?: number;
}

export interface ResolveOrCreateInput {
  title: string;
  authors?: string | null;
  year?: number | null;
  venue?: string | null;
  abstract?: string | null;
  identifiers: IdentifierInput[];
  source: string;
}

export interface ResolveOrCreateResult {
  entityId: string;
  created: boolean;
}

type EntityServiceDb = Pick<
  typeof prisma,
  "paperIdentifier" | "paperEntity" | "paperEntityCandidateLink"
>;

const IDENTIFIER_PRIORITY: Record<string, number> = {
  doi: 0,
  arxiv: 1,
  semantic_scholar: 2,
  openalex: 3,
  pmid: 4,
  openreview: 5,
};

export async function resolveOrCreateEntity(
  input: ResolveOrCreateInput,
  db: EntityServiceDb = prisma
): Promise<ResolveOrCreateResult> {
  const normalized = input.identifiers
    .map((id) => ({
      ...id,
      raw: id.value,
      value: normalizeIdentifier(id.type, id.value),
    }))
    .sort((a, b) => (IDENTIFIER_PRIORITY[a.type] ?? 99) - (IDENTIFIER_PRIORITY[b.type] ?? 99));

  let resolvedEntityId: string | null = null;
  let matchedIdentifierIndex = -1;

  for (let i = 0; i < normalized.length; i++) {
    const id = normalized[i];
    const existing = await db.paperIdentifier.findUnique({
      where: { type_value: { type: id.type, value: id.value } },
      include: { entity: true },
    });
    if (existing) {
      resolvedEntityId = await followMergeChain(existing.entity.id, db);
      matchedIdentifierIndex = i;
      break;
    }
  }

  if (resolvedEntityId) {
    for (let i = 0; i < normalized.length; i++) {
      if (i === matchedIdentifierIndex) continue;
      const id = normalized[i];
      try {
        await db.paperIdentifier.create({
          data: {
            entityId: resolvedEntityId,
            type: id.type,
            value: id.value,
            raw: id.raw,
            source: id.source,
            confidence: id.confidence ?? 1.0,
          },
        });
      } catch {
        const conflicting = await db.paperIdentifier.findUnique({
          where: { type_value: { type: id.type, value: id.value } },
        });
        if (conflicting && conflicting.entityId !== resolvedEntityId) {
          await createCandidateLink(
            resolvedEntityId,
            conflicting.entityId,
            "identifier_conflict",
            id.confidence ?? 0.8,
            db
          );
        }
      }
    }

    await updateEntityMetadata(
      resolvedEntityId,
      {
        title: input.title,
        authors: input.authors,
        year: input.year,
        venue: input.venue,
        abstract: input.abstract,
      },
      input.source,
      db
    );

    return { entityId: resolvedEntityId, created: false };
  }

  const entity = await db.paperEntity.create({
    data: {
      title: input.title,
      authors: input.authors,
      year: input.year,
      venue: input.venue,
      abstract: input.abstract,
      titleSource: input.source,
      authorsSource: input.authors ? input.source : null,
      yearSource: input.year ? input.source : null,
      venueSource: input.venue ? input.source : null,
    },
  });

  let raceConflictEntityId: string | null = null;

  for (const id of normalized) {
    try {
      await db.paperIdentifier.create({
        data: {
          entityId: entity.id,
          type: id.type,
          value: id.value,
          raw: id.raw,
          source: id.source,
          confidence: id.confidence ?? 1.0,
        },
      });
    } catch {
      const conflicting = await db.paperIdentifier.findUnique({
        where: { type_value: { type: id.type, value: id.value } },
      });
      if (conflicting && conflicting.entityId !== entity.id) {
        if (id.type === "doi" || id.type === "arxiv") {
          raceConflictEntityId = await followMergeChain(conflicting.entityId, db);
        } else {
          await createCandidateLink(
            entity.id,
            conflicting.entityId,
            "identifier_conflict",
            id.confidence ?? 0.8,
            db
          );
        }
      }
    }
  }

  if (raceConflictEntityId) {
    const orphanIdentifiers = await db.paperIdentifier.findMany({
      where: { entityId: entity.id },
    });

    for (const ident of orphanIdentifiers) {
      try {
        await db.paperIdentifier.update({
          where: { id: ident.id },
          data: { entityId: raceConflictEntityId },
        });
      } catch {
        await db.paperIdentifier.delete({ where: { id: ident.id } }).catch(() => {});
      }
    }

    await db.paperEntity.delete({ where: { id: entity.id } }).catch(() => {});
    return { entityId: raceConflictEntityId, created: false };
  }

  return { entityId: entity.id, created: true };
}

async function followMergeChain(
  entityId: string,
  db: Pick<typeof prisma, "paperEntity"> = prisma
): Promise<string> {
  let currentId = entityId;
  for (let depth = 0; depth < 10; depth++) {
    const entity = await db.paperEntity.findUnique({
      where: { id: currentId },
      select: { id: true, mergedIntoEntityId: true },
    });
    if (!entity || !entity.mergedIntoEntityId) {
      return currentId;
    }
    currentId = entity.mergedIntoEntityId;
  }
  return currentId;
}

export async function updateEntityMetadata(
  entityId: string,
  metadata: {
    title?: string;
    authors?: string | null;
    year?: number | null;
    venue?: string | null;
    abstract?: string | null;
  },
  source: string,
  db: Pick<typeof prisma, "paperEntity"> = prisma
): Promise<void> {
  const entity = await db.paperEntity.findUnique({ where: { id: entityId } });
  if (!entity) return;

  const newPriority = SOURCE_PRIORITY[source] ?? 0;
  const updates: Record<string, unknown> = {};

  if (metadata.title && newPriority >= (SOURCE_PRIORITY[entity.titleSource ?? ""] ?? -1)) {
    updates.title = metadata.title;
    updates.titleSource = source;
  }
  if (metadata.authors && newPriority >= (SOURCE_PRIORITY[entity.authorsSource ?? ""] ?? -1)) {
    updates.authors = metadata.authors;
    updates.authorsSource = source;
  }
  if (metadata.year && newPriority >= (SOURCE_PRIORITY[entity.yearSource ?? ""] ?? -1)) {
    updates.year = metadata.year;
    updates.yearSource = source;
  }
  if (metadata.venue && newPriority >= (SOURCE_PRIORITY[entity.venueSource ?? ""] ?? -1)) {
    updates.venue = metadata.venue;
    updates.venueSource = source;
  }
  if (metadata.abstract && !entity.abstract) {
    updates.abstract = metadata.abstract;
  }

  if (Object.keys(updates).length > 0) {
    await db.paperEntity.update({
      where: { id: entityId },
      data: updates,
    });
  }
}

export async function createCandidateLink(
  entityAId: string,
  entityBId: string,
  reason: string,
  confidence: number,
  db: Pick<typeof prisma, "paperEntityCandidateLink"> = prisma
): Promise<void> {
  const [orderedA, orderedB] =
    entityAId < entityBId ? [entityAId, entityBId] : [entityBId, entityAId];

  await db.paperEntityCandidateLink.create({
    data: {
      entityAId: orderedA,
      entityBId: orderedB,
      reason,
      confidence,
    },
  }).catch(() => {});
}

export function collectIdentifiers(
  record: {
    doi?: string | null;
    arxivId?: string | null;
    semanticScholarId?: string | null;
  },
  source: string
): IdentifierInput[] {
  const ids: IdentifierInput[] = [];
  if (record.doi) ids.push({ type: "doi", value: record.doi, source });
  if (record.arxivId) ids.push({ type: "arxiv", value: record.arxivId, source });
  if (record.semanticScholarId) {
    ids.push({ type: "semantic_scholar", value: record.semanticScholarId, source });
  }
  return ids;
}
