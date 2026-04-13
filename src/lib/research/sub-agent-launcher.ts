import { prisma } from "@/lib/prisma";

async function failPendingAgentTask(taskId: string, reason: string) {
  try {
    await prisma.agentTask.updateMany({
      where: {
        id: taskId,
        status: { in: ["PENDING", "RUNNING"] },
      },
      data: {
        status: "FAILED",
        error: reason.slice(0, 1000),
        completedAt: new Date(),
      },
    });
  } catch (err) {
    console.error(`[sub-agent-launcher] Failed to mark task ${taskId} as FAILED:`, err);
  }
}

export async function launchSubAgentTask(taskId: string, context = "sub-agent-launcher"): Promise<void> {
  try {
    const { runSubAgent } = await import("./sub-agent");
    await runSubAgent(taskId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${context}] Task ${taskId} failed to launch or execute:`, err);
    await failPendingAgentTask(taskId, message || "Sub-agent launch failed");
    throw err;
  }
}
