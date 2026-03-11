"use client";

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { RefreshCw, Loader2, Minus, Plus, Crosshair } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface SectionRewriterProps {
  paperId: string;
  section: "review" | "methodology" | "results";
  onRewritten: () => void;
}

export function SectionRewriter({ paperId, section, onRewritten }: SectionRewriterProps) {
  const [loading, setLoading] = useState(false);
  const [showTopicInput, setShowTopicInput] = useState(false);
  const [topic, setTopic] = useState("");

  const handleRewrite = async (mode: "shorter" | "longer" | "focus", focusTopic?: string) => {
    setLoading(true);
    setShowTopicInput(false);
    try {
      const res = await fetch(`/api/papers/${paperId}/llm/rewrite-section`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section, mode, topic: focusTopic }),
      });
      if (res.ok) {
        toast.success("Section rewritten");
        onRewritten();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to rewrite");
      }
    } catch {
      toast.error("Failed to rewrite section");
    } finally {
      setLoading(false);
      setTopic("");
    }
  };

  if (loading) {
    return (
      <div className="inline-flex h-7 w-7 items-center justify-center">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <DropdownMenu
      open={showTopicInput ? true : undefined}
      onOpenChange={(open) => { if (!open) setShowTopicInput(false); }}
    >
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-accent hover:text-foreground transition-colors"
          title="Rewrite section"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => handleRewrite("shorter")}>
          <Minus className="h-4 w-4" />
          Rewrite shorter
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleRewrite("longer")}>
          <Plus className="h-4 w-4" />
          Rewrite longer
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {showTopicInput ? (
          <div className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (topic.trim()) handleRewrite("focus", topic.trim());
              }}
            >
              <Input
                autoFocus
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. attention mechanism"
                className="h-8 text-sm"
              />
              <Button
                type="submit"
                size="sm"
                disabled={!topic.trim()}
                className="mt-1.5 w-full h-7 text-xs"
              >
                Rewrite with focus
              </Button>
            </form>
          </div>
        ) : (
          <DropdownMenuItem onClick={(e) => { e.preventDefault(); setShowTopicInput(true); }}>
            <Crosshair className="h-4 w-4" />
            Focus on topic...
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
