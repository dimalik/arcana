import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchByTitle, S2RateLimitError } from "@/lib/import/semantic-scholar";
import { findLibraryMatchByIds } from "@/lib/references/match";
import { requireUserId } from "@/lib/paper-auth";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await requireUserId();
    const { id } = await params;

  const paper = await prisma.paper.findFirst({ where: { id, userId } });
  if (!paper) {
    return Response.json({ error: "Paper not found" }, { status: 404 });
  }

  const references = await prisma.reference.findMany({
    where: { paperId: id, semanticScholarId: null },
  });

  if (references.length === 0) {
    return Response.json({ enriched: 0, failed: 0, total: 0 });
  }

  // Load library papers for re-matching
  const libraryPapers = await prisma.paper.findMany({
    select: { id: true, title: true, doi: true, arxivId: true },
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let enriched = 0;
      let failed = 0;
      const total = references.length;

      for (let i = 0; i < references.length; i++) {
        const ref = references[i];

        // Send progress
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              type: "progress",
              current: i + 1,
              total,
              title: ref.title,
            }) + "\n"
          )
        );

        try {
          const result = await searchByTitle(ref.title, ref.year);

          if (result) {
            // Re-check library match with enriched data
            const libraryMatch = findLibraryMatchByIds(
              {
                doi: result.doi,
                arxivId: result.arxivId,
                title: ref.title,
              },
              libraryPapers
            );

            await prisma.reference.update({
              where: { id: ref.id },
              data: {
                semanticScholarId: result.semanticScholarId,
                arxivId: result.arxivId,
                externalUrl: result.externalUrl,
                authors: ref.authors || JSON.stringify(result.authors),
                year: ref.year ?? result.year,
                venue: ref.venue || result.venue,
                doi: ref.doi || result.doi,
                ...(libraryMatch && {
                  matchedPaperId: libraryMatch.paperId,
                  matchConfidence: libraryMatch.confidence,
                }),
              },
            });
            enriched++;
          } else {
            failed++;
          }
        } catch (err) {
          if (err instanceof S2RateLimitError) {
            // Stop the whole batch — no point continuing
            const remaining = total - i;
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: "done",
                  enriched,
                  failed: failed + remaining,
                  total,
                  rateLimited: true,
                }) + "\n"
              )
            );
            controller.close();
            return;
          }
          console.error(`Failed to enrich reference "${ref.title}":`, err);
          failed++;
        }
      }

      // Send final result
      controller.enqueue(
        encoder.encode(
          JSON.stringify({ type: "done", enriched, failed, total }) + "\n"
        )
      );
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    },
  });
}
