import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { startResearchAgent, isAgentRunning, requestAgentStop } from "@/lib/research/agent";

// Allow long-running SSE streams (45 minutes)
export const maxDuration = 2700;

type Params = { params: Promise<{ id: string }> };

/**
 * POST — Start the research agent (or reconnect to a running one).
 * Returns an SSE stream of agent events.
 *
 * Body (optional): { message?: string }
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    let userMessage: string | undefined;
    try {
      const body = await request.json();
      userMessage = body.message;
    } catch {
      // No body is fine — agent starts with default prompt
    }

    // Update project status
    await prisma.researchProject.update({
      where: { id },
      data: { status: "ACTIVE" },
    });

    // startResearchAgent handles both new starts and reconnections
    const stream = startResearchAgent(id, userId, userMessage);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    console.error("[api/research/agent] POST error:", err);
    return NextResponse.json({ error: "Failed to start agent" }, { status: 500 });
  }
}

/**
 * GET — Check if the agent is currently running for this project.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  return NextResponse.json({ running: isAgentRunning(id) });
}

/**
 * DELETE — Request the agent to stop after the current step.
 * The agent will finish its current LLM call/tool execution, then stop.
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const stopped = requestAgentStop(id);
  return NextResponse.json({ stopped });
}
