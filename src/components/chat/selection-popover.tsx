"use client";

import { useEffect, useState, useCallback, forwardRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Lightbulb,
  MessageCircle,
  ExternalLink,
  Trash2,
  ChevronDown,
  ChevronRight,
  Loader2,
  BookmarkPlus,
} from "lucide-react";
import { useNotebook } from "@/hooks/use-notebook";

interface Match {
  id: string;
  matchType: "exact" | "superset" | "subset";
  selectedText: string;
  mode: string | null;
  title: string | null;
  previewText: string | null;
  messageCount: number;
  createdAt: string;
}

interface SelectionPopoverProps {
  paperId: string;
  text: string;
  x: number;
  y: number;
  placement: "above" | "below";
  onExplain: () => void;
  onChat: () => void;
  onOpenConversation: (convId: string) => void;
  onDeleteConversation: (convId: string) => void;
}

export const SelectionPopover = forwardRef<
  HTMLDivElement,
  SelectionPopoverProps
>(function SelectionPopover(
  {
    paperId,
    text,
    x,
    y,
    placement,
    onExplain,
    onChat,
    onOpenConversation,
    onDeleteConversation,
  },
  ref
) {
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [subsetOpen, setSubsetOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchMatches = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/papers/${paperId}/conversations/matches?text=${encodeURIComponent(text)}`
      );
      if (res.ok) {
        const data: Match[] = await res.json();
        setMatches(data.length > 0 ? data : null);
      } else {
        setMatches(null);
      }
    } catch {
      setMatches(null);
    }
    setLoading(false);
  }, [paperId, text]);

  useEffect(() => {
    fetchMatches();
  }, [fetchMatches]);

  const handleDelete = async (convId: string) => {
    setDeletingId(convId);
    await onDeleteConversation(convId);
    setMatches((prev) => {
      if (!prev) return null;
      const next = prev.filter((m) => m.id !== convId);
      return next.length > 0 ? next : null;
    });
    setDeletingId(null);
  };

  const { saveToNotebook, saving: notebookSaving } = useNotebook();

  const primaryMatches = matches?.filter(
    (m) => m.matchType === "exact" || m.matchType === "superset"
  );
  const subsetMatches = matches?.filter((m) => m.matchType === "subset");
  const hasMatches = matches && matches.length > 0;

  // Minimal pill — shown while loading or when no matches
  if (loading || !hasMatches) {
    return (
      <div
        ref={ref}
        className="fixed z-[60] animate-in fade-in zoom-in-95 duration-100"
        style={{
          left: `${x}px`,
          top: `${y}px`,
          transform:
            placement === "above"
              ? "translate(-50%, -100%)"
              : "translate(-50%, 0%)",
        }}
      >
        <div className="flex gap-1 rounded-lg bg-popover border shadow-lg p-1">
          {loading ? (
            <div className="flex items-center px-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            </div>
          ) : null}
          <button
            title="Explain"
            onClick={onExplain}
            className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
          >
            <Lightbulb className="h-3 w-3" />
            Explain
          </button>
          <button
            title="Ask about this"
            onClick={onChat}
            className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 transition-colors"
          >
            <MessageCircle className="h-3 w-3" />
            Chat
          </button>
          <button
            title="Save to notebook"
            disabled={notebookSaving}
            onClick={() =>
              saveToNotebook({
                paperId,
                type: "selection",
                selectedText: text,
              })
            }
            className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 transition-colors disabled:opacity-50"
          >
            <BookmarkPlus className="h-3 w-3" />
            Notebook
          </button>
        </div>
      </div>
    );
  }

  // Rich card — shown when matches exist
  return (
    <div
      ref={ref}
      className="fixed z-[60] animate-in fade-in zoom-in-95 duration-100"
      style={{
        left: `${x}px`,
        top: `${y}px`,
        transform:
          placement === "above"
            ? "translate(-50%, -100%)"
            : "translate(-50%, 0%)",
      }}
    >
      <div className="w-[340px] rounded-lg bg-popover border shadow-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
          <span className="text-xs font-medium text-muted-foreground">
            Previous results
          </span>
          <div className="flex gap-1">
            <button
              onClick={onExplain}
              className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
            >
              <Lightbulb className="h-3 w-3" />
              Explain
            </button>
            <button
              onClick={onChat}
              className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 transition-colors"
            >
              <MessageCircle className="h-3 w-3" />
              Chat
            </button>
            <button
              title="Save to notebook"
              disabled={notebookSaving}
              onClick={() =>
                saveToNotebook({
                  paperId,
                  type: "selection",
                  selectedText: text,
                })
              }
              className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 transition-colors disabled:opacity-50"
            >
              <BookmarkPlus className="h-3 w-3" />
              Notebook
            </button>
          </div>
        </div>

        <ScrollArea className="max-h-[280px]">
          {/* Primary matches (exact + superset) */}
          {primaryMatches && primaryMatches.length > 0 && (
            <div className="p-1.5 space-y-1">
              {primaryMatches.map((match) => (
                <MatchItem
                  key={match.id}
                  match={match}
                  deleting={deletingId === match.id}
                  onOpen={() => onOpenConversation(match.id)}
                  onDelete={() => handleDelete(match.id)}
                />
              ))}
            </div>
          )}

          {/* Subset matches (collapsible) */}
          {subsetMatches && subsetMatches.length > 0 && (
            <div className="border-t">
              <button
                onClick={() => setSubsetOpen(!subsetOpen)}
                className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40 transition-colors"
              >
                {subsetOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                {subsetMatches.length} partial{" "}
                {subsetMatches.length === 1 ? "match" : "matches"}
              </button>
              {subsetOpen && (
                <div className="p-1.5 pt-0 space-y-1">
                  {subsetMatches.map((match) => (
                    <MatchItem
                      key={match.id}
                      match={match}
                      deleting={deletingId === match.id}
                      showQuotedText
                      onOpen={() => onOpenConversation(match.id)}
                      onDelete={() => handleDelete(match.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
});

function MatchItem({
  match,
  deleting,
  showQuotedText,
  onOpen,
  onDelete,
}: {
  match: Match;
  deleting: boolean;
  showQuotedText?: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-md px-2.5 py-2 hover:bg-muted/50 transition-colors group relative">
      <div className="flex items-center gap-1.5 mb-1">
        {match.mode && (
          <Badge
            variant="secondary"
            className="h-4 px-1.5 text-[10px] leading-none"
          >
            {match.mode === "explain" ? (
              <Lightbulb className="h-2.5 w-2.5 mr-0.5" />
            ) : (
              <MessageCircle className="h-2.5 w-2.5 mr-0.5" />
            )}
            {match.mode}
          </Badge>
        )}
        <span className="text-[10px] text-muted-foreground">
          {match.messageCount} msg{match.messageCount !== 1 ? "s" : ""}
        </span>
      </div>

      {showQuotedText && (
        <p className="text-[11px] text-muted-foreground italic mb-1 line-clamp-1">
          &ldquo;{match.selectedText}&rdquo;
        </p>
      )}

      {match.previewText && (
        <p className="text-xs text-foreground/80 line-clamp-2 leading-relaxed">
          {match.previewText}
        </p>
      )}

      {/* Hover actions */}
      <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 p-0"
          title="Open conversation"
          onClick={onOpen}
        >
          <ExternalLink className="h-3 w-3" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 p-0 text-destructive hover:text-destructive"
          title="Delete"
          onClick={onDelete}
          disabled={deleting}
        >
          {deleting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </Button>
      </div>
    </div>
  );
}
