import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type StepOrderDb = Prisma.TransactionClient | typeof prisma;

export async function reserveResearchStepSortOrders(
  db: StepOrderDb,
  iterationId: string,
  count = 1,
): Promise<number[]> {
  if (count < 1) return [];

  const updatedIteration = await db.researchIteration.update({
    where: { id: iterationId },
    data: {
      nextStepSortOrder: { increment: count },
    },
    select: { nextStepSortOrder: true },
  });

  const start = updatedIteration.nextStepSortOrder - count;
  return Array.from({ length: count }, (_, index) => start + index);
}

export async function reserveNextResearchStepSortOrder(
  db: StepOrderDb,
  iterationId: string,
): Promise<number> {
  const [sortOrder] = await reserveResearchStepSortOrders(db, iterationId, 1);
  return sortOrder;
}
