import { NextRequest, NextResponse } from "next/server";
import { trackEngagement, type EngagementEvent } from "@/lib/engagement/track";
import { z } from "zod";
import { requirePaperAccess } from "@/lib/paper-auth";

const engageSchema = z.object({
  event: z.enum([
    "view",
    "pdf_open",
    "annotate",
    "chat",
    "concept_explore",
    "discovery_seed",
    "import",
  ]),
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const paperId = params.id;
    const paper = await requirePaperAccess(paperId);
    if (!paper) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const body = await request.json();
    const { event } = engageSchema.parse(body);

    await trackEngagement(paperId, event as EngagementEvent);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Engagement tracking error:", error);
    return NextResponse.json(
      { error: "Failed to track engagement" },
      { status: 500 }
    );
  }
}
