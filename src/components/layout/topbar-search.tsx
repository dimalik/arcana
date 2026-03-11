"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, FileText, Loader2, Plus, Check, ExternalLink } from "lucide-react";
import { toast } from "sonner";

interface LocalResult {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
}

interface OnlineResult {
  semanticScholarId: string;
  title: string;
  abstract: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  externalUrl: string;
  citationCount: number | null;
  openAccessPdfUrl: string | null;
  source?: string;
}

const sourceColor: Record<string, string> = {
  openalex: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  s2: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  crossref: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
};
const sourceLabel: Record<string, string> = {
  openalex: "OA",
  s2: "S2",
  crossref: "CR",
};

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function TopbarSearch({ wide = false }: { wide?: boolean }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [localResults, setLocalResults] = useState<LocalResult[]>([]);
  const [onlineResults, setOnlineResults] = useState<OnlineResult[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(-1);
  const [importing, setImporting] = useState<Record<string, "loading" | "done" | "exists">>({});

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const localAbortRef = useRef<AbortController | null>(null);
  const onlineAbortRef = useRef<AbortController | null>(null);

  // --- Local search (200ms debounce) ---
  const searchLocal = useCallback(async (q: string) => {
    if (q.length < 2) {
      setLocalResults([]);
      return;
    }
    localAbortRef.current?.abort();
    const controller = new AbortController();
    localAbortRef.current = controller;
    setLocalLoading(true);
    try {
      const res = await fetch(
        `/api/papers?search=${encodeURIComponent(q)}&limit=5`,
        { signal: controller.signal }
      );
      if (!res.ok) return;
      const data = await res.json();
      setLocalResults(data.papers ?? []);
      setSelected(-1);
    } catch {
      // aborted
    } finally {
      if (!controller.signal.aborted) setLocalLoading(false);
    }
  }, []);

  // --- Online search (500ms debounce, >= 3 chars) ---
  const searchOnline = useCallback(async (q: string) => {
    if (q.length < 3) {
      setOnlineResults([]);
      return;
    }
    onlineAbortRef.current?.abort();
    const controller = new AbortController();
    onlineAbortRef.current = controller;
    setOnlineLoading(true);
    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(q)}`,
        { signal: controller.signal }
      );
      if (!res.ok) return;
      const data: OnlineResult[] = await res.json();
      setOnlineResults(data);
    } catch {
      // aborted
    } finally {
      if (!controller.signal.aborted) setOnlineLoading(false);
    }
  }, []);

  // Debounce local
  useEffect(() => {
    const t = setTimeout(() => searchLocal(query), 200);
    return () => clearTimeout(t);
  }, [query, searchLocal]);

  // Debounce online
  useEffect(() => {
    const t = setTimeout(() => searchOnline(query), 500);
    return () => clearTimeout(t);
  }, [query, searchOnline]);

  // Dedup online results against local
  const filteredOnline = onlineResults.filter((online) => {
    return !localResults.some((local) => {
      const localAuthorsRaw = local.authors;
      // Check DOI
      if (online.doi && localAuthorsRaw) {
        // We don't have DOI on local results from the search endpoint,
        // so fall through to title matching
      }
      // Check normalized title
      if (normalize(online.title) === normalize(local.title)) return true;
      return false;
    });
  }).slice(0, 8);

  // Open logic
  const shouldOpen = query.length >= 2 && (
    localResults.length > 0 ||
    filteredOnline.length > 0 ||
    onlineLoading ||
    localLoading
  );

  useEffect(() => {
    if (shouldOpen) setOpen(true);
    else if (query.length < 2) setOpen(false);
  }, [shouldOpen, query]);

  // Combined flat list for keyboard nav
  const flatList = [...localResults.map((r) => ({ type: "local" as const, data: r })), ...filteredOnline.map((r) => ({ type: "online" as const, data: r }))];

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const navigateLocal = (id: string) => {
    setOpen(false);
    setQuery("");
    router.push(`/papers/${id}`);
  };

  const handleImport = async (result: OnlineResult) => {
    const key = result.semanticScholarId;
    setImporting((prev) => ({ ...prev, [key]: "loading" }));
    try {
      const res = await fetch("/api/search/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: result.title,
          abstract: result.abstract,
          authors: result.authors,
          year: result.year,
          venue: result.venue,
          doi: result.doi,
          arxivId: result.arxivId,
          externalUrl: result.externalUrl,
          citationCount: result.citationCount,
          openAccessPdfUrl: result.openAccessPdfUrl,
          semanticScholarId: result.semanticScholarId,
        }),
      });

      if (res.status === 409) {
        setImporting((prev) => ({ ...prev, [key]: "exists" }));
        toast.info("Paper already in library");
        return;
      }
      if (!res.ok) throw new Error("Import failed");

      setImporting((prev) => ({ ...prev, [key]: "done" }));
      toast.success("Paper added to library");
      window.dispatchEvent(new Event("paper-imported"));
    } catch {
      setImporting((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      toast.error("Failed to import paper");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || flatList.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, flatList.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, -1));
    } else if (e.key === "Enter" && selected >= 0) {
      e.preventDefault();
      const item = flatList[selected];
      if (item.type === "local") {
        navigateLocal((item.data as LocalResult).id);
      } else {
        handleImport(item.data as OnlineResult);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  // Global Cmd+/ to focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // External event: topbar-search
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) {
        setQuery(detail);
        inputRef.current?.focus();
      }
    };
    window.addEventListener("topbar-search", handler);
    return () => window.removeEventListener("topbar-search", handler);
  }, []);

  // Track index for rendering
  let globalIndex = -1;

  return (
    <div ref={containerRef} className={`relative hidden sm:block ${wide ? "w-full max-w-2xl" : ""}`}>
      <div className="flex items-center gap-1.5 rounded-md border border-border/40 px-2.5 py-1 text-xs text-muted-foreground focus-within:border-border/70 transition-colors">
        {localLoading ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Search className="h-3 w-3" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => { if (shouldOpen) setOpen(true); }}
          onKeyDown={handleKeyDown}
          placeholder="Search papers..."
          className={`bg-transparent outline-none placeholder:text-muted-foreground/60 transition-all ${
            wide ? "w-full" : "w-36 focus:w-52"
          }`}
        />
        <kbd className="font-mono text-[10px] opacity-50">&#8984;/</kbd>
      </div>

      {/* Results dropdown */}
      {open && (
        <div className="absolute left-0 top-full mt-1 rounded-md border bg-popover shadow-lg z-50 w-[420px] max-h-[420px] overflow-y-auto">
          {/* Local section */}
          {localResults.length > 0 && (
            <div>
              <div className="px-2.5 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                In Library
              </div>
              <div className="p-1">
                {localResults.map((paper) => {
                  globalIndex++;
                  const idx = globalIndex;
                  const authors = paper.authors ? JSON.parse(paper.authors) as string[] : [];
                  return (
                    <button
                      key={paper.id}
                      onClick={() => navigateLocal(paper.id)}
                      onMouseEnter={() => setSelected(idx)}
                      className={`flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors ${
                        selected === idx ? "bg-accent text-accent-foreground" : ""
                      }`}
                    >
                      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-xs">{paper.title}</div>
                        {(authors.length > 0 || paper.year) && (
                          <div className="truncate text-[11px] text-muted-foreground">
                            {authors.slice(0, 2).join(", ")}
                            {authors.length > 2 && " et al."}
                            {paper.year && ` \u00b7 ${paper.year}`}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Online section */}
          {(filteredOnline.length > 0 || onlineLoading) && query.length >= 3 && (
            <div>
              {localResults.length > 0 && <div className="border-t border-border/40" />}
              <div className="px-2.5 pt-2 pb-1 flex items-center justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Online
                </span>
                {onlineLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/60" />}
              </div>
              <div className="p-1">
                {filteredOnline.map((result) => {
                  globalIndex++;
                  const idx = globalIndex;
                  const key = result.semanticScholarId;
                  const importState = importing[key];
                  return (
                    <div
                      key={key}
                      onMouseEnter={() => setSelected(idx)}
                      className={`flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors ${
                        selected === idx ? "bg-accent text-accent-foreground" : ""
                      }`}
                    >
                      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {result.externalUrl ? (
                            <a
                              href={result.externalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="truncate font-medium text-xs hover:underline"
                            >
                              {result.title}
                            </a>
                          ) : (
                            <span className="truncate font-medium text-xs">{result.title}</span>
                          )}
                          {result.source && (
                            <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium leading-none ${sourceColor[result.source] || "bg-muted text-muted-foreground"}`}>
                              {sourceLabel[result.source] || result.source}
                            </span>
                          )}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {result.authors.slice(0, 2).join(", ")}
                          {result.authors.length > 2 && " et al."}
                          {result.year && ` \u00b7 ${result.year}`}
                        </div>
                      </div>
                      <div className="shrink-0 ml-1">
                        {importState === "done" ? (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-green-600 dark:text-green-400 font-medium">
                            <Check className="h-3 w-3" /> Added
                          </span>
                        ) : importState === "exists" ? (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-blue-600 dark:text-blue-400 font-medium">
                            <Check className="h-3 w-3" /> In library
                          </span>
                        ) : importState === "loading" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleImport(result); }}
                            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors"
                          >
                            <Plus className="h-3 w-3" /> Import
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Empty state */}
          {localResults.length === 0 && filteredOnline.length === 0 && !localLoading && !onlineLoading && query.length >= 2 && (
            <div className="p-3 text-center text-sm text-muted-foreground">
              No papers found
            </div>
          )}
        </div>
      )}
    </div>
  );
}
