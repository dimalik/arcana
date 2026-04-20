"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import type { UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport } from "ai";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  ArrowUp,
  Loader2,
  Minimize2,
  Maximize2,
  X,
  BookmarkPlus,
  Plus,
  History,
  Paperclip,
  BookOpen,
} from "lucide-react";
import { useNotebook } from "@/hooks/use-notebook";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { PaperPicker } from "./paper-picker";
import { ChatMessageSupport } from "./chat-message-support";
import {
  parseChatMessageMetadata,
  type ChatMessageMetadata,
} from "@/lib/papers/answer-engine/metadata";

interface ConversationArtifactRecord {
  id: string;
  kind: string;
  title: string;
  payloadJson: string;
}

type PaperChatMessageMetadata = Partial<ChatMessageMetadata> & {
  artifacts?: ConversationArtifactRecord[];
};

type PaperChatMessage = UIMessage<PaperChatMessageMetadata>;

interface PersistedConversationMessage {
  id: string;
  role: string;
  content: string;
  metadataJson?: string | null;
  artifacts?: ConversationArtifactRecord[];
}

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
  hideControls?: boolean;
  onNewChat?: () => void;
  onShowHistory?: () => void;
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
  hideControls,
  onNewChat,
  onShowHistory,
}: ConversationViewProps) {
  const [input, setInput] = useState("");
  const [title, setTitle] = useState<string | null>(null);
  const { saveToNotebook } = useNotebook();
  const [context, setContext] = useState<string | null>(
    selectedContext || null
  );
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [referencedPapers, setReferencedPapers] = useState<
    { id: string; title: string }[]
  >([]);
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

  const { messages, sendMessage, status, setMessages } = useChat<PaperChatMessage>({
    transport,
  });

  const isLoading = status === "submitted" || status === "streaming";

  const loadConversation = useCallback(async () => {
      const [historyRes, convRes] = await Promise.all([
        fetch(
          `/api/papers/${paperId}/conversations/${conversationId}/messages`
        ),
        fetch(`/api/papers/${paperId}/conversations/${conversationId}`),
      ]);
      const history = (await historyRes.json()) as PersistedConversationMessage[];
      const conv = await convRes.json();
      setTitle(conv.title || null);
      setReferencedPapers(
        (conv.additionalPapers || []).map(
          (ap: { paper: { id: string; title: string } }) => ap.paper
        )
      );

      if (history.length > 0) {
        setMessages(
          history.map(
            (m) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              metadata: {
                ...(parseChatMessageMetadata(m.metadataJson) ?? undefined),
                ...(m.artifacts?.length ? { artifacts: m.artifacts } : {}),
              },
              content: m.content,
              parts: [{ type: "text" as const, text: m.content }],
            })
          )
        );
      }
      setHistoryLoaded(true);
  }, [conversationId, paperId, setMessages]);

  // Load conversation details + history on mount
  useEffect(() => {
    void loadConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadConversation]);

  const previousStatus = useRef(status);
  useEffect(() => {
    if (previousStatus.current === "streaming" && status === "ready") {
      void loadConversation();
    }
    previousStatus.current = status;
  }, [loadConversation, status]);

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

  const handleAddPaper = useCallback(
    async (addPaperId: string, title: string) => {
      await fetch(`/api/papers/${paperId}/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addPaperIds: [addPaperId] }),
      });
      setReferencedPapers((prev) => [...prev, { id: addPaperId, title }]);
    },
    [paperId, conversationId]
  );

  const handleRemovePaper = useCallback(
    async (removePaperId: string) => {
      await fetch(`/api/papers/${paperId}/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removePaperIds: [removePaperId] }),
      });
      setReferencedPapers((prev) =>
        prev.filter((r) => r.id !== removePaperId)
      );
    },
    [paperId, conversationId]
  );

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
      {/* Minimal toolbar */}
      <div className="flex items-center px-2 py-1.5">
        {/* Left: back arrow (only when conversation started) */}
        <div className="flex items-center gap-0.5">
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              onClick={onBack}
              title="Back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        {/* Right: new chat, history, expand/close */}
        <div className="flex items-center gap-0.5 ml-auto">
          {messages.length > 0 && onNewChat && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              onClick={onNewChat}
              title="New chat"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          {onShowHistory && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              onClick={onShowHistory}
              title="Chat history"
            >
              <History className="h-3.5 w-3.5" />
            </Button>
          )}
          {!hideControls && (
            <>
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
            </>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4" ref={scrollRef}>
        <div className="flex min-h-full flex-col space-y-3 py-3">
          {messages.length === 0 && !initialMessage && !selectedContext && (
            <div className="flex flex-1 flex-col items-center justify-end gap-2 pb-4 text-center">
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
                    onClick={() => sendMessage({ text: suggestion })}
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
                      <ChatMessageSupport
                        citations={message.metadata?.citations}
                        artifacts={message.metadata?.artifacts}
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

      {/* Input area */}
      <div className="p-3">
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
        <div className="relative rounded-2xl border border-muted-foreground/20 focus-within:border-muted-foreground/40 transition-colors">
          {/* Paper chips */}
          {referencedPapers.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5 pr-10">
              {referencedPapers.map((paper) => (
                <span
                  key={paper.id}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground max-w-[180px]"
                >
                  <BookOpen className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{paper.title}</span>
                  <button
                    onClick={() => handleRemovePaper(paper.id)}
                    className="shrink-0 hover:text-foreground"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* Textarea */}
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              context
                ? "Ask your question about this passage..."
                : "Chat about the paper"
            }
            rows={3}
            className="min-h-[80px] resize-none border-0 shadow-none focus-visible:ring-0 pr-12 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          {/* Paperclip (top-right) + Send (bottom-right) */}
          <PaperPicker
            paperId={paperId}
            conversationId={conversationId}
            onAdd={handleAddPaper}
            onRemove={handleRemovePaper}
            trigger={
              <button
                className="absolute top-2 right-2.5 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/30 hover:text-muted-foreground transition-colors"
                title="Add paper context"
              >
                <Paperclip className="h-4 w-4" />
              </button>
            }
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="absolute bottom-2.5 right-2.5 flex h-8 w-8 items-center justify-center rounded-lg bg-muted-foreground/15 text-muted-foreground transition-colors hover:bg-muted-foreground/25 disabled:opacity-40 disabled:hover:bg-muted-foreground/15"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  );
}
