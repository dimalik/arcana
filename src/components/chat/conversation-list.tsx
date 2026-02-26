"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  MessageSquare,
  Plus,
  Trash2,
  Loader2,
  Minimize2,
  Maximize2,
  X,
  Lightbulb,
  MessageCircle,
} from "lucide-react";

interface Conversation {
  id: string;
  title: string | null;
  selectedText: string | null;
  mode: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { messages: number };
}

interface ConversationListProps {
  paperId: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  onSelectConversation: (id: string) => void;
  onNewConversation: (id: string) => void;
  refreshKey: number;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ConversationList({
  paperId,
  expanded,
  onToggleExpand,
  onClose,
  onSelectConversation,
  onNewConversation,
  refreshKey,
}: ConversationListProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const fetchConversations = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/papers/${paperId}/conversations`);
    const data = await res.json();
    setConversations(data);
    setLoading(false);
  }, [paperId]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations, refreshKey]);

  const handleNewChat = async () => {
    setCreating(true);
    const res = await fetch(`/api/papers/${paperId}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    setCreating(false);
    onNewConversation(data.id);
  };

  const handleDelete = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/papers/${paperId}/conversations/${convId}`, {
      method: "DELETE",
    });
    setConversations((prev) => prev.filter((c) => c.id !== convId));
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">Conversations</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onToggleExpand}
            title={expanded ? "Minimize" : "Expand"}
          >
            {expanded ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* New Chat button */}
        <div className="p-3">
          <Button
            onClick={handleNewChat}
            disabled={creating}
            className="w-full gap-2"
            size="sm"
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            New Chat
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center px-4">
            <MessageSquare className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No conversations yet
            </p>
            <p className="text-xs text-muted-foreground/60">
              Start a new chat or select text to explain
            </p>
          </div>
        ) : (
          <div className="space-y-1 px-3 pb-3">
            {conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => onSelectConversation(conv.id)}
                className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-muted/60 transition-colors group"
              >
                <MessageSquare className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium truncate">
                      {conv.title || "Untitled conversation"}
                    </p>
                    {conv.mode && (
                      <Badge
                        variant="secondary"
                        className="h-4 px-1.5 text-[10px] leading-none shrink-0"
                      >
                        {conv.mode === "explain" ? (
                          <Lightbulb className="h-2.5 w-2.5 mr-0.5" />
                        ) : (
                          <MessageCircle className="h-2.5 w-2.5 mr-0.5" />
                        )}
                        {conv.mode}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                    <span>
                      {conv._count.messages}{" "}
                      {conv._count.messages === 1 ? "reply" : "replies"}
                    </span>
                    <span>&middot;</span>
                    <span>{timeAgo(conv.updatedAt)}</span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
                  onClick={(e) => handleDelete(conv.id, e)}
                  title="Delete conversation"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
