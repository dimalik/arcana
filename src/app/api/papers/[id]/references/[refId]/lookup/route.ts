import { NextRequest } from "next/server";
import { searchByTitle, S2RateLimitError } from "@/lib/import/semantic-scholar";
import { requirePaperAccess } from "@/lib/paper-auth";
import { enrichReferenceEntryFromCandidate, findReferenceEntryForPaper } from "@/lib/citations/reference-entry-service";
import { getPaperReferenceViewById } from "@/lib/references/read-model";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; refId: string }> }
) {
  const { id, refId } = await params;
  const paper = await requirePaperAccess(id);
  if (!paper) {
    return Response.json({ error: "Paper not found" }, { status: 404 });
  }

  const reference = await findReferenceEntryForPaper(id, refId);

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

    const updated = await enrichReferenceEntryFromCandidate({
      paperId: id,
      referenceId: refId,
      userId: paper.userId,
      candidate: result,
    });
    if (!updated) {
      return Response.json({ error: "Reference not found" }, { status: 404 });
    }

    const view = await getPaperReferenceViewById(id, paper.userId, updated.referenceEntryId);
    if (!view) {
      return Response.json({ error: "Reference not found" }, { status: 404 });
    }

    return Response.json({
      reference: view,
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
