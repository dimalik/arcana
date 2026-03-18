import { NextRequest, NextResponse } from "next/server";
import { getUsageSummary } from "@/lib/usage";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "30", 10);

    const summary = await getUsageSummary(Math.min(days, 365));

    return NextResponse.json(summary);
  } catch (err) {
    console.error("[api/admin/usage] GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch usage data" },
      { status: 500 }
    );
  }
}
