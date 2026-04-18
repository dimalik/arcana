import { prisma } from "@/lib/prisma";

const completedPaperMissingAnalysisWhere = (userId: string) => ({
  userId,
  processingStatus: "COMPLETED",
  fullText: { not: null },
  keyFindings: null,
});

export async function countCompletedPapersNeedingFullReprocess(
  userId: string,
): Promise<number> {
  return prisma.paper.count({
    where: completedPaperMissingAnalysisWhere(userId),
  });
}

export async function findCompletedPapersNeedingFullReprocess(
  userId: string,
): Promise<Array<{ id: string }>> {
  return prisma.paper.findMany({
    where: completedPaperMissingAnalysisWhere(userId),
    select: { id: true },
  });
}
