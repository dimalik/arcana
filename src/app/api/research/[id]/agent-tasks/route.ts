import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;

  // Defensive: agentTask may not exist on stale Prisma client after schema change
  if (!(prisma as unknown as Record<string, unknown>).agentTask) {
    return NextResponse.json({ tasks: [] });
  }

  try {
    const tasks = await prisma.agentTask.findMany({
      where: { projectId },
      select: {
        id: true,
        role: true,
        goal: true,
        status: true,
        createdAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return NextResponse.json({ tasks });
  } catch {
    // Table may not exist yet if migration hasn't run
    return NextResponse.json({ tasks: [] });
  }
}
