import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/paper-auth";
import { applyAcceptedPaperDuplicateCandidates } from "@/lib/papers/duplicate-candidates";

export async function POST() {
  const userId = await requireUserId();
  const result = await applyAcceptedPaperDuplicateCandidates(userId);
  return NextResponse.json(result);
}
