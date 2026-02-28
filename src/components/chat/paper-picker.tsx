"use client";

import { useState, useEffect, ReactNode } from "react";
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
import { BookOpen, Loader2 } from "lucide-react";

interface PaperPickerProps {
  paperId: string;
  conversationId: string;
  /** Custom trigger element (renders inside PopoverTrigger) */
  trigger?: ReactNode;
  /** Called after a paper is added server-side */
  onAdd?: (paperId: string, title: string) => void;
  /** Called after a paper is removed server-side */
  onRemove?: (paperId: string) => void;
}

export function PaperPicker({
  paperId,
  conversationId,
  trigger,
  onAdd,
  onRemove,
}: PaperPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<
    { id: string; title: string }[]
  >([]);
  const [referencedIds, setReferencedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  // Load currently referenced paper ids when opened
  useEffect(() => {
    if (!open) return;
    (async () => {
      const res = await fetch(
        `/api/papers/${paperId}/conversations/${conversationId}`
      );
      const data = await res.json();
      setReferencedIds(
        new Set(
          (data.additionalPapers || []).map(
            (ap: { paper: { id: string } }) => ap.paper.id
          )
        )
      );
    })();
  }, [open, paperId, conversationId]);

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
  }, [search, paperId, referencedIds]);

  const handleAdd = async (addPaperId: string, title: string) => {
    await fetch(`/api/papers/${paperId}/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addPaperIds: [addPaperId] }),
    });
    setReferencedIds((prev) => {
      const next = new Set(Array.from(prev));
      next.add(addPaperId);
      return next;
    });
    onAdd?.(addPaperId, title);
    setSearch("");
    setSearchResults([]);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger || (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Add paper context"
          >
            <BookOpen className="h-3.5 w-3.5" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="start"
        side="top"
        sideOffset={4}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search papers to add..."
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
      </PopoverContent>
    </Popover>
  );
}
