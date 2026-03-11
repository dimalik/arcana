import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";
import { EXTRACT_GUIDANCE_PROMPT } from "@/lib/synthesis/guide-prompt";
import { synthesisQueue } from "@/lib/synthesis/queue";
import { requireUserId } from "@/lib/paper-auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const session = await prisma.synthesisSession.findFirst({
      where: { id, papers: { some: { paper: { userId } } } },
      select: { status: true, guidanceMessages: true },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.status !== "GUIDING") {
      return NextResponse.json(
        { error: `Session is in ${session.status} state, not GUIDING` },
        { status: 400 }
      );
    }

    // Extract structured guidance from chat if messages exist
    let guidanceJson: string | null = null;

    if (session.guidanceMessages) {
      try {
        const messages = JSON.parse(session.guidanceMessages) as {
          role: string;
          content: string;
        }[];

        if (messages.length > 0) {
          const transcript = messages
            .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
            .join("\n\n");

          const { provider, modelId, proxyConfig } = await getDefaultModel();
          const raw = await generateLLMResponse({
            provider,
            modelId,
            system: EXTRACT_GUIDANCE_PROMPT.system,
            prompt: EXTRACT_GUIDANCE_PROMPT.buildPrompt(transcript),
            maxTokens: 2000,
            proxyConfig,
          });

          // Validate it's parseable JSON
          const parsed = JSON.parse(
            raw.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim()
          );
          guidanceJson = JSON.stringify(parsed);
        }
      } catch (err) {
        console.error("[proceed] Failed to extract guidance:", err);
        // Non-fatal: continue without guidance
      }
    }

    // Store guidance and resume
    await prisma.synthesisSession.update({
      where: { id },
      data: { guidance: guidanceJson },
    });

    // Resume the pipeline (phase 2)
    synthesisQueue.resume(id);

    return NextResponse.json({ status: "resuming" });
  } catch (err) {
    console.error("[api/synthesis/[id]/proceed] POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to proceed" },
      { status: 500 }
    );
  }
}
