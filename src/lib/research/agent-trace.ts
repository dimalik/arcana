import { prisma } from "@/lib/prisma";

export interface PersistableAgentTraceEvent {
  type: "text" | "tool_call" | "tool_result" | "tool_progress" | "tool_output" | "step_done" | "thinking" | "error" | "done" | "heartbeat";
  content?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  stepNumber?: number;
  activity?: {
    phase: "generating" | "tool_running" | "thinking" | "idle";
    tokens?: number;
    tool?: string;
    stepCount?: number;
    lastEventAgoMs?: number;
  };
}

function truncateText(value: string | null | undefined, limit = 8000): string | null {
  if (!value) return null;
  return value.length > limit ? `${value.slice(0, limit)}…[truncated]` : value;
}

function safeJson(value: unknown, limit = 16000): string | null {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > limit ? `${serialized.slice(0, limit)}…[truncated]` : serialized;
  } catch {
    return truncateText(String(value), limit);
  }
}

export function shouldPersistAgentTraceEvent(event: PersistableAgentTraceEvent): boolean {
  return event.type !== "heartbeat";
}

export async function appendAgentTraceEvent(params: {
  projectId: string;
  runId: string;
  sessionNumber: number;
  sequence: number;
  event: PersistableAgentTraceEvent;
}) {
  const { projectId, runId, sessionNumber, sequence, event } = params;
  await prisma.agentTraceEvent.create({
    data: {
      projectId,
      runId,
      sessionNumber,
      sequence,
      eventType: event.type,
      stepNumber: event.stepNumber ?? event.activity?.stepCount ?? null,
      toolName: event.toolName || null,
      toolCallId: event.toolCallId || null,
      content: truncateText(event.content),
      argsJson: safeJson(event.args),
      resultJson: safeJson(event.result),
      activityJson: safeJson(event.activity),
      metadata: safeJson({
        persistedAt: new Date().toISOString(),
      }),
    },
  });
}

export async function listAgentTraceEvents(params: {
  projectId: string;
  runId?: string | null;
  limit?: number;
}) {
  const limit = Math.max(1, Math.min(params.limit ?? 200, 1000));
  return prisma.agentTraceEvent.findMany({
    where: {
      projectId: params.projectId,
      ...(params.runId ? { runId: params.runId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { sequence: "desc" }],
    take: limit,
  });
}
