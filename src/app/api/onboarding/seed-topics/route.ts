import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { searchAllSources } from "@/lib/import/semantic-scholar";

/**
 * POST /api/onboarding/seed-topics
 * Search for papers by topic keywords to seed the library during onboarding.
 * Returns candidates — does NOT import them.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { topics } = body;

  if (!Array.isArray(topics) || topics.length === 0) {
    return NextResponse.json({ error: "topics array required" }, { status: 400 });
  }

  // Search for up to 5 papers per topic, max 3 topics
  const topicSlice = topics.slice(0, 3) as string[];
  const allResults: Array<{
    topic: string;
    papers: Array<{
      title: string;
      authors: string[];
      year: number | null;
      venue: string | null;
      doi: string | null;
      arxivId: string | null;
      citationCount: number | null;
      abstract: string | null;
      externalUrl: string;
      semanticScholarId: string;
    }>;
  }> = [];

  for (const topic of topicSlice) {
    try {
      const results = await searchAllSources(topic);
      allResults.push({
        topic,
        papers: results.slice(0, 5).map((r) => ({
          title: r.title,
          authors: r.authors,
          year: r.year,
          venue: r.venue,
          doi: r.doi,
          arxivId: r.arxivId,
          citationCount: r.citationCount,
          abstract: r.abstract,
          externalUrl: r.externalUrl,
          semanticScholarId: r.semanticScholarId,
        })),
      });
    } catch (e) {
      console.error(`[onboarding] Topic search failed for "${topic}":`, e);
      allResults.push({ topic, papers: [] });
    }
  }

  return NextResponse.json({ results: allResults });
}
