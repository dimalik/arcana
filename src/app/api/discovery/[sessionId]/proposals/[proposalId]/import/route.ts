import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchArxivMetadata, downloadArxivPdf } from "@/lib/import/arxiv";
import { processingQueue } from "@/lib/processing/queue";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { fetchDoiMetadata } from "@/lib/import/url";

/**
 * POST /api/discovery/[sessionId]/proposals/[proposalId]/import
 * Import a proposal as a paper into the library.
 */
export async function POST(
  _req: NextRequest,
  {
    params,
  }: { params: Promise<{ sessionId: string; proposalId: string }> }
) {
  const { sessionId, proposalId } = await params;

  const proposal = await prisma.discoveryProposal.findFirst({
    where: { id: proposalId, sessionId },
  });

  if (!proposal) {
    return Response.json({ error: "Proposal not found" }, { status: 404 });
  }

  if (proposal.status === "IMPORTED") {
    return Response.json(
      { error: "Proposal already imported" },
      { status: 409 }
    );
  }

  try {
    let paper;

    if (proposal.arxivId) {
      // ── arXiv path (unchanged) ──────────────────────────────────────
      const existing = await prisma.paper.findFirst({
        where: { arxivId: proposal.arxivId },
      });
      if (existing) {
        await prisma.discoveryProposal.update({
          where: { id: proposalId },
          data: { status: "ALREADY_IN_LIBRARY", importedPaperId: existing.id },
        });
        return Response.json(existing, { status: 200 });
      }

      const metadata = await fetchArxivMetadata(proposal.arxivId);

      let filePath: string | undefined;
      try {
        filePath = await downloadArxivPdf(proposal.arxivId);
      } catch (e) {
        console.error("ArXiv PDF download failed:", e);
      }

      paper = await prisma.paper.create({
        data: {
          title: metadata.title,
          abstract: metadata.abstract,
          authors: JSON.stringify(metadata.authors),
          year: metadata.year,
          sourceType: "ARXIV",
          sourceUrl: `https://arxiv.org/abs/${proposal.arxivId}`,
          arxivId: proposal.arxivId,
          filePath,
          categories: JSON.stringify(metadata.categories),
          processingStatus: "EXTRACTING_TEXT",
        },
      });

      processingQueue.enqueue(paper.id);
    } else {
      // ── Non-arXiv: aggressive PDF search + metadata fetch ───────────

      // 1. Try to find a PDF from multiple sources
      const pdfResult = await findAndDownloadPdf({
        doi: proposal.doi,
        arxivId: null,
        existingPdfUrl: proposal.openAccessPdfUrl,
      });

      // 2. Fetch abstract/metadata via DOI APIs (OpenAlex → CrossRef)
      let abstract: string | null = null;
      if (proposal.doi) {
        const doiMeta = await fetchDoiMetadata(proposal.doi);
        if (doiMeta?.abstract) {
          abstract = doiMeta.abstract;
        }
      }

      // 3. Determine processing status:
      //    - Has PDF → EXTRACTING_TEXT (queue will extract text then run LLM)
      //    - No PDF but has abstract → TEXT_EXTRACTED (queue will run LLM from abstract)
      //    - Neither → PENDING (needs manual PDF upload)
      const hasContent = !!pdfResult?.filePath || !!abstract;
      const processingStatus = pdfResult?.filePath
        ? "EXTRACTING_TEXT"
        : abstract
          ? "TEXT_EXTRACTED"
          : "PENDING";

      paper = await prisma.paper.create({
        data: {
          title: proposal.title,
          authors: proposal.authors,
          year: proposal.year,
          venue: proposal.venue,
          doi: proposal.doi,
          sourceType: "URL",
          sourceUrl:
            proposal.externalUrl ||
            (proposal.doi ? `https://doi.org/${proposal.doi}` : undefined),
          filePath: pdfResult?.filePath,
          abstract,
          processingStatus,
        },
      });

      // Always enqueue if we have something to process
      if (hasContent) {
        processingQueue.enqueue(paper.id);
      }
    }

    // Mark proposal as imported
    await prisma.discoveryProposal.update({
      where: { id: proposalId },
      data: { status: "IMPORTED", importedPaperId: paper.id },
    });

    return Response.json(paper, { status: 201 });
  } catch (err) {
    console.error("Import failed:", err);
    return Response.json(
      { error: "Failed to import proposal" },
      { status: 500 }
    );
  }
}
