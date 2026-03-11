"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Search,
  Check,
  X,
  Loader2,
  MessageCircle,
  Zap,
  FileText,
  BookOpen,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import type { SynthesisDepth } from "@/lib/synthesis/types";

interface Paper {
  id: string;
  title: string;
  year: number | null;
  authors: string | null;
  tags: { tag: { id: string; name: string; color: string } }[];
}

interface TagCluster {
  id: string;
  name: string;
  color: string;
  tags: { id: string; name: string; color: string; _count: { papers: number } }[];
}

export function PaperSelector() {
  const router = useRouter();
  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [clusters, setClusters] = useState<TagCluster[]>([]);
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"auto" | "guided">("auto");
  const [depth, setDepth] = useState<SynthesisDepth>("balanced");
  const [submitting, setSubmitting] = useState(false);

  const fetchPapers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (selectedCluster) params.set("clusterId", selectedCluster);
    params.set("limit", "200");

    const res = await fetch(`/api/papers?${params}`);
    const data = await res.json();
    setPapers(data.papers || []);
    setLoading(false);
  }, [search, selectedCluster]);

  useEffect(() => {
    fetchPapers();
  }, [fetchPapers]);

  useEffect(() => {
    fetch("/api/tags/clusters")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setClusters(data);
      })
      .catch(() => {});
  }, []);

  const togglePaper = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const p of papers) next.add(p.id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const handleGenerate = async () => {
    if (selectedIds.size < 2) {
      toast.error("Select at least 2 papers");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/synthesis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paperIds: Array.from(selectedIds),
          title: title || undefined,
          query: query || undefined,
          mode,
          depth,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to start synthesis");
        return;
      }

      const { id } = await res.json();
      router.push(`/synthesis/${id}`);
    } catch {
      toast.error("Failed to start synthesis");
    } finally {
      setSubmitting(false);
    }
  };

  const parseAuthors = (authors: string | null): string => {
    if (!authors) return "";
    try {
      const arr = JSON.parse(authors);
      if (Array.isArray(arr)) return arr.slice(0, 2).join(", ") + (arr.length > 2 ? " et al." : "");
    } catch {}
    return authors.slice(0, 50);
  };

  return (
    <div className="space-y-2">
      {/* Search + actions row */}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
          <Input
            placeholder="Search papers or tags..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm !border-transparent shadow-none bg-muted/30 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-0"
          />
        </div>
        {selectedIds.size > 0 && (
          <button
            onClick={clearSelection}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-accent hover:text-foreground transition-colors"
            title="Clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Cluster chips */}
      {clusters.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={() => setSelectedCluster(null)}
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
              selectedCluster === null
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground/60 hover:text-muted-foreground"
            }`}
          >
            All
          </button>
          {clusters.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedCluster(selectedCluster === c.id ? null : c.id)}
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                selectedCluster === c.id
                  ? "ring-1 ring-offset-1 ring-offset-background"
                  : "opacity-60 hover:opacity-100"
              }`}
              style={{
                backgroundColor: c.color + (selectedCluster === c.id ? "25" : "12"),
                color: c.color,
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {/* Paper list */}
      <div className="rounded-lg max-h-[45vh] overflow-y-auto scrollbar-thin">
        {loading ? (
          <div className="p-2 space-y-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : papers.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            No papers found
          </div>
        ) : (
          <div className="p-1">
            {papers.map((p) => {
              const isSelected = selectedIds.has(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => togglePaper(p.id)}
                  className={`w-full text-left rounded-md px-2.5 py-1.5 flex items-start gap-2 transition-colors ${
                    isSelected
                      ? "bg-primary/8"
                      : "hover:bg-muted/60"
                  }`}
                >
                  <div className={`mt-0.5 shrink-0 h-4 w-4 rounded border flex items-center justify-center transition-colors ${
                    isSelected
                      ? "bg-primary border-primary"
                      : "border-muted-foreground/30"
                  }`}>
                    {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm leading-tight truncate ${isSelected ? "font-medium" : ""}`}>
                      {p.title}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {p.year && (
                        <span className="text-[11px] text-muted-foreground/60">{p.year}</span>
                      )}
                      {parseAuthors(p.authors) && (
                        <span className="text-[11px] text-muted-foreground/60 truncate">
                          {parseAuthors(p.authors)}
                        </span>
                      )}
                    </div>
                  </div>
                  {p.tags?.length > 0 && (
                    <div className="flex gap-0.5 shrink-0 mt-0.5">
                      {p.tags.slice(0, 2).map((t) => (
                        <span
                          key={t.tag.id}
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{ backgroundColor: t.tag.color }}
                          title={t.tag.name}
                        />
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom config */}
      <div className="sticky bottom-0 pt-2 space-y-1.5">
        <Input
          placeholder="Title (auto-generated if empty)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-7 text-xs rounded-lg !border-transparent shadow-none bg-muted/30 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-0"
        />
        <Input
          placeholder="Focus — e.g., 'Compare detection methods'"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 text-xs rounded-lg !border-transparent shadow-none bg-muted/30 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-0"
        />

        {/* Controls row */}
        <div className="flex items-center gap-1.5 pt-0.5">
          {/* Mode */}
          <div className="flex rounded-lg bg-muted/30 p-0.5 gap-0.5">
            <button
              onClick={() => setMode("auto")}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                mode === "auto"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Fully automatic"
            >
              <Zap className="h-3 w-3" />
              Auto
            </button>
            <button
              onClick={() => setMode("guided")}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                mode === "guided"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Interactive guidance"
            >
              <MessageCircle className="h-3 w-3" />
              Guided
            </button>
          </div>

          {/* Depth */}
          <div className="flex rounded-lg bg-muted/30 p-0.5 gap-0.5">
            <button
              onClick={() => setDepth("quick")}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                depth === "quick"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="~2 pages"
            >
              <Zap className="h-3 w-3" />
              Quick
            </button>
            <button
              onClick={() => setDepth("balanced")}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                depth === "balanced"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="~5 pages"
            >
              <FileText className="h-3 w-3" />
              Balanced
            </button>
            <button
              onClick={() => setDepth("deep")}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                depth === "deep"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="10+ pages"
            >
              <BookOpen className="h-3 w-3" />
              Deep
            </button>
          </div>

          {/* Generate */}
          <button
            onClick={handleGenerate}
            disabled={selectedIds.size < 2 || submitting}
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none transition-colors"
            title={`Generate synthesis (${selectedIds.size} papers)`}
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
