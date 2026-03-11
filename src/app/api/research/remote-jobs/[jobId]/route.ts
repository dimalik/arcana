import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { cancelRemoteJob } from "@/lib/research/remote-executor";

type Params = { params: Promise<{ jobId: string }> };

// GET — Get job status and logs
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireUserId();
    const { jobId } = await params;

    const job = await prisma.remoteJob.findUnique({
      where: { id: jobId },
      include: {
        host: { select: { alias: true, gpuType: true, host: true } },
      },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    return NextResponse.json(job);
  } catch (err) {
    return NextResponse.json({ error: "Failed to fetch job" }, { status: 500 });
  }
}

// DELETE — Cancel a running job
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    await requireUserId();
    const { jobId } = await params;

    await cancelRemoteJob(jobId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to cancel job" },
      { status: 500 },
    );
  }
}
