"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText } from "lucide-react";
import { PaperCard, PaperCardData } from "@/components/paper-card";
import { toast } from "sonner";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

interface YearData {
  year: number;
  count: number;
}

interface Tag {
  id: string;
  name: string;
  color: string;
  _count: { papers: number };
}

export default function DashboardPage() {
  const [yearData, setYearData] = useState<YearData[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [papers, setPapers] = useState<PaperCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(true);

  // Fetch tags once
  useEffect(() => {
    fetch("/api/tags")
      .then((r) => r.json())
      .then(setTags)
      .catch(() => {});
  }, []);

  // Fetch chart data whenever selected tags change
  const fetchYearData = useCallback(async (tagIds: Set<string>) => {
    setChartLoading(true);
    try {
      const params = new URLSearchParams();
      if (tagIds.size > 0) {
        params.set("tagIds", Array.from(tagIds).join(","));
      }
      const res = await fetch(`/api/stats/papers-by-year?${params}`);
      const data = await res.json();
      setYearData(data);
    } catch {
      toast.error("Failed to load chart data");
    }
    setChartLoading(false);
  }, []);

  // Fetch papers whenever selected tags change
  const fetchPapers = useCallback(async (tagIds: Set<string>) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "10" });
      // The papers API supports a single tagId; for multi-tag, fetch for first selected
      // or all if none selected
      if (tagIds.size === 1) {
        params.set("tagId", Array.from(tagIds)[0]);
      } else if (tagIds.size > 1) {
        // Fetch more and filter client-side for multi-tag
        params.set("limit", "200");
      }
      const res = await fetch(`/api/papers?${params}`);
      const data = await res.json();
      let list: PaperCardData[] = data.papers ?? [];

      // Client-side filtering for multi-tag selection
      if (tagIds.size > 1) {
        list = list.filter((p) =>
          p.tags.some((pt) => tagIds.has(pt.tag.id))
        );
        list = list.slice(0, 10);
      }

      setPapers(list);
    } catch {
      toast.error("Failed to load papers");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchYearData(selectedTagIds);
    fetchPapers(selectedTagIds);
  }, [selectedTagIds, fetchYearData, fetchPapers]);

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  };

  const clearTags = () => setSelectedTagIds(new Set());

  const handleBookmarkToggle = async (id: string) => {
    const res = await fetch(`/api/papers/${id}/bookmark`, { method: "PATCH" });
    if (res.ok) {
      const { isBookmarked } = await res.json();
      setPapers((prev) =>
        prev.map((p) => (p.id === id ? { ...p, isBookmarked } : p))
      );
    }
  };

  const handleStatusChange = async (id: string, status: string) => {
    const res = await fetch(`/api/papers/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      setPapers((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, readingStatus: status } : p
        )
      );
    }
  };

  const totalPapers = yearData.reduce((sum, d) => sum + d.count, 0);

  return (
    <div className="flex gap-6">
      {/* Main content */}
      <div className="flex-1 min-w-0 space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-muted-foreground">
            Your research paper repository at a glance.
          </p>
        </div>

        {/* Year chart */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-baseline justify-between mb-4">
              <h3 className="text-sm font-medium text-muted-foreground">
                Papers by Year
              </h3>
              <span className="text-2xl font-bold">{totalPapers}</span>
            </div>
            {chartLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : yearData.length === 0 ? (
              <div className="flex items-center justify-center h-[260px] text-sm text-muted-foreground">
                No papers with year data
                {selectedTagIds.size > 0 ? " for selected tags" : ""}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={yearData}
                  margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    className="stroke-border"
                  />
                  <XAxis
                    dataKey="year"
                    tickLine={false}
                    axisLine={false}
                    className="text-xs fill-muted-foreground"
                    tickFormatter={(v) => String(v)}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    className="text-xs fill-muted-foreground"
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "0.5rem",
                      fontSize: "0.875rem",
                    }}
                    labelStyle={{ color: "hsl(var(--foreground))" }}
                    itemStyle={{ color: "hsl(var(--foreground))" }}
                    formatter={(value) => [value, "Papers"]}
                    labelFormatter={(label) => `Year ${label}`}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {yearData.map((_, index) => (
                      <Cell
                        key={index}
                        className="fill-primary hover:fill-primary/80"
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Recent papers */}
        <div>
          <h3 className="mb-3 text-lg font-semibold">
            Recent Papers
            {selectedTagIds.size > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                (filtered)
              </span>
            )}
          </h3>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="mb-2 h-5 w-3/4" />
                    <Skeleton className="mb-2 h-4 w-1/2" />
                    <Skeleton className="h-4 w-full" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : papers.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 p-12">
                <FileText className="h-12 w-12 text-muted-foreground" />
                <p className="text-muted-foreground">
                  {selectedTagIds.size > 0
                    ? "No papers found for selected tags."
                    : "No papers yet. Upload or import your first paper to get started."}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {papers.map((paper) => (
                <PaperCard
                  key={paper.id}
                  paper={paper}
                  onBookmarkToggle={handleBookmarkToggle}
                  onStatusChange={handleStatusChange}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tag filter sidebar */}
      <div className="w-56 shrink-0">
        <div className="sticky top-0">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              Filter by Tags
            </h3>
            {selectedTagIds.size > 0 && (
              <button
                onClick={clearTags}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear
              </button>
            )}
          </div>
          <div className="space-y-1">
            {tags.map((tag) => {
              const isSelected = selectedTagIds.has(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleTag(tag.id)}
                  className={`flex items-center justify-between w-full rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                    isSelected
                      ? "bg-accent font-medium"
                      : "hover:bg-accent/50"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="truncate">{tag.name}</span>
                  </div>
                  <span className="text-xs text-muted-foreground ml-2 shrink-0">
                    {tag._count.papers}
                  </span>
                </button>
              );
            })}
            {tags.length === 0 && (
              <p className="text-xs text-muted-foreground px-2.5 py-4">
                No tags yet
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
