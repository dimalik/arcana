import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse } from "@/lib/llm/provider";
import { buildPrompt, cleanJsonResponse } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { getBodyTextForContextExtraction } from "@/lib/references/extract-section";
import { matchCitationToReference } from "@/lib/references/match-citation";
import { requireUserId } from "@/lib/paper-auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await requireUserId();
    const { id } = await params;

  const paper = await prisma.paper.findFirst({ where: { id, userId } });
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  if (!paper.fullText) {
    return NextResponse.json(
      { error: "No full text available" },
      { status: 400 }
    );
  }

  const references = await prisma.reference.findMany({
    where: { paperId: id },
    select: { id: true, title: true, authors: true, year: true, referenceIndex: true },
  });

  if (references.length === 0) {
    return NextResponse.json(
      { error: "No references found — extract references first" },
      { status: 400 }
    );
  }

  const bodyText = getBodyTextForContextExtraction(paper.fullText);
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
    return NextResponse.json({ updated: 0 });
  }

  // Group contexts by matched reference ID
  const contextsByRef = new Map<string, string[]>();

  for (const ctx of contexts) {
    if (!ctx.citation || !ctx.context) continue;
    const refId = matchCitationToReference(ctx.citation, references);
    if (!refId) continue;

    const existing = contextsByRef.get(refId) || [];
    if (!existing.includes(ctx.context)) {
      existing.push(ctx.context);
    }
    contextsByRef.set(refId, existing);
  }

  // Clear existing contexts first
  await prisma.reference.updateMany({
    where: { paperId: id },
    data: { citationContext: null },
  });

  // Update matched references
  let updated = 0;
  const entries = Array.from(contextsByRef.entries());
  for (const [refId, ctxList] of entries) {
    await prisma.reference.update({
      where: { id: refId },
      data: { citationContext: ctxList.join("; ") },
    });
    updated++;
  }

  return NextResponse.json({
    updated,
    total: references.length,
    extractedCitations: contexts.length,
  });
}
