import { prisma } from "@/lib/prisma";

const KEY_MAP: Record<string, string> = {
  openai: "openai_api_key",
  anthropic: "anthropic_api_key",
};

/**
 * Get an API key for a provider. DB first, env fallback.
 */
export async function getApiKey(provider: "openai" | "anthropic"): Promise<string | null> {
  const dbKey = KEY_MAP[provider];
  if (dbKey) {
    const row = await prisma.setting.findUnique({ where: { key: dbKey } });
    if (row?.value) return row.value;
  }
  // Env fallback
  if (provider === "openai") return process.env.OPENAI_API_KEY || null;
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY || null;
  return null;
}

/**
 * Save an API key to DB. Pass empty string to clear.
 */
export async function saveApiKey(provider: "openai" | "anthropic", key: string): Promise<void> {
  const dbKey = KEY_MAP[provider];
  if (!dbKey) return;
  await prisma.setting.upsert({
    where: { key: dbKey },
    update: { value: key },
    create: { key: dbKey, value: key },
  });
}

/**
 * Get masked keys for display (DB + env status).
 */
export async function getApiKeyStatus(): Promise<{
  openai: { set: boolean; source: "db" | "env" | null; masked: string };
  anthropic: { set: boolean; source: "db" | "env" | null; masked: string };
}> {
  const [openaiRow, anthropicRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "openai_api_key" } }),
    prisma.setting.findUnique({ where: { key: "anthropic_api_key" } }),
  ]);

  function status(dbValue: string | undefined, envVar: string | undefined) {
    if (dbValue) {
      return { set: true, source: "db" as const, masked: `••••${dbValue.slice(-4)}` };
    }
    if (envVar) {
      return { set: true, source: "env" as const, masked: `••••${envVar.slice(-4)}` };
    }
    return { set: false, source: null, masked: "" };
  }

  return {
    openai: status(openaiRow?.value, process.env.OPENAI_API_KEY),
    anthropic: status(anthropicRow?.value, process.env.ANTHROPIC_API_KEY),
  };
}
