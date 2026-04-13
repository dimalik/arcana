import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import {
  startResearchAgent,
  isAgentRunning,
  requestAgentStop,
  type ResearchAgentRuntimeOptions,
} from "@/lib/research/agent";

// Allow long-running SSE streams (45 minutes)
export const maxDuration = 2700;

type Params = { params: Promise<{ id: string }> };

interface AgentStartBody {
  message?: string;
  disable_auto_continue?: boolean;
  mock_llm_fixture?: string;
  mock_executor?: {
    enabled?: boolean;
    mode?: "success" | "failure";
    write_result_file?: boolean;
  };
}

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
    const previousStatus = project.status;

    let userMessage: string | undefined;
    let runtimeOptions: ResearchAgentRuntimeOptions | undefined;
    try {
      const body = (await request.json()) as AgentStartBody;
      userMessage = body.message;

      const requestedTestMode =
        !!body.disable_auto_continue ||
        !!body.mock_llm_fixture ||
        !!body.mock_executor?.enabled;

      if (requestedTestMode && process.env.NODE_ENV === "production") {
        return NextResponse.json(
          { error: "Test runtime options are disabled in production." },
          { status: 400 },
        );
      }

      if (requestedTestMode) {
        runtimeOptions = {
          disableAutoContinue: !!body.disable_auto_continue,
          mockLlmFixtureId: body.mock_llm_fixture || undefined,
          mockExecutor: body.mock_executor?.enabled
            ? {
                enabled: true,
                mode: body.mock_executor.mode || "success",
                writeResultFile: body.mock_executor.write_result_file !== false,
              }
            : undefined,
        };
      }
    } catch {
      // No body is fine — agent starts with default prompt
    }

    let stream: ReadableStream<Uint8Array>;
    try {
      await prisma.researchProject.update({
        where: { id },
        data: { status: "ACTIVE" },
      });
      stream = startResearchAgent(id, userId, userMessage, runtimeOptions);
    } catch (startErr) {
      await prisma.researchProject.update({
        where: { id },
        data: { status: previousStatus },
      }).catch((rollbackErr) => {
        console.error("[api/research/agent] Failed to roll back project status after startup failure:", rollbackErr);
      });
      throw startErr;
    }

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
  const userId = await requireUserId();
  const { id } = await params;
  const project = await prisma.researchProject.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({ running: isAgentRunning(id) });
}

/**
 * DELETE — Request the agent to stop after the current step.
 * The agent will finish its current LLM call/tool execution, then stop.
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const userId = await requireUserId();
  const { id } = await params;
  const project = await prisma.researchProject.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const stopped = requestAgentStop(id);
  return NextResponse.json({ stopped });
}
