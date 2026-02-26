import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchByTitle, S2RateLimitError } from "@/lib/import/semantic-scholar";
import { findLibraryMatchByIds } from "@/lib/references/match";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; refId: string }> }
) {
  const { id, refId } = await params;

  const reference = await prisma.reference.findFirst({
    where: { id: refId, paperId: id },
  });

  if (!reference) {
    return Response.json({ error: "Reference not found" }, { status: 404 });
  }

  try {
    const result = await searchByTitle(reference.title, reference.year);

    if (!result) {
      return Response.json(
        { error: "No match found" },
        { status: 404 }
      );
    }

    // Re-check library match with enriched data
    const libraryPapers = await prisma.paper.findMany({
      select: { id: true, title: true, doi: true, arxivId: true },
    });

    const libraryMatch = findLibraryMatchByIds(
      {
        doi: result.doi,
        arxivId: result.arxivId,
        title: reference.title,
      },
      libraryPapers
    );

    const updated = await prisma.reference.update({
      where: { id: refId },
      data: {
        semanticScholarId: result.semanticScholarId,
        arxivId: result.arxivId,
        externalUrl: result.externalUrl,
        authors: reference.authors || JSON.stringify(result.authors),
        year: reference.year ?? result.year,
        venue: reference.venue || result.venue,
        doi: reference.doi || result.doi,
        ...(libraryMatch && {
          matchedPaperId: libraryMatch.paperId,
          matchConfidence: libraryMatch.confidence,
        }),
      },
      include: {
        matchedPaper: {
          select: { id: true, title: true, year: true, authors: true },
        },
      },
    });

    return Response.json({
      reference: updated,
      externalLinks: {
        openAlex: result.semanticScholarId,
        doi: result.doi ? `https://doi.org/${result.doi}` : null,
        arxiv: result.arxivId
          ? `https://arxiv.org/abs/${result.arxivId}`
          : null,
      },
    });
  } catch (err) {
    if (err instanceof S2RateLimitError) {
      return Response.json(
        { error: "Rate limit exceeded. Try again in a minute." },
        { status: 429 }
      );
    }
    console.error("Lookup failed:", err);
    return Response.json({ error: "Lookup failed" }, { status: 500 });
  }
}
