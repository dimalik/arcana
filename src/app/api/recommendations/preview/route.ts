import { NextRequest, NextResponse } from "next/server";

import { requireUserId } from "@/lib/paper-auth";
import { searchByTitle } from "@/lib/import/semantic-scholar";
import { fetchDoiMetadata } from "@/lib/import/url";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireUserId();

    const title = request.nextUrl.searchParams.get("title")?.trim() ?? "";
    const doi = request.nextUrl.searchParams.get("doi")?.trim() ?? "";
    const yearParam = request.nextUrl.searchParams.get("year")?.trim() ?? "";
    const year = yearParam ? Number.parseInt(yearParam, 10) : null;

    if (!title) {
      return NextResponse.json(
        { error: "Missing title" },
        { status: 400 },
      );
    }

    if (doi) {
      const metadata = await fetchDoiMetadata(doi);
      if (metadata?.abstract) {
        return NextResponse.json({
          abstract: metadata.abstract,
          source: "doi",
        });
      }
    }

    const match = await searchByTitle(title, Number.isFinite(year) ? year : null);

    return NextResponse.json({
      abstract: match?.abstract ?? null,
      source: match?.source ?? null,
    });
  } catch (error) {
    console.error("[recommendations-preview] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch recommendation preview" },
      { status: 500 },
    );
  }
}
