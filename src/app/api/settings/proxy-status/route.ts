import { NextResponse } from "next/server";
import { getProxyConfig } from "@/lib/llm/proxy-settings";

export async function GET() {
  const config = await getProxyConfig();

  // Parse comma-separated model IDs
  const models = config.modelId
    ? config.modelId.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return NextResponse.json({
    enabled: config.enabled,
    models,
  });
}
