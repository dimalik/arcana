"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

type LLMProvider = "openai" | "anthropic" | "proxy";

interface ModelOption {
  id: string;
  name: string;
  provider: LLMProvider;
  group: string;
}

const BASE_MODELS: ModelOption[] = [
  { id: "gpt-4o", name: "GPT-4o", provider: "openai", group: "OpenAI" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", group: "OpenAI" },
  { id: "gpt-4-turbo", name: "GPT-4 Turbo", provider: "openai", group: "OpenAI" },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic", group: "Anthropic" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic", group: "Anthropic" },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "anthropic", group: "Anthropic" },
];

interface ModelSelectorProps {
  provider: LLMProvider;
  modelId: string;
  onProviderChange: (provider: LLMProvider) => void;
  onModelChange: (modelId: string) => void;
  label?: string;
}

export function ModelSelector({
  provider,
  modelId,
  onProviderChange,
  onModelChange,
  label = "Model",
}: ModelSelectorProps) {
  const [proxyModels, setProxyModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    fetch("/api/settings/proxy-status")
      .then((r) => r.json())
      .then((data) => {
        if (data.enabled && data.models?.length > 0) {
          setProxyModels(
            data.models.map((id: string) => ({
              id,
              name: id,
              provider: "proxy" as LLMProvider,
              group: "Proxy",
            }))
          );
        }
      })
      .catch(() => setProxyModels([]));
  }, []);

  const allModels = [...proxyModels, ...BASE_MODELS];
  const compositeValue = `${provider}::${modelId}`;

  // Find current model's display name
  const currentModel = allModels.find(
    (m) => m.provider === provider && m.id === modelId
  );
  const displayName = currentModel?.name || modelId || "Select model";

  // Group models
  const groups = new Map<string, ModelOption[]>();
  for (const m of allModels) {
    const list = groups.get(m.group) || [];
    list.push(m);
    groups.set(m.group, list);
  }

  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select
        value={compositeValue}
        onValueChange={(val) => {
          const [prov, ...rest] = val.split("::");
          const mid = rest.join("::");
          onProviderChange(prov as LLMProvider);
          onModelChange(mid);
        }}
      >
        <SelectTrigger className="w-[260px]">
          <SelectValue>{displayName}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {Array.from(groups.entries()).map(([group, models]) => (
            <SelectGroup key={group}>
              <SelectLabel>{group}</SelectLabel>
              {models.map((m) => (
                <SelectItem key={`${m.provider}::${m.id}`} value={`${m.provider}::${m.id}`}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
