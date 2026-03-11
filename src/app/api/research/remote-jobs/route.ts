import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { submitRemoteJob } from "@/lib/research/remote-executor";

// GET — List remote jobs, optionally filtered by projectId or stepId
export async function GET(request: NextRequest) {
  try {
    await requireUserId();
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    const stepId = searchParams.get("stepId");

    const where: Record<string, unknown> = {};
    if (projectId) where.projectId = projectId;
    if (stepId) where.stepId = stepId;

    const jobs = await prisma.remoteJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        host: { select: { alias: true, gpuType: true, host: true } },
      },
    });

    return NextResponse.json(jobs);
  } catch (err) {
    return NextResponse.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }
}

// POST — Submit a new remote job
export async function POST(request: NextRequest) {
  try {
    await requireUserId();
    const body = await request.json();

    const { hostId, localDir, command, stepId, projectId } = body as {
      hostId: string;
      localDir: string;
      command: string;
      stepId?: string;
      projectId?: string;
    };

    if (!hostId || !localDir || !command) {
      return NextResponse.json(
        { error: "hostId, localDir, and command are required" },
        { status: 400 },
      );
    }

    const result = await submitRemoteJob({ hostId, localDir, command, stepId, projectId });
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to submit job" },
      { status: 500 },
    );
  }
}
