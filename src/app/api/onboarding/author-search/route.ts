import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { fetchWithRetry, getS2Headers } from "@/lib/import/semantic-scholar";

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const AUTHOR_FIELDS = "name,affiliations,paperCount,citationCount,hIndex,url";
const PAPER_FIELDS = "title,abstract,authors,year,venue,externalIds,citationCount,openAccessPdf";

interface S2Author {
  authorId: string;
  name: string;
  affiliations?: string[];
  paperCount?: number;
  citationCount?: number;
  hIndex?: number;
  url?: string;
}

interface S2Paper {
  paperId: string;
  title: string;
  abstract?: string | null;
  authors?: { name: string }[];
  year?: number;
  venue?: string;
  externalIds?: Record<string, string>;
  citationCount?: number;
  openAccessPdf?: { url: string } | null;
}

/**
 * GET /api/onboarding/author-search?name=...&affiliation=...
 * Search for author profiles on Semantic Scholar.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const name = req.nextUrl.searchParams.get("name");
  if (!name || name.trim().length < 2) {
    return NextResponse.json({ error: "name parameter required (min 2 chars)" }, { status: 400 });
  }

  const affiliation = req.nextUrl.searchParams.get("affiliation") || "";

  // Build query: combine name and affiliation for better matching
  const query = affiliation ? `${name.trim()} ${affiliation.trim()}` : name.trim();

  const url = `${S2_BASE}/author/search?query=${encodeURIComponent(query)}&fields=${AUTHOR_FIELDS}&limit=5`;
  const headers = getS2Headers();
  const res = await fetchWithRetry(url, "s2", 1100, headers);

  if (!res) {
    return NextResponse.json({ authors: [] });
  }

  const data = await res.json();
  const authors: S2Author[] = data.data || [];

  return NextResponse.json({
    authors: authors.map((a) => ({
      authorId: a.authorId,
      name: a.name,
      affiliations: a.affiliations || [],
      paperCount: a.paperCount ?? 0,
      citationCount: a.citationCount ?? 0,
      hIndex: a.hIndex ?? 0,
      url: a.url || null,
    })),
  });
}

/**
 * POST /api/onboarding/author-search
 * Fetch recent papers for a selected author.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { authorId } = body;

  if (!authorId) {
    return NextResponse.json({ error: "authorId required" }, { status: 400 });
  }

  const url = `${S2_BASE}/author/${encodeURIComponent(authorId)}/papers?fields=${PAPER_FIELDS}&limit=20`;
  const headers = getS2Headers();
  const res = await fetchWithRetry(url, "s2", 1100, headers);

  if (!res) {
    return NextResponse.json({ papers: [] });
  }

  const data = await res.json();
  const papers: S2Paper[] = (data.data || []).filter((p: S2Paper) => p.title);

  return NextResponse.json({
    papers: papers.map((p) => ({
      title: p.title,
      abstract: p.abstract || null,
      authors: (p.authors || []).map((a) => a.name),
      year: p.year ?? null,
      venue: p.venue || null,
      doi: p.externalIds?.DOI || null,
      arxivId: p.externalIds?.ArXiv || null,
      citationCount: p.citationCount ?? null,
      externalUrl: p.externalIds?.DOI
        ? `https://doi.org/${p.externalIds.DOI}`
        : p.externalIds?.ArXiv
        ? `https://arxiv.org/abs/${p.externalIds.ArXiv}`
        : `https://www.semanticscholar.org/paper/${p.paperId}`,
      semanticScholarId: `s2:${p.paperId}`,
    })),
  });
}
