import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const TIER_KEYS = ["tier_reasoning_model", "tier_standard_model"] as const;

const TIER_DEFAULTS: Record<string, string> = {
  tier_reasoning_model: "claude-opus-4-6",
  tier_standard_model: "claude-sonnet-4-6",
};

export async function GET() {
  const settings = await prisma.setting.findMany({
    where: { key: { in: [...TIER_KEYS] } },
  });

  const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));

  return NextResponse.json({
    reasoning: map.tier_reasoning_model || TIER_DEFAULTS.tier_reasoning_model,
    standard: map.tier_standard_model || TIER_DEFAULTS.tier_standard_model,
  });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { reasoning, standard } = body as { reasoning?: string; standard?: string };

    if (reasoning) {
      await prisma.setting.upsert({
        where: { key: "tier_reasoning_model" },
        create: { key: "tier_reasoning_model", value: reasoning },
        update: { value: reasoning },
      });
    }

    if (standard) {
      await prisma.setting.upsert({
        where: { key: "tier_standard_model" },
        create: { key: "tier_standard_model", value: standard },
        update: { value: standard },
      });
    }

    return NextResponse.json({ reasoning, standard });
  } catch {
    return NextResponse.json({ error: "Failed to save tier settings" }, { status: 500 });
  }
}
