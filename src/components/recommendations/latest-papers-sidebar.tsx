"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { ChevronLeft, RefreshCw, Plus, Check, BookOpen } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

interface RecommendedPaper {
  title: string;
  abstract: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  externalUrl: string;
  citationCount: number | null;
  openAccessPdfUrl: string | null;
  source: string;
  matchReason?: string;
}

interface RecommendationsData {
  latest: RecommendedPaper[];
  recommended: RecommendedPaper[];
  fetchedAt: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const SOURCE_COLORS: Record<string, string> = {
  openalex: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  s2: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  crossref: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  arxiv: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

const SOURCE_LABELS: Record<string, string> = {
  openalex: "OpenAlex",
  s2: "Semantic Scholar",
  crossref: "CrossRef",
  arxiv: "arXiv",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 px-0.5">
        {title}
      </h3>
      {children}
    </div>
  );
}

function PaperCard({
  paper,
  isImported,
  isImporting,
  onImport,
}: {
  paper: RecommendedPaper;
  isImported: boolean;
  isImporting: boolean;
  onImport: (paper: RecommendedPaper) => void;
}) {
  const authorStr =
    paper.authors.length > 2
      ? `${paper.authors[0]} et al.`
      : paper.authors.join(", ");

  return (
    <div className="group p-2.5 rounded-lg border border-border/30 hover:border-border/60 hover:bg-accent/30 transition-colors">
      <a
        href={paper.externalUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        <h4 className="text-sm font-medium leading-snug line-clamp-2 group-hover:text-primary transition-colors">
          {paper.title}
        </h4>
      </a>
      <p className="text-xs text-muted-foreground mt-0.5 truncate">
        {authorStr}
        {paper.year ? ` · ${paper.year}` : ""}
      </p>
      {paper.abstract && (
        <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 group-hover:grid-rows-[1fr]">
          <div className="overflow-hidden">
            <p className="mt-1.5 line-clamp-4 text-xs leading-relaxed text-muted-foreground/80">
              {paper.abstract}
            </p>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between mt-1.5">
        <div className="flex items-center gap-1 min-w-0">
          <span
            className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${
              SOURCE_COLORS[paper.source] || "bg-muted text-muted-foreground"
            }`}
          >
            {SOURCE_LABELS[paper.source] || paper.source}
          </span>
          {paper.matchReason && (
            <span className="text-[10px] text-muted-foreground/60 truncate" title={paper.matchReason}>
              {paper.matchReason}
            </span>
          )}
        </div>
        <button
          onClick={() => onImport(paper)}
          disabled={isImported || isImporting}
          className={`inline-flex h-6 px-2 items-center gap-1 rounded-md text-[11px] font-medium transition-colors ${
            isImported
              ? "text-green-600 dark:text-green-400"
              : "text-muted-foreground hover:text-foreground hover:bg-accent"
          } disabled:opacity-70`}
          title={isImported ? "In library" : "Import paper"}
        >
          {isImported ? (
            <Check className="h-3 w-3" />
          ) : (
            <>
              <Plus className="h-3 w-3" />
              <span>Import</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export function LatestPapersSidebar() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<RecommendationsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [importingId, setImportingId] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const fetchRecommendations = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);

    try {
      const url = refresh ? "/api/recommendations?refresh=true" : "/api/recommendations";
      const res = await fetch(url);
      if (res.ok) {
        const result = await res.json();
        setData(result);
      }
    } catch {
      // silently fail — sidebar is non-critical
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Fetch on first open
  useEffect(() => {
    if (open && !data && !loading) {
      fetchRecommendations();
    }
  }, [open, data, loading, fetchRecommendations]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleImport = async (paper: RecommendedPaper) => {
    const paperId = paper.doi || paper.arxivId || paper.title;
    if (importedIds.has(paperId)) return;

    setImportingId(paperId);
    try {
      const res = await fetch("/api/search/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: paper.title,
          abstract: paper.abstract,
          authors: paper.authors,
          year: paper.year,
          doi: paper.doi,
          arxivId: paper.arxivId,
          externalUrl: paper.externalUrl,
          citationCount: paper.citationCount,
          openAccessPdfUrl: paper.openAccessPdfUrl,
        }),
      });

      if (res.ok) {
        setImportedIds((prev) => new Set(prev).add(paperId));
        // Remove from displayed lists
        setData((prev) => prev ? {
          ...prev,
          latest: prev.latest.filter((p) => getPaperId(p) !== paperId),
          recommended: prev.recommended.filter((p) => getPaperId(p) !== paperId),
        } : prev);
        toast.success("Paper imported");
        window.dispatchEvent(new CustomEvent("paper-imported"));
      } else if (res.status === 409) {
        setImportedIds((prev) => new Set(prev).add(paperId));
        setData((prev) => prev ? {
          ...prev,
          latest: prev.latest.filter((p) => getPaperId(p) !== paperId),
          recommended: prev.recommended.filter((p) => getPaperId(p) !== paperId),
        } : prev);
        toast.info("Already in library");
      } else {
        toast.error("Import failed");
      }
    } catch {
      toast.error("Import failed");
    } finally {
      setImportingId(null);
    }
  };

  const getPaperId = (paper: RecommendedPaper) =>
    paper.doi || paper.arxivId || paper.title;

  return (
    <div ref={sidebarRef}>
      {/* Toggle tab */}
      <button
        onClick={() => setOpen((prev) => !prev)}
        className={`fixed top-1/2 -translate-y-1/2 z-40 flex items-center justify-center h-8 w-4 rounded-l-md bg-muted/60 hover:bg-muted text-muted-foreground/40 hover:text-muted-foreground transition-all ${
          open ? "right-72" : "right-0"
        }`}
        title="Latest Papers"
      >
        <ChevronLeft
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Sidebar */}
      {open && (
        <div className="fixed right-0 top-12 bottom-0 z-30 w-72 bg-background/95 backdrop-blur-sm border-l border-border/30 overflow-y-auto scrollbar-thin flex flex-col">
          {/* Header */}
          <div className="sticky top-0 bg-background/95 backdrop-blur-sm border-b border-border/20 px-4 py-3 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Discoveries
            </span>
            <div className="flex items-center gap-1">
              {data?.fetchedAt && (
                <span className="text-[10px] text-muted-foreground/50 mr-1">
                  {timeAgo(data.fetchedAt)}
                </span>
              )}
              <button
                onClick={() => fetchRecommendations(true)}
                disabled={refreshing}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50"
                title="Refresh recommendations"
              >
                <RefreshCw
                  className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
                />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 p-3 space-y-2">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="p-2.5 rounded-lg border border-border/30">
                  <Skeleton className="h-4 w-full mb-1.5" />
                  <Skeleton className="h-3 w-3/4 mb-2" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))
            ) : !data || ((data.latest?.length ?? 0) === 0 && (data.recommended?.length ?? 0) === 0) ? (
              <div className="flex flex-col items-center gap-2 pt-12 text-center">
                <BookOpen className="h-8 w-8 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground/60 px-4">
                  Add papers and tags to get personalized recommendations.
                </p>
              </div>
            ) : (
              <>
                {(data.latest?.length ?? 0) > 0 && (
                  <Section title="Latest">
                    {data.latest.map((paper, idx) => (
                      <PaperCard
                        key={`latest-${idx}`}
                        paper={paper}
                        isImported={importedIds.has(getPaperId(paper))}
                        isImporting={importingId === getPaperId(paper)}
                        onImport={handleImport}
                      />
                    ))}
                  </Section>
                )}
                {(data.recommended?.length ?? 0) > 0 && (
                  <Section title="Recommended">
                    {data.recommended.map((paper, idx) => (
                      <PaperCard
                        key={`rec-${idx}`}
                        paper={paper}
                        isImported={importedIds.has(getPaperId(paper))}
                        isImporting={importingId === getPaperId(paper)}
                        onImport={handleImport}
                      />
                    ))}
                  </Section>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
