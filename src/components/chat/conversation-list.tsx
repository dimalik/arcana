"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  MessageSquare,
  Trash2,
  Loader2,
  Minimize2,
  Maximize2,
  X,
  ArrowLeft,
  ArrowUp,
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
  hideControls?: boolean;
  onBack?: () => void;
  /** Called when user types a message from the history view — creates a new conversation */
  onSendNew?: (text: string) => void;
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
  hideControls,
  onBack,
  onSendNew,
}: ConversationListProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  const handleDelete = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/papers/${paperId}/conversations/${convId}`, {
      method: "DELETE",
    });
    setConversations((prev) => prev.filter((c) => c.id !== convId));
  };

  const handleSend = () => {
    if (!input.trim() || sending || !onSendNew) return;
    setSending(true);
    onSendNew(input.trim());
    setInput("");
  };

  return (
    <>
      {/* Minimal toolbar — back arrow left, controls right */}
      {(onBack || !hideControls) && (
        <div className="flex items-center px-2 py-1.5">
          <div className="flex items-center gap-0.5">
            {onBack && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground"
                onClick={onBack}
                title="Back to chat"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {!hideControls && (
            <div className="flex items-center gap-0.5 ml-auto">
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
          )}
        </div>
      )}

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center px-4">
            <p className="text-sm text-muted-foreground">
              No conversations yet
            </p>
            <p className="text-xs text-muted-foreground/60">
              Type below to start a new chat
            </p>
          </div>
        ) : (
          <div className="space-y-1 px-3 pb-3">
            <p className="text-xs text-muted-foreground font-medium px-3 py-1.5">
              Past conversations
            </p>
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

      {/* Input area — typing here starts a new conversation */}
      {onSendNew && (
        <div className="p-3">
          <div className="relative rounded-2xl border border-muted-foreground/20 focus-within:border-muted-foreground/40 transition-colors">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Chat about the paper"
              rows={3}
              className="min-h-[80px] resize-none border-0 shadow-none focus-visible:ring-0 pr-12 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="absolute bottom-2.5 right-2.5 flex h-8 w-8 items-center justify-center rounded-lg bg-muted-foreground/15 text-muted-foreground transition-colors hover:bg-muted-foreground/25 disabled:opacity-40 disabled:hover:bg-muted-foreground/15"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
