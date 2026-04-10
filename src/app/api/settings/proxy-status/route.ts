import { NextResponse } from "next/server";
import { getProxyConfig } from "@/lib/llm/proxy-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = await getProxyConfig();

  // Collect models from default model IDs + all gateway routes
  const defaultModels = config.modelId
    ? config.modelId.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const routeModels = (config.routes || []).flatMap((r) => r.models || []);
  const models = Array.from(new Set([...defaultModels, ...routeModels]));

  return NextResponse.json({
    enabled: config.enabled,
    models,
  });
}
