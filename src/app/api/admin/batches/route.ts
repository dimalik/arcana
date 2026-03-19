import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const [batches, missingPdfs, totalNoPdf, libraryNoPdf, researchNoPdf] = await Promise.all([
    prisma.processingBatch.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        groupId: true,
        phase: true,
        status: true,
        requestCount: true,
        completedCount: true,
        failedCount: true,
        createdAt: true,
        completedAt: true,
      },
    }),
    prisma.paper.count({
      where: {
        filePath: null,
        OR: [{ arxivId: { not: null } }, { doi: { not: null } }],
      },
    }),
    prisma.paper.count({ where: { filePath: null } }),
    prisma.paper.count({ where: { filePath: null, isResearchOnly: false } }),
    prisma.paper.count({ where: { filePath: null, isResearchOnly: true } }),
  ]);

  // Aggregate by status
  const summary = {
    processing: 0,
    submitted: 0,
    completed: 0,
    failed: 0,
    totalRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
  };

  for (const b of batches) {
    const s = b.status.toLowerCase();
    if (s === "processing") summary.processing++;
    else if (s === "submitted") summary.submitted++;
    else if (s === "completed") summary.completed++;
    else if (s === "failed") summary.failed++;
    summary.totalRequests += b.requestCount;
    summary.completedRequests += b.completedCount;
    summary.failedRequests += b.failedCount;
  }

  return NextResponse.json({
    summary,
    missingPdfs: {
      repairable: missingPdfs,
      total: totalNoPdf,
      library: libraryNoPdf,
      research: researchNoPdf,
    },
    batches: batches.map((b) => ({
      ...b,
      createdAt: new Date(Number(b.createdAt)).toISOString(),
      completedAt: b.completedAt ? new Date(Number(b.completedAt)).toISOString() : null,
    })),
  });
}
