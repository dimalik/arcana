import { prisma } from "../prisma";
import { normalizeTitle } from "../references/match";
import { collectIdentifiers, resolveOrCreateEntity } from "./entity-service";

export type ExistingPaperRef = {
  id: string;
  title: string;
  year: number | null;
  authors: string | null;
};

const EXISTING_PAPER_SELECT = {
  id: true,
  title: true,
  year: true,
  authors: true,
} as const;

export async function resolveEntityForImport(input: {
  userId: string;
  title: string;
  authors?: string | null;
  year?: number | null;
  venue?: string | null;
  abstract?: string | null;
  doi?: string | null;
  arxivId?: string | null;
  semanticScholarId?: string | null;
}): Promise<{
  entityId: string | null;
  existingPaper: ExistingPaperRef | null;
}> {
  const identifiers = collectIdentifiers(input, "import");

  if (identifiers.length > 0) {
    const result = await resolveOrCreateEntity({
      title: input.title,
      authors: input.authors,
      year: input.year,
      venue: input.venue,
      abstract: input.abstract,
      identifiers,
      source: "import",
    });

    const existing = await prisma.paper.findFirst({
      where: { userId: input.userId, entityId: result.entityId },
      select: EXISTING_PAPER_SELECT,
    });

    if (existing) {
      return { entityId: result.entityId, existingPaper: existing };
    }

    return { entityId: result.entityId, existingPaper: null };
  }

  if (input.title) {
    const normalized = normalizeTitle(input.title);
    if (normalized.length > 10) {
      const candidates = await prisma.paper.findMany({
        where: { userId: input.userId },
        select: EXISTING_PAPER_SELECT,
      });
      const match = candidates.find((paper) => normalizeTitle(paper.title) === normalized);
      if (match) {
        return { entityId: null, existingPaper: match };
      }
    }
  }

  return { entityId: null, existingPaper: null };
}

export async function handleDuplicatePaperError(
  error: unknown,
  userId: string,
  entityId: string | null
): Promise<ExistingPaperRef | null> {
  if (!entityId) return null;

  const isPrismaUniqueError =
    error instanceof Error &&
    "code" in error &&
    (error as { code: string }).code === "P2002";

  if (!isPrismaUniqueError) return null;

  return prisma.paper.findFirst({
    where: { userId, entityId },
    select: EXISTING_PAPER_SELECT,
  });
}
