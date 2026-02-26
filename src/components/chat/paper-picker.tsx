"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { BookOpen, X, Loader2 } from "lucide-react";

interface ReferencedPaper {
  id: string;
  title: string;
}

interface PaperPickerProps {
  paperId: string; // primary paper id (excluded from search)
  conversationId: string;
}

export function PaperPicker({ paperId, conversationId }: PaperPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<
    { id: string; title: string }[]
  >([]);
  const [referenced, setReferenced] = useState<ReferencedPaper[]>([]);
  const [loading, setLoading] = useState(false);

  // Load currently referenced papers
  const loadReferenced = useCallback(async () => {
    const res = await fetch(
      `/api/papers/${paperId}/conversations/${conversationId}`
    );
    const data = await res.json();
    setReferenced(
      (data.additionalPapers || []).map(
        (ap: { paper: { id: string; title: string } }) => ap.paper
      )
    );
  }, [paperId, conversationId]);

  useEffect(() => {
    if (open) loadReferenced();
  }, [open, loadReferenced]);

  // Search papers
  useEffect(() => {
    if (!search.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setLoading(true);
      const res = await fetch(
        `/api/papers?search=${encodeURIComponent(search)}&limit=10`
      );
      const data = await res.json();
      // Exclude primary paper and already-referenced papers
      const referencedIds = new Set(referenced.map((r) => r.id));
      setSearchResults(
        (data.papers || [])
          .filter(
            (p: { id: string }) =>
              p.id !== paperId && !referencedIds.has(p.id)
          )
          .map((p: { id: string; title: string }) => ({
            id: p.id,
            title: p.title,
          }))
      );
      setLoading(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, paperId, referenced]);

  const handleAdd = async (addPaperId: string, title: string) => {
    await fetch(`/api/papers/${paperId}/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addPaperIds: [addPaperId] }),
    });
    setReferenced((prev) => [...prev, { id: addPaperId, title }]);
    setSearch("");
    setSearchResults([]);
  };

  const handleRemove = async (removePaperId: string) => {
    await fetch(`/api/papers/${paperId}/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removePaperIds: [removePaperId] }),
    });
    setReferenced((prev) => prev.filter((r) => r.id !== removePaperId));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Add paper context"
        >
          <BookOpen className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="end"
        side="bottom"
        sideOffset={4}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search papers..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading && (
              <div className="flex justify-center py-3">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && search.trim() && searchResults.length === 0 && (
              <CommandEmpty>No papers found</CommandEmpty>
            )}
            {searchResults.map((paper) => (
              <CommandItem
                key={paper.id}
                onSelect={() => handleAdd(paper.id, paper.title)}
                className="cursor-pointer"
              >
                <BookOpen className="h-3.5 w-3.5 mr-2 shrink-0" />
                <span className="truncate text-sm">{paper.title}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>

        {/* Referenced papers */}
        {referenced.length > 0 && (
          <div className="border-t px-3 py-2 space-y-1">
            <p className="text-xs text-muted-foreground font-medium">
              Referenced papers
            </p>
            {referenced.map((paper) => (
              <div
                key={paper.id}
                className="flex items-center gap-1.5 text-sm"
              >
                <span className="truncate flex-1">{paper.title}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0"
                  onClick={() => handleRemove(paper.id)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
