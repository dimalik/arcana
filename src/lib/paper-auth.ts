import { prisma } from "./prisma";
import { getCurrentUser } from "./auth";

/**
 * Get the current user's ID. Throws if not authenticated.
 */
export async function requireUserId(): Promise<string> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  return user.id;
}

/**
 * Verify a paper belongs to the current user.
 * Returns the paper if it exists and belongs to the user, null otherwise.
 */
export async function requirePaperAccess(paperId: string) {
  const userId = await requireUserId();
  const paper = await prisma.paper.findFirst({
    where: { id: paperId, userId },
  });
  return paper;
}
