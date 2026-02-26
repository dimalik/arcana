import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

export async function GET() {
  const providerSetting = await prisma.setting.findUnique({
    where: { key: "default_provider" },
  });
  const modelSetting = await prisma.setting.findUnique({
    where: { key: "default_model" },
  });

  return NextResponse.json({
    provider: providerSetting?.value || null,
    modelId: modelSetting?.value || null,
  });
}

const updateSchema = z.object({
  provider: z.enum(["openai", "anthropic", "proxy"]),
  modelId: z.string().min(1),
});

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { provider, modelId } = updateSchema.parse(body);

    await prisma.setting.upsert({
      where: { key: "default_provider" },
      create: { key: "default_provider", value: provider },
      update: { value: provider },
    });

    await prisma.setting.upsert({
      where: { key: "default_model" },
      create: { key: "default_model", value: modelId },
      update: { value: modelId },
    });

    return NextResponse.json({ provider, modelId });
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
