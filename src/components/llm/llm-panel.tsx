"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  FileText,
  Search,
  Tags,
  Code,
  MessageSquare,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

interface PromptResult {
  id: string;
  promptType: string;
  prompt: string;
  result: string;
  provider: string | null;
  model: string | null;
  createdAt: string;
}

interface Paper {
  id: string;
  fullText: string | null;
  abstract: string | null;
  promptResults: PromptResult[];
}

interface LlmPanelProps {
  paper: Paper;
  onUpdate: () => void;
}

type Feature = "summarize" | "extract" | "categorize" | "code" | "custom";

export function LlmPanel({ paper, onUpdate }: LlmPanelProps) {
  const [loading, setLoading] = useState<Feature | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [activeResult, setActiveResult] = useState<string | null>(null);

  const hasText = !!(paper.fullText || paper.abstract);

  const runFeature = async (feature: Feature) => {
    if (!hasText) {
      toast.error("No text available for analysis");
      return;
    }

    setLoading(feature);
    try {
      const body: Record<string, unknown> = {};
      if (feature === "custom") body.prompt = customPrompt;
      if (feature === "categorize") body.autoTag = true;
      if (feature === "code" && customPrompt)
        body.customPrompt = customPrompt;

      const res = await fetch(`/api/papers/${paper.id}/llm/${feature}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Request failed");
      }

      const result = await res.json();
      setActiveResult(result.result);
      toast.success(`${feature} completed`);
      onUpdate();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to process"
      );
    } finally {
      setLoading(null);
    }
  };

  const features: { key: Feature; label: string; icon: typeof FileText; description: string }[] = [
    {
      key: "summarize",
      label: "Summarize",
      icon: FileText,
      description: "Generate a comprehensive summary",
    },
    {
      key: "extract",
      label: "Extract Info",
      icon: Search,
      description: "Extract structured metadata",
    },
    {
      key: "categorize",
      label: "Categorize & Tag",
      icon: Tags,
      description: "Auto-categorize and create tags",
    },
    {
      key: "code",
      label: "Generate Code",
      icon: Code,
      description: "Generate implementation code",
    },
    {
      key: "custom",
      label: "Custom Prompt",
      icon: MessageSquare,
      description: "Ask anything about this paper",
    },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>AI Analysis</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasText && (
            <p className="text-sm text-destructive">
              No text extracted from this paper. Upload a PDF or add text first.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) =>
              f.key === "custom" ? null : (
                <Button
                  key={f.key}
                  variant="outline"
                  className="h-auto flex-col items-start gap-1 p-4"
                  disabled={!hasText || loading !== null}
                  onClick={() => runFeature(f.key)}
                >
                  <div className="flex items-center gap-2">
                    {loading === f.key ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <f.icon className="h-4 w-4" />
                    )}
                    <span className="font-medium">{f.label}</span>
                  </div>
                  <span className="text-xs text-muted-foreground text-left">
                    {f.description}
                  </span>
                </Button>
              )
            )}
          </div>

          <Separator />

          <div className="space-y-2">
            <p className="text-sm font-medium">Custom Prompt</p>
            <Textarea
              placeholder="Ask anything about this paper..."
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={3}
            />
            <Button
              disabled={!hasText || !customPrompt || loading !== null}
              onClick={() => runFeature("custom")}
            >
              {loading === "custom" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <MessageSquare className="mr-2 h-4 w-4" />
              )}
              Send
            </Button>
          </div>
        </CardContent>
      </Card>

      {activeResult && (
        <Card>
          <CardHeader>
            <CardTitle>Latest Result</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm rounded-md bg-muted p-4">
              <MarkdownRenderer content={activeResult} />
            </div>
          </CardContent>
        </Card>
      )}

      {paper.promptResults.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Previous Results ({paper.promptResults.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {paper.promptResults.map((pr) => (
              <div key={pr.id} className="rounded-md border p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium capitalize">
                    {pr.promptType}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {pr.provider}/{pr.model} &middot;{" "}
                    {new Date(pr.createdAt).toLocaleDateString()}
                  </span>
                </div>
                {pr.prompt !== pr.promptType && (
                  <p className="text-sm text-muted-foreground italic">
                    {pr.prompt}
                  </p>
                )}
                <div className="text-sm rounded-md bg-muted p-3 max-h-48 overflow-y-auto">
                  <MarkdownRenderer content={pr.result} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
