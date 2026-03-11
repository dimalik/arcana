import { NextRequest, NextResponse } from "next/server";
import { searchAllSources } from "@/lib/import/semantic-scholar";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  const yearStr = searchParams.get("year");
  const year = yearStr ? parseInt(yearStr, 10) : null;

  if (!query) {
    return NextResponse.json(
      { error: "Missing required query parameter 'q'" },
      { status: 400 }
    );
  }

  try {
    const results = await searchAllSources(query, year);
    return NextResponse.json(results);
  } catch (error) {
    console.error("[search] Error:", error);
    return NextResponse.json(
      { error: "Search failed" },
      { status: 500 }
    );
  }
}
