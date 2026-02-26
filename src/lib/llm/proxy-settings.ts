import { prisma } from "@/lib/prisma";

export type ProxyVendor = "openrouter" | "litellm" | "azure" | "custom";

export interface ProxyConfig {
  enabled: boolean;
  vendor: ProxyVendor;
  baseUrl: string;
  apiKey: string;
  headerName: string;
  headerValue: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}

export interface VendorPreset {
  label: string;
  baseUrl: string;
  headerName: string;
  prefix: string;
}

export const VENDOR_PRESETS: Record<ProxyVendor, VendorPreset> = {
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    headerName: "Authorization",
    prefix: "Bearer ",
  },
  litellm: {
    label: "LiteLLM",
    baseUrl: "http://localhost:4000/v1",
    headerName: "Authorization",
    prefix: "Bearer ",
  },
  azure: {
    label: "Azure OpenAI",
    baseUrl: "https://<resource>.openai.azure.com/openai/deployments/<deployment>/v1",
    headerName: "api-key",
    prefix: "",
  },
  custom: {
    label: "Custom",
    baseUrl: "",
    headerName: "Authorization",
    prefix: "Bearer ",
  },
};

const PROXY_KEYS = [
  "proxy_enabled",
  "proxy_vendor",
  "proxy_base_url",
  "proxy_api_key",
  "proxy_header_name",
  "proxy_header_value",
  "proxy_model_id",
  "proxy_context_window",
  "proxy_max_tokens",
] as const;

/**
 * Read proxy configuration from DB, falling back to env vars.
 */
export async function getProxyConfig(): Promise<ProxyConfig> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...PROXY_KEYS] } },
  });
  const db = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  // If DB has config, use it
  if (db.proxy_enabled !== undefined) {
    const vendor = (db.proxy_vendor || "custom") as ProxyVendor;
    const apiKey = db.proxy_api_key || "";
    const preset = VENDOR_PRESETS[vendor];

    return {
      enabled: db.proxy_enabled === "true",
      vendor,
      baseUrl: db.proxy_base_url || preset.baseUrl,
      apiKey,
      headerName: db.proxy_header_name || preset.headerName,
      headerValue: db.proxy_header_value || (preset.prefix + apiKey),
      modelId: db.proxy_model_id || "",
      contextWindow: parseInt(db.proxy_context_window || "128000", 10),
      maxTokens: parseInt(db.proxy_max_tokens || "4096", 10),
    };
  }

  // Fall back to env vars
  const proxyUrl = process.env.LLM_PROXY_URL;
  const headerName = process.env.LLM_PROXY_HEADER_NAME || "X-LLM-Proxy-Calling-Service";
  const headerValue = process.env.LLM_PROXY_HEADER_VALUE || "";

  if (proxyUrl && headerValue) {
    return {
      enabled: true,
      vendor: "custom",
      baseUrl: proxyUrl.replace(/\/chat\/completions$/, ""),
      apiKey: "",
      headerName,
      headerValue,
      modelId: "gpt-5.2",
      contextWindow: 128000,
      maxTokens: 4096,
    };
  }

  return {
    enabled: false,
    vendor: "custom",
    baseUrl: "",
    apiKey: "",
    headerName: "Authorization",
    headerValue: "",
    modelId: "",
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

/**
 * Save proxy configuration to DB. If apiKey is null, keeps existing value.
 */
export async function saveProxyConfig(config: {
  enabled: boolean;
  vendor: ProxyVendor;
  baseUrl: string;
  apiKey: string | null;
  headerName: string;
  headerValue: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}): Promise<void> {
  // If apiKey is null, keep existing
  let apiKey = config.apiKey;
  if (apiKey === null) {
    const existing = await prisma.setting.findUnique({ where: { key: "proxy_api_key" } });
    apiKey = existing?.value || "";
  }

  // For known vendors, auto-compose headerValue from prefix + apiKey
  const vendor = config.vendor as ProxyVendor;
  let headerValue = config.headerValue;
  let headerName = config.headerName;
  if (vendor !== "custom") {
    const preset = VENDOR_PRESETS[vendor];
    headerName = preset.headerName;
    headerValue = preset.prefix + apiKey;
  }

  const pairs: [string, string][] = [
    ["proxy_enabled", String(config.enabled)],
    ["proxy_vendor", config.vendor],
    ["proxy_base_url", config.baseUrl],
    ["proxy_api_key", apiKey],
    ["proxy_header_name", headerName],
    ["proxy_header_value", headerValue],
    ["proxy_model_id", config.modelId],
    ["proxy_context_window", String(config.contextWindow)],
    ["proxy_max_tokens", String(config.maxTokens)],
  ];

  for (const [key, value] of pairs) {
    await prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
}

/**
 * Check if proxy is configured (DB first, then env fallback).
 */
export async function isProxyConfigured(): Promise<boolean> {
  const enabledRow = await prisma.setting.findUnique({ where: { key: "proxy_enabled" } });
  if (enabledRow) {
    return enabledRow.value === "true";
  }
  // Env fallback
  return !!(process.env.LLM_PROXY_URL && process.env.LLM_PROXY_HEADER_VALUE);
}
