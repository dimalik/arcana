import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchByTitle, S2RateLimitError } from "@/lib/import/semantic-scholar";
import { requireUserId } from "@/lib/paper-auth";
import { enrichReferenceEntryFromCandidate } from "@/lib/citations/reference-entry-service";

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

  const references = await prisma.referenceEntry.findMany({
    where: { paperId: id, semanticScholarId: null },
    select: {
      id: true,
      title: true,
      year: true,
    },
  });

  if (references.length === 0) {
    return Response.json({ enriched: 0, failed: 0, total: 0 });
  }

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
            await enrichReferenceEntryFromCandidate({
              paperId: id,
              referenceId: ref.id,
              userId,
              candidate: result,
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
