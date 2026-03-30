"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Bell,
  X,
  CheckCircle,
  Package,
  Key,
  HelpCircle,
  Terminal,
  AlertCircle,
  Send,
  ExternalLink,
  ArrowRightLeft,
  Wrench,
  MessageSquare,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface AttentionItem {
  id: string;
  category: "package" | "api_key" | "env_issue" | "user_input" | "general";
  title: string;
  detail: string;
  suggestion?: string;
  createdAt: string;
  resolved: boolean;
}

const CATEGORY_META: Record<
  string,
  { icon: typeof Package; color: string; bgColor: string; label: string }
> = {
  package: {
    icon: Package,
    color: "text-amber-500",
    bgColor: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    label: "Package",
  },
  api_key: {
    icon: Key,
    color: "text-blue-500",
    bgColor: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    label: "API Key",
  },
  env_issue: {
    icon: Terminal,
    color: "text-red-500",
    bgColor: "bg-red-500/10 text-red-600 dark:text-red-400",
    label: "Environment",
  },
  user_input: {
    icon: HelpCircle,
    color: "text-purple-500",
    bgColor: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
    label: "Input Needed",
  },
  general: {
    icon: AlertCircle,
    color: "text-muted-foreground",
    bgColor: "bg-muted text-muted-foreground",
    label: "Issue",
  },
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function NotificationBell({ projectId, onOpenInChat }: { projectId: string; onOpenInChat?: (message: string) => void }) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Track which items have an open response input
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [responseText, setResponseText] = useState("");
  const [alternativeFor, setAlternativeFor] = useState<string | null>(null);
  const [alternativeText, setAlternativeText] = useState("");
  const [resolving, setResolving] = useState<Set<string>>(new Set());

  const fetchItems = useCallback(() => {
    fetch(`/api/research/${projectId}/log?type=help_request`)
      .then((r) => r.json())
      .then((data) => {
        const logs = data.entries || data;
        if (!Array.isArray(logs)) return;
        const parsed: AttentionItem[] = logs.map(
          (l: {
            id: string;
            content: string;
            metadata?: string;
            createdAt: string;
          }) => {
            let meta: Record<string, unknown> = {};
            try {
              meta = JSON.parse(l.metadata || "{}");
            } catch {
              /* */
            }
            return {
              id: l.id,
              category:
                (meta.category as AttentionItem["category"]) || "general",
              title: (meta.title as string) || l.content.slice(0, 80),
              detail: l.content,
              suggestion: meta.suggestion as string | undefined,
              createdAt: l.createdAt,
              resolved: meta.resolved === true,
            };
          }
        );
        setItems(parsed);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    fetchItems();
    const interval = setInterval(fetchItems, 10_000);
    return () => clearInterval(interval);
  }, [fetchItems]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const pending = items.filter((i) => !i.resolved);

  // Core resolution function
  const resolveItem = async (itemId: string, noteContent: string) => {
    setResolving((prev) => new Set(prev).add(itemId));
    try {
      await fetch(`/api/research/${projectId}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "user_note",
          content: noteContent,
          metadata: { resolvedHelpRequest: itemId },
        }),
      });

      await fetch(`/api/research/${projectId}/log`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryId: itemId,
          metadata: { resolved: true, resolvedAt: new Date().toISOString() },
        }),
      });

      setItems((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, resolved: true } : i))
      );
      if (respondingTo === itemId) {
        setRespondingTo(null);
        setResponseText("");
      }
      if (alternativeFor === itemId) {
        setAlternativeFor(null);
        setAlternativeText("");
      }
      toast.success("Resolved");
    } catch {
      toast.error("Failed to resolve");
    } finally {
      setResolving((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    }
  };

  const handleDismiss = (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    if (respondingTo === itemId) {
      setRespondingTo(null);
      setResponseText("");
    }
    if (alternativeFor === itemId) {
      setAlternativeFor(null);
      setAlternativeText("");
    }
  };

  const handleSendResponse = async (item: AttentionItem) => {
    if (!responseText.trim()) return;
    await resolveItem(
      item.id,
      `[User response to: ${item.title}] ${responseText.trim()}`
    );
  };

  const handleSendAlternative = async (item: AttentionItem) => {
    if (!alternativeText.trim()) return;
    await resolveItem(
      item.id,
      `[Alternative package] User specified alternative: ${alternativeText.trim()}`
    );
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors relative"
        title={`${pending.length} items need attention`}
      >
        <Bell className="h-4 w-4" />
        {pending.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-medium px-1">
            {pending.length}
          </span>
        )}
      </button>

      {open && pending.length > 0 && (
        <div className="absolute right-0 top-full mt-2 w-[380px] max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-background shadow-xl z-50 animate-in fade-in-0 slide-in-from-top-2 duration-150">
          <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {pending.length} item{pending.length !== 1 ? "s" : ""} need
              {pending.length === 1 ? "s" : ""} attention
            </span>
            <button
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="divide-y divide-border/30">
            {pending.map((item) => (
              <NotificationItem
                key={item.id}
                item={item}
                resolving={resolving}
                respondingTo={respondingTo}
                responseText={responseText}
                alternativeFor={alternativeFor}
                alternativeText={alternativeText}
                onResolve={resolveItem}
                onDismiss={handleDismiss}
                onSetRespondingTo={(id) => {
                  setRespondingTo(id);
                  if (id) setAlternativeFor(null);
                }}
                onSetResponseText={setResponseText}
                onSetAlternativeFor={(id) => {
                  setAlternativeFor(id);
                  if (id) setRespondingTo(null);
                }}
                onSetAlternativeText={setAlternativeText}
                onSendResponse={handleSendResponse}
                onSendAlternative={handleSendAlternative}
                onOpenInChat={onOpenInChat ? (msg: string) => { setOpen(false); onOpenInChat(msg); } : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationItem({
  item,
  resolving,
  respondingTo,
  responseText,
  alternativeFor,
  alternativeText,
  onResolve,
  onDismiss,
  onSetRespondingTo,
  onSetResponseText,
  onSetAlternativeFor,
  onSetAlternativeText,
  onSendResponse,
  onSendAlternative,
  onOpenInChat,
}: {
  item: AttentionItem;
  resolving: Set<string>;
  respondingTo: string | null;
  responseText: string;
  alternativeFor: string | null;
  alternativeText: string;
  onResolve: (id: string, note: string) => Promise<void>;
  onDismiss: (id: string) => void;
  onSetRespondingTo: (id: string | null) => void;
  onSetResponseText: (text: string) => void;
  onSetAlternativeFor: (id: string | null) => void;
  onSetAlternativeText: (text: string) => void;
  onSendResponse: (item: AttentionItem) => Promise<void>;
  onSendAlternative: (item: AttentionItem) => Promise<void>;
  onOpenInChat?: (message: string) => void;
}) {
  const meta = CATEGORY_META[item.category] || CATEGORY_META.general;
  const Icon = meta.icon;
  const isResolving = resolving.has(item.id);
  const isResponding = respondingTo === item.id;
  const isAlternative = alternativeFor === item.id;

  // Shared button style
  const btnPrimary = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50";
  const btnSecondary = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-muted-foreground border border-border/40 hover:bg-muted/40 transition-colors disabled:opacity-50";

  const renderActions = () => {
    switch (item.category) {
      case "package":
        return (
          <>
            <button disabled={isResolving} onClick={() => onResolve(item.id, "User confirmed package installed")} className={btnPrimary}>
              Installed
            </button>
            <button disabled={isResolving} onClick={() => isAlternative ? (onSetAlternativeFor(null), onSetAlternativeText("")) : onSetAlternativeFor(item.id)} className={btnSecondary}>
              Use alternative
            </button>
            {isAlternative && (
              <div className="w-full flex gap-2 mt-1">
                <input type="text" value={alternativeText} onChange={(e) => onSetAlternativeText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && onSendAlternative(item)}
                  placeholder="Package name..." autoFocus
                  className="flex-1 text-[11px] px-2.5 py-1 rounded-md border border-border/40 bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
                <button disabled={!alternativeText.trim() || isResolving} onClick={() => onSendAlternative(item)} className={btnPrimary}>
                  <Send className="h-3 w-3" />
                </button>
              </div>
            )}
          </>
        );

      case "api_key":
        return (
          <>
            <Link href="/settings" className={btnSecondary}>
              <ExternalLink className="h-3 w-3" /> Settings
            </Link>
            <button disabled={isResolving} onClick={() => onResolve(item.id, "User confirmed API key configured")} className={btnPrimary}>
              Done
            </button>
          </>
        );

      case "env_issue":
        return (
          <>
            <button disabled={isResolving} onClick={() => onResolve(item.id, "User confirmed environment issue fixed")} className={btnPrimary}>
              Fixed
            </button>
            <button disabled={isResolving} onClick={() => isResponding ? (onSetRespondingTo(null), onSetResponseText("")) : onSetRespondingTo(item.id)} className={btnSecondary}>
              Respond
            </button>
            {isResponding && <div className="w-full mt-1">{renderResponseInput()}</div>}
          </>
        );

      case "user_input":
        return renderResponseInput(true);

      default:
        return (
          <>
            <button disabled={isResolving} onClick={() => onResolve(item.id, "User resolved this issue")} className={btnPrimary}>
              Resolved
            </button>
            <button disabled={isResolving} onClick={() => isResponding ? (onSetRespondingTo(null), onSetResponseText("")) : onSetRespondingTo(item.id)} className={btnSecondary}>
              Respond
            </button>
            {isResponding && <div className="w-full mt-1">{renderResponseInput()}</div>}
          </>
        );
    }
  };

  const renderResponseInput = (prominent: boolean = false) => {
    const isThisItem = respondingTo === item.id;
    const text = isThisItem ? responseText : "";

    return (
      <div className="flex flex-col gap-1.5">
        <textarea
          value={text}
          onChange={(e) => {
            if (!isThisItem) {
              onSetRespondingTo(item.id);
              onSetAlternativeFor(null);
            }
            onSetResponseText(e.target.value);
          }}
          onFocus={() => {
            if (!isThisItem) {
              onSetRespondingTo(item.id);
              onSetResponseText("");
              onSetAlternativeFor(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              onSendResponse(item);
            }
          }}
          placeholder="Your response will be visible to the research agent..."
          rows={prominent ? 3 : 2}
          className="w-full text-[11px] px-2.5 py-1.5 rounded-md border border-border/40 bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/30 resize-y min-h-[40px]"
          autoFocus={!prominent}
        />
        <div className="flex justify-end">
          <button disabled={!text.trim() || resolving.has(item.id)} onClick={() => onSendResponse(item)} className={btnPrimary}>
            Send
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="px-4 py-4">
      {/* Title row */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full shrink-0 ${meta.bgColor}`}>
            <Icon className="h-2.5 w-2.5" />
          </span>
          <span className="text-xs font-medium leading-tight truncate">{item.title}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[11px] text-muted-foreground/40">{timeAgo(item.createdAt)}</span>
          <button onClick={() => onDismiss(item.id)} className="h-6 w-6 inline-flex items-center justify-center rounded-md text-muted-foreground/30 hover:text-muted-foreground hover:bg-muted/50 transition-colors" title="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Detail */}
      <p className="text-[11px] text-muted-foreground/60 leading-relaxed mb-2.5">{item.detail}</p>

      {/* Suggestion */}
      {item.suggestion && (
        <p className="text-[11px] text-muted-foreground/40 bg-muted/20 rounded-md px-2.5 py-1.5 mb-2.5 leading-relaxed">
          {item.suggestion}
        </p>
      )}

      {/* Actions — clean row */}
      <div className="flex items-center gap-2 flex-wrap">
        {renderActions()}
        {onOpenInChat && (
          <button
            onClick={() => onOpenInChat(`The agent needs help with: ${item.title}\n\nDetails: ${item.detail}\n${item.suggestion ? `Suggestion: ${item.suggestion}` : ""}\n\nHow should I handle this?`)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-muted-foreground/60 hover:text-foreground hover:bg-muted/30 transition-colors"
          >
            <MessageSquare className="h-3 w-3" />
            Chat
          </button>
        )}
      </div>
    </div>
  );
}
