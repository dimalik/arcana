import { prisma } from "@/lib/prisma";

export type ProxyVendor = "openrouter" | "litellm" | "azure" | "custom" | "gateway";

/**
 * A provider route within a gateway proxy.
 * Each route maps a provider (openai, anthropic, google) to a URL path
 * within the gateway, with optional target URL headers.
 */
export interface ProviderRoute {
  provider: "openai" | "anthropic" | "google";
  path: string;         // e.g., "openai/v1", "anthropic/v1", "google_ai_studio/v1"
  targetUrl?: string;   // e.g., "https://api.anthropic.com" — sent as X-LLM-Proxy-Target-URL
  models: string[];     // e.g., ["gpt-5.2", "gpt-4o"]
}

export interface ProxyConfig {
  enabled: boolean;
  vendor: ProxyVendor;
  baseUrl: string;          // gateway base or single endpoint
  anthropicBaseUrl: string; // legacy — derived from routes for gateway vendor
  apiKey: string;
  headerName: string;
  headerValue: string;
  modelId: string;          // comma-separated default models
  contextWindow: number;
  maxTokens: number;
  routes: ProviderRoute[];  // gateway provider routes
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
  gateway: {
    label: "Gateway (multi-provider)",
    baseUrl: "",
    headerName: "X-LLM-Proxy-Calling-Service",
    prefix: "",
  },
};

const PROXY_KEYS = [
  "proxy_enabled",
  "proxy_vendor",
  "proxy_base_url",
  "proxy_anthropic_base_url",
  "proxy_api_key",
  "proxy_header_name",
  "proxy_header_value",
  "proxy_model_id",
  "proxy_context_window",
  "proxy_max_tokens",
  "proxy_routes",
] as const;

/**
 * Resolve the full endpoint URL for a specific model.
 * For gateway vendors, this looks up the route for the model's provider.
 * For other vendors, returns the base URL directly.
 */
export function resolveEndpointForModel(config: ProxyConfig, modelId: string): {
  baseUrl: string;
  extraHeaders: Record<string, string>;
  sdkProvider: "openai" | "anthropic" | "google";
} {
  const sdkProvider = detectSdkProvider(modelId);

  // Gateway mode: look up the route
  if (config.vendor === "gateway" && config.routes.length > 0) {
    const route = config.routes.find(r => r.provider === sdkProvider)
      || config.routes.find(r => r.models.some(m => modelId.startsWith(m.split("-")[0])));

    if (route) {
      const gateway = config.baseUrl.replace(/\/+$/, "");
      const routePath = route.path.replace(/^\/+/, "");
      const baseUrl = `${gateway}/${routePath}`;
      const extraHeaders: Record<string, string> = {};
      if (route.targetUrl) {
        extraHeaders["X-LLM-Proxy-Target-URL"] = route.targetUrl;
      }
      return { baseUrl, extraHeaders, sdkProvider };
    }
  }

  // Legacy mode: single base URL + anthropic URL
  if (sdkProvider === "anthropic" && config.anthropicBaseUrl) {
    return {
      baseUrl: config.anthropicBaseUrl,
      extraHeaders: { "X-LLM-Proxy-Target-URL": "https://api.anthropic.com" },
      sdkProvider,
    };
  }

  return { baseUrl: config.baseUrl, extraHeaders: {}, sdkProvider };
}

/** Check if a model ID is an Anthropic/Claude model. */
export function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith("claude");
}

/** Check if a model ID is a Google/Gemini model. */
export function isGoogleModel(modelId: string): boolean {
  return modelId.startsWith("gemini");
}

/** Detect which SDK provider to use for a model. */
export function detectSdkProvider(modelId: string): "openai" | "anthropic" | "google" {
  if (isAnthropicModel(modelId)) return "anthropic";
  if (isGoogleModel(modelId)) return "google";
  return "openai";
}

/**
 * Read proxy configuration from DB, falling back to env vars.
 */
export async function getProxyConfig(): Promise<ProxyConfig> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...PROXY_KEYS] } },
  });
  const db: Record<string, string> = {};
  for (const row of rows) db[row.key] = row.value;

  const baseUrl = db.proxy_base_url || process.env.LLM_PROXY_URL || "";
  const headerName = db.proxy_header_name || process.env.LLM_PROXY_HEADER_NAME || "X-LLM-Proxy-Calling-Service";
  const headerValue = db.proxy_header_value || process.env.LLM_PROXY_HEADER_VALUE || "";
  const vendor = (db.proxy_vendor || "custom") as ProxyVendor;

  // Parse routes from DB
  let routes: ProviderRoute[] = [];
  if (db.proxy_routes) {
    try { routes = JSON.parse(db.proxy_routes); } catch { /* invalid JSON */ }
  }

  // Legacy: derive anthropic URL from base URL if routes are empty
  let anthropicBaseUrl = db.proxy_anthropic_base_url || "";
  if (!anthropicBaseUrl && baseUrl.includes("/openai/")) {
    anthropicBaseUrl = baseUrl.replace("/openai/", "/anthropic/");
  }

  return {
    enabled: db.proxy_enabled === "true" || !!(baseUrl && headerValue),
    vendor,
    baseUrl,
    anthropicBaseUrl,
    apiKey: db.proxy_api_key || "",
    headerName,
    headerValue,
    modelId: db.proxy_model_id || "",
    contextWindow: parseInt(db.proxy_context_window || "128000"),
    maxTokens: parseInt(db.proxy_max_tokens || "4096"),
    routes,
  };
}

/** Check if proxy is configured (via env vars). */
export function isProxyConfiguredFromEnv(): boolean {
  return !!(process.env.LLM_PROXY_URL && process.env.LLM_PROXY_HEADER_VALUE);
}

export interface SaveProxyInput {
  vendor: ProxyVendor;
  baseUrl: string;
  anthropicBaseUrl?: string;
  headerName: string;
  headerValue: string;
  modelId: string;
  apiKey?: string | null;
  contextWindow?: number;
  maxTokens?: number;
  routes?: ProviderRoute[];
}

export async function saveProxyConfig(config: SaveProxyInput): Promise<void> {
  const pairs: [string, string][] = [
    ["proxy_enabled", "true"],
    ["proxy_vendor", config.vendor],
    ["proxy_base_url", config.baseUrl],
    ["proxy_anthropic_base_url", config.anthropicBaseUrl || ""],
    ["proxy_header_name", config.headerName],
    ["proxy_header_value", config.headerValue],
    ["proxy_model_id", config.modelId],
    ["proxy_context_window", String(config.contextWindow || 128000)],
    ["proxy_max_tokens", String(config.maxTokens || 4096)],
  ];

  if (config.routes && config.routes.length > 0) {
    pairs.push(["proxy_routes", JSON.stringify(config.routes)]);
  }

  if (config.apiKey) {
    pairs.push(["proxy_api_key", config.apiKey]);
  }

  for (const [key, value] of pairs) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}
