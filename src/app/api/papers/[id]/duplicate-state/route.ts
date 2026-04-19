import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PaperDuplicateState } from "@/generated/prisma/enums";
import { paperAccessErrorToResponse, requirePaperAccess } from "@/lib/paper-auth";
import { restorePaperDuplicateState } from "@/lib/papers/duplicate-candidates";
import { prisma } from "@/lib/prisma";

const updateDuplicateStateSchema = z.object({
  duplicateState: z.nativeEnum(PaperDuplicateState),
  collapsedIntoPaperId: z.string().min(1).nullable().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, { mode: "duplicate_state" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const body = await request.json();
    const input = updateDuplicateStateSchema.parse(body);

    if (input.duplicateState === PaperDuplicateState.ACTIVE) {
      await restorePaperDuplicateState(access.userId, id);
      return NextResponse.json({ success: true, duplicateState: "active" });
    }

    await prisma.paper.update({
      where: { id },
      data: {
        duplicateState: input.duplicateState,
        collapsedIntoPaperId:
          input.duplicateState === PaperDuplicateState.COLLAPSED
            ? (input.collapsedIntoPaperId ?? access.collapsedIntoPaperId)
            : null,
      },
    });

    return NextResponse.json({
      success: true,
      duplicateState: input.duplicateState.toLowerCase(),
      collapsedIntoPaperId:
        input.duplicateState === PaperDuplicateState.COLLAPSED
          ? (input.collapsedIntoPaperId ?? access.collapsedIntoPaperId)
          : null,
    });
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 },
      );
    }

    console.error("Update duplicate state error:", error);
    return NextResponse.json(
      { error: "Failed to update duplicate state" },
      { status: 500 },
    );
  }
}
