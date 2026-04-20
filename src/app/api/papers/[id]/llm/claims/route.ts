import { NextRequest, NextResponse } from "next/server";

import { resolveModelConfig } from "@/lib/llm/auto-process";
import {
  getLatestCompletedPaperClaimRun,
  runPaperAnalysisCapability,
} from "@/lib/papers/analysis";
import { prisma } from "@/lib/prisma";
import {
  jsonWithDuplicateState,
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, {
      mode: "read",
      select: { id: true },
    });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const latestRun = await getLatestCompletedPaperClaimRun(prisma, id);
    return jsonWithDuplicateState(
      access,
      {
        paperId: id,
        extractorVersion: latestRun?.extractorVersion ?? null,
        run: latestRun
          ? {
              id: latestRun.id,
              status: latestRun.status,
              sourceTextHash: latestRun.sourceTextHash,
              createdAt: latestRun.createdAt,
              completedAt: latestRun.completedAt,
            }
          : null,
        claims: latestRun?.claims ?? [],
      },
    );
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    console.error("Claims GET error:", error);
    return NextResponse.json(
      { error: "Failed to load claims" },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, {
      mode: "mutate",
      select: {
        id: true,
        title: true,
        abstract: true,
        fullText: true,
      },
    });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);
    const text = access.paper.fullText || access.paper.abstract || "";

    if (!text) {
      return NextResponse.json(
        { error: "No text available for claim extraction" },
        { status: 400 },
      );
    }

    const result = await runPaperAnalysisCapability({
      capability: "claims",
      paperId: id,
      text,
      provider,
      modelId,
      proxyConfig,
      userId: access.userId,
      force: body.force === true,
    });

    return NextResponse.json(result);
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    console.error("Claims POST error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to extract claims",
      },
      { status: 500 },
    );
  }
}
