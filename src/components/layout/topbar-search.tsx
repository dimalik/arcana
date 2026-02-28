"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, FileText, Loader2 } from "lucide-react";

interface PaperResult {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
}

export function TopbarSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PaperResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/papers?search=${encodeURIComponent(q)}&limit=6`,
        { signal: controller.signal }
      );
      if (!res.ok) return;
      const data = await res.json();
      setResults(data.papers ?? []);
      setOpen(true);
      setSelected(-1);
    } catch {
      // aborted or network error
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  // Debounce
  useEffect(() => {
    const t = setTimeout(() => search(query), 200);
    return () => clearTimeout(t);
  }, [query, search]);

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

  const navigate = (id: string) => {
    setOpen(false);
    setQuery("");
    router.push(`/papers/${id}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (s + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (s - 1 + results.length) % results.length);
    } else if (e.key === "Enter" && selected >= 0) {
      e.preventDefault();
      navigate(results[selected].id);
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

  return (
    <div ref={containerRef} className="relative hidden sm:block">
      <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs text-muted-foreground focus-within:border-foreground/30 transition-colors">
        {loading ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Search className="h-3 w-3" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          onKeyDown={handleKeyDown}
          placeholder="Search papers..."
          className="w-36 bg-transparent outline-none placeholder:text-muted-foreground/60 focus:w-52 transition-all"
        />
        <kbd className="font-mono text-[10px] opacity-50">&#8984;/</kbd>
      </div>

      {/* Results dropdown */}
      {open && results.length > 0 && (
        <div className="absolute right-0 top-full mt-1 w-80 rounded-md border bg-popover p-1 shadow-lg z-50">
          {results.map((paper, i) => {
            const authors = paper.authors ? JSON.parse(paper.authors) as string[] : [];
            return (
              <button
                key={paper.id}
                onClick={() => navigate(paper.id)}
                onMouseEnter={() => setSelected(i)}
                className={`flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors ${
                  i === selected ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="truncate font-medium">{paper.title}</div>
                  {(authors.length > 0 || paper.year) && (
                    <div className="truncate text-xs text-muted-foreground">
                      {authors.slice(0, 2).join(", ")}
                      {authors.length > 2 && " et al."}
                      {paper.year && ` · ${paper.year}`}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {open && query.length >= 2 && results.length === 0 && !loading && (
        <div className="absolute right-0 top-full mt-1 w-64 rounded-md border bg-popover p-3 text-center text-sm text-muted-foreground shadow-lg z-50">
          No papers found
        </div>
      )}
    </div>
  );
}
