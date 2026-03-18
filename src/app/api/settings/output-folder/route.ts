import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

export const dynamic = "force-dynamic";

const SETTING_KEY = "output_folder";
const DEFAULT_FOLDER = "./output";

export async function GET() {
  const setting = await prisma.setting.findUnique({
    where: { key: SETTING_KEY },
  });

  return NextResponse.json({
    folder: setting?.value || DEFAULT_FOLDER,
  });
}

const updateSchema = z.object({
  folder: z.string().min(1, "Folder path is required"),
});

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { folder } = updateSchema.parse(body);

    await prisma.setting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value: folder },
      update: { value: folder },
    });

    return NextResponse.json({ folder });
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
