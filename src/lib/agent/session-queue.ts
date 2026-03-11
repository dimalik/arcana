import { prisma } from "@/lib/prisma";
import { getTemplate, type AgentMode, type AgentTemplateContext } from "./templates";
import { buildSystemPrompt, ANALYZE_TOOLS, MODIFY_TOOLS } from "./prompt";
import type { AgentEvent } from "./types";

const STALL_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const FLUSH_INTERVAL = 5; // flush events to DB every N events

class AgentSessionQueue {
  private running = new Map<string, AbortController>(); // sessionId -> abort
  private sessionOptions = new Map<string, AgentTemplateContext>(); // sessionId -> extra options
  private initialized = false;

  enqueue(sessionId: string, paperId: string, options?: AgentTemplateContext): void {
    if (options) {
      this.sessionOptions.set(sessionId, options);
    }
    if (!this.initialized) {
      this.initialized = true;
      this.recoverStalled().catch((e) =>
        console.error("[agent-queue] Stall recovery failed:", e)
      );
    }

    if (this.running.has(sessionId)) return;

    console.log(`[agent-queue] Enqueued session ${sessionId} for paper ${paperId}`);
    this.processSession(sessionId).catch((e) =>
      console.error(`[agent-queue] Unhandled error in session ${sessionId}:`, e)
    );
  }

