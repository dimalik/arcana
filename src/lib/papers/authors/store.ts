import { prisma } from "@/lib/prisma";

import {
  authorBucketKey,
  canonicalizeAuthorName,
  parsePaperAuthorsJson,
} from "./normalize";

type AuthorStoreDb = Pick<typeof prisma, "author" | "paperAuthor">;

export interface UpsertAuthorInput {
  rawName: string;
  orcid?: string | null;
  semanticScholarAuthorId?: string | null;
}

export interface SyncedPaperAuthor {
  authorId: string;
  orderIndex: number;
  rawName: string;
  normalizedName: string;
}

function chooseCanonicalName(
  existingName: string,
  candidateName: string,
): string {
  if (!existingName) return candidateName;
  if (!candidateName) return existingName;
  return candidateName.length > existingName.length ? candidateName : existingName;
}

export async function upsertAuthorByNormalizedName(
  input: UpsertAuthorInput,
  db: AuthorStoreDb = prisma,
) {
  const canonicalName = canonicalizeAuthorName(input.rawName);
  const normalizedName = authorBucketKey(canonicalName);
  if (!canonicalName || !normalizedName) {
    throw new Error("Cannot upsert author without a normalized name");
  }

  const existing = await db.author.findUnique({
    where: { normalizedName },
  });

  if (!existing) {
    return db.author.create({
      data: {
        canonicalName,
        normalizedName,
        orcid: input.orcid ?? null,
        semanticScholarAuthorId: input.semanticScholarAuthorId ?? null,
      },
    });
  }

  if (
    input.orcid
    && existing.orcid
    && existing.orcid !== input.orcid
  ) {
    throw new Error(
      `Author normalized-name collision for "${normalizedName}" with conflicting ORCID values`,
    );
  }

  if (
    input.semanticScholarAuthorId
    && existing.semanticScholarAuthorId
    && existing.semanticScholarAuthorId !== input.semanticScholarAuthorId
  ) {
    throw new Error(
      `Author normalized-name collision for "${normalizedName}" with conflicting Semantic Scholar ids`,
    );
  }

  return db.author.update({
    where: { id: existing.id },
    data: {
      canonicalName: chooseCanonicalName(existing.canonicalName, canonicalName),
      orcid: existing.orcid ?? input.orcid ?? null,
      semanticScholarAuthorId:
        existing.semanticScholarAuthorId ?? input.semanticScholarAuthorId ?? null,
    },
  });
}

export async function syncPaperAuthorIndex(
  paperId: string,
  authors: string[] | string | null | undefined,
  db: AuthorStoreDb = prisma,
): Promise<SyncedPaperAuthor[]> {
  const rawAuthors = Array.isArray(authors)
    ? authors
    : parsePaperAuthorsJson(authors);

  const dedupedAuthors: Array<{ rawName: string; normalizedName: string }> = [];
  const seen = new Set<string>();

  for (const rawName of rawAuthors) {
    const canonicalName = canonicalizeAuthorName(rawName);
    const normalizedName = authorBucketKey(canonicalName);
    if (!canonicalName || !normalizedName || seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    dedupedAuthors.push({ rawName: canonicalName, normalizedName });
  }

  if (dedupedAuthors.length === 0) {
    await db.paperAuthor.deleteMany({ where: { paperId } });
    return [];
  }

  const synced: SyncedPaperAuthor[] = [];
  for (let index = 0; index < dedupedAuthors.length; index += 1) {
    const author = dedupedAuthors[index];
    const row = await upsertAuthorByNormalizedName({ rawName: author.rawName }, db);
    await db.paperAuthor.upsert({
      where: {
        paperId_authorId: {
          paperId,
          authorId: row.id,
        },
      },
      create: {
        paperId,
        authorId: row.id,
        orderIndex: index,
        rawName: author.rawName,
      },
      update: {
        orderIndex: index,
        rawName: author.rawName,
      },
    });
    synced.push({
      authorId: row.id,
      orderIndex: index,
      rawName: author.rawName,
      normalizedName: author.normalizedName,
    });
  }

  await db.paperAuthor.deleteMany({
    where: {
      paperId,
      authorId: {
        notIn: synced.map((entry) => entry.authorId),
      },
    },
  });

  return synced;
}
