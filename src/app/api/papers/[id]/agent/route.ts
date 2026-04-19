import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTemplate } from "@/lib/agent/templates";
import { agentSessionQueue } from "@/lib/agent/session-queue";
import type { AgentEvent, AgentSessionData } from "@/lib/agent/types";
import {
  jsonWithDuplicateState,
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";

type Params = { params: Promise<{ id: string }> };

function toSessionData(row: {
  id: string;
  paperId: string;
  templateId: string | null;
  customPrompt: string | null;
  mode: string;
  status: string;
  events: string;
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}): AgentSessionData {
  let events: AgentEvent[] = [];
  try {
    events = JSON.parse(row.events);
  } catch {
    // ignore
  }
  return {
    id: row.id,
    paperId: row.paperId,
    templateId: row.templateId,
    customPrompt: row.customPrompt,
    mode: row.mode,
    status: row.status as AgentSessionData["status"],
    events,
    costUsd: row.costUsd,
    durationMs: row.durationMs,
    turns: row.turns,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * POST — Create a new agent session and enqueue it for background processing.
 * Returns 202 with { sessionId }.
 * Returns 409 if a PENDING/RUNNING session already exists for this paper.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, { mode: "mutate" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY is not set. The agent requires a direct Anthropic API key." },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { templateId, customPrompt, mode = "analyze", options } = body as {
      templateId?: string;
      customPrompt?: string;
      mode?: string;
      options?: { attachPath?: string };
    };

    if (templateId && !getTemplate(templateId)) {
      return NextResponse.json({ error: "Unknown template" }, { status: 400 });
    }

    if (!templateId && !customPrompt) {
      return NextResponse.json(
        { error: "Provide templateId or customPrompt" },
        { status: 400 }
      );
    }

    const existing = await prisma.agentSession.findFirst({
      where: {
        paperId: id,
        status: { in: ["PENDING", "RUNNING"] },
      },
    });

    if (existing) {
      return access.setDuplicateStateHeaders(NextResponse.json(
        { error: "An agent session is already running for this paper", sessionId: existing.id },
        { status: 409 }
      ));
    }

    const session = await prisma.agentSession.create({
      data: {
        paperId: id,
        templateId: templateId ?? null,
        customPrompt: customPrompt ?? null,
        mode,
      },
    });

    agentSessionQueue.enqueue(session.id, id, options ? { attachPath: options.attachPath } : undefined);

    return access.setDuplicateStateHeaders(NextResponse.json({ sessionId: session.id }, { status: 202 }));
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    console.error("Failed to create agent session:", error);
    return NextResponse.json({ error: "Failed to create agent session" }, { status: 500 });
  }
}

/**
 * GET — Return session data.
 * ?sessionId=<id> — specific session
 * ?all=true — all sessions for this paper (most recent first)
 * Default — latest session for this paper
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, { mode: "read" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");
    const all = searchParams.get("all");

    if (all) {
      const sessions = await prisma.agentSession.findMany({
        where: { paperId: id },
        orderBy: { createdAt: "desc" },
      });
      return jsonWithDuplicateState(access, sessions.map(toSessionData));
    }

    const where = sessionId
      ? { id: sessionId }
      : { paperId: id };

    const session = await prisma.agentSession.findFirst({
      where,
      orderBy: { createdAt: "desc" },
    });

    return jsonWithDuplicateState(access, session ? toSessionData(session) : null);
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    console.error("Failed to load agent session:", error);
    return NextResponse.json({ error: "Failed to load agent session" }, { status: 500 });
  }
}

/**
 * DELETE — Cancel a running session.
 * ?sessionId=<id> — specific session to cancel
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, { mode: "mutate" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }

    const session = await prisma.agentSession.findFirst({
      where: { id: sessionId, paperId: id },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.status !== "PENDING" && session.status !== "RUNNING") {
      return NextResponse.json({ error: "Session is not active" }, { status: 400 });
    }

    const cancelled = await agentSessionQueue.cancel(sessionId);

    if (!cancelled) {
      await prisma.agentSession.update({
        where: { id: sessionId },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
        },
      });
    }

    return access.setDuplicateStateHeaders(NextResponse.json({ ok: true }));
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    console.error("Failed to cancel agent session:", error);
    return NextResponse.json({ error: "Failed to cancel agent session" }, { status: 500 });
  }
}
