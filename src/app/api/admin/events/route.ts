import { NextRequest, NextResponse } from "next/server";
import { getRecentEvents } from "@/lib/logger";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
    const level = searchParams.get("level") as "error" | "warn" | "info" | null;
    const category = searchParams.get("category") as string | null;

    const events = await getRecentEvents(
      limit,
      level || undefined,
      category as Parameters<typeof getRecentEvents>[2]
    );

    return NextResponse.json(events);
  } catch (err) {
    console.error("[api/admin/events] GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 }
    );
  }
}
