"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Lightbulb,
  XCircle,
  PenLine,
  Bot,
  HelpCircle,
  CheckCircle,
  Eye,
  Send,
  FileText,
  Activity,
  Save,
  Loader2,
  Maximize2,
  X,
  ChevronDown,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

const TYPE_CONFIG: Record<string, { icon: typeof Lightbulb; color: string }> = {
  breakthrough: { icon: Lightbulb, color: "text-amber-500" },
  dead_end: { icon: XCircle, color: "text-red-400" },
  user_note: { icon: PenLine, color: "text-blue-400" },
  agent_suggestion: { icon: Bot, color: "text-purple-400" },
  question: { icon: HelpCircle, color: "text-cyan-400" },
  decision: { icon: CheckCircle, color: "text-emerald-400" },
  observation: { icon: Eye, color: "text-muted-foreground" },
};

interface LogEntry {
  id: string;
  type: string;
  content: string;
  createdAt: string;
}

interface ResearchLogProps {
  entries: LogEntry[];
  projectId: string;
  onAddNote?: (content: string) => void;
}

type Tab = "activity" | "notebook";

export function ResearchLog({ entries, projectId, onAddNote }: ResearchLogProps) {
  const [tab, setTab] = useState<Tab>("notebook");
  const [expanded, setExpanded] = useState(false);

  const content = (
    <>
      {/* Tab switcher */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setTab("notebook")}
          className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-medium transition-colors ${
            tab === "notebook"
              ? "text-foreground border-b-2 border-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <FileText className="h-3 w-3" />
          Notebook
        </button>
        <button
          onClick={() => setTab("activity")}
          className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-medium transition-colors ${
            tab === "activity"
              ? "text-foreground border-b-2 border-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Activity className="h-3 w-3" />
          Activity
        </button>
        <button
          onClick={() => setExpanded(!expanded)}
          className="px-1.5 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <X className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
        </button>
      </div>

      {tab === "notebook" ? (
        <NotebookTab projectId={projectId} />
      ) : (
        <ActivityTab entries={entries} onAddNote={onAddNote} />
      )}
    </>
  );

  if (expanded) {
    return (
      <>
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black/30 z-40"
          onClick={() => setExpanded(false)}
        />
        {/* Expanded panel */}
        <div className="fixed left-4 top-16 bottom-4 w-[480px] z-50 rounded-lg border border-border bg-card shadow-xl flex flex-col overflow-hidden">
          {content}
        </div>
      </>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {content}
    </div>
  );
}

// ── Notebook tab: editable RESEARCH_LOG.md ────────────────────

function NotebookTab({ projectId }: { projectId: string }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const lastSaved = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fetchLog = useCallback(async () => {
    try {
      const res = await fetch(`/api/research/${projectId}/log-file`);
      if (res.ok) {
        const data = await res.json();
        const newContent = data.content || "";
        // Only update if user hasn't made local edits
        if (!dirty) {
          setContent(newContent);
          lastSaved.current = newContent;
        }
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [projectId, dirty]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  // Auto-refresh every 10s to pick up agent writes (only if not dirty)
  useEffect(() => {
    const interval = setInterval(() => {
      if (!dirty) fetchLog();
    }, 10_000);
    return () => clearInterval(interval);
  }, [dirty, fetchLog]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/research/${projectId}/log-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        lastSaved.current = content;
        setDirty(false);
      }
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleChange = (value: string) => {
    setContent(value);
    setDirty(value !== lastSaved.current);
  };

  // Ctrl+S / Cmd+S to save
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (dirty) handleSave();
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1 w-full resize-none bg-transparent px-3 py-2 text-[11px] font-mono leading-relaxed text-foreground/80 focus:outline-none placeholder:text-muted-foreground/40"
        placeholder="Research notebook — add notes, papers to consult, directions to explore. The agent reads this at the start of every session."
        spellCheck={false}
      />
      {dirty && (
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-muted/30">
          <span className="text-[9px] text-muted-foreground">Unsaved changes</span>
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Save className="h-2.5 w-2.5" />}
            Save
          </button>
        </div>
      )}
    </div>
  );
}

// ── Activity tab: DB log entries ──────────────────────────────

function ActivityTab({ entries, onAddNote }: { entries: LogEntry[]; onAddNote?: (content: string) => void }) {
  const [noteText, setNoteText] = useState("");
  const [showInput, setShowInput] = useState(false);

  const handleSubmit = () => {
    if (!noteText.trim()) return;
    onAddNote?.(noteText.trim());
    setNoteText("");
    setShowInput(false);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-end px-3 py-1 border-b border-border">
        <button
          onClick={() => setShowInput(!showInput)}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          + Note
        </button>
      </div>

      {showInput && (
        <div className="px-3 py-2 border-b border-border">
          <div className="flex gap-1">
            <input
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder="Add a note..."
              className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
              autoFocus
            />
            <button
              onClick={handleSubmit}
              disabled={!noteText.trim()}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <Send className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto px-3 py-2 space-y-1.5">
        {entries.length === 0 ? (
          <p className="text-[10px] text-muted-foreground/50 text-center py-4">No log entries yet</p>
        ) : (
          entries.map((entry) => (
            <LogEntryItem key={entry.id} entry={entry} />
          ))
        )}
      </div>
    </div>
  );
}

// ── Log entry (expandable, markdown-rendered) ─────────────────

function LogEntryItem({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const config = TYPE_CONFIG[entry.type] || TYPE_CONFIG.observation;
  const Icon = config.icon;

  // Multi-line content (e.g., dead_end with stderr) is expandable
  const hasDetails = entry.content.includes("\n") || entry.content.length > 120;
  const firstLine = entry.content.split("\n")[0];
  const showContent = expanded ? entry.content : firstLine;

  return (
    <div className="group">
      <div
        className={`flex items-start gap-1.5 ${hasDetails ? "cursor-pointer" : ""}`}
        onClick={hasDetails ? () => setExpanded((e) => !e) : undefined}
      >
        <Icon className={`h-3 w-3 mt-0.5 shrink-0 ${config.color}`} />
        <div className="min-w-0 flex-1">
          {expanded ? (
            <div className="text-[11px] text-foreground/80 leading-snug [&_pre]:text-[10px] [&_pre]:bg-muted/50 [&_pre]:rounded [&_pre]:p-1.5 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_code]:text-[10px]">
              <MarkdownRenderer content={showContent} />
            </div>
          ) : (
            <p className="text-[11px] text-foreground/80 leading-snug truncate">
              {firstLine}
            </p>
          )}
          <p className="text-[9px] text-muted-foreground/50 mt-0.5">
            {new Date(entry.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
        {hasDetails && (
          <ChevronDown className={`h-2.5 w-2.5 text-muted-foreground/40 shrink-0 mt-1 transition-transform ${expanded ? "" : "-rotate-90"}`} />
        )}
      </div>
    </div>
  );
}
