import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";
import { DISCOVER_QUERIES_PROMPT } from "@/lib/synthesis/prompts";
import { searchAllSources, type S2Result } from "@/lib/import/semantic-scholar";
import { getReferencesForPaper, getCitationsForPaper } from "@/lib/discovery/s2-graph";
import { titleSimilarity } from "@/lib/references/match";
import { requireUserId } from "@/lib/paper-auth";
import type { SynthesisPlan } from "@/lib/synthesis/types";

interface DiscoverQuery {
  query: string;
  rationale: string;
  targetGap: string;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const session = await prisma.synthesisSession.findFirst({
      where: { id, papers: { some: { paper: { userId } } } },
      include: {
        sections: { orderBy: { sortOrder: "asc" } },
        papers: {
          include: {
            paper: {
              select: { id: true, title: true, doi: true, arxivId: true },
            },
          },
        },
      },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.status !== "COMPLETED") {
      return NextResponse.json(
        { error: "Synthesis must be completed before discovering papers" },
        { status: 400 }
      );
    }

    const plan: SynthesisPlan | null = session.plan ? JSON.parse(session.plan) : null;
    if (!plan) {
      return NextResponse.json({ error: "No synthesis plan found" }, { status: 400 });
    }

    // Build context for query generation
    const themes = plan.themes
      .map((t) => `- ${t.label}: ${t.description}`)
      .join("\n");

    const gapSection = session.sections.find((s) => s.sectionType === "gaps");
    const gaps = gapSection
      ? gapSection.content.slice(0, 3000)
      : "No explicit gaps section available. Generate queries based on themes.";

    const existingTitles = session.papers
      .map((sp) => `- ${sp.paper.title}`)
      .join("\n");

    // LLM generates search queries
    const { provider, modelId, proxyConfig } = await getDefaultModel();
    const raw = await generateLLMResponse({
      provider,
      modelId,
      system: DISCOVER_QUERIES_PROMPT.system,
      prompt: DISCOVER_QUERIES_PROMPT.buildPrompt(themes, gaps, existingTitles),
      maxTokens: 2000,
      proxyConfig,
    });

    let queries: DiscoverQuery[] = [];
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      const parsed = JSON.parse(cleaned);
      queries = parsed.queries || [];
    } catch {
      return NextResponse.json({ error: "Failed to parse LLM query response" }, { status: 500 });
    }

    // Search for candidates using each query (max 5)
    const allCandidates: (S2Result & { querySource?: string })[] = [];
    for (const q of queries.slice(0, 5)) {
      try {
        const results = await searchAllSources(q.query);
        for (const r of results) {
          allCandidates.push({ ...r, querySource: q.query });
        }
      } catch (err) {
        console.error(`[discover] Search failed for query "${q.query}":`, err);
      }
    }

    // Citation traversal for top synthesis papers with identifiers
    const papersWithIds = session.papers
      .filter((sp) => sp.paper.doi || sp.paper.arxivId)
      .slice(0, 3);

    for (const sp of papersWithIds) {
      try {
        const identifier = sp.paper.doi || sp.paper.arxivId || "";
        const [refs, cites] = await Promise.all([
          getReferencesForPaper(identifier),
          getCitationsForPaper(identifier),
        ]);
        for (const r of refs.slice(0, 20)) {
          allCandidates.push({ ...r, querySource: `refs:${sp.paper.title.slice(0, 40)}` });
        }
        for (const c of cites.slice(0, 20)) {
          allCandidates.push({ ...c, querySource: `cites:${sp.paper.title.slice(0, 40)}` });
        }
      } catch (err) {
        console.error(`[discover] Citation traversal failed for ${sp.paper.id}:`, err);
      }
    }

    // Deduplicate against library papers
    const libraryPapers = session.papers.map((sp) => sp.paper);
    const deduped: (S2Result & { querySource?: string })[] = [];
    const seenKeys = new Set<string>();

    for (const candidate of allCandidates) {
      // Skip if already in library (by doi, arxivId, or title similarity)
      const inLibrary = libraryPapers.some((lp) => {
        if (candidate.doi && lp.doi && candidate.doi.toLowerCase() === lp.doi.toLowerCase()) return true;
        if (candidate.arxivId && lp.arxivId && candidate.arxivId === lp.arxivId) return true;
        if (titleSimilarity(candidate.title, lp.title) >= 0.85) return true;
        return false;
      });
      if (inLibrary) continue;

      // Deduplicate among candidates
      const key = candidate.doi?.toLowerCase()
        || candidate.arxivId?.toLowerCase()
        || candidate.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
      if (!key || seenKeys.has(key)) continue;

      // Also check title similarity against already-added candidates
      const titleDupe = deduped.some((d) => titleSimilarity(d.title, candidate.title) >= 0.85);
      if (titleDupe) continue;

      seenKeys.add(key);
      deduped.push(candidate);
    }

    // Sort by citation count desc, take top 30
    deduped.sort((a, b) => (b.citationCount ?? -1) - (a.citationCount ?? -1));
    const candidates = deduped.slice(0, 30);

    return NextResponse.json({ queries, candidates });
  } catch (err) {
    console.error("[api/synthesis/[id]/discover] POST error:", err);
    return NextResponse.json(
      { error: "Failed to discover papers" },
      { status: 500 }
    );
  }
}
