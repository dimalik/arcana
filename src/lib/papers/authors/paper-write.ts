import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

import { syncPaperAuthorIndex } from "./store";

function extractAuthorsField(
  data:
    | Prisma.PaperCreateInput
    | Prisma.PaperUncheckedCreateInput
    | Prisma.PaperUpdateInput
    | Prisma.PaperUncheckedUpdateInput,
): string | string[] | null | undefined {
  const authors = (data as { authors?: unknown }).authors;
  if (
    authors == null
    || typeof authors === "string"
    || Array.isArray(authors)
  ) {
    return authors ?? null;
  }
  return undefined;
}

export async function createPaperWithAuthorIndex<T extends Prisma.PaperCreateArgs>(
  args: Prisma.SelectSubset<T, Prisma.PaperCreateArgs>,
): Promise<Prisma.PaperGetPayload<T>> {
  const authors = extractAuthorsField(args.data);

  return prisma.$transaction(async (tx) => {
    const paper = await tx.paper.create(args as Prisma.PaperCreateArgs);
    await syncPaperAuthorIndex(paper.id, authors, tx);
    return paper as Prisma.PaperGetPayload<T>;
  });
}

export async function updatePaperWithAuthorIndex<T extends Prisma.PaperUpdateArgs>(
  args: Prisma.SelectSubset<T, Prisma.PaperUpdateArgs>,
): Promise<Prisma.PaperGetPayload<T>> {
  const authors = extractAuthorsField(args.data);

  return prisma.$transaction(async (tx) => {
    const paper = await tx.paper.update(args as Prisma.PaperUpdateArgs);
    if (authors !== undefined) {
      await syncPaperAuthorIndex(paper.id, authors, tx);
    }
    return paper as Prisma.PaperGetPayload<T>;
  });
}
