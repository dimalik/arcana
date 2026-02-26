import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Paper } from "@/generated/prisma/client";
import {
  fetchArxivMetadata,
  downloadArxivPdf,
} from "@/lib/import/arxiv";
import { processingQueue } from "@/lib/processing/queue";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const { referenceId } = body;

  if (!referenceId) {
    return Response.json(
      { error: "referenceId is required" },
      { status: 400 }
    );
  }

  const reference = await prisma.reference.findFirst({
    where: { id: referenceId, paperId: id },
  });

  if (!reference) {
    return Response.json({ error: "Reference not found" }, { status: 404 });
  }

  if (reference.matchedPaperId) {
    return Response.json(
      { error: "Reference already linked to a library paper" },
      { status: 409 }
    );
  }

  let authors: string[] = [];
  try {
    if (reference.authors) authors = JSON.parse(reference.authors);
  } catch {
    // ignore
  }

  try {
    let paper: Paper;

    if (reference.arxivId) {
      // Import from arXiv
      const existing = await prisma.paper.findFirst({
        where: { arxivId: reference.arxivId },
      });
      if (existing) {
        // Already in library — just link it
        await prisma.reference.update({
          where: { id: referenceId },
          data: { matchedPaperId: existing.id, matchConfidence: 1.0 },
        });
        return Response.json(existing, { status: 200 });
      }

      const metadata = await fetchArxivMetadata(reference.arxivId);

      // Download PDF synchronously
      let filePath: string | undefined;
      try {
        filePath = await downloadArxivPdf(reference.arxivId);
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
          sourceUrl: `https://arxiv.org/abs/${reference.arxivId}`,
          arxivId: reference.arxivId,
          filePath,
          categories: JSON.stringify(metadata.categories),
          processingStatus: "EXTRACTING_TEXT",
        },
      });

      // Queue handles: PDF text extraction → LLM pipeline
      processingQueue.enqueue(paper.id);
    } else if (reference.externalUrl) {
      // Try to download open access PDF
      let filePath: string | undefined;
      try {
        const pdfRes = await fetch(reference.externalUrl);
        const contentType = pdfRes.headers.get("content-type") || "";
        if (pdfRes.ok && contentType.includes("pdf")) {
          const uploadDir = path.join(process.cwd(), "uploads");
          await mkdir(uploadDir, { recursive: true });
          const buffer = Buffer.from(await pdfRes.arrayBuffer());
          const filename = `import-${uuidv4().slice(0, 8)}.pdf`;
          const fullPath = path.join(uploadDir, filename);
          await writeFile(fullPath, buffer);
          filePath = `uploads/${filename}`;
        }
      } catch {
        // PDF download failed, create without file
      }

      paper = await prisma.paper.create({
        data: {
          title: reference.title,
          authors: reference.authors || JSON.stringify(authors),
          year: reference.year,
          venue: reference.venue,
          doi: reference.doi,
          sourceType: "URL",
          sourceUrl: reference.externalUrl,
          filePath,
          processingStatus: filePath ? "EXTRACTING_TEXT" : "PENDING",
        },
      });

      // Queue handles: PDF text extraction → LLM pipeline (if we have a file)
      if (filePath) {
        processingQueue.enqueue(paper.id);
      }
    } else {
      // Create minimal paper record from reference metadata
      paper = await prisma.paper.create({
        data: {
          title: reference.title,
          authors: reference.authors || JSON.stringify(authors),
          year: reference.year,
          venue: reference.venue,
          doi: reference.doi,
          sourceType: "URL",
          sourceUrl: reference.doi
            ? `https://doi.org/${reference.doi}`
            : undefined,
          processingStatus: "PENDING",
        },
      });
    }

    // Link reference to the new paper
    await prisma.reference.update({
      where: { id: referenceId },
      data: { matchedPaperId: paper.id, matchConfidence: 1.0 },
    });

    return Response.json(paper, { status: 201 });
  } catch (err) {
    console.error("Import failed:", err);
    return Response.json(
      { error: "Failed to import reference" },
      { status: 500 }
    );
  }
}
