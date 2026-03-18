import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

export const dynamic = "force-dynamic";

export async function GET() {
  const setting = await prisma.setting.findUnique({
    where: { key: "pdf_layout" },
  });

  return NextResponse.json({
    layout: setting?.value || "split",
  });
}

const updateSchema = z.object({
  layout: z.enum(["off", "replace", "split"]),
});

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { layout } = updateSchema.parse(body);

    await prisma.setting.upsert({
      where: { key: "pdf_layout" },
      create: { key: "pdf_layout", value: layout },
      update: { value: layout },
    });

    return NextResponse.json({ layout });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
