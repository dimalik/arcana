"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LLMProvider = "openai" | "anthropic" | "proxy";

interface ModelInfo {
  id: string;
  name: string;
  provider: LLMProvider;
}

const BASE_MODELS: ModelInfo[] = [
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
  { id: "gpt-4-turbo", name: "GPT-4 Turbo", provider: "openai" },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "anthropic" },
];

interface ModelSelectorProps {
  provider: LLMProvider;
  modelId: string;
  onProviderChange: (provider: LLMProvider) => void;
  onModelChange: (modelId: string) => void;
}

export function ModelSelector({
  provider,
  modelId,
  onProviderChange,
  onModelChange,
}: ModelSelectorProps) {
  const [proxyEnabled, setProxyEnabled] = useState(false);

  useEffect(() => {
    fetch("/api/settings/proxy-status")
      .then((r) => r.json())
      .then((data) => setProxyEnabled(data.enabled))
      .catch(() => setProxyEnabled(false));
  }, []);

  const providerModels = BASE_MODELS.filter((m) => m.provider === provider);
  const isProxy = provider === "proxy";

  return (
    <div className="flex gap-3">
      <div className="space-y-1">
        <Label className="text-xs">Provider</Label>
        <Select
          value={provider}
          onValueChange={(v: LLMProvider) => {
            onProviderChange(v);
            if (v !== "proxy") {
              const firstModel = BASE_MODELS.find((m) => m.provider === v);
              if (firstModel) onModelChange(firstModel.id);
            }
          }}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI</SelectItem>
            <SelectItem value="anthropic">Anthropic</SelectItem>
            {proxyEnabled && (
              <SelectItem value="proxy">Proxy</SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Model</Label>
        {isProxy ? (
          <Input
            value={modelId}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="anthropic/claude-sonnet-4"
            className="w-[200px] font-mono text-sm"
          />
        ) : (
          <Select value={modelId} onValueChange={onModelChange}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providerModels.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
