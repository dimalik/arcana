import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchArxivMetadata, downloadArxivPdf } from "@/lib/import/arxiv";
import { processingQueue } from "@/lib/processing/queue";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { fetchDoiMetadata } from "@/lib/import/url";
import { requireUserId } from "@/lib/paper-auth";
import {
  createPaperWithAuthorIndex,
  serializePaperAuthors,
} from "@/lib/papers/authors";
import { handleDuplicatePaperError, resolveEntityForImport } from "@/lib/canonical/import-dedup";

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
  const userId = await requireUserId();
  const { sessionId, proposalId } = await params;

  // Verify session belongs to user
  const session = await prisma.discoverySession.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

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
      const metadata = await fetchArxivMetadata(proposal.arxivId);
      const resolved = await resolveEntityForImport({
        userId,
        title: metadata.title,
        arxivId: proposal.arxivId,
      });

      if (resolved.existingPaper) {
        await prisma.discoveryProposal.update({
          where: { id: proposalId },
          data: { status: "ALREADY_IN_LIBRARY", importedPaperId: resolved.existingPaper.id },
        });
        return Response.json(resolved.existingPaper, { status: 200 });
      }

      let filePath: string | undefined;
      try {
        filePath = await downloadArxivPdf(proposal.arxivId);
      } catch (e) {
        console.error("ArXiv PDF download failed:", e);
      }

      try {
        paper = await createPaperWithAuthorIndex({
          data: {
            title: metadata.title,
            userId,
            abstract: metadata.abstract,
            authors: serializePaperAuthors(metadata.authors),
            year: metadata.year,
            sourceType: "ARXIV",
            sourceUrl: `https://arxiv.org/abs/${proposal.arxivId}`,
            arxivId: proposal.arxivId,
            filePath,
            categories: JSON.stringify(metadata.categories),
            processingStatus: "EXTRACTING_TEXT",
            entityId: resolved.entityId,
          },
        });
      } catch (error) {
        const existing = await handleDuplicatePaperError(error, userId, resolved.entityId);
        if (existing) {
          await prisma.discoveryProposal.update({
            where: { id: proposalId },
            data: { status: "ALREADY_IN_LIBRARY", importedPaperId: existing.id },
          });
          return Response.json(existing, { status: 200 });
        }
        throw error;
      }

      processingQueue.enqueue(paper.id);
    } else {
      // ── Non-arXiv: aggressive PDF search + metadata fetch ───────────
      const resolved = await resolveEntityForImport({
        userId,
        title: proposal.title,
        doi: proposal.doi,
        arxivId: proposal.arxivId,
        semanticScholarId: proposal.semanticScholarId,
      });

      if (resolved.existingPaper) {
        await prisma.discoveryProposal.update({
          where: { id: proposalId },
          data: { status: "ALREADY_IN_LIBRARY", importedPaperId: resolved.existingPaper.id },
        });
        return Response.json(resolved.existingPaper, { status: 200 });
      }

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

      try {
        paper = await createPaperWithAuthorIndex({
          data: {
            title: proposal.title,
            userId,
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
            entityId: resolved.entityId,
          },
        });
      } catch (error) {
        const existing = await handleDuplicatePaperError(error, userId, resolved.entityId);
        if (existing) {
          await prisma.discoveryProposal.update({
            where: { id: proposalId },
            data: { status: "ALREADY_IN_LIBRARY", importedPaperId: existing.id },
          });
          return Response.json(existing, { status: 200 });
        }
        throw error;
      }

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
