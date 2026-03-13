"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  Search,
  ChevronRight,
  Bold,
  Italic,
  List,
  ListOrdered,
  Heading,
  Quote,
  Code,
  Link2,
  Minus,
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

// Type accent colors
const typeAccent: Record<string, { dot: string; bg: string; text: string; label: string; icon: typeof FileText }> = {
  selection:   { dot: "bg-slate-400",   bg: "bg-slate-400/8",   text: "text-slate-400",   label: "Selection",   icon: FileText },
  explanation: { dot: "bg-amber-400",   bg: "bg-amber-400/8",   text: "text-amber-400",   label: "Explanation", icon: Lightbulb },
  chat:        { dot: "bg-blue-400",    bg: "bg-blue-400/8",    text: "text-blue-400",    label: "Chat",        icon: MessageCircle },
  note:        { dot: "bg-emerald-400", bg: "bg-emerald-400/8", text: "text-emerald-400", label: "Note",        icon: StickyNote },
  screenshot:  { dot: "bg-violet-400",  bg: "bg-violet-400/8",  text: "text-violet-400",  label: "Screenshot",  icon: Camera },
};

// ── Helpers ─────────────────────────────────────────────────────────

function relativeDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function entryTitle(entry: NotebookEntry): string {
  if (entry.type === "screenshot" && entry.content) {
    try {
      const parsed = JSON.parse(entry.content);
      return `Screenshot from page ${parsed.pageNumber || "?"}`;
    } catch { /* fall through */ }
  }
  // First line of content or annotation as a "title"
  const raw = entry.annotation || entry.content || entry.selectedText || "Empty entry";
  const cleaned = raw.replace(/[#*_`>\[\]]/g, "").trim();
  const firstLine = cleaned.split("\n")[0];
  return firstLine.slice(0, 80);
}

function entryBody(entry: NotebookEntry): string {
  // Second-priority text for the preview body
  const primary = entry.annotation || entry.content || entry.selectedText || "";
  const cleaned = primary.replace(/[#*_`>\[\]]/g, "").trim();
  const lines = cleaned.split("\n").filter(Boolean);
  // Skip the first line (used as title), return the rest
  return lines.slice(1).join(" ").slice(0, 120) || (entry.selectedText && entry.annotation ? entry.selectedText.slice(0, 120) : "");
}

function dateGroupLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const entryDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today.getTime() - entryDay.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This week";
  if (diffDays < 30) return "This month";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// ── Sidebar Entry Row (Bear-style: title + body preview + date) ─────

function SidebarRow({
  entry,
  isActive,
  onClick,
}: {
  entry: NotebookEntry;
  isActive: boolean;
  onClick: () => void;
}) {
  const accent = typeAccent[entry.type] || typeAccent.note;
  const title = entryTitle(entry);
  const body = entryBody(entry);

  return (
    <button
      onClick={onClick}
      className={`group w-full text-left px-3 py-2.5 border-b border-border/20 transition-colors ${
        isActive
          ? "bg-accent/80"
          : "hover:bg-accent/30"
      }`}
    >
      <p className="text-[13px] font-semibold leading-snug text-foreground/90 line-clamp-1">
        {title}
      </p>
      {body && (
        <p className="text-[12px] leading-relaxed text-muted-foreground/50 line-clamp-2 mt-0.5">
          {body}
        </p>
      )}
      <div className="flex items-center gap-1.5 mt-1">
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${accent.dot} opacity-60`} />
        <span className="text-[10px] text-muted-foreground/30">
          {relativeDate(entry.createdAt)}
        </span>
        <span className="text-[10px] text-muted-foreground/20 truncate">
          {entry.paper.title}
        </span>
      </div>
    </button>
  );
}

// ── Type Filter Chips ───────────────────────────────────────────────

function TypeChips({
  active,
  onToggle,
  counts,
}: {
  active: string;
  onToggle: (type: string) => void;
  counts: Record<string, number>;
}) {
  const types = ["all", "selection", "explanation", "chat", "note", "screenshot"];

  return (
    <div className="flex items-center gap-1 px-3 flex-wrap">
      {types.map((t) => {
        const accent = typeAccent[t];
        const isActive = active === t;
        const count = t === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : (counts[t] || 0);
        if (t !== "all" && count === 0) return null;

        return (
          <button
            key={t}
            onClick={() => onToggle(t)}
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-all ${
              isActive
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground/50 hover:text-muted-foreground"
            }`}
          >
            {t !== "all" && (
              <span className={`h-1.5 w-1.5 rounded-full ${accent?.dot} ${isActive ? "opacity-100" : "opacity-40"}`} />
            )}
            {t === "all" ? "All" : accent?.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Formatting Toolbar (Bear-style) ─────────────────────────────────

function FormattingToolbar({
  textareaRef,
  value,
  onChange,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
}) {
  const insert = (before: string, after = "") => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = value.slice(start, end);
    const replacement = before + (selected || "text") + after;
    const next = value.slice(0, start) + replacement + value.slice(end);
    onChange(next);
    // Restore cursor after React re-render
    requestAnimationFrame(() => {
      ta.focus();
      const cursorPos = start + before.length + (selected || "text").length;
      ta.setSelectionRange(
        start + before.length,
        start + before.length + (selected || "text").length
      );
    });
  };

  const insertLine = (prefix: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    // Find start of current line
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + prefix.length, start + prefix.length);
    });
  };

  const tools = [
    { icon: Heading, label: "Heading", action: () => insertLine("## ") },
    { icon: Bold, label: "Bold", action: () => insert("**", "**") },
    { icon: Italic, label: "Italic", action: () => insert("_", "_") },
    { icon: List, label: "Bullet list", action: () => insertLine("- ") },
    { icon: ListOrdered, label: "Numbered list", action: () => insertLine("1. ") },
    { icon: Quote, label: "Quote", action: () => insertLine("> ") },
    { icon: Code, label: "Code", action: () => insert("`", "`") },
    { icon: Link2, label: "Link", action: () => insert("[", "](url)") },
    { icon: Minus, label: "Divider", action: () => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = ta.selectionStart;
      const next = value.slice(0, pos) + "\n---\n" + value.slice(pos);
      onChange(next);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(pos + 5, pos + 5);
      });
    }},
  ];

  return (
    <div className="flex items-center gap-0.5 px-4 py-2 border-t border-border/30 bg-background/80">
      {tools.map((tool, i) => {
        const Icon = tool.icon;
        return (
          <button
            key={i}
            onClick={tool.action}
            title={tool.label}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-accent/60 transition-colors"
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}

// ── Detail View ─────────────────────────────────────────────────────

function EntryDetail({
  entry,
  editingAnnotation,
  editText,
  onStartEdit,
  onSaveAnnotation,
  onCancelEdit,
  onEditTextChange,
  onDelete,
  onOpenChat,
  inlineChat,
  onCloseChat,
}: {
  entry: NotebookEntry;
  editingAnnotation: boolean;
  editText: string;
  onStartEdit: () => void;
  onSaveAnnotation: () => void;
  onCancelEdit: () => void;
  onEditTextChange: (v: string) => void;
  onDelete: () => void;
  onOpenChat: (mode: "explain" | "chat") => void;
  inlineChat: { paperId: string; conversationId: string; mode: "explain" | "chat"; selectedText: string } | null;
  onCloseChat: () => void;
}) {
  const accent = typeAccent[entry.type] || typeAccent.note;
  const Icon = accent.icon;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header bar */}
      <div className="shrink-0 px-8 pt-5 pb-3 border-b border-border/30">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`h-6 w-6 rounded-lg flex items-center justify-center shrink-0 ${accent.bg}`}>
              <Icon className={`h-3.5 w-3.5 ${accent.text}`} />
            </div>
            <div className="min-w-0">
              <Link
                href={`/papers/${entry.paper.id}`}
                className="text-sm font-medium text-foreground/80 hover:text-foreground truncate block transition-colors"
              >
                {entry.paper.title}
              </Link>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-[10px] font-medium ${accent.text}`}>{accent.label}</span>
                <span className="text-[10px] text-muted-foreground/40">
                  {new Date(entry.createdAt).toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {entry.selectedText && (
              <>
                <button
                  onClick={() => onOpenChat("explain")}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-amber-400 hover:bg-amber-400/10 transition-colors"
                  title="Explain this passage"
                >
                  <Lightbulb className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onOpenChat("chat")}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-blue-400 hover:bg-blue-400/10 transition-colors"
                  title="Chat about this passage"
                >
                  <MessageCircle className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <button
              onClick={onDelete}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="Delete entry"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Content area — centered */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-8">
          {/* Screenshot */}
          {entry.type === "screenshot" && entry.content && (() => {
            try {
              const parsed = JSON.parse(entry.content);
              const filename = parsed.screenshotPath?.split("/").pop();
              if (!filename) return null;
              return (
                <div className="mb-6 relative">
                  <span className="absolute top-2 left-2 text-[10px] font-medium bg-black/60 text-white px-1.5 py-0.5 rounded">
                    Page {parsed.pageNumber}
                  </span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/screenshots/${filename}`}
                    alt="Screenshot"
                    className="rounded-lg border border-border/40 max-w-full"
                  />
                </div>
              );
            } catch {
              return null;
            }
          })()}

          {/* Selected text — elegant pull-quote */}
          {entry.selectedText && (
            <div className="mb-6 relative">
              <div className="absolute left-0 top-0 bottom-0 w-[2px] rounded-full bg-gradient-to-b from-muted-foreground/30 to-transparent" />
              <blockquote className="pl-5 text-[15px] leading-[1.8] text-muted-foreground/70 italic">
                {entry.selectedText}
              </blockquote>
            </div>
          )}

          {/* Main content */}
          {entry.content && entry.type !== "screenshot" && (
            <div className="mb-6 notebook-content">
              <MarkdownRenderer
                content={entry.content}
                className="text-[15px] leading-[1.8] text-foreground/85"
              />
            </div>
          )}

          {/* Annotation */}
          <div className="mt-2">
            {editingAnnotation ? (
              <div className="space-y-2">
                <textarea
                  value={editText}
                  onChange={(e) => onEditTextChange(e.target.value)}
                  placeholder="Your thoughts..."
                  rows={3}
                  className="w-full text-sm bg-transparent border border-muted-foreground/15 rounded-lg px-4 py-3 focus:border-muted-foreground/30 focus:outline-none resize-none"
                  autoFocus
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={onSaveAnnotation}
                    className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium bg-foreground/10 text-foreground hover:bg-foreground/15 transition-colors"
                  >
                    <Check className="h-3 w-3" /> Save
                  </button>
                  <button
                    onClick={onCancelEdit}
                    className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={onStartEdit}
                className={`group w-full text-left rounded-lg px-4 py-3 transition-all ${
                  entry.annotation
                    ? "bg-muted/30 hover:bg-muted/50"
                    : "border border-dashed border-muted-foreground/15 hover:border-muted-foreground/30"
                }`}
              >
                {entry.annotation ? (
                  <div className="flex items-start gap-2">
                    <p className="text-sm text-foreground/70 flex-1 leading-relaxed">
                      {entry.annotation}
                    </p>
                    <Pencil className="h-3 w-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 shrink-0 mt-1 transition-colors" />
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground/30 group-hover:text-muted-foreground/50 transition-colors">
                    Add your thoughts...
                  </span>
                )}
              </button>
            )}
          </div>

          {/* Inline chat */}
          {inlineChat && (
            <div className="mt-6">
              <InlineChat
                paperId={inlineChat.paperId}
                conversationId={inlineChat.conversationId}
                selectedText={inlineChat.selectedText}
                mode={inlineChat.mode}
                onClose={onCloseChat}
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
        </div>
      </div>
    </div>
  );
}

