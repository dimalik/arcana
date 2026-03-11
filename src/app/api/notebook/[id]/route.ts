import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { requireUserId } from "@/lib/paper-auth";

const updateEntrySchema = z.object({
  annotation: z.string().nullable().optional(),
  content: z.string().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireUserId();
    const existing = await prisma.notebookEntry.findFirst({
      where: { id: params.id, paper: { userId } },
    });
    if (!existing) {
      return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    }

    const body = await request.json();
    const data = updateEntrySchema.parse(body);

    const entry = await prisma.notebookEntry.update({
      where: { id: params.id },
      data,
    });
    return NextResponse.json(entry);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update notebook entry" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireUserId();
    const existing = await prisma.notebookEntry.findFirst({
      where: { id: params.id, paper: { userId } },
    });
    if (!existing) {
      return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    }
    await prisma.notebookEntry.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete notebook entry" },
      { status: 500 }
    );
  }
}
