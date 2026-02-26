import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchArxivMetadata, downloadArxivPdf } from "@/lib/import/arxiv";
import { processingQueue } from "@/lib/processing/queue";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

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
      // Check if already in library by arXiv ID
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
    } else if (proposal.openAccessPdfUrl) {
      // Try to download open access PDF
      let filePath: string | undefined;
      try {
        const pdfRes = await fetch(proposal.openAccessPdfUrl);
        const contentType = pdfRes.headers.get("content-type") || "";
        if (pdfRes.ok && contentType.includes("pdf")) {
          const uploadDir = path.join(process.cwd(), "uploads");
          await mkdir(uploadDir, { recursive: true });
          const buffer = Buffer.from(await pdfRes.arrayBuffer());
          const filename = `discovery-${uuidv4().slice(0, 8)}.pdf`;
          const fullPath = path.join(uploadDir, filename);
          await writeFile(fullPath, buffer);
          filePath = `uploads/${filename}`;
        }
      } catch {
        // PDF download failed
      }

      paper = await prisma.paper.create({
        data: {
          title: proposal.title,
          authors: proposal.authors,
          year: proposal.year,
          venue: proposal.venue,
          doi: proposal.doi,
          sourceType: "URL",
          sourceUrl: proposal.externalUrl || undefined,
          filePath,
          processingStatus: filePath ? "EXTRACTING_TEXT" : "PENDING",
        },
      });

      if (filePath) {
        processingQueue.enqueue(paper.id);
      }
    } else {
      // Create minimal paper record
      paper = await prisma.paper.create({
        data: {
          title: proposal.title,
          authors: proposal.authors,
          year: proposal.year,
          venue: proposal.venue,
          doi: proposal.doi,
          sourceType: "URL",
          sourceUrl: proposal.externalUrl || (proposal.doi ? `https://doi.org/${proposal.doi}` : undefined),
          processingStatus: "PENDING",
        },
      });
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
