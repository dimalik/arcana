import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTemplate } from "@/lib/agent/templates";
import { agentSessionQueue } from "@/lib/agent/session-queue";
import type { AgentEvent, AgentSessionData } from "@/lib/agent/types";
import { requireUserId } from "@/lib/paper-auth";

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
  const userId = await requireUserId();
    const { id } = await params;

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

  // Validate paper exists
  const paper = await prisma.paper.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  // Validate template if provided
  if (templateId && !getTemplate(templateId)) {
    return NextResponse.json({ error: "Unknown template" }, { status: 400 });
  }

  if (!templateId && !customPrompt) {
    return NextResponse.json(
      { error: "Provide templateId or customPrompt" },
      { status: 400 }
    );
  }

  // Check for existing active session
  const existing = await prisma.agentSession.findFirst({
    where: {
      paperId: id,
      status: { in: ["PENDING", "RUNNING"] },
    },
  });

  if (existing) {
    return NextResponse.json(
      { error: "An agent session is already running for this paper", sessionId: existing.id },
      { status: 409 }
    );
  }

  // Create session row
  const session = await prisma.agentSession.create({
    data: {
      paperId: id,
      templateId: templateId ?? null,
      customPrompt: customPrompt ?? null,
      mode,
    },
  });

  // Fire and forget
  agentSessionQueue.enqueue(session.id, id, options ? { attachPath: options.attachPath } : undefined);

  return NextResponse.json({ sessionId: session.id }, { status: 202 });
}

/**
 * GET — Return session data.
 * ?sessionId=<id> — specific session
 * ?all=true — all sessions for this paper (most recent first)
 * Default — latest session for this paper
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");
  const all = searchParams.get("all");

  if (all) {
    const sessions = await prisma.agentSession.findMany({
      where: { paperId: id },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(sessions.map(toSessionData));
  }

  const where = sessionId
    ? { id: sessionId }
    : { paperId: id };

  const session = await prisma.agentSession.findFirst({
    where,
    orderBy: { createdAt: "desc" },
  });

  if (!session) {
    return NextResponse.json(null);
  }

  return NextResponse.json(toSessionData(session));
}

/**
 * DELETE — Cancel a running session.
 * ?sessionId=<id> — specific session to cancel
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");

  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  // Verify session belongs to this paper
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
    // Queue didn't have it — update DB directly
    await prisma.agentSession.update({
      where: { id: sessionId },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
      },
    });
  }

  return NextResponse.json({ ok: true });
}
