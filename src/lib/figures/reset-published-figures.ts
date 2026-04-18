import { prisma } from "@/lib/prisma";

export type ResetPublishedFiguresContext = "acceptance-script-reset";

/**
 * Sanctioned reset API for narrow test/operator flows that need to clear the
 * published compatibility cache before rebuilding it through the normal
 * publication path.
 */
export async function resetPublishedFiguresForPaper(
  paperId: string,
  options: { context: ResetPublishedFiguresContext },
): Promise<{ deletedCount: number }> {
  if (!options?.context) {
    throw new Error("resetPublishedFiguresForPaper requires a caller context");
  }

  const result = await prisma.paperFigure.deleteMany({
    where: { paperId },
  });

  return { deletedCount: result.count };
}
