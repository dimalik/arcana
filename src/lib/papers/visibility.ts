import type { Prisma } from "../../generated/prisma/client";
import { PaperDuplicateState } from "../../generated/prisma/enums";

export function paperVisibilityWhere(userId: string): Prisma.PaperWhereInput {
  return {
    userId,
    duplicateState: PaperDuplicateState.ACTIVE,
  };
}

export function mergePaperVisibilityWhere(
  userId: string,
  where: Prisma.PaperWhereInput = {},
): Prisma.PaperWhereInput {
  return {
    AND: [paperVisibilityWhere(userId), where],
  };
}

export function isUserVisiblePaper(
  paper:
    | {
        duplicateState?: PaperDuplicateState | null;
      }
    | null
    | undefined,
): boolean {
  if (!paper) return false;
  return paper.duplicateState === PaperDuplicateState.ACTIVE;
}
