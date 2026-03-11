import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse, MAX_PAPER_CHARS } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";
import { cleanJsonResponse } from "@/lib/llm/prompts";
import { requireUserId } from "@/lib/paper-auth";
import type { PaperDigest, SectionDraft } from "@/lib/synthesis/types";
import {
  REDUCE_THEMATIC,
  REDUCE_METHODOLOGY,
  REDUCE_META,
  REDUCE_GENERIC,
} from "@/lib/synthesis/prompts";

// POST — Regenerate one section
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    // Verify ownership
    const ownerCheck = await prisma.synthesisSession.findFirst({
      where: { id, papers: { some: { paper: { userId } } } },
      select: { id: true },
    });
    if (!ownerCheck) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const body = await request.json();
    const { sectionType, instructions } = body as {
      sectionType: string;
      instructions?: string;
    };

    if (!sectionType) {
      return NextResponse.json(
        { error: "sectionType is required" },
        { status: 400 }
      );
    }

    // Find the section
    const section = await prisma.synthesisSection.findFirst({
      where: { sessionId: id, sectionType },
    });

    if (!section) {
      return NextResponse.json(
        { error: "Section not found" },
        { status: 404 }
      );
    }

    // Load session plan and digests
    const session = await prisma.synthesisSession.findUniqueOrThrow({
      where: { id },
      include: {
        papers: { select: { digest: true, paperId: true } },
      },
    });

    const plan = session.plan ? JSON.parse(session.plan) : null;
    const digests: PaperDigest[] = session.papers
      .filter((p) => p.digest)
      .map((p) => JSON.parse(p.digest!) as PaperDigest);

    // Find which digests are relevant for this section
    const planSection = plan?.structure?.find(
      (s: { sectionType: string; themes?: string[] }) => s.sectionType === sectionType
    );
    const relevantDigests = planSection?.themes
      ? digests.filter((d) => d.themes.some((t: string) => planSection.themes.includes(t)))
      : digests;

    const digestText = relevantDigests
      .map(
        (d) =>
          `### Paper: ${d.paperId}\nContribution: ${d.coreContribution}\nMethodology: ${d.methodology}\nFindings: ${d.keyFindings.join("; ")}\nMetrics: ${JSON.stringify(d.metrics)}\nLimitations: ${d.limitations}`
      )
      .join("\n\n---\n\n")
      .slice(0, MAX_PAPER_CHARS);

    const { provider, modelId, proxyConfig } = await getDefaultModel();

    let system: string;
    let prompt: string;

    switch (sectionType) {
      case "thematic": {
        const theme = plan?.themes?.find((t: { id: string }) =>
          planSection?.themes?.includes(t.id)
        );
        system = REDUCE_THEMATIC.system;
        prompt = REDUCE_THEMATIC.buildPrompt(
          theme?.label || planSection?.focus || "Thematic Analysis",
          theme?.description || "",
          digestText
        );
        break;
      }
      case "methodology":
        system = REDUCE_METHODOLOGY.system;
        prompt = REDUCE_METHODOLOGY.buildPrompt(digestText);
        break;
      case "meta":
        system = REDUCE_META.system;
        prompt = REDUCE_META.buildPrompt(digestText);
        break;
      default:
        system = REDUCE_GENERIC.system;
        prompt = REDUCE_GENERIC.buildPrompt(
          sectionType,
          planSection?.focus || sectionType,
          digestText
        );
        break;
    }

    if (instructions) {
      prompt += `\n\n---\n\nAdditional instructions from the user: ${instructions}`;
    }

    const raw = await generateLLMResponse({
      provider,
      modelId,
      system,
      prompt,
      maxTokens: 4000,
      proxyConfig,
    });

    const draft = JSON.parse(cleanJsonResponse(raw)) as SectionDraft;

    // Update section in-place
    await prisma.synthesisSection.update({
      where: { id: section.id },
      data: {
        content: draft.content,
        title: draft.title || section.title,
        citations: JSON.stringify(draft.citations || []),
      },
    });

    // Rebuild the full output
    const allSections = await prisma.synthesisSection.findMany({
      where: { sessionId: id },
      orderBy: { sortOrder: "asc" },
    });

    const sessionData = await prisma.synthesisSession.findUniqueOrThrow({
      where: { id },
      include: {
        papers: {
          include: {
            paper: { select: { id: true, title: true, year: true, authors: true } },
          },
        },
      },
    });

    const bibliography = sessionData.papers
      .map((sp, i) => {
        const p = sp.paper;
        let authors = "";
        try { authors = JSON.parse(p.authors || "[]").join(", "); } catch { authors = p.authors || ""; }
        return `${i + 1}. **${p.title}** ${authors ? `— ${authors}` : ""}${p.year ? ` (${p.year})` : ""} [View](/papers/${p.id})`;
      })
      .join("\n");

    const fullOutput = [
      `# ${sessionData.title}\n`,
      `*Synthesis of ${sessionData.paperCount} papers*\n`,
      ...allSections.map((s) => `## ${s.title}\n\n${s.content}`),
      `\n## Bibliography\n\n${bibliography}`,
    ].join("\n\n");

    await prisma.synthesisSession.update({
      where: { id },
      data: { output: fullOutput },
    });

    return NextResponse.json({
      section: {
        ...section,
        content: draft.content,
        title: draft.title || section.title,
      },
    });
  } catch (err) {
    console.error("[api/synthesis/[id]/regenerate] POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to regenerate section" },
      { status: 500 }
    );
  }
}
