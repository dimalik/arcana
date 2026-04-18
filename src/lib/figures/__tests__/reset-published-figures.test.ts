import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paperFigure: {
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { resetPublishedFiguresForPaper } from "../reset-published-figures";

describe("resetPublishedFiguresForPaper", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires a caller context", async () => {
    await expect(
      resetPublishedFiguresForPaper("paper-1", {} as never),
    ).rejects.toThrow("resetPublishedFiguresForPaper requires a caller context");

    expect(prisma.paperFigure.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes published figures through the sanctioned helper", async () => {
    vi.mocked(prisma.paperFigure.deleteMany).mockResolvedValue({ count: 4 } as never);

    await expect(
      resetPublishedFiguresForPaper("paper-1", { context: "acceptance-script-reset" }),
    ).resolves.toEqual({ deletedCount: 4 });

    expect(prisma.paperFigure.deleteMany).toHaveBeenCalledWith({
      where: { paperId: "paper-1" },
    });
  });
});
