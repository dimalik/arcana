"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport } from "ai";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Send,
  Loader2,
  Minimize2,
  Maximize2,
  X,
  MessageSquare,
  BookmarkPlus,
} from "lucide-react";
import { useNotebook } from "@/hooks/use-notebook";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { PaperPicker } from "./paper-picker";

interface ConversationViewProps {
  paperId: string;
  conversationId: string;
  initialMessage?: string;
  /** Selected text shown as context above input — user types their own question */
  selectedContext?: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  onBack: () => void;
}

export function ConversationView({
  paperId,
  conversationId,
  initialMessage,
  selectedContext,
  expanded,
  onToggleExpand,
  onClose,
  onBack,
}: ConversationViewProps) {
  const [input, setInput] = useState("");
  const [title, setTitle] = useState<string | null>(null);
  const { saveToNotebook } = useNotebook();
  const [context, setContext] = useState<string | null>(
    selectedContext || null
  );
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialSent = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: `/api/papers/${paperId}/conversations/${conversationId}/messages`,
      }),
    [paperId, conversationId]
  );

  const { messages, sendMessage, status, setMessages } = useChat({
    transport,
  });

  const isLoading = status === "submitted" || status === "streaming";

  // Load conversation details + history on mount
  useEffect(() => {
    const load = async () => {
      const [historyRes, convRes] = await Promise.all([
        fetch(
          `/api/papers/${paperId}/conversations/${conversationId}/messages`
        ),
        fetch(`/api/papers/${paperId}/conversations/${conversationId}`),
      ]);
      const history = await historyRes.json();
      const conv = await convRes.json();
      setTitle(conv.title || null);

      if (history.length > 0) {
        setMessages(
          history.map(
            (m: { id: string; role: string; content: string }) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              parts: [{ type: "text" as const, text: m.content }],
            })
          )
        );
      }
      setHistoryLoaded(true);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, conversationId]);

  // Send initial message AFTER history is loaded (fixes race condition)
  useEffect(() => {
    if (!historyLoaded || initialSent.current || !initialMessage) return;
    initialSent.current = true;
    sendMessage({ text: initialMessage });
  }, [historyLoaded, initialMessage, sendMessage]);

  // Focus input when opened with context (quick-chat flow)
  useEffect(() => {
    if (historyLoaded && selectedContext && inputRef.current) {
      inputRef.current.focus();
    }
  }, [historyLoaded, selectedContext]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isLoading) return;
    let text = input;
    // Wrap with context if present
    if (context) {
      text = `Regarding this passage from the paper:\n\n"${context}"\n\n${input}`;
      setContext(null);
    }
    setInput("");
    await sendMessage({ text });
  }, [input, isLoading, sendMessage, context]);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onBack}
            title="Back to conversations"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-sm font-medium truncate">
            {title || "New conversation"}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <PaperPicker
            paperId={paperId}
            conversationId={conversationId}
          />
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4" ref={scrollRef}>
        <div className="space-y-3 py-3">
          {messages.length === 0 && !initialMessage && !selectedContext && (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <MessageSquare className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                Ask anything about this paper
              </p>
              <div className="mt-1 flex flex-wrap justify-center gap-1.5">
                {[
                  "Key contributions",
                  "Explain the methodology",
                  "Limitations?",
                ].map((suggestion) => (
                  <Button
                    key={suggestion}
                    variant="outline"
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => setInput(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message) => {
            const messageText =
              message.parts
                ?.filter(
                  (p): p is { type: "text"; text: string } =>
                    p.type === "text"
                )
                .map((p) => p.text)
                .join("") || "";
            return (
              <div
                key={message.id}
                className={`flex ${
                  message.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`relative max-w-[85%] rounded-lg px-3 py-2 group ${
                    message.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  }`}
                >
                  {message.role === "assistant" ? (
                    <>
                      <MarkdownRenderer
                        content={messageText}
                        className="text-sm"
                      />
                      <button
                        onClick={() =>
                          saveToNotebook({
                            paperId,
                            type: "chat",
                            content: messageText,
                            conversationId,
                            messageId: message.id,
                          })
                        }
                        className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-green-500/10 border border-green-500/20 text-green-600 dark:text-green-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-green-500/20"
                        title="Save to notebook"
                      >
                        <BookmarkPlus className="h-3 w-3" />
                      </button>
                    </>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">
                      {messageText}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
          {isLoading &&
            messages[messages.length - 1]?.role !== "assistant" && (
              <div className="flex justify-start">
                <div className="rounded-lg bg-muted px-3 py-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              </div>
            )}
        </div>
      </div>

      {/* Context chip + Input */}
      <div className="border-t p-3">
        {context && (
          <div className="mb-2 flex items-start gap-1.5 rounded-md bg-muted/60 border px-2.5 py-1.5">
            <p className="text-xs text-muted-foreground flex-1 line-clamp-2">
              <span className="font-medium">Re:</span>{" "}
              &ldquo;{context}&rdquo;
            </p>
            <button
              onClick={() => setContext(null)}
              className="text-muted-foreground hover:text-foreground shrink-0 mt-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              context
                ? "Ask your question about this passage..."
                : "Ask about this paper..."
            }
            rows={1}
            className="min-h-[36px] resize-none text-sm"
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
            className="h-9 w-9 p-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );
}
