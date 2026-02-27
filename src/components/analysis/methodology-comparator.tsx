"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, FlaskConical, Trophy } from "lucide-react";
import { toast } from "sonner";
import { cleanJsonResponse } from "@/lib/llm/prompts";

interface PromptResult {
  id: string;
  promptType: string;
  result: string;
  createdAt: string;
}

interface RelatedPaper {
  id: string;
  title: string;
  year: number | null;
}

interface PaperComparison {
  paperId: string;
  title: string;
  approach: string;
  datasets: string[];
  metrics: string[];
  baselines: string[];
  keyResults: string;
}

interface HeadToHead {
  dataset: string;
  metric: string;
  results: { paperId: string; value: string; notes: string }[];
}

interface MethodDifference {
  aspect: string;
  description: string;
  implication: string;
}

interface ComparisonResult {
  comparison: {
    papers: PaperComparison[];
    commonDatasets: string[];
    commonMetrics: string[];
    headToHead: HeadToHead[];
  };
  methodologicalDifferences: MethodDifference[];
  verdict: string;
}

function safeParse<T>(result: string): T | null {
  try {
    return JSON.parse(cleanJsonResponse(result)) as T;
  } catch {
    return null;
  }
}

export function MethodologyComparator({
  paperId,
  promptResults,
  onUpdate,
}: {
  paperId: string;
  promptResults: PromptResult[];
  onUpdate: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [relatedPapers, setRelatedPapers] = useState<RelatedPaper[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingPapers, setLoadingPapers] = useState(true);

  // Fetch related papers for the selector
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/papers/${paperId}/relations`);
        if (res.ok) {
          const rels: { relatedPaper: RelatedPaper }[] = await res.json();
          const papers = rels.map((r) => r.relatedPaper);
          setRelatedPapers(papers);
          setSelectedIds(new Set(papers.map((p) => p.id)));
        }
      } catch {
        // ignore
      } finally {
        setLoadingPapers(false);
      }
    })();
  }, [paperId]);

  const latest = promptResults
    .filter((pr) => pr.promptType === "compareMethodologies")
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

  const handleRun = async () => {
    if (selectedIds.size === 0) {
      toast.error("Select at least one paper to compare");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/papers/${paperId}/llm/compare-methodologies`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paperIds: Array.from(selectedIds) }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to compare methodologies");
        return;
      }
      toast.success("Methodology comparison complete");
      onUpdate();
    } catch {
      toast.error("Failed to compare methodologies");
    } finally {
      setLoading(false);
    }
  };

  const togglePaper = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const parsed = latest ? safeParse<ComparisonResult>(latest.result) : null;

  return (
    <div className="space-y-3">
      {/* Paper selector */}
      {!loadingPapers && relatedPapers.length > 0 && (
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              Papers to compare
            </p>
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {relatedPapers.map((p) => (
                <label
                  key={p.id}
                  className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(p.id)}
                    onChange={() => togglePaper(p.id)}
                    className="h-3.5 w-3.5 rounded border-border"
                  />
                  <span className="truncate">{p.title}</span>
                  {p.year && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      ({p.year})
                    </span>
                  )}
                </label>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRun}
          disabled={loading || selectedIds.size === 0}
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
          )}
          {loading ? "Comparing..." : "Compare Methodologies"}
        </Button>
      </div>

      {/* Results */}
      {parsed && (
        <div className="space-y-4">
          {/* Comparison table */}
          {parsed.comparison.papers.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">
                      Paper
                    </th>
                    <th className="text-left py-2 px-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">
                      Approach
                    </th>
                    <th className="text-left py-2 px-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">
                      Datasets
                    </th>
                    <th className="text-left py-2 px-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">
                      Metrics
                    </th>
                    <th className="text-left py-2 pl-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">
                      Key Results
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.comparison.papers.map((p) => (
                    <tr key={p.paperId} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium max-w-[160px]">
                        <span className="line-clamp-2">{p.title}</span>
                      </td>
                      <td className="py-2 px-3 text-muted-foreground max-w-[200px]">
                        {p.approach}
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex flex-wrap gap-1">
                          {p.datasets.map((d, i) => (
                            <Badge
                              key={i}
                              variant="outline"
                              className="text-[10px]"
                            >
                              {d}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex flex-wrap gap-1">
                          {p.metrics.map((m, i) => (
                            <Badge
                              key={i}
                              variant="secondary"
                              className="text-[10px]"
                            >
                              {m}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 pl-3 text-muted-foreground max-w-[200px]">
                        {p.keyResults}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Head-to-head */}
          {parsed.comparison.headToHead.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Trophy className="h-3.5 w-3.5" />
                Head-to-Head
              </p>
              {parsed.comparison.headToHead.map((h2h, i) => (
                <Card key={i}>
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline" className="text-[10px]">
                        {h2h.dataset}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {h2h.metric}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {h2h.results.map((r, j) => {
                        const paper = parsed.comparison.papers.find(
                          (p) => p.paperId === r.paperId
                        );
                        return (
                          <div
                            key={j}
                            className="flex items-center gap-2 text-sm"
                          >
                            <span className="font-mono text-xs font-semibold min-w-[60px]">
                              {r.value}
                            </span>
                            <span className="text-muted-foreground truncate">
                              {paper?.title || r.paperId}
                            </span>
                            {r.notes && (
                              <span className="text-xs text-muted-foreground/70">
                                ({r.notes})
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Methodological differences */}
          {parsed.methodologicalDifferences.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Key Differences
              </p>
              {parsed.methodologicalDifferences.map((diff, i) => (
                <Card key={i}>
                  <CardContent className="pt-3 pb-3 space-y-1">
                    <p className="text-sm font-medium">{diff.aspect}</p>
                    <p className="text-sm text-muted-foreground">
                      {diff.description}
                    </p>
                    <p className="text-xs text-muted-foreground/80 italic">
                      {diff.implication}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Verdict */}
          {parsed.verdict && (
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="pt-4 pb-4">
                <p className="text-xs uppercase tracking-wider text-primary/70 mb-1">
                  Verdict
                </p>
                <p className="text-sm">{parsed.verdict}</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Empty state */}
      {!parsed && !loading && !latest && (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Select papers above and click &quot;Compare Methodologies&quot; to
            analyze how their experimental setups differ.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
