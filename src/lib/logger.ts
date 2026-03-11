import { prisma } from "./prisma";

type LogLevel = "error" | "warn" | "info";
type LogCategory =
  | "llm"
  | "api"
  | "import"
  | "synthesis"
  | "auth"
  | "system";

interface LogContext {
  userId?: string;
  category: LogCategory;
  metadata?: Record<string, unknown>;
}

function formatMessage(
  level: LogLevel,
  category: string,
  message: string
): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.toUpperCase()}] [${category}] ${message}`;
}

async function persist(
  level: LogLevel,
  category: LogCategory,
  message: string,
  userId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.appEvent.create({
      data: {
        userId: userId || null,
        level,
        category,
        message: message.slice(0, 5000),
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
    });
  } catch {
    // Last resort — don't crash if logging fails
    console.error("[logger] Failed to persist event to DB");
  }
}

export const logger = {
  info(message: string, ctx: LogContext) {
    console.log(formatMessage("info", ctx.category, message));
    // Only persist info events if there's meaningful metadata
    if (ctx.metadata) {
      persist("info", ctx.category, message, ctx.userId, ctx.metadata);
    }
  },

  warn(message: string, ctx: LogContext) {
    console.warn(formatMessage("warn", ctx.category, message));
    persist("warn", ctx.category, message, ctx.userId, ctx.metadata);
  },

  error(message: string, ctx: LogContext & { error?: unknown }) {
    const errMsg =
      ctx.error instanceof Error ? ctx.error.message : String(ctx.error ?? "");
    const stack =
      ctx.error instanceof Error ? ctx.error.stack : undefined;

    const full = errMsg ? `${message}: ${errMsg}` : message;
    console.error(formatMessage("error", ctx.category, full));

    persist("error", ctx.category, full, ctx.userId, {
      ...ctx.metadata,
      ...(stack ? { stack: stack.slice(0, 3000) } : {}),
    });
  },
};

// ── Query helpers for admin ──────────────────────────────────────

export async function getRecentEvents(
  limit = 50,
  level?: LogLevel,
  category?: LogCategory
) {
  return prisma.appEvent.findMany({
    where: {
      ...(level ? { level } : {}),
      ...(category ? { category } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      user: { select: { id: true, email: true, name: true } },
    },
  });
}
