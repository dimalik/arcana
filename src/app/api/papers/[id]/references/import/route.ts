import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Paper } from "@/generated/prisma/client";
import {
  fetchArxivMetadata,
  downloadArxivPdf,
} from "@/lib/import/arxiv";
import { processingQueue } from "@/lib/processing/queue";
import {
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { handleDuplicatePaperError, resolveEntityForImport } from "@/lib/canonical/import-dedup";
import {
  findReferenceEntryForPaper,
  projectReferenceEntryImportLink,
} from "@/lib/citations/reference-entry-service";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, { mode: "mutate" });
    if (!access) {
      return Response.json({ error: "Paper not found" }, { status: 404 });
    }
    const userId = access.userId;
    const body = await req.json();
    const { referenceId } = body;

    if (!referenceId) {
      return Response.json(
        { error: "referenceId is required" },
        { status: 400 }
      );
    }

    const reference = await findReferenceEntryForPaper(id, referenceId);

    if (!reference) {
      return Response.json({ error: "Reference not found" }, { status: 404 });
    }

    if (reference.resolvedEntityId) {
      const linkedPaper = await prisma.paper.findFirst({
        where: {
          userId,
          entityId: reference.resolvedEntityId,
        },
        select: {
          id: true,
          title: true,
          year: true,
          authors: true,
        },
      });
      if (linkedPaper) {
        return Response.json(
          { error: "Reference already linked to a library paper" },
          { status: 409 }
        );
      }
    }

    let authors: string[] = [];
    try {
      if (reference.authors) authors = JSON.parse(reference.authors);
    } catch {
      // ignore
    }

    let paper: Paper;

    if (reference.arxivId) {
      const metadata = await fetchArxivMetadata(reference.arxivId);
      const resolved = await resolveEntityForImport({
        userId,
        title: metadata.title,
        arxivId: reference.arxivId,
      });

      if (resolved.existingPaper) {
        await projectReferenceEntryImportLink({
          paperId: id,
          referenceId,
          linkedPaperId: resolved.existingPaper.id,
          linkedPaperEntityId: resolved.entityId,
        });
        return access.setDuplicateStateHeaders(Response.json(resolved.existingPaper, { status: 200 }));
      }

      // Download PDF synchronously
      let filePath: string | undefined;
      try {
        filePath = await downloadArxivPdf(reference.arxivId);
      } catch (e) {
        console.error("ArXiv PDF download failed:", e);
      }

      try {
        paper = await prisma.paper.create({
          data: {
            title: metadata.title,
            userId,
            abstract: metadata.abstract,
            authors: JSON.stringify(metadata.authors),
            year: metadata.year,
            sourceType: "ARXIV",
            sourceUrl: `https://arxiv.org/abs/${reference.arxivId}`,
            arxivId: reference.arxivId,
            filePath,
            categories: JSON.stringify(metadata.categories),
            processingStatus: "EXTRACTING_TEXT",
            entityId: resolved.entityId,
          },
        });
      } catch (error) {
        const existing = await handleDuplicatePaperError(error, userId, resolved.entityId);
        if (existing) {
          await projectReferenceEntryImportLink({
            paperId: id,
            referenceId,
            linkedPaperId: existing.id,
            linkedPaperEntityId: resolved.entityId,
          });
          return access.setDuplicateStateHeaders(Response.json(existing, { status: 200 }));
        }
        throw error;
      }

      await projectReferenceEntryImportLink({
        paperId: id,
        referenceId,
        linkedPaperId: paper.id,
        linkedPaperEntityId: paper.entityId,
      });
      // Queue handles: PDF text extraction → LLM pipeline
      processingQueue.enqueue(paper.id);
    } else if (reference.externalUrl) {
      const resolved = await resolveEntityForImport({
        userId,
        title: reference.title,
        doi: reference.doi,
        arxivId: reference.arxivId,
        semanticScholarId: reference.semanticScholarId,
      });

      if (resolved.existingPaper) {
        await projectReferenceEntryImportLink({
          paperId: id,
          referenceId,
          linkedPaperId: resolved.existingPaper.id,
          linkedPaperEntityId: resolved.entityId,
        });
        return access.setDuplicateStateHeaders(Response.json(resolved.existingPaper, { status: 200 }));
      }

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

      try {
        paper = await prisma.paper.create({
          data: {
            title: reference.title,
            userId,
            authors: reference.authors || JSON.stringify(authors),
            year: reference.year,
            venue: reference.venue,
            doi: reference.doi,
            sourceType: "URL",
            sourceUrl: reference.externalUrl,
            filePath,
            processingStatus: filePath ? "EXTRACTING_TEXT" : "PENDING",
            entityId: resolved.entityId,
          },
        });
      } catch (error) {
        const existing = await handleDuplicatePaperError(error, userId, resolved.entityId);
        if (existing) {
          await projectReferenceEntryImportLink({
            paperId: id,
            referenceId,
            linkedPaperId: existing.id,
            linkedPaperEntityId: resolved.entityId,
          });
          return access.setDuplicateStateHeaders(Response.json(existing, { status: 200 }));
        }
        throw error;
      }

      await projectReferenceEntryImportLink({
        paperId: id,
        referenceId,
        linkedPaperId: paper.id,
        linkedPaperEntityId: paper.entityId,
      });
      // Queue handles: PDF text extraction → LLM pipeline (if we have a file)
      if (filePath) {
        processingQueue.enqueue(paper.id);
      }
    } else {
      const resolved = await resolveEntityForImport({
        userId,
        title: reference.title,
        doi: reference.doi,
        arxivId: reference.arxivId,
        semanticScholarId: reference.semanticScholarId,
      });

      if (resolved.existingPaper) {
        await projectReferenceEntryImportLink({
          paperId: id,
          referenceId,
          linkedPaperId: resolved.existingPaper.id,
          linkedPaperEntityId: resolved.entityId,
        });
        return access.setDuplicateStateHeaders(Response.json(resolved.existingPaper, { status: 200 }));
      }

      // Create minimal paper record from reference metadata
      try {
        paper = await prisma.paper.create({
          data: {
            title: reference.title,
            userId,
            authors: reference.authors || JSON.stringify(authors),
            year: reference.year,
            venue: reference.venue,
            doi: reference.doi,
            sourceType: "URL",
            sourceUrl: reference.doi
              ? `https://doi.org/${reference.doi}`
              : undefined,
            processingStatus: "PENDING",
            entityId: resolved.entityId,
          },
        });
      } catch (error) {
        const existing = await handleDuplicatePaperError(error, userId, resolved.entityId);
        if (existing) {
          await projectReferenceEntryImportLink({
            paperId: id,
            referenceId,
            linkedPaperId: existing.id,
            linkedPaperEntityId: resolved.entityId,
          });
          return access.setDuplicateStateHeaders(Response.json(existing, { status: 200 }));
        }
        throw error;
      }
      await projectReferenceEntryImportLink({
        paperId: id,
        referenceId,
        linkedPaperId: paper.id,
        linkedPaperEntityId: paper.entityId,
      });
    }

    return access.setDuplicateStateHeaders(Response.json(paper, { status: 201 }));
  } catch (err) {
    const response = paperAccessErrorToResponse(err);
    if (response) return response;
    console.error("Import failed:", err);
    return Response.json(
      { error: "Failed to import reference" },
      { status: 500 }
    );
  }
}
