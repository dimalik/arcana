import "server-only";

import { prisma } from "@/lib/prisma";
import { paperVisibilityWhere } from "@/lib/papers/visibility";

type AuthorLibraryDb = Pick<typeof prisma, "author" | "paperAuthor">;

export interface AuthorLibraryPaper {
  id: string;
  title: string;
  abstract: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  sourceUrl: string | null;
  citationCount: number | null;
  createdAt: string;
}

export interface AuthorLibraryView {
  author: {
    id: string;
    name: string;
    normalizedName: string;
    orcid: string | null;
    semanticScholarAuthorId: string | null;
  };
  paperCount: number;
  papers: AuthorLibraryPaper[];
}

export async function getAuthorLibraryView(
  params: {
    authorId: string;
    userId: string;
    includeResearchOnly?: boolean;
  },
  db: AuthorLibraryDb = prisma,
): Promise<AuthorLibraryView | null> {
  const author = await db.author.findUnique({
    where: { id: params.authorId },
    select: {
      id: true,
      canonicalName: true,
      normalizedName: true,
      orcid: true,
      semanticScholarAuthorId: true,
    },
  });

  if (!author) return null;

  const visibilityWhere = params.includeResearchOnly
    ? paperVisibilityWhere(params.userId)
    : {
        AND: [
          paperVisibilityWhere(params.userId),
          {
            isResearchOnly: false,
          },
        ],
      };

  const rows = await db.paperAuthor.findMany({
    where: {
      authorId: params.authorId,
      paper: visibilityWhere,
    },
    select: {
      paper: {
        select: {
          id: true,
          title: true,
          abstract: true,
          authors: true,
          year: true,
          venue: true,
          doi: true,
          sourceUrl: true,
          citationCount: true,
          createdAt: true,
        },
      },
    },
  });

  const papers = rows
    .map((row) => ({
      ...row.paper,
      createdAt: row.paper.createdAt.toISOString(),
    }))
    .sort((left, right) => {
      const leftCitationCount = left.citationCount ?? 0;
      const rightCitationCount = right.citationCount ?? 0;
      if (rightCitationCount !== leftCitationCount) {
        return rightCitationCount - leftCitationCount;
      }
      const leftYear = left.year ?? 0;
      const rightYear = right.year ?? 0;
      if (rightYear !== leftYear) {
        return rightYear - leftYear;
      }
      return right.createdAt.localeCompare(left.createdAt);
    });

  return {
    author: {
      id: author.id,
      name: author.canonicalName,
      normalizedName: author.normalizedName,
      orcid: author.orcid,
      semanticScholarAuthorId: author.semanticScholarAuthorId,
    },
    paperCount: papers.length,
    papers,
  };
}
