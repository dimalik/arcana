"use client";

import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { X, Search } from "lucide-react";

interface PaperOption {
  id: string;
  title: string;
  year: number | null;
}

interface PaperPickerProps {
  selected: PaperOption[];
  onChange: (papers: PaperOption[]) => void;
}

export function PaperPicker({ selected, onChange }: PaperPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PaperOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/papers?search=${encodeURIComponent(query)}&limit=10`
        );
        const data = await res.json();
        const papers = (data.papers || []).map(
          (p: { id: string; title: string; year: number | null }) => ({
            id: p.id,
            title: p.title,
            year: p.year,
          })
        );
        setResults(papers);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(debounceRef.current);
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const addPaper = (paper: PaperOption) => {
    if (!selected.find((p) => p.id === paper.id)) {
      onChange([...selected, paper]);
    }
    setQuery("");
    setOpen(false);
  };

  const removePaper = (id: string) => {
    onChange(selected.filter((p) => p.id !== id));
  };

  const filteredResults = results.filter(
    (r) => !selected.find((s) => s.id === r.id)
  );

  return (
    <div ref={containerRef} className="space-y-2">
      {/* Selected papers */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((paper) => (
            <Badge
              key={paper.id}
              variant="secondary"
              className="gap-1 pr-1 text-xs"
            >
              <span className="max-w-[200px] truncate">{paper.title}</span>
              {paper.year && (
                <span className="text-muted-foreground">({paper.year})</span>
              )}
              <button
                onClick={() => removePaper(paper.id)}
                className="ml-1 rounded-full p-0.5 hover:bg-muted"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search papers to use as seeds..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => query.trim() && results.length > 0 && setOpen(true)}
          className="pl-9"
        />

        {/* Dropdown */}
        {open && filteredResults.length > 0 && (
          <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
            <div className="max-h-[240px] overflow-y-auto p-1">
              {filteredResults.map((paper) => (
                <button
                  key={paper.id}
                  onClick={() => addPaper(paper)}
                  className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="flex-1 line-clamp-2">{paper.title}</span>
                  {paper.year && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {paper.year}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {open && loading && (
          <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-3 text-center text-sm text-muted-foreground shadow-md">
            Searching...
          </div>
        )}
      </div>
    </div>
  );
}
