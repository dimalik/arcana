"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  FileText,
  ArrowUpDown,
  MoreHorizontal,
  Plus,
  Tags,
  Trash2,
  Check,
  X,
} from "lucide-react";
import { PaperCard, PaperCardData } from "@/components/paper-card";
import { DiscoveriesPanel } from "@/components/recommendations/discoveries-panel";
import { AddPaperDialog } from "@/components/add-paper-dialog";
import { toast } from "sonner";

interface TagCluster {
  id: string;
  name: string;
  color: string;
  tags: { id: string; name: string; color: string; _count: { papers: number } }[];
}

// ── Tag Filter Strip ──────────────────────────────────────────────

function TagFilterStrip({
  clusters,
  selectedTagIds,
  onToggleTag,
  onClear,
}: {
  clusters: TagCluster[];
  selectedTagIds: Set<string>;
  onToggleTag: (tagId: string) => void;
  onClear: () => void;
}) {
  const [openCluster, setOpenCluster] = useState<string | null>(null);

  // Build a flat tag list for resolving selected tags
  const allTags = clusters.flatMap((c) =>
    c.tags
      .filter((t) => t._count.papers >= 1)
      .map((t) => ({ ...t, cluster: c }))
  );

  const selectedTags = allTags.filter((t) => selectedTagIds.has(t.id));

  if (clusters.length === 0) return null;

  return (
    <div className="space-y-2">
      {/* Cluster chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {clusters.map((cluster) => {
          const visibleTags = cluster.tags.filter((t) => t._count.papers >= 1);
          if (visibleTags.length === 0) return null;
          const activeInCluster = visibleTags.filter((t) => selectedTagIds.has(t.id)).length;

          return (
            <Popover
              key={cluster.id}
              open={openCluster === cluster.id}
              onOpenChange={(open) => setOpenCluster(open ? cluster.id : null)}
            >
              <PopoverTrigger asChild>
                <button
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all hover:ring-1 hover:ring-border/60"
                  style={{
                    backgroundColor: cluster.color + "12",
                    color: cluster.color,
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: cluster.color }}
                  />
                  {cluster.name}
                  {activeInCluster > 0 && (
                    <span
                      className="ml-0.5 h-4 min-w-4 inline-flex items-center justify-center rounded-full text-[10px] font-bold text-white"
                      style={{ backgroundColor: cluster.color }}
                    >
                      {activeInCluster}
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-52 p-1.5"
                onOpenAutoFocus={(e) => e.preventDefault()}
              >
                <div className="space-y-0.5 max-h-64 overflow-y-auto">
                  {visibleTags.map((tag) => {
                    const isSelected = selectedTagIds.has(tag.id);
                    return (
                      <button
                        key={tag.id}
                        onClick={() => onToggleTag(tag.id)}
                        className={`flex items-center justify-between w-full rounded-sm px-2 py-1.5 text-xs transition-colors ${
                          isSelected ? "bg-accent font-medium" : "hover:bg-accent/50"
                        }`}
                      >
                        <span className="truncate">{tag.name}</span>
                        <span className="flex items-center gap-1.5 ml-2 shrink-0">
                          <span className="text-[10px] text-muted-foreground/50 tabular-nums">
                            {tag._count.papers}
                          </span>
                          {isSelected && <Check className="h-3 w-3 text-primary" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          );
        })}
      </div>

      {/* Active filter pills */}
      {selectedTags.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mr-0.5">Filtered</span>
          {selectedTags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => onToggleTag(tag.id)}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors hover:opacity-80"
              style={{
                backgroundColor: tag.color + "20",
                color: tag.color,
              }}
            >
              {tag.name}
              <X className="h-2.5 w-2.5 opacity-60" />
            </button>
          ))}
          <button
            onClick={onClear}
            className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground ml-1 transition-colors"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function HomePage() {
  const [clusters, setClusters] = useState<TagCluster[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [papers, setPapers] = useState<PaperCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [sort, setSort] = useState("newest");

  // Add Paper dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogTab, setAddDialogTab] = useState<"pdf" | "arxiv" | "anthology" | "url">("pdf");

  // Fetch clusters once
  useEffect(() => {
    fetch("/api/tags/clusters")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setClusters(data);
        }
      })
      .catch(() => {});
  }, []);

  // Fetch papers
  const fetchPapers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: page.toString(), sort });

      if (selectedTagIds.size === 1) {
        params.set("tagId", Array.from(selectedTagIds)[0]);
      } else if (selectedTagIds.size > 1) {
        params.set("tagIds", Array.from(selectedTagIds).join(","));
      }

      const res = await fetch(`/api/papers?${params}`);
      const data = await res.json();
      setPapers(data.papers ?? []);
      setTotal(data.total ?? 0);
      setTotalPages(data.totalPages ?? 1);
    } catch {
      toast.error("Failed to load papers");
    }
    setLoading(false);
  }, [page, selectedTagIds, sort]);

  useEffect(() => {
    fetchPapers();
  }, [fetchPapers]);

  // Auto-refresh when a paper is imported from the sidebar
  useEffect(() => {
    const handler = () => fetchPapers();
    window.addEventListener("paper-imported", handler);
    return () => window.removeEventListener("paper-imported", handler);
  }, [fetchPapers]);

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
    setPage(1);
  };

  const clearFilters = () => {
    setSelectedTagIds(new Set());
    setPage(1);
  };

  const handleLikeToggle = async (id: string) => {
    const res = await fetch(`/api/papers/${id}/like`, { method: "PATCH" });
    if (res.ok) {
      const { isLiked } = await res.json();
      setPapers((prev) =>
        prev.map((p) => (p.id === id ? { ...p, isLiked } : p))
      );
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this paper?")) return;
    await fetch(`/api/papers/${id}`, { method: "DELETE" });
    toast.success("Paper deleted");
    fetchPapers();
  };

  const hasFilters = selectedTagIds.size > 0;

  return (
    <div className="flex gap-6">
      {/* Papers list — 3/4 */}
      <div className="flex-1 min-w-0 space-y-4">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">Library</h3>
            <span className="text-[11px] font-medium rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            {/* Add paper */}
            <button
              onClick={() => { setAddDialogTab("pdf"); setAddDialogOpen(true); }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              title="Add paper"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>

            {/* Sort */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                  <ArrowUpDown className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {[
                  { value: "newest", label: "Newest first" },
                  { value: "oldest", label: "Oldest first" },
                  { value: "title", label: "Title A-Z" },
                  { value: "year", label: "Year" },
                  { value: "engagement", label: "Most read" },
                ].map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => { setSort(opt.value); setPage(1); }}
                    className="flex items-center justify-between"
                  >
                    {opt.label}
                    {sort === opt.value && <Check className="h-3.5 w-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* More actions */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => { setAddDialogTab("pdf"); setAddDialogOpen(true); }} className="flex items-center gap-2">
                  <Plus className="h-3.5 w-3.5" />
                  Add paper
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings?tab=tags" className="flex items-center gap-2">
                    <Tags className="h-3.5 w-3.5" />
                    Manage tags
                  </Link>
                </DropdownMenuItem>
                {hasFilters && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={clearFilters} className="flex items-center gap-2">
                      <Trash2 className="h-3.5 w-3.5" />
                      Clear filters
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Tag filter strip */}
        <TagFilterStrip
          clusters={clusters}
          selectedTagIds={selectedTagIds}
          onToggleTag={toggleTag}
          onClear={clearFilters}
        />

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
                {hasFilters
                  ? "No papers found for these filters."
                  : "No papers yet. Upload or import your first paper to get started."}
              </p>
              {!hasFilters && (
                <Button variant="outline" size="sm" onClick={() => { setAddDialogTab("pdf"); setAddDialogOpen(true); }}>
                  Upload a Paper
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {papers.map((paper) => (
              <PaperCard
                key={paper.id}
                paper={paper}
                onLikeToggle={handleLikeToggle}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex justify-center items-center gap-3 pt-4">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              {page} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        )}

        {/* Add Paper dialog */}
        <AddPaperDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          defaultTab={addDialogTab}
        />
      </div>

      {/* Discoveries — 1/4 */}
      <div className="w-72 shrink-0 hidden lg:block">
        <div className="sticky top-0">
          <DiscoveriesPanel tagIds={Array.from(selectedTagIds)} />
        </div>
      </div>
    </div>
  );
}
