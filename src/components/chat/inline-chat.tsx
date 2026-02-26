"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport } from "ai";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { X, Send, Loader2, ArrowUpRight, BookmarkPlus } from "lucide-react";
import { useNotebook } from "@/hooks/use-notebook";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

interface InlineChatProps {
  paperId: string;
  conversationId: string;
  selectedText: string;
  mode: "explain" | "chat";
  position: { x: number; y: number; placement: "above" | "below" };
  onClose: () => void;
  onOpenFull: (conversationId: string) => void;
  inline?: boolean;
}

export function InlineChat({
  paperId,
  conversationId,
  selectedText,
  mode,
  position,
  onClose,
  onOpenFull,
  inline,
}: InlineChatProps) {
  const [input, setInput] = useState("");
  const [sent, setSent] = useState(false);
  const { saveToNotebook, saving: notebookSaving } = useNotebook();
  const cardRef = useRef<HTMLDivElement>(null);
  const initialSent = useRef(false);

  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: `/api/papers/${paperId}/conversations/${conversationId}/messages`,
        body: { brief: true },
      }),
    [paperId, conversationId]
  );

  const { messages, sendMessage, status } = useChat({ transport });

  const isLoading = status === "submitted" || status === "streaming";

  // For explain mode, send immediately
  useEffect(() => {
    if (mode === "explain" && !initialSent.current) {
      initialSent.current = true;
      sendMessage({
        text: `Explain this passage from the paper:\n\n"${selectedText}"`,
      });
    }
  }, [mode, selectedText, sendMessage]);

  // Click outside to close (skip for inline mode)
  useEffect(() => {
    if (inline) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid the triggering click closing it immediately
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 150);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose, inline]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isLoading) return;
    const text = `Regarding this passage from the paper:\n\n"${selectedText}"\n\n${input}`;
    setInput("");
    setSent(true);
    await sendMessage({ text });
  }, [input, isLoading, sendMessage, selectedText]);

  // Extract assistant response text
  const assistantMessage = messages.find((m) => m.role === "assistant");
  const responseText = assistantMessage
    ? assistantMessage.parts
        ?.filter(
          (p): p is { type: "text"; text: string } => p.type === "text"
        )
        .map((p) => p.text)
        .join("") || ""
    : "";

  const displayText =
    selectedText.length > 150
      ? selectedText.slice(0, 147) + "..."
      : selectedText;

  // Calculate left position: center on x, clamp to viewport
  const cardWidth = 380;
  const left = Math.max(
    12,
    Math.min(position.x - cardWidth / 2, window.innerWidth - cardWidth - 12)
  );

  return (
    <div
      ref={cardRef}
      className={
        inline
          ? "animate-in fade-in slide-in-from-bottom-2 duration-150"
          : "fixed z-[60] animate-in fade-in slide-in-from-bottom-2 duration-150"
      }
      style={
        inline
          ? undefined
          : {
              left: `${left}px`,
              top:
                position.placement === "below"
                  ? `${position.y}px`
                  : undefined,
              bottom:
                position.placement === "above"
                  ? `${window.innerHeight - position.y}px`
                  : undefined,
              width: cardWidth,
            }
      }
    >
      <Card className="shadow-xl border overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30">
          <span className="text-xs font-medium text-muted-foreground">
            {mode === "explain" ? "Explanation" : "Quick Chat"}
          </span>
          <div className="flex items-center gap-0.5">
            {(responseText || sent) && (
              <button
                onClick={() => onOpenFull(conversationId)}
                className="text-muted-foreground hover:text-foreground p-0.5"
                title="Continue in full chat"
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-0.5"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="max-h-[280px] overflow-y-auto">
          {/* Chat mode: show input before user sends */}
          {mode === "chat" && !sent && (
            <div className="px-3 py-2.5 space-y-2">
              <p className="text-xs text-muted-foreground line-clamp-2 italic">
                &ldquo;{displayText}&rdquo;
              </p>
              <div className="flex gap-1.5">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask about this..."
                  rows={1}
                  className="min-h-[32px] resize-none text-sm"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                />
                <Button
                  size="sm"
                  onClick={handleSend}
                  disabled={isLoading || !input.trim()}
                  className="h-8 w-8 p-0 shrink-0"
                >
                  <Send className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Chat mode: show user question after sending */}
          {mode === "chat" && sent && (
            <div className="px-3 pt-2.5">
              <p className="text-xs text-muted-foreground mb-1.5">
                <span className="italic">&ldquo;{displayText}&rdquo;</span>
                {" — "}
                {messages
                  .find((m) => m.role === "user")
                  ?.parts?.filter(
                    (p): p is { type: "text"; text: string } =>
                      p.type === "text"
                  )
                  .map((p) => {
                    // Strip the "Regarding this passage..." wrapper, show just the user's question
                    const match = p.text.match(
                      /Regarding this passage from the paper:\n\n"[^"]*"\n\n([\s\S]+)/
                    );
                    return match ? match[1] : p.text;
                  })
                  .join("") || ""}
              </p>
            </div>
          )}

          {/* Streaming response */}
          {responseText && (
            <div className="px-3 py-2">
              <MarkdownRenderer content={responseText} className="text-sm" />
              {!isLoading && (
                <div className="mt-2 flex justify-end">
                  <button
                    disabled={notebookSaving}
                    onClick={() =>
                      saveToNotebook({
                        paperId,
                        type: mode === "explain" ? "explanation" : "chat",
                        selectedText,
                        content: responseText,
                        conversationId,
                      })
                    }
                    className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 transition-colors disabled:opacity-50"
                  >
                    <BookmarkPlus className="h-3 w-3" />
                    Notebook
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Loading: before first token */}
          {isLoading && !responseText && (
            <div className="px-3 py-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {mode === "explain" ? "Explaining..." : "Thinking..."}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
