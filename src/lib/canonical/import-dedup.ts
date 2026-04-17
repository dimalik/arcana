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

const HYDRATION_PAPER_SELECT = {
  id: true,
  userId: true,
  title: true,
  abstract: true,
  authors: true,
  year: true,
  venue: true,
  doi: true,
  arxivId: true,
  entityId: true,
} as const;

export interface PaperEntityHydrationInspection {
  paperId: string;
  title: string;
  entityId: string | null;
  canHydrate: boolean;
  identifierTypes: string[];
}

export interface PaperEntityHydrationResult extends PaperEntityHydrationInspection {
  status: "already_linked" | "hydrated" | "no_identifiers" | "duplicate_conflict";
}

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

export async function inspectPaperEntityHydration(
  paperId: string
): Promise<PaperEntityHydrationInspection | null> {
  const paper = await prisma.paper.findUnique({
    where: { id: paperId },
    select: HYDRATION_PAPER_SELECT,
  });
  if (!paper) return null;

  const identifiers = collectIdentifiers(paper, "import");
  return {
    paperId: paper.id,
    title: paper.title,
    entityId: paper.entityId,
    canHydrate: identifiers.length > 0,
    identifierTypes: identifiers.map((identifier) => identifier.type),
  };
}

export async function hydratePaperEntityIfPossible(
  paperId: string
): Promise<PaperEntityHydrationResult | null> {
  const paper = await prisma.paper.findUnique({
    where: { id: paperId },
    select: HYDRATION_PAPER_SELECT,
  });
  if (!paper) return null;

  const identifiers = collectIdentifiers(paper, "import");
  if (paper.entityId) {
    return {
      paperId: paper.id,
      title: paper.title,
      entityId: paper.entityId,
      canHydrate: true,
      identifierTypes: identifiers.map((identifier) => identifier.type),
      status: "already_linked",
    };
  }

  if (identifiers.length === 0) {
    return {
      paperId: paper.id,
      title: paper.title,
      entityId: null,
      canHydrate: false,
      identifierTypes: [],
      status: "no_identifiers",
    };
  }

  const result = await resolveOrCreateEntity({
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    abstract: paper.abstract,
    identifiers,
    source: "import",
  });

  if (paper.userId) {
    const duplicate = await prisma.paper.findFirst({
      where: {
        userId: paper.userId,
        entityId: result.entityId,
        NOT: { id: paper.id },
      },
      select: { id: true },
    });
    if (duplicate) {
      return {
        paperId: paper.id,
        title: paper.title,
        entityId: null,
        canHydrate: true,
        identifierTypes: identifiers.map((identifier) => identifier.type),
        status: "duplicate_conflict",
      };
    }
  }

  await prisma.paper.update({
    where: { id: paper.id },
    data: { entityId: result.entityId },
  });

  return {
    paperId: paper.id,
    title: paper.title,
    entityId: result.entityId,
    canHydrate: true,
    identifierTypes: identifiers.map((identifier) => identifier.type),
    status: "hydrated",
  };
}
