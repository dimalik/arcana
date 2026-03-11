"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import {
  Lightbulb,
  MessageCircle,
  FileText,
  StickyNote,
  Camera,
  Trash2,
  Pencil,
  Check,
  X,
  Plus,
  BookOpen,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { InlineChat } from "@/components/chat/inline-chat";

interface NotebookEntry {
  id: string;
  paperId: string;
  type: "selection" | "explanation" | "chat" | "note" | "screenshot";
  selectedText: string | null;
  content: string | null;
  annotation: string | null;
  conversationId: string | null;
  messageId: string | null;
  createdAt: string;
  updatedAt: string;
  paper: { id: string; title: string; authors: string | null };
}

const typeConfig = {
  selection: {
    label: "Selection",
    icon: FileText,
    color: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  },
  explanation: {
    label: "Explanation",
    icon: Lightbulb,
    color: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  chat: {
    label: "Chat",
    icon: MessageCircle,
    color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
  note: {
    label: "Note",
    icon: StickyNote,
    color: "bg-green-500/10 text-green-600 dark:text-green-400",
  },
  screenshot: {
    label: "Screenshot",
    icon: Camera,
    color: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  },
};

export default function NotebookPage() {
  const [entries, setEntries] = useState<NotebookEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [paperFilter, setPaperFilter] = useState<string>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showNewNote, setShowNewNote] = useState(false);
  const [newNotePaperId, setNewNotePaperId] = useState("");
  const [newNoteContent, setNewNoteContent] = useState("");
  const [papers, setPapers] = useState<
    { id: string; title: string }[]
  >([]);
  const [inlineChat, setInlineChat] = useState<{
    entryId: string;
    paperId: string;
    conversationId: string;
    mode: "explain" | "chat";
    selectedText: string;
  } | null>(null);

  const fetchEntries = useCallback(async () => {
    const params = new URLSearchParams();
    if (typeFilter !== "all") params.set("type", typeFilter);
    if (paperFilter !== "all") params.set("paperId", paperFilter);

    const res = await fetch(`/api/notebook?${params}`);
    const data = await res.json();
    setEntries(data);
    setLoading(false);
  }, [typeFilter, paperFilter]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  // Fetch papers for selector
  useEffect(() => {
    fetch("/api/papers?limit=200")
      .then((r) => r.json())
      .then((data) => {
        const list = (data.papers || data).map(
          (p: { id: string; title: string }) => ({
            id: p.id,
            title: p.title,
          })
        );
        setPapers(list);
      });
  }, []);

  // Derive unique papers from entries for filter
  const entryPapers = Array.from(
    new Map(entries.map((e) => [e.paper.id, e.paper])).values()
  );

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/notebook/${id}`, { method: "DELETE" });
    if (res.ok) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
      toast.success("Entry deleted");
    } else {
      toast.error("Failed to delete entry");
    }
  };

  const handleSaveAnnotation = async (id: string) => {
    const res = await fetch(`/api/notebook/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotation: editText || null }),
    });
    if (res.ok) {
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, annotation: editText || null } : e
        )
      );
      setEditingId(null);
      toast.success("Annotation saved");
    } else {
      toast.error("Failed to save annotation");
    }
  };

  const handleCreateNote = async () => {
    if (!newNotePaperId || !newNoteContent.trim()) return;
    const res = await fetch("/api/notebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paperId: newNotePaperId,
        type: "note",
        content: newNoteContent.trim(),
      }),
    });
    if (res.ok) {
      setShowNewNote(false);
      setNewNotePaperId("");
      setNewNoteContent("");
      fetchEntries();
      toast.success("Note created");
    } else {
      toast.error("Failed to create note");
    }
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleOpenChat = async (
    entry: NotebookEntry,
    mode: "explain" | "chat"
  ) => {
    const selectedText = entry.selectedText || "";
    if (!selectedText) return;

    try {
      const res = await fetch(
        `/api/papers/${entry.paperId}/conversations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selectedText, mode }),
        }
      );
      if (!res.ok) throw new Error("Failed to create conversation");
      const conv = await res.json();
      setInlineChat({
        entryId: entry.id,
        paperId: entry.paperId,
        conversationId: conv.id,
        mode,
        selectedText,
      });
    } catch {
      toast.error("Failed to start conversation");
    }
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Notebook</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Saved selections, explanations, and research notes
            </p>
          </div>
          <Button onClick={() => setShowNewNote(!showNewNote)}>
            <Plus className="h-4 w-4 mr-1.5" />
            New Note
          </Button>
        </div>

        {/* New Note Form */}
        {showNewNote && (
          <Card className="mb-6 p-4">
            <h3 className="text-sm font-medium mb-3">New Note</h3>
            <div className="space-y-3">
              <Select
                value={newNotePaperId}
                onValueChange={setNewNotePaperId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a paper..." />
                </SelectTrigger>
                <SelectContent>
                  {papers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea
                value={newNoteContent}
                onChange={(e) => setNewNoteContent(e.target.value)}
                placeholder="Write your note..."
                rows={4}
              />
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowNewNote(false);
                    setNewNotePaperId("");
                    setNewNoteContent("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleCreateNote}
                  disabled={!newNotePaperId || !newNoteContent.trim()}
                >
                  Save Note
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Filters */}
        <div className="flex gap-3 mb-6">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="selection">Selection</SelectItem>
              <SelectItem value="explanation">Explanation</SelectItem>
              <SelectItem value="chat">Chat</SelectItem>
              <SelectItem value="note">Note</SelectItem>
              <SelectItem value="screenshot">Screenshot</SelectItem>
            </SelectContent>
          </Select>
          <Select value={paperFilter} onValueChange={setPaperFilter}>
            <SelectTrigger className="w-[240px]">
              <SelectValue placeholder="All papers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All papers</SelectItem>
              {entryPapers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.title.length > 40
                    ? p.title.slice(0, 37) + "..."
                    : p.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Entries */}
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="p-4 animate-pulse">
                <div className="h-4 bg-muted rounded w-1/4 mb-3" />
                <div className="h-3 bg-muted rounded w-3/4 mb-2" />
                <div className="h-3 bg-muted rounded w-1/2" />
              </Card>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <BookOpen className="h-12 w-12 text-muted-foreground/30" />
            <h3 className="text-lg font-medium text-muted-foreground">
              No entries yet
            </h3>
            <p className="text-sm text-muted-foreground/60 max-w-md">
              Save text selections, explanations, and chat responses from your
              papers to build your research notebook.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => {
              const config = typeConfig[entry.type];
              const TypeIcon = config.icon;
              const isExpanded = expandedIds.has(entry.id);
              const contentLong =
                (entry.content?.length || 0) > 400;

              return (
                <Card key={entry.id} className="p-4">
                  {/* Top row: badge + paper + actions */}
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        variant="secondary"
                        className={`shrink-0 ${config.color}`}
                      >
                        <TypeIcon className="h-3 w-3 mr-1" />
                        {config.label}
                      </Badge>
                      <Link
                        href={`/papers/${entry.paper.id}`}
                        className="text-sm font-medium text-foreground/80 hover:text-foreground truncate hover:underline"
                      >
                        {entry.paper.title}
                      </Link>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-xs text-muted-foreground mr-1">
                        {formatDate(entry.createdAt)}
                      </span>
                      {entry.selectedText && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-amber-500 hover:text-amber-600"
                            title="Explain"
                            onClick={() => handleOpenChat(entry, "explain")}
                          >
                            <Lightbulb className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-blue-500 hover:text-blue-600"
                            title="Chat"
                            onClick={() => handleOpenChat(entry, "chat")}
                          >
                            <MessageCircle className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(entry.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Screenshot image */}
                  {entry.type === "screenshot" && entry.content && (() => {
                    try {
                      const parsed = JSON.parse(entry.content);
                      const filename = parsed.screenshotPath?.split("/").pop();
                      if (!filename) return null;
                      return (
                        <div className="mb-2 relative">
                          <Badge variant="outline" className="absolute top-2 left-2 text-[10px] bg-background/80">
                            Page {parsed.pageNumber}
                          </Badge>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/screenshots/${filename}`}
                            alt="Screenshot"
                            className="rounded-md border max-h-64 w-auto"
                          />
                        </div>
                      );
                    } catch {
                      return null;
                    }
                  })()}

                  {/* Selected text blockquote */}
                  {entry.selectedText && (
                    <blockquote className="border-l-2 border-muted-foreground/20 pl-3 mb-2 text-sm text-muted-foreground italic line-clamp-3">
                      &ldquo;{entry.selectedText}&rdquo;
                    </blockquote>
                  )}

                  {/* Content */}
                  {entry.content && entry.type !== "screenshot" && (
                    <div className="mb-2">
                      <div
                        className={
                          !isExpanded && contentLong
                            ? "line-clamp-6"
                            : undefined
                        }
                      >
                        <MarkdownRenderer
                          content={entry.content}
                          className="text-sm"
                        />
                      </div>
                      {contentLong && (
                        <button
                          onClick={() => toggleExpanded(entry.id)}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1 transition-colors"
                        >
                          {isExpanded ? (
                            <>
                              <ChevronUp className="h-3 w-3" /> Show less
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-3 w-3" /> Show more
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Annotation */}
                  {editingId === entry.id ? (
                    <div className="flex gap-2 mt-2">
                      <Textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        placeholder="Add your annotation..."
                        rows={2}
                        className="text-sm"
                        autoFocus
                      />
                      <div className="flex flex-col gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() =>
                            handleSaveAnnotation(entry.id)
                          }
                        >
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setEditingId(null)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2">
                      {entry.annotation ? (
                        <div className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2">
                          <p className="text-sm text-foreground/80 flex-1">
                            {entry.annotation}
                          </p>
                          <button
                            onClick={() => {
                              setEditingId(entry.id);
                              setEditText(entry.annotation || "");
                            }}
                            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setEditingId(entry.id);
                            setEditText("");
                          }}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <Pencil className="h-3 w-3" />
                          Add annotation
                        </button>
                      )}
                    </div>
                  )}

                  {/* Inline chat for this entry */}
                  {inlineChat?.entryId === entry.id && (
                    <div className="mt-3">
                      <InlineChat
                        paperId={inlineChat.paperId}
                        conversationId={inlineChat.conversationId}
                        selectedText={inlineChat.selectedText}
                        mode={inlineChat.mode}
                        onClose={() => setInlineChat(null)}
                        onOpenFull={() => {
                          window.open(
                            `/papers/${inlineChat.paperId}?conv=${inlineChat.conversationId}`,
                            "_blank"
                          );
                        }}
                        inline
                      />
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
