import { NextRequest, NextResponse } from "next/server";
import { getRecommendations } from "@/lib/recommendations/engine";
import { requireUserId } from "@/lib/paper-auth";

export async function GET(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const refresh = request.nextUrl.searchParams.get("refresh") === "true";
    const tagIdsParam = request.nextUrl.searchParams.get("tagIds");
    const tagIds = tagIdsParam ? tagIdsParam.split(",").filter(Boolean) : undefined;
    const data = await getRecommendations(refresh, userId, tagIds);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[recommendations] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch recommendations" },
      { status: 500 }
    );
  }
}
