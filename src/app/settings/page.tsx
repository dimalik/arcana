"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelSelector } from "@/components/llm/model-selector";
import { Save, Loader2, Zap, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";

type ProxyVendor = "openrouter" | "litellm" | "azure" | "custom";

const VENDOR_PRESETS: Record<ProxyVendor, { label: string; baseUrl: string; headerName: string; prefix: string }> = {
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", headerName: "Authorization", prefix: "Bearer " },
  litellm: { label: "LiteLLM", baseUrl: "http://localhost:4000/v1", headerName: "Authorization", prefix: "Bearer " },
  azure: { label: "Azure OpenAI", baseUrl: "https://<resource>.openai.azure.com/openai/deployments/<deployment>/v1", headerName: "api-key", prefix: "" },
  custom: { label: "Custom", baseUrl: "", headerName: "Authorization", prefix: "Bearer " },
};

export default function SettingsPage() {
  const [provider, setProvider] = useState<"openai" | "anthropic" | "proxy">("openai");
  const [modelId, setModelId] = useState("gpt-4o-mini");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Proxy settings
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyVendor, setProxyVendor] = useState<ProxyVendor>("openrouter");
  const [proxyBaseUrl, setProxyBaseUrl] = useState("");
  const [proxyAnthropicBaseUrl, setProxyAnthropicBaseUrl] = useState("");
  const [proxyApiKey, setProxyApiKey] = useState("");
  const [proxyHeaderName, setProxyHeaderName] = useState("Authorization");
  const [proxyHeaderValue, setProxyHeaderValue] = useState("");
  const [proxyModels, setProxyModels] = useState("");
  const [proxyContextWindow, setProxyContextWindow] = useState("128000");
  const [proxyMaxTokens, setProxyMaxTokens] = useState("4096");
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [proxyLoaded, setProxyLoaded] = useState(false);
  const [proxyHasExistingKey, setProxyHasExistingKey] = useState(false);

  useEffect(() => {
    fetch("/api/settings/default-model")
      .then((r) => r.json())
      .then((data) => {
        if (data.provider) setProvider(data.provider);
        if (data.modelId) setModelId(data.modelId);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    fetch("/api/settings/proxy")
      .then((r) => r.json())
      .then((data) => {
        setProxyEnabled(data.enabled);
        setProxyVendor(data.vendor || "openrouter");
        setProxyBaseUrl(data.baseUrl || "");
        setProxyAnthropicBaseUrl(data.anthropicBaseUrl || "");
        setProxyHeaderName(data.headerName || "Authorization");
        setProxyHeaderValue(data.headerValue || "");
        setProxyModels(data.modelId || "");
        setProxyContextWindow(String(data.contextWindow || 128000));
        setProxyMaxTokens(String(data.maxTokens || 4096));
        setProxyHasExistingKey(!!data.apiKey);
        setProxyLoaded(true);
      })
      .catch(() => setProxyLoaded(true));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/default-model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, modelId }),
      });
      if (res.ok) {
        toast.success("Default model saved");
      } else {
        toast.error("Failed to save");
      }
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleVendorChange = useCallback((vendor: ProxyVendor) => {
    setProxyVendor(vendor);
    const preset = VENDOR_PRESETS[vendor];
    if (vendor !== "custom") {
      setProxyBaseUrl(preset.baseUrl);
      setProxyHeaderName(preset.headerName);
    }
    setProxyTestResult(null);
  }, []);

  const buildHeaderValue = useCallback(() => {
    if (proxyVendor === "custom") return proxyHeaderValue;
    const preset = VENDOR_PRESETS[proxyVendor];
    return preset.prefix + proxyApiKey;
  }, [proxyVendor, proxyApiKey, proxyHeaderValue]);

  const handleProxySave = async () => {
    setProxySaving(true);
    try {
      const res = await fetch("/api/settings/proxy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: proxyEnabled,
          vendor: proxyVendor,
          baseUrl: proxyBaseUrl,
          anthropicBaseUrl: proxyAnthropicBaseUrl,
          apiKey: proxyApiKey || null,
          headerName: proxyHeaderName,
          headerValue: proxyVendor === "custom" ? proxyHeaderValue : "",
          modelId: proxyModels,
          contextWindow: proxyContextWindow,
          maxTokens: proxyMaxTokens,
        }),
      });
      if (res.ok) {
        toast.success("Proxy settings saved");
        if (proxyApiKey) {
          setProxyHasExistingKey(true);
          setProxyApiKey("");
        }
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to save proxy settings");
      }
    } catch {
      toast.error("Failed to save proxy settings");
    } finally {
      setProxySaving(false);
    }
  };

  const handleProxyTest = async () => {
    setProxyTesting(true);
    setProxyTestResult(null);
    try {
      const headerValue = buildHeaderValue();
      // Test with the first model in the list
      const firstModel = proxyModels.split(",").map(s => s.trim()).filter(Boolean)[0] || "gpt-3.5-turbo";
      const res = await fetch("/api/settings/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: proxyBaseUrl,
          anthropicBaseUrl: proxyAnthropicBaseUrl,
          headerName: proxyHeaderName,
          headerValue,
          modelId: firstModel,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setProxyTestResult({ ok: true, message: `Connected! Model: ${firstModel}. Response: "${data.response}"` });
      } else {
        setProxyTestResult({ ok: false, message: data.error || "Connection failed" });
      }
    } catch (e) {
      setProxyTestResult({ ok: false, message: e instanceof Error ? e.message : "Connection failed" });
    } finally {
      setProxyTesting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        <p className="text-muted-foreground">
          Configure your Arcana instance.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>AI Model</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The model used for all AI analysis — summaries, metadata extraction,
            tagging, concepts, and chat. Proxy models appear when a proxy is
            configured and enabled below.
          </p>
          {loaded && (
            <div className="flex items-end gap-3">
              <ModelSelector
                provider={provider}
                modelId={modelId}
                onProviderChange={setProvider}
                onModelChange={setModelId}
              />
              <Button onClick={handleSave} disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            LLM Proxy
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Connect to an LLM proxy to use models without direct API keys.
            Configured models appear in the model selector above.
          </p>

          {proxyLoaded && (
            <>
              {/* Enable toggle */}
              <div className="flex items-center gap-3">
                <Button
                  variant={proxyEnabled ? "default" : "outline"}
                  size="sm"
                  onClick={() => setProxyEnabled(!proxyEnabled)}
                >
                  {proxyEnabled ? "Enabled" : "Disabled"}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {proxyEnabled ? "Proxy provider is active" : "Enable to configure proxy"}
                </span>
              </div>

              {proxyEnabled && (
                <div className="space-y-4 border-t pt-4">
                  {/* Vendor selector */}
                  <div className="space-y-1">
                    <Label>Vendor Preset</Label>
                    <Select value={proxyVendor} onValueChange={(v) => handleVendorChange(v as ProxyVendor)}>
                      <SelectTrigger className="w-[200px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="openrouter">OpenRouter</SelectItem>
                        <SelectItem value="litellm">LiteLLM</SelectItem>
                        <SelectItem value="azure">Azure OpenAI</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Base URLs */}
                  <div className="space-y-1">
                    <Label>Base URL (OpenAI-compatible)</Label>
                    <Input
                      value={proxyBaseUrl}
                      onChange={(e) => setProxyBaseUrl(e.target.value)}
                      placeholder="https://proxy.example.com/openai/v1"
                      className="font-mono text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label>Base URL (Anthropic)</Label>
                    <Input
                      value={proxyAnthropicBaseUrl}
                      onChange={(e) => setProxyAnthropicBaseUrl(e.target.value)}
                      placeholder="https://proxy.example.com/anthropic/v1"
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      Only needed if you use Claude models via the proxy. Auto-derived if left blank.
                    </p>
                  </div>

                  {/* API Key */}
                  <div className="space-y-1">
                    <Label>API Key</Label>
                    <Input
                      type="password"
                      value={proxyApiKey}
                      onChange={(e) => setProxyApiKey(e.target.value)}
                      placeholder={proxyHasExistingKey ? "••••••••  (saved — leave blank to keep)" : "sk-or-..."}
                      className="font-mono text-sm"
                    />
                    {proxyHasExistingKey && !proxyApiKey && (
                      <p className="text-xs text-muted-foreground">
                        An API key is already saved. Enter a new one to replace it.
                      </p>
                    )}
                  </div>

                  {/* Custom header fields (only for custom vendor) */}
                  {proxyVendor === "custom" && (
                    <>
                      <div className="space-y-1">
                        <Label>Auth Header Name</Label>
                        <Input
                          value={proxyHeaderName}
                          onChange={(e) => setProxyHeaderName(e.target.value)}
                          placeholder="Authorization"
                          className="font-mono text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>Auth Header Value</Label>
                        <Input
                          type="password"
                          value={proxyHeaderValue}
                          onChange={(e) => setProxyHeaderValue(e.target.value)}
                          placeholder="Bearer sk-..."
                          className="font-mono text-sm"
                        />
                      </div>
                    </>
                  )}

                  {/* Available Models */}
                  <div className="space-y-1">
                    <Label>Available Models</Label>
                    <Input
                      value={proxyModels}
                      onChange={(e) => setProxyModels(e.target.value)}
                      placeholder="gpt-5.2, claude-sonnet-4-6"
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      Comma-separated model IDs. These appear in the model selector above.
                      Claude models (starting with &quot;claude&quot;) automatically route through the Anthropic endpoint.
                    </p>
                  </div>

                  {/* Context window / Max tokens */}
                  <div className="flex gap-4">
                    <div className="space-y-1 flex-1">
                      <Label>Context Window</Label>
                      <Input
                        type="number"
                        value={proxyContextWindow}
                        onChange={(e) => setProxyContextWindow(e.target.value)}
                        placeholder="128000"
                      />
                    </div>
                    <div className="space-y-1 flex-1">
                      <Label>Max Output Tokens</Label>
                      <Input
                        type="number"
                        value={proxyMaxTokens}
                        onChange={(e) => setProxyMaxTokens(e.target.value)}
                        placeholder="4096"
                      />
                    </div>
                  </div>

                  {/* Test result */}
                  {proxyTestResult && (
                    <div className={`flex items-start gap-2 rounded-md p-3 text-sm ${
                      proxyTestResult.ok
                        ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200"
                        : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
                    }`}>
                      {proxyTestResult.ok ? (
                        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                      ) : (
                        <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                      )}
                      <span className="break-all">{proxyTestResult.message}</span>
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={handleProxyTest}
                      disabled={proxyTesting || !proxyBaseUrl || !proxyModels}
                    >
                      {proxyTesting ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Zap className="mr-2 h-4 w-4" />
                      )}
                      Test Connection
                    </Button>
                    <Button onClick={handleProxySave} disabled={proxySaving}>
                      {proxySaving ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="mr-2 h-4 w-4" />
                      )}
                      Save
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            API keys are configured via environment variables in your{" "}
            <code className="rounded bg-muted px-1 py-0.5">.env</code> file.
          </p>
          <div>
            <Label>OpenAI API Key</Label>
            <Input
              type="password"
              value="••••••••"
              disabled
              className="font-mono"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Set via <code>OPENAI_API_KEY</code> in .env
            </p>
          </div>
          <div>
            <Label>Anthropic API Key</Label>
            <Input
              type="password"
              value="••••••••"
              disabled
              className="font-mono"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Set via <code>ANTHROPIC_API_KEY</code> in .env
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Arcana</span>
            <Badge variant="secondary">v1.0.0</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            A research paper repository with AI-powered analysis
          </p>
          <div className="text-sm text-muted-foreground space-y-1">
            <p>Built with Next.js 14, Prisma, and Vercel AI SDK</p>
            <p>Supports OpenAI, Anthropic, and proxy models</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
