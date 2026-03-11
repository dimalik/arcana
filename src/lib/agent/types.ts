export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool"; name: string; input: string }
  | { type: "tool_result"; name: string }
  | { type: "done"; cost?: number; duration?: number; turns?: number }
  | { type: "error"; message: string };

export type AgentSessionStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface AgentSessionData {
  id: string;
  paperId: string;
  templateId: string | null;
  customPrompt: string | null;
  mode: string;
  status: AgentSessionStatus;
  events: AgentEvent[];
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}