  async cancel(sessionId: string): Promise<boolean> {
    const controller = this.running.get(sessionId);
    if (controller) {
      console.log(`[agent-queue] Cancelling session ${sessionId}`);
      controller.abort();
      return true;
    }
    return false;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  private async processSession(sessionId: string): Promise<void> {
    const abortController = new AbortController();
    this.running.set(sessionId, abortController);
    const startTime = Date.now();

    try {
      // Mark RUNNING
      await prisma.agentSession.update({
        where: { id: sessionId },
        data: { status: "RUNNING", startedAt: new Date() },
      });

      // Load session + paper
      const session = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        include: {
          paper: {
            select: { id: true, title: true, abstract: true, fullText: true },
          },
        },
      });

      if (!session || !session.paper) {
        throw new Error("Session or paper not found");
      }

      // Resolve prompt
      const outputFolderSetting = await prisma.setting.findUnique({
        where: { key: "output_folder" },
      });
      const outputFolder = outputFolderSetting?.value || "./output";

      let userPrompt: string;
      let effectiveMode: AgentMode = session.mode as AgentMode;
      const extraOptions = this.sessionOptions.get(sessionId);
      this.sessionOptions.delete(sessionId); // clean up

      if (session.templateId) {
        const template = getTemplate(session.templateId);
        if (!template) throw new Error(`Unknown template: ${session.templateId}`);
        userPrompt = template.promptBuilder(session.paper, {
          outputFolder,
          ...extraOptions,
        });
        effectiveMode = template.mode;
      } else if (session.customPrompt) {
        userPrompt = session.customPrompt;
      } else {
        throw new Error("No templateId or customPrompt");
      }

      const systemPrompt = buildSystemPrompt(session.paper, effectiveMode);
      const allowedTools =
        effectiveMode === "modify" ? MODIFY_TOOLS : ANALYZE_TOOLS;
      // Code generation needs more turns for writing files, running tests, fixing errors
      const isCodeGen = session.templateId === "generate-code";
      const maxTurns = isCodeGen ? 40 : effectiveMode === "modify" ? 25 : 15;

      // Check API key (DB-backed, with env fallback)
      const { getApiKey } = await import("@/lib/llm/api-keys");
      const anthropicKey = await getApiKey("anthropic");
      if (!anthropicKey) {
        throw new Error("Anthropic API key is not configured. Set it in Settings → LLM.");
      }
      process.env.ANTHROPIC_API_KEY = anthropicKey;

      // Run the agent
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      const q = query({
        prompt: userPrompt,
        options: {
          systemPrompt,
          tools: allowedTools,
          allowedTools,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns,
          cwd: process.cwd(),
          abortController,
          persistSession: false,
        },
      });

      const events: AgentEvent[] = [];
      let unflushed = 0;

      for await (const message of q) {
        if (abortController.signal.aborted) {
          q.close();
          break;
        }

        if (message.type === "assistant" && message.message?.content) {
          for (const block of message.message.content) {
            if ("text" in block && block.text) {
              events.push({ type: "text", content: block.text });
              unflushed++;
            } else if ("name" in block) {
              events.push({
                type: "tool",
                name: block.name,
                input:
                  typeof block.input === "string"
                    ? block.input
                    : JSON.stringify(block.input, null, 2),
              });
              unflushed++;
            }
          }
        } else if (message.type === "user") {
          if (message.tool_use_result) {
            const results = Array.isArray(message.tool_use_result)
              ? message.tool_use_result
              : [message.tool_use_result];
            for (const _r of results) {
              events.push({ type: "tool_result", name: "tool" });
              unflushed++;
            }
          }
        } else if (message.type === "result") {
          if (message.is_error && "errors" in message) {
            for (const errMsg of message.errors) {
              events.push({ type: "error", message: errMsg });
            }
          }
          events.push({
            type: "done",
            cost: message.total_cost_usd,
            duration: message.duration_ms,
            turns: message.num_turns,
          });
          unflushed++;
        }

        // Periodic flush
        if (unflushed >= FLUSH_INTERVAL) {
          await this.flushEvents(sessionId, events);
          unflushed = 0;
        }
      }

      // Check if aborted
      if (abortController.signal.aborted) {
        await prisma.agentSession.update({
          where: { id: sessionId },
          data: {
            status: "CANCELLED",
            events: JSON.stringify(events),
            completedAt: new Date(),
            durationMs: Date.now() - startTime,
          },
        });
        return;
      }

      // Final flush — COMPLETED
      const doneEvent = events.find((e) => e.type === "done") as
        | Extract<AgentEvent, { type: "done" }>
        | undefined;

      await prisma.agentSession.update({
        where: { id: sessionId },
        data: {
          status: "COMPLETED",
          events: JSON.stringify(events),
          costUsd: doneEvent?.cost ?? null,
          durationMs: doneEvent?.duration ?? Date.now() - startTime,
          turns: doneEvent?.turns ?? null,
          completedAt: new Date(),
        },
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Agent execution failed";
      console.error(`[agent-queue] Session ${sessionId} failed:`, message);

      try {
        await prisma.agentSession.update({
          where: { id: sessionId },
          data: {
            status: abortController.signal.aborted ? "CANCELLED" : "FAILED",
            error: message,
            completedAt: new Date(),
            durationMs: Date.now() - startTime,
          },
        });
      } catch {
        // Session may have been deleted
      }
    } finally {
      this.running.delete(sessionId);
    }
  }

  private async flushEvents(
    sessionId: string,
    events: AgentEvent[]
  ): Promise<void> {
    try {
      await prisma.agentSession.update({
        where: { id: sessionId },
        data: { events: JSON.stringify(events) },
      });
    } catch {
      // Ignore flush errors (session may have been deleted)
    }
  }

  async recoverStalled(): Promise<void> {
    const stallCutoff = new Date(Date.now() - STALL_THRESHOLD_MS);

    const stalled = await prisma.agentSession.findMany({
      where: {
        status: { in: ["PENDING", "RUNNING"] },
        OR: [
          { startedAt: { lt: stallCutoff } },
          { startedAt: null, createdAt: { lt: stallCutoff } },
        ],
      },
      select: { id: true, status: true },
    });

    if (stalled.length > 0) {
      console.log(
        `[agent-queue] Recovering ${stalled.length} stalled sessions:`,
        stalled.map((s) => s.id)
      );

      for (const session of stalled) {
        await prisma.agentSession.update({
          where: { id: session.id },
          data: {
            status: "FAILED",
            error: "Session stalled and was automatically recovered",
            completedAt: new Date(),
          },
        });
      }
    }
  }
}

// Singleton — survives HMR in development via globalThis
const globalForQueue = globalThis as unknown as {
  agentSessionQueue: AgentSessionQueue | undefined;
};

export const agentSessionQueue =
  globalForQueue.agentSessionQueue ?? new AgentSessionQueue();

if (process.env.NODE_ENV !== "production") {
  globalForQueue.agentSessionQueue = agentSessionQueue;
}
