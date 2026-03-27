"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertCircle, CheckCircle, Package, Key, HelpCircle, Terminal, X, ChevronDown } from "lucide-react";
import { toast } from "sonner";

interface AttentionItem {
  id: string;
  category: "package" | "api_key" | "env_issue" | "user_input" | "general";
  title: string;
  detail: string;
  suggestion?: string;
  createdAt: string;
  resolved: boolean;
}

const CATEGORY_META: Record<string, { icon: typeof Package; color: string; label: string }> = {
  package: { icon: Package, color: "text-amber-500", label: "Package" },
  api_key: { icon: Key, color: "text-blue-500", label: "API Key" },
  env_issue: { icon: Terminal, color: "text-red-500", label: "Environment" },
  user_input: { icon: HelpCircle, color: "text-purple-500", label: "Input needed" },
  general: { icon: AlertCircle, color: "text-muted-foreground", label: "Issue" },
};

export function AttentionQueue({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [expanded, setExpanded] = useState(false);

  const fetchItems = useCallback(() => {
    fetch(`/api/research/${projectId}/log?type=help_request`)
      .then((r) => r.json())
      .then((data) => {
        const logs = data.entries || data;
        if (!Array.isArray(logs)) return;
        const parsed: AttentionItem[] = logs.map((l: { id: string; content: string; metadata?: string; createdAt: string }) => {
          let meta: Record<string, unknown> = {};
          try { meta = JSON.parse(l.metadata || "{}"); } catch { /* */ }
          return {
            id: l.id,
            category: (meta.category as AttentionItem["category"]) || "general",
            title: (meta.title as string) || l.content.slice(0, 60),
            detail: l.content,
            suggestion: meta.suggestion as string | undefined,
            createdAt: l.createdAt,
            resolved: meta.resolved === true,
          };
        });
        setItems(parsed);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    fetchItems();
    const interval = setInterval(fetchItems, 15_000);
    return () => clearInterval(interval);
  }, [fetchItems]);

  const handleResolve = async (itemId: string) => {
    try {
      // Mark as resolved by creating a follow-up log entry
      await fetch(`/api/research/${projectId}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "user_note",
          content: `[RESOLVED] Issue ${itemId} resolved by user`,
          metadata: JSON.stringify({ resolvedHelpRequest: itemId }),
        }),
      });
      setItems((prev) => prev.map((i) => i.id === itemId ? { ...i, resolved: true } : i));
      toast.success("Marked as resolved");
    } catch { toast.error("Failed to resolve"); }
  };

  const handleDismiss = (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
  };

  const pending = items.filter((i) => !i.resolved);
  if (pending.length === 0) return null;

  return (
    <div className="shrink-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md border border-amber-500/20 bg-amber-500/[0.03] hover:bg-amber-500/[0.06] transition-colors text-left"
      >
        <AlertCircle className="h-3.5 w-3.5 text-amber-500/70 shrink-0" />
        <span className="text-[11px] font-medium flex-1">
          {pending.length} item{pending.length !== 1 ? "s" : ""} need{pending.length === 1 ? "s" : ""} your attention
        </span>
        <ChevronDown className={`h-3 w-3 text-muted-foreground/30 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="border border-t-0 border-amber-500/20 rounded-b-md divide-y divide-border/30">
          {pending.map((item) => {
            const meta = CATEGORY_META[item.category] || CATEGORY_META.general;
            const Icon = meta.icon;
            return (
              <div key={item.id} className="px-3 py-2 flex items-start gap-2">
                <Icon className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${meta.color}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-medium">{item.title}</span>
                    <span className={`text-[8px] px-1 py-0.5 rounded ${meta.color} bg-current/5`}>{meta.label}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground/50 mt-0.5 line-clamp-2">{item.detail}</p>
                  {item.suggestion && (
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5 italic">{item.suggestion}</p>
                  )}
                </div>
                <div className="flex gap-0.5 shrink-0">
                  <button
                    onClick={() => handleResolve(item.id)}
                    className="h-5 w-5 inline-flex items-center justify-center rounded text-emerald-500/50 hover:text-emerald-500 hover:bg-emerald-500/10 transition-colors"
                    title="Mark as resolved"
                  >
                    <CheckCircle className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => handleDismiss(item.id)}
                    className="h-5 w-5 inline-flex items-center justify-center rounded text-muted-foreground/30 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
                    title="Dismiss"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
