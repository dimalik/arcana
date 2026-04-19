import { PaperDuplicateState } from "../../generated/prisma/enums";

export const PAPER_DUPLICATE_STATE_HEADER = "X-Paper-Duplicate-State";
export const PAPER_COLLAPSED_INTO_HEADER = "X-Paper-Collapsed-Into-Paper-Id";

export type PaperDuplicateStateSignal = "active" | "hidden" | "archived" | "collapsed";

export function toPaperDuplicateStateSignal(
  state: PaperDuplicateState | null | undefined,
): PaperDuplicateStateSignal {
  switch (state) {
    case PaperDuplicateState.HIDDEN:
      return "hidden";
    case PaperDuplicateState.ARCHIVED:
      return "archived";
    case PaperDuplicateState.COLLAPSED:
      return "collapsed";
    case PaperDuplicateState.ACTIVE:
    default:
      return "active";
  }
}

export function isCollapsedDuplicateState(
  state: PaperDuplicateState | PaperDuplicateStateSignal | null | undefined,
): boolean {
  return state === PaperDuplicateState.COLLAPSED || state === "collapsed";
}
