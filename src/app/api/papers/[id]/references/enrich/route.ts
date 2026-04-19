import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchByTitle, S2RateLimitError } from "@/lib/import/semantic-scholar";
import { paperAccessErrorToResponse, requirePaperAccess } from "@/lib/paper-auth";
import {
  enrichReferenceEntryFromCandidate,
  referenceEntryNeedsMetadataRepair,
} from "@/lib/citations/reference-entry-service";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, { mode: "mutate" });
    if (!access) {
      return Response.json({ error: "Paper not found" }, { status: 404 });
    }
    const userId = access.userId;

    const references = await prisma.referenceEntry.findMany({
      where: { paperId: id },
      select: {
        id: true,
        title: true,
        authors: true,
        year: true,
        venue: true,
        semanticScholarId: true,
      },
    });

    const pendingReferences = references.filter(
      (reference) =>
        !reference.semanticScholarId || referenceEntryNeedsMetadataRepair(reference),
    );

    if (pendingReferences.length === 0) {
      return access.setDuplicateStateHeaders(Response.json({ enriched: 0, failed: 0, total: 0 }));
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let enriched = 0;
        let repaired = 0;
        let filled = 0;
        let unchanged = 0;
        let failed = 0;
        const total = pendingReferences.length;

        for (let i = 0; i < pendingReferences.length; i++) {
          const ref = pendingReferences[i];

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
              const updated = await enrichReferenceEntryFromCandidate({
                paperId: id,
                referenceId: ref.id,
                userId,
                candidate: result,
              });

              if (!updated) {
                failed++;
                continue;
              }

              enriched++;
              const outcomes = Object.values(updated.mergeSummary).filter(
                (value): value is string => typeof value === "string",
              );
              if (outcomes.includes("replaced_polluted")) {
                repaired++;
              } else if (outcomes.includes("filled_missing")) {
                filled++;
              } else {
                unchanged++;
              }
            } else {
              failed++;
            }
          } catch (err) {
            if (err instanceof S2RateLimitError) {
              const remaining = total - i;
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    type: "done",
                    enriched,
                    repaired,
                    filled,
                    unchanged,
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

        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              type: "done",
              enriched,
              repaired,
              filled,
              unchanged,
              failed,
              total,
            }) + "\n"
          )
        );
        controller.close();
      },
    });

    return access.setDuplicateStateHeaders(new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      },
    }));
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    console.error("Reference enrichment failed:", error);
    return Response.json({ error: "Reference enrichment failed" }, { status: 500 });
  }
}
