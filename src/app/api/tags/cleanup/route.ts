import { NextResponse } from "next/server";
import { runTagCleanup } from "@/lib/tags/cleanup";

export async function POST() {
  try {
    const result = await runTagCleanup();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tag cleanup error:", error);
    return NextResponse.json(
      { error: "Failed to run tag cleanup" },
      { status: 500 },
    );
  }
}
