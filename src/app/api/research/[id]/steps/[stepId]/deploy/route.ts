import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { submitRemoteJob } from "@/lib/research/remote-executor";
import path from "path";
import { access } from "fs/promises";

type Params = { params: Promise<{ id: string; stepId: string }> };

/**
 * POST — Deploy a step to a remote host.
 *
 * Uses the project's output directory (where the agent writes files via write_file)
 * and syncs it to the remote host for execution.
 *
 * Body: { hostId: string, command?: string }
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id, stepId } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const step = await prisma.researchStep.findUnique({ where: { id: stepId } });
    if (!step) {
      return NextResponse.json({ error: "Step not found" }, { status: 400 });
    }

    const body = await request.json();
    const { hostId, command } = body as { hostId: string; command?: string };

    if (!hostId) {
      return NextResponse.json({ error: "hostId is required" }, { status: 400 });
    }

    // Resolve the project's working directory (same logic as agent.ts)
    const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    const localDir = project.outputFolder || path.join(process.cwd(), "output", "research", slug);

    // Verify directory exists
    try {
      await access(localDir);
    } catch {
      return NextResponse.json(
        { error: `Output directory not found: ${localDir}. Run the agent first to generate experiment code.` },
        { status: 400 },
      );
    }

    // Figure out the command to run
    let runCmd = command;
    if (!runCmd) {
      // Try to extract filename from step output
      let filename = "experiment.py";
      try {
        const output = JSON.parse(step.output || "{}");
        if (output.filename) {
          filename = output.filename;
        }
      } catch { /* use default */ }

      // The Arcana helper handles venv + pip install automatically — just run the script
      runCmd = `python3 ${filename}`;
    }

    // Submit the remote job
    const result = await submitRemoteJob({
      hostId,
      localDir,
      command: runCmd,
      stepId,
      projectId: id,
    });

    await prisma.researchLogEntry.create({
      data: {
        projectId: id,
        type: "decision",
        content: `Manually deployed to remote: ${runCmd}`,
      },
    });

    return NextResponse.json({ jobId: result.jobId, localDir }, { status: 202 });
  } catch (err) {
    console.error("[api/research/steps/deploy] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to deploy" },
      { status: 500 },
    );
  }
}