// ── Compose View with Toolbar ───────────────────────────────────────

function ComposeView({
  papers,
  onSave,
  onCancel,
}: {
  papers: { id: string; title: string }[];
  onSave: (paperId: string, content: string) => void;
  onCancel: () => void;
}) {
  const [paperId, setPaperId] = useState("");
  const [content, setContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-8 pt-5 pb-3 border-b border-border/30">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-6 w-6 rounded-lg flex items-center justify-center bg-emerald-400/8">
              <StickyNote className="h-3.5 w-3.5 text-emerald-400" />
            </div>
            <span className="text-sm font-medium text-foreground/80">New Note</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onCancel}
              className="text-xs text-muted-foreground hover:text-foreground px-2.5 py-1 rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (paperId && content.trim()) onSave(paperId, content.trim());
              }}
              disabled={!paperId || !content.trim()}
              className="text-xs font-medium bg-foreground/10 text-foreground hover:bg-foreground/15 disabled:opacity-30 disabled:pointer-events-none px-3 py-1 rounded-md transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-6">
          <Select value={paperId} onValueChange={setPaperId}>
            <SelectTrigger className="w-full mb-4 border-muted-foreground/15 bg-transparent text-sm">
              <SelectValue placeholder="Link to a paper..." />
            </SelectTrigger>
            <SelectContent>
              {papers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Start writing..."
            className="w-full min-h-[400px] bg-transparent text-[15px] leading-[1.8] text-foreground/85 placeholder:text-muted-foreground/25 resize-none outline-none"
          />
        </div>
      </div>

      {/* Formatting toolbar */}
      <FormattingToolbar
        textareaRef={textareaRef}
        value={content}
        onChange={setContent}
      />
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────

export default function NotebookPage() {
  const [entries, setEntries] = useState<NotebookEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");
  const [paperFilter, setPaperFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [papers, setPapers] = useState<{ id: string; title: string }[]>([]);
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

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  useEffect(() => {
    fetch("/api/papers?limit=200")
      .then((r) => r.json())
      .then((data) => {
        const list = (data.papers || data).map(
          (p: { id: string; title: string }) => ({ id: p.id, title: p.title })
        );
        setPapers(list);
      });
  }, []);

  const entryPapers = useMemo(
    () => Array.from(new Map(entries.map((e) => [e.paper.id, e.paper])).values()),
    [entries]
  );

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of entries) counts[e.type] = (counts[e.type] || 0) + 1;
    return counts;
  }, [entries]);

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const q = searchQuery.toLowerCase();
    return entries.filter(
      (e) =>
        (e.content?.toLowerCase().includes(q)) ||
        (e.selectedText?.toLowerCase().includes(q)) ||
        (e.annotation?.toLowerCase().includes(q)) ||
        e.paper.title.toLowerCase().includes(q)
    );
  }, [entries, searchQuery]);

  const groupedEntries = useMemo(() => {
    const groups: { label: string; entries: NotebookEntry[] }[] = [];
    let currentLabel = "";
    for (const entry of filteredEntries) {
      const label = dateGroupLabel(entry.createdAt);
      if (label !== currentLabel) {
        groups.push({ label, entries: [] });
        currentLabel = label;
      }
      groups[groups.length - 1].entries.push(entry);
    }
    return groups;
  }, [filteredEntries]);

  const activeEntry = activeId ? entries.find((e) => e.id === activeId) : null;

  useEffect(() => {
    if (!activeId && entries.length > 0 && !composing) {
      setActiveId(entries[0].id);
    }
  }, [entries, activeId, composing]);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this entry?")) return;
    const res = await fetch(`/api/notebook/${id}`, { method: "DELETE" });
    if (res.ok) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
      if (activeId === id) {
        setActiveId(entries.find((e) => e.id !== id)?.id || null);
      }
      toast.success("Entry deleted");
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
        prev.map((e) => (e.id === id ? { ...e, annotation: editText || null } : e))
      );
      setEditingId(null);
    }
  };

  const handleCreateNote = async (paperId: string, content: string) => {
    const res = await fetch("/api/notebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paperId, type: "note", content }),
    });
    if (res.ok) {
      const created = await res.json();
      setComposing(false);
      fetchEntries();
      setActiveId(created.id);
      toast.success("Note created");
    } else {
      toast.error("Failed to create note");
    }
  };

  const handleOpenChat = async (entry: NotebookEntry, mode: "explain" | "chat") => {
    const selectedText = entry.selectedText || "";
    if (!selectedText) return;
    try {
      const res = await fetch(`/api/papers/${entry.paperId}/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedText, mode }),
      });
      if (!res.ok) throw new Error();
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

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* ── Left Panel: Index ────────────────────────────── */}
      <div className="w-72 shrink-0 border-r border-border/40 flex flex-col overflow-hidden">
        {/* Search */}
        <div className="shrink-0 px-3 pt-4 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/30" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes..."
              className="w-full h-8 rounded-lg bg-muted/30 border-0 pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground/30 outline-none focus:bg-muted/50 transition-colors"
            />
          </div>
        </div>

        {/* Type chips */}
        <div className="shrink-0">
          <TypeChips active={typeFilter} onToggle={setTypeFilter} counts={typeCounts} />
        </div>

        {/* Paper filter */}
        {entryPapers.length > 1 && (
          <div className="shrink-0 px-3 mt-2">
            <Select value={paperFilter} onValueChange={setPaperFilter}>
              <SelectTrigger className="h-7 text-[11px] border-muted-foreground/10 bg-transparent">
                <SelectValue placeholder="All papers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All papers</SelectItem>
                {entryPapers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title.length > 35 ? p.title.slice(0, 32) + "..." : p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Entry list */}
        <div className="flex-1 overflow-y-auto mt-2">
          <div className="pb-3">
            {loading ? (
              <div className="space-y-3 px-3 pt-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="animate-pulse">
                    <div className="h-3.5 bg-muted rounded w-3/4 mb-1" />
                    <div className="h-3 bg-muted/50 rounded w-full mb-1" />
                    <div className="h-2 bg-muted/30 rounded w-1/3" />
                  </div>
                ))}
              </div>
            ) : filteredEntries.length === 0 ? (
              <div className="px-3 pt-8 text-center">
                <BookOpen className="h-8 w-8 text-muted-foreground/15 mx-auto mb-2" />
                <p className="text-[11px] text-muted-foreground/30">
                  {searchQuery ? "No matching entries" : "No entries yet"}
                </p>
              </div>
            ) : (
              groupedEntries.map((group) => (
                <div key={group.label}>
                  <div className="px-3 pt-3 pb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/30">
                      {group.label}
                    </span>
                  </div>
                  {group.entries.map((entry) => (
                    <SidebarRow
                      key={entry.id}
                      entry={entry}
                      isActive={activeId === entry.id && !composing}
                      onClick={() => {
                        setActiveId(entry.id);
                        setComposing(false);
                      }}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </div>

        {/* New note button */}
        <div className="shrink-0 p-3 border-t border-border/30">
          <button
            onClick={() => {
              setComposing(true);
              setActiveId(null);
            }}
            className="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg text-[12px] font-medium text-muted-foreground/60 hover:text-foreground hover:bg-accent/60 transition-all"
          >
            <Plus className="h-3.5 w-3.5" />
            New Note
          </button>
        </div>
      </div>

      {/* ── Right Panel: Detail / Compose ────────────────── */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {composing ? (
          <ComposeView
            papers={papers}
            onSave={handleCreateNote}
            onCancel={() => {
              setComposing(false);
              if (entries.length > 0) setActiveId(entries[0].id);
            }}
          />
        ) : activeEntry ? (
          <EntryDetail
            entry={activeEntry}
            editingAnnotation={editingId === activeEntry.id}
            editText={editText}
            onStartEdit={() => {
              setEditingId(activeEntry.id);
              setEditText(activeEntry.annotation || "");
            }}
            onSaveAnnotation={() => handleSaveAnnotation(activeEntry.id)}
            onCancelEdit={() => setEditingId(null)}
            onEditTextChange={setEditText}
            onDelete={() => handleDelete(activeEntry.id)}
            onOpenChat={(mode) => handleOpenChat(activeEntry, mode)}
            inlineChat={inlineChat?.entryId === activeEntry.id ? inlineChat : null}
            onCloseChat={() => setInlineChat(null)}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center px-8">
            <div className="relative mb-4">
              <BookOpen className="h-16 w-16 text-muted-foreground/8" />
              <div className="absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-muted/50 flex items-center justify-center">
                <ChevronRight className="h-3 w-3 text-muted-foreground/20" />
              </div>
            </div>
            <p className="text-sm text-muted-foreground/25 max-w-[240px] leading-relaxed">
              Select a note from the sidebar, or save selections and explanations from your papers.
            </p>
            <button
              onClick={() => setComposing(true)}
              className="mt-4 text-[12px] font-medium text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors"
            >
              or start writing
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
