import { describe, expect, it } from "vitest";
import { PaperDuplicateState } from "../../generated/prisma/enums";
import { isUserVisiblePaper, mergePaperVisibilityWhere, paperVisibilityWhere } from "./visibility";

describe("paperVisibilityWhere", () => {
  it("filters to active papers for a user", () => {
    expect(paperVisibilityWhere("user-1")).toEqual({
      userId: "user-1",
      duplicateState: PaperDuplicateState.ACTIVE,
    });
  });

  it("merges visibility with caller filters", () => {
    expect(
      mergePaperVisibilityWhere("user-1", {
        processingStatus: "COMPLETED",
      }),
    ).toEqual({
      AND: [
        {
          userId: "user-1",
          duplicateState: PaperDuplicateState.ACTIVE,
        },
        {
          processingStatus: "COMPLETED",
        },
      ],
    });
  });
});

describe("isUserVisiblePaper", () => {
  it("returns true for active papers", () => {
    expect(isUserVisiblePaper({ duplicateState: PaperDuplicateState.ACTIVE })).toBe(true);
  });

  it("returns false for non-active duplicate states", () => {
    expect(isUserVisiblePaper({ duplicateState: PaperDuplicateState.HIDDEN })).toBe(false);
    expect(isUserVisiblePaper({ duplicateState: PaperDuplicateState.ARCHIVED })).toBe(false);
    expect(isUserVisiblePaper({ duplicateState: PaperDuplicateState.COLLAPSED })).toBe(false);
  });
});
