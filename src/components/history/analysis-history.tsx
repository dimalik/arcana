"use client";

import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

interface PromptResult {
  id: string;
  promptType: string;
  prompt: string;
  result: string;
  provider: string | null;
  model: string | null;
  createdAt: string;
}

interface AnalysisHistoryProps {
  paperId: string;
  promptResults: PromptResult[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: () => void;
}

const TYPE_LABELS: Record<string, string> = {
  summarize: "Summary",
  extract: "Metadata",
  categorize: "Categories",
  extractReferences: "References",
  detectContradictions: "Contradictions",
  findGaps: "Research Gaps",
  buildTimeline: "Idea Timeline",
  compareMethodologies: "Methodology Comparison",
};

const TYPE_ORDER = ["summarize", "extract", "categorize", "extractReferences", "detectContradictions", "findGaps", "buildTimeline", "compareMethodologies"];

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncatePreview(text: string, maxLines = 2): string {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.slice(0, maxLines).join("\n");
}

export function AnalysisHistory({
  paperId,
  promptResults,
  open,
  onOpenChange,
  onRestore,
}: AnalysisHistoryProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  // Group by type and sort by recency within each group
  const grouped = TYPE_ORDER.map((type) => ({
    type,
    label: TYPE_LABELS[type] || type,
    results: promptResults
      .filter((pr) => pr.promptType === type)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
  })).filter((g) => g.results.length > 0);

  const handleRestore = async (promptResultId: string) => {
    setRestoring(promptResultId);
    try {
      const res = await fetch(`/api/papers/${paperId}/history/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptResultId }),
      });
      if (res.ok) {
        toast.success("Previous version restored");
        onOpenChange(false);
        onRestore();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to restore");
      }
    } catch {
      toast.error("Failed to restore");
    } finally {
      setRestoring(null);
    }
  };

  const canRestore = (type: string) =>
    ["summarize", "extract", "categorize"].includes(type);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Analysis History</SheetTitle>
          <SheetDescription>
            Browse and restore previous analysis versions
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {grouped.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No analysis history yet
            </p>
          )}

          {grouped.map((group) => (
            <div key={group.type}>
              <h3 className="text-sm font-medium text-muted-foreground mb-2">
                {group.label}
              </h3>
              <div className="space-y-2">
                {group.results.map((pr, idx) => {
                  const isExpanded = expandedId === pr.id;
                  const isCurrent = idx === 0;

                  return (
                    <div
                      key={pr.id}
                      className={`rounded-lg border p-3 transition-colors ${
                        isCurrent
                          ? "border-primary/30 bg-primary/5"
                          : "border-border"
                      }`}
                    >
                      {/* Header row */}
                      <button
                        onClick={() =>
                          setExpandedId(isExpanded ? null : pr.id)
                        }
                        className="flex items-center gap-2 w-full text-left"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="text-xs text-muted-foreground">
                          {timeAgo(pr.createdAt)}
                        </span>
                        {pr.model && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {pr.model}
                          </Badge>
                        )}
                        {isCurrent && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            current
                          </Badge>
                        )}
                      </button>

                      {/* Preview (collapsed) */}
                      {!isExpanded && (
                        <p className="mt-1.5 ml-5.5 text-xs text-muted-foreground line-clamp-2">
                          {truncatePreview(pr.result)}
                        </p>
                      )}

                      {/* Expanded content */}
                      {isExpanded && (
                        <div className="mt-3 ml-5.5">
                          <div className="max-h-64 overflow-y-auto rounded border bg-muted/30 p-3">
                            <MarkdownRenderer
                              content={pr.result}
                              className="text-xs"
                            />
                          </div>
                          {canRestore(pr.promptType) && !isCurrent && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-2 h-7 text-xs"
                              disabled={restoring === pr.id}
                              onClick={() => handleRestore(pr.id)}
                            >
                              <RotateCcw className="mr-1.5 h-3 w-3" />
                              {restoring === pr.id
                                ? "Restoring..."
                                : "Restore this version"}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
