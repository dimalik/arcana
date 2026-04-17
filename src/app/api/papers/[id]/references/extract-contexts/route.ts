import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse } from "@/lib/llm/provider";
import { buildPrompt, cleanJsonResponse } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { getBodyTextForContextExtraction } from "@/lib/references/extract-section";
import { GrobidCitationMentionExtractor } from "@/lib/references/grobid/citation-mentions";
import type { CitationMentionInput } from "@/lib/citations/citation-mention-service";
import { replaceCitationMentionsWithLegacyProjection } from "@/lib/citations/citation-mention-service";
import { requireUserId } from "@/lib/paper-auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await requireUserId();
  const { id } = await params;

  const paper = await prisma.paper.findFirst({
    where: { id, userId },
    select: {
      id: true,
      fullText: true,
      filePath: true,
    },
  });
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  if (!paper.fullText && !paper.filePath) {
    return NextResponse.json(
      { error: "No full text or PDF available" },
      { status: 400 }
    );
  }

  const referenceCount = await prisma.referenceEntry.count({
    where: { paperId: id },
  });
  if (referenceCount === 0) {
    return NextResponse.json(
      { error: "No references found — extract references first" },
      { status: 400 }
    );
  }

  let mentionInputs: CitationMentionInput[] = [];
  let extractorVersion: string | null = "manual_llm_v1";
  let provenance = "llm_extraction";

  if (paper.filePath) {
    const grobidMentions = await new GrobidCitationMentionExtractor().extract(
      paper.filePath,
    );
    if (grobidMentions.mentions.length > 0) {
      mentionInputs = grobidMentions.mentions;
      extractorVersion = "grobid_fulltext_v1";
      provenance = "grobid_fulltext";
    }
  }

  if (mentionInputs.length === 0) {
    const bodyText = getBodyTextForContextExtraction(paper.fullText ?? "");
    if (!bodyText) {
      return NextResponse.json(
        { error: "Could not extract body text" },
        { status: 400 }
      );
    }

    let modelConfig;
    try {
      modelConfig = await resolveModelConfig({});
    } catch {
      return NextResponse.json(
        { error: "No LLM provider configured" },
        { status: 500 }
      );
    }

    const { provider, modelId, proxyConfig } = modelConfig;
    const { system } = buildPrompt("extractCitationContexts", "");

    const ctxResult = await generateLLMResponse({
      provider,
      modelId,
      system,
      prompt: `Here is the body text of the paper:\n\n${bodyText}`,
      maxTokens: 4000,
      proxyConfig,
    });

    const cleaned = cleanJsonResponse(ctxResult);
    let contexts: Array<{ citation: string; context: string }>;
    try {
      contexts = JSON.parse(cleaned);
    } catch {
      return NextResponse.json(
        { error: "Failed to parse LLM response" },
        { status: 500 }
      );
    }

    if (!Array.isArray(contexts) || contexts.length === 0) {
      const replaced = await replaceCitationMentionsWithLegacyProjection(
        id,
        [],
        extractorVersion,
        provenance,
      );
      return NextResponse.json({
        updated: replaced.legacyUpdated,
        total: referenceCount,
        extractedCitations: 0,
        unmatched: 0,
        method: "none",
      });
    }

    mentionInputs = contexts
      .filter((ctx) => ctx.citation && ctx.context)
      .map((ctx) => ({
        citationText: ctx.citation,
        excerpt: ctx.context,
      }));
  }

  const replaced = await replaceCitationMentionsWithLegacyProjection(
    id,
    mentionInputs,
    extractorVersion,
    provenance,
  );

  return NextResponse.json({
    updated: replaced.legacyUpdated,
    total: referenceCount,
    extractedCitations: mentionInputs.length,
    unmatched: replaced.unmatched,
    method: provenance === "grobid_fulltext" ? "grobid" : "llm",
  });
}
