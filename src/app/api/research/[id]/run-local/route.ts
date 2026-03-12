import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { spawn } from "child_process";
import path from "path";

type Params = { params: Promise<{ id: string }> };

/**
 * POST — Run a command locally in the project's output directory.
 * Used when migrating a running remote job to local execution.
 *
 * Body: { command: string, workDir?: string, cancelJobId?: string }
 *
 * If cancelJobId is provided, cancels the remote job first.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id: projectId } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id: projectId, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const { command, workDir, cancelJobId } = body as {
      command: string;
      workDir?: string;
      cancelJobId?: string;
    };

    if (!command) {
      return NextResponse.json({ error: "command is required" }, { status: 400 });
    }

    // Cancel remote job if requested
    if (cancelJobId) {
      const { cancelRemoteJob } = await import("@/lib/research/remote-executor");
      await cancelRemoteJob(cancelJobId).catch((err) => {
        console.warn(`[run-local] Failed to cancel remote job ${cancelJobId}:`, err);
      });
    }

    // Determine working directory — use provided workDir or project output dir
    const outputDir = workDir || path.join(process.cwd(), "output", projectId);

    // Strip timeout wrappers that the agent may have added for remote execution
    const cleanCommand = command
      .replace(/^timeout\s+\d+[smh]?\s+/, "")
      .replace(/;\s*echo\s+\$\?\s*>\s*\.exit_code\s*$/, "")
      .trim();

    // Spawn the process in the background
    const proc = spawn("bash", ["-c", cleanCommand], {
      cwd: outputDir,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pid = proc.pid;

    // Write stdout/stderr to log files
    const fs = await import("fs/promises");
    const stdoutPath = path.join(outputDir, "stdout.log");
    const stderrPath = path.join(outputDir, "stderr.log");

    // Clear previous logs
    await fs.writeFile(stdoutPath, "").catch(() => {});
    await fs.writeFile(stderrPath, "").catch(() => {});

    proc.stdout?.on("data", (chunk: Buffer) => {
      fs.appendFile(stdoutPath, chunk).catch(() => {});
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      fs.appendFile(stderrPath, chunk).catch(() => {});
    });

    // Log entry
    await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "observation",
        content: `Moved experiment to local execution: \`${cleanCommand.slice(0, 100)}\` (PID: ${pid})`,
      },
    });

    // Track completion in background
    proc.on("close", async (code) => {
      try {
        const stdout = await fs.readFile(stdoutPath, "utf-8").catch(() => "");
        await prisma.researchLogEntry.create({
          data: {
            projectId,
            type: code === 0 ? "observation" : "dead_end",
            content: code === 0
              ? `Local experiment completed successfully:\n\`\`\`\n${stdout.trim().split("\n").slice(-10).join("\n")}\n\`\`\``
              : `Local experiment failed (exit ${code})`,
          },
        });
      } catch (err) {
        console.error("[run-local] completion tracking error:", err);
      }
    });

    // Unref so the process survives if the request handler ends
    proc.unref();

    return NextResponse.json({
      status: "RUNNING",
      pid,
      command: cleanCommand,
      workDir: outputDir,
    });
  } catch (err) {
    console.error("[run-local] POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to run locally" },
      { status: 500 },
    );
  }
}
