import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse, truncateText } from "@/lib/llm/provider";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { parseSummarySections } from "@/lib/papers/parse-sections";
import { z } from "zod";
import { requireUserId } from "@/lib/paper-auth";

const requestSchema = z.object({
  section: z.enum(["review", "methodology", "results"]),
  mode: z.enum(["shorter", "longer", "focus"]),
  topic: z.string().optional(),
});

const SECTION_HEADER: Record<string, string> = {
  review: "",
  methodology: "## Methodology",
  results: "## Results",
};

const SECTION_LABEL: Record<string, string> = {
  review: "Review / Overview (Summary, Core Problem, Why It Matters, Novelty, Highlights, Reviewer Assessment)",
  methodology: "Methodology (Approach, Models & Datasets, Technical Details)",
  results: "Results (key findings, tables, ablation studies)",
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();
    const { section, mode, topic } = requestSchema.parse(body);
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);

    const paper = await prisma.paper.findFirst({ where: { id, userId } });
    if (!paper) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const text = paper.fullText || paper.abstract || "";
    if (!text) {
      return NextResponse.json({ error: "No text available" }, { status: 400 });
    }

    if (!paper.summary) {
      return NextResponse.json({ error: "No existing summary to rewrite" }, { status: 400 });
    }

    const sections = parseSummarySections(paper.summary);
    const currentContent = section === "review"
      ? sections.overview
      : section === "methodology"
        ? sections.methodology
        : sections.results;

    const truncated = truncateText(text, modelId, proxyConfig);

    let instruction = "";
    if (mode === "shorter") {
      instruction = `Rewrite the ${SECTION_LABEL[section]} section of this paper review. Make it significantly MORE CONCISE — roughly half the length. Keep the most important points, specific numbers, and key findings. Remove verbose explanations and redundant details.`;
    } else if (mode === "longer") {
      instruction = `Rewrite the ${SECTION_LABEL[section]} section of this paper review. Make it significantly MORE DETAILED — roughly double the length. Add more depth, include additional findings, equations, technical details, and nuances from the paper that were omitted in the original version.`;
    } else {
      instruction = `Rewrite the ${SECTION_LABEL[section]} section of this paper review, but FOCUS specifically on: "${topic}". Restructure the section around this topic — what the paper says about it, how it relates to the methodology/results, and what implications it has. Keep specific numbers and findings related to this focus.`;
    }

    const system = `You are a senior scientific peer reviewer rewriting a specific section of a paper review. Write in clear, direct language. Be specific — cite numbers, model names, dataset names, and equations. Use markdown headers, bullet points, tables, and code blocks for structure.`;

    const header = SECTION_HEADER[section];
    const prompt = `Here is the full paper text:\n\n${truncated}\n\n---\n\nHere is the CURRENT version of the section:\n\n${currentContent}\n\n---\n\n${instruction}\n\nIMPORTANT: Output ONLY the rewritten section content.${header ? ` Start with "${header}" as the heading.` : " Do NOT start with a ## Methodology or ## Results heading — this is the overview/review section that comes before those."}`;

    const result = await generateLLMResponse({
      provider,
      modelId,
      system,
      prompt,
      proxyConfig,
    });

    // Splice the rewritten section back into the full summary
    const newSections = { ...sections };
    if (section === "review") {
      newSections.overview = result.trim();
    } else if (section === "methodology") {
      newSections.methodology = result.trim();
    } else {
      newSections.results = result.trim();
    }

    const newSummary = [
      newSections.overview,
      newSections.methodology ? `\n\n---\n\n${newSections.methodology}` : "",
      newSections.results ? `\n\n---\n\n${newSections.results}` : "",
    ].join("");

    await prisma.paper.update({
      where: { id },
      data: { summary: newSummary },
    });

    await prisma.promptResult.create({
      data: {
        paperId: id,
        promptType: "rewrite-section",
        prompt: `Rewrite ${section} (${mode}${topic ? `: ${topic}` : ""})`,
        result,
        provider,
        model: modelId,
      },
    });

    return NextResponse.json({ section, result, summary: newSummary });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Rewrite section error:", error);
    return NextResponse.json(
      { error: "Failed to rewrite section" },
      { status: 500 }
    );
  }
}
