import { NextRequest, NextResponse } from "next/server";
import { getApiKeyStatus, saveApiKey } from "@/lib/llm/api-keys";
import { clearApiKeyCache } from "@/lib/llm/provider";

export const dynamic = "force-dynamic";

/**
 * GET — return masked key status for each provider.
 */
export async function GET() {
  const status = await getApiKeyStatus();
  return NextResponse.json(status);
}

/**
 * PUT — save API keys. Omit a key or pass null to keep existing.
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();

    if (typeof body.openai === "string") {
      await saveApiKey("openai", body.openai);
    }
    if (typeof body.anthropic === "string") {
      await saveApiKey("anthropic", body.anthropic);
    }

    clearApiKeyCache();
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[api-keys] PUT error:", e);
    return NextResponse.json({ error: "Failed to save API keys" }, { status: 500 });
  }
}
