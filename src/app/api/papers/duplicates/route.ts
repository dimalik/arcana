import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PaperDuplicateAction, PaperDuplicateReviewStatus } from "@/generated/prisma/enums";
import { requireUserId } from "@/lib/paper-auth";
import {
  getPaperDuplicateDashboard,
  listPaperDuplicateCandidates,
  reviewPaperDuplicateCandidate,
  scanPaperDuplicateCandidates,
} from "@/lib/papers/duplicate-candidates";

const bulkReviewSchema = z.object({
  candidateId: z.string().min(1),
  reviewStatus: z.enum([PaperDuplicateReviewStatus.ACCEPTED, PaperDuplicateReviewStatus.DISMISSED]),
  chosenAction: z.nativeEnum(PaperDuplicateAction).nullable().optional(),
  winnerPaperId: z.string().min(1).optional(),
});

export async function GET() {
  const userId = await requireUserId();
  const [dashboard, candidates] = await Promise.all([
    getPaperDuplicateDashboard(userId),
    listPaperDuplicateCandidates(userId),
  ]);

  return NextResponse.json({
    dashboard,
    candidates,
  });
}

export async function POST() {
  const userId = await requireUserId();
  const summary = await scanPaperDuplicateCandidates(userId);
  return NextResponse.json(summary, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = await request.json();
    const input = bulkReviewSchema.parse(body);
    const candidate = await reviewPaperDuplicateCandidate({
      userId,
      candidateId: input.candidateId,
      reviewStatus: input.reviewStatus,
      chosenAction: input.chosenAction,
      winnerPaperId: input.winnerPaperId,
    });

    if (!candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }

    return NextResponse.json(candidate);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 },
      );
    }

    console.error("Review duplicate candidate error:", error);
    return NextResponse.json(
      { error: "Failed to update duplicate candidate" },
      { status: 500 },
    );
  }
}
