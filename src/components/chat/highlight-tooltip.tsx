"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport } from "ai";
import {
  Lightbulb,
  MessageSquare,
  Trash2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Send,
  Loader2,
  X,
  BookmarkPlus,
} from "lucide-react";
import { useNotebook } from "@/hooks/use-notebook";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import {
  ChatArtifactsInline,
  ChatMessageSupport,
  linkifyPaperAnswerContent,
} from "./chat-message-support";
import {
  parseChatMessageMetadata,
  type AnswerCitation,
} from "@/lib/papers/answer-engine/metadata";

interface ConversationInfo {
  id: string;
  mode: string;
  preview: string | null;
  messageCount: number;
}

interface HighlightTooltipProps {
  paperId: string;
  conversations: ConversationInfo[];
  selectedText: string;
  rect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onPin: () => void;
  onDismiss: () => void;
  tooltipRef: React.Ref<HTMLDivElement>;
}

export function HighlightTooltip({
  paperId,
  conversations,
  selectedText,
  rect,
  onMouseEnter,
  onMouseLeave,
  onPin,
  onDismiss,
  tooltipRef,
}: HighlightTooltipProps) {
  const { saveToNotebook } = useNotebook();
  const explains = conversations.filter((c) => c.mode === "explain");
  const chats = conversations.filter((c) => c.mode === "chat");

  // Accordion: always exactly one item expanded. Can't collapse the last one.
  const hasExplains = explains.length > 0;
  const defaultId = hasExplains ? explains[0].id : chats[0]?.id ?? null;
  const [expandedId, setExpandedId] = useState<string | null>(defaultId);

  const toggleExpanded = (id: string) => {
    // Only switch, never collapse to nothing
    if (expandedId !== id) setExpandedId(id);
  };

  // Quick-chat state
  const [chatInput, setChatInput] = useState("");
  const [quickChat, setQuickChat] = useState<{
    conversationId: string;
    mode: "explain" | "chat";
    initialMessage: string;
  } | null>(null);
  const [pinned, setPinned] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const openInPanel = (e: React.MouseEvent, convId: string) => {
    e.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("open-highlight-conversation", {
        detail: { conversationId: convId },
      })
    );
  };

  const deleteConversation = (e: React.MouseEvent, convId: string) => {
    e.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("delete-highlight-conversation", {
        detail: { conversationId: convId },
      })
    );
  };

  const handleExplainInline = async () => {
    setPinned(true);
    onPin();
    const res = await fetch(`/api/papers/${paperId}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedText, mode: "explain" }),
    });
    const data = await res.json();
    setQuickChat({
      conversationId: data.id,
      mode: "explain",
      initialMessage: `Explain this passage from the paper:\n\n"${selectedText}"`,
    });
    setExpandedId("__quick__");
  };

  const handleChatSubmit = async () => {
    const text = chatInput.trim();
    if (!text) return;
    setPinned(true);
    onPin();
    setChatInput("");
    const res = await fetch(`/api/papers/${paperId}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedText, mode: "chat" }),
    });
    const data = await res.json();
    setQuickChat({
      conversationId: data.id,
      mode: "chat",
      initialMessage: `Regarding this passage from the paper:\n\n"${selectedText}"\n\n${text}`,
    });
    setExpandedId("__quick__");
  };

  const handleDismiss = () => {
    if (quickChat) {
      window.dispatchEvent(new CustomEvent("paper-highlights-changed"));
    }
    onDismiss();
  };

  // Position above the mark by default, below if not enough space
  const spaceAbove = rect.top;
  const placement = spaceAbove > 240 ? "above" : "below";
  const left = Math.max(
    12,
    Math.min(rect.left + rect.width / 2, window.innerWidth - 200)
  );

  const style: React.CSSProperties = {
    left,
    transform: "translateX(-50%)",
  };

  if (placement === "above") {
    style.bottom = window.innerHeight - rect.top + 6;
  } else {
    style.top = rect.bottom + 6;
  }

  return createPortal(
    <div
      ref={tooltipRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={pinned ? undefined : onMouseLeave}
      className="fixed z-[100] w-96 rounded-lg border bg-popover text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95 duration-100"
      style={style}
    >
      <div className="p-3 space-y-2">
        {/* Close button when pinned */}
        {pinned && (
          <button
            onClick={handleDismiss}
            className="absolute top-2 right-2 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Explanations */}
        {explains.map((conv) => (
          <div key={conv.id} className="rounded-md">
            <div
              className="flex items-center justify-between cursor-pointer select-none"
              onClick={() => toggleExpanded(conv.id)}
            >
              <div className="flex items-center gap-1.5">
                {expandedId === conv.id ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                )}
                <Lightbulb className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  Explanation
                </span>
              </div>
              <div className="flex gap-0.5 shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    saveToNotebook({
                      paperId,
                      type: "explanation",
                      selectedText,
                      content: conv.preview || undefined,
                      conversationId: conv.id,
                    });
                  }}
                  className="p-1 rounded hover:bg-green-500/10 text-muted-foreground hover:text-green-600 dark:hover:text-green-400 transition-colors"
                  title="Save to notebook"
                >
                  <BookmarkPlus className="h-3 w-3" />
                </button>
                <button
                  onClick={(e) => openInPanel(e, conv.id)}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  title="Open in Chat"
                >
                  <ExternalLink className="h-3 w-3" />
                </button>
                <button
                  onClick={(e) => deleteConversation(e, conv.id)}
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
            {expandedId === conv.id && (
              <>
                {conv.preview && (
                  <div className="mt-1.5 max-h-40 overflow-y-auto rounded bg-muted/40 px-2.5 py-1.5 highlight-tooltip-scroll text-xs [&_p]:mb-1 [&_p]:leading-snug [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_ul]:mb-1 [&_ol]:mb-1 [&_pre]:my-1 [&_blockquote]:my-1">
                    <MarkdownRenderer
                      content={conv.preview}
                      className="text-xs"
                    />
                  </div>
                )}
                {!conv.preview && conv.messageCount === 0 && (
                  <p className="text-xs text-muted-foreground/60 italic mt-1">
                    No response yet
                  </p>
                )}
              </>
            )}
          </div>
        ))}

        {/* Separator */}
        {explains.length > 0 && chats.length > 0 && (
          <div className="border-t" />
        )}

        {/* Chats */}
        {chats.map((conv) => (
          <div key={conv.id} className="rounded-md">
            <div
              className="flex items-center justify-between cursor-pointer select-none"
              onClick={() => toggleExpanded(conv.id)}
            >
              <div className="flex items-center gap-1.5">
                {expandedId === conv.id ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                )}
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                <span className="text-xs">
                  Chat
                  <span className="text-muted-foreground ml-1">
                    · {conv.messageCount}{" "}
                    {conv.messageCount === 1 ? "reply" : "replies"}
                  </span>
                </span>
              </div>
              <div className="flex gap-0.5 shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    saveToNotebook({
                      paperId,
                      type: "chat",
                      selectedText,
                      content: conv.preview || undefined,
                      conversationId: conv.id,
                    });
                  }}
                  className="p-1 rounded hover:bg-green-500/10 text-muted-foreground hover:text-green-600 dark:hover:text-green-400 transition-colors"
                  title="Save to notebook"
                >
                  <BookmarkPlus className="h-3 w-3" />
                </button>
                <button
                  onClick={(e) => openInPanel(e, conv.id)}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  title="Open in Chat"
                >
                  <ExternalLink className="h-3 w-3" />
                </button>
                <button
                  onClick={(e) => deleteConversation(e, conv.id)}
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
            {expandedId === conv.id && conv.preview && (
              <div className="mt-1.5 max-h-28 overflow-y-auto rounded bg-muted/40 px-2.5 py-1.5 highlight-tooltip-scroll text-xs [&_p]:mb-1 [&_p]:leading-snug [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_ul]:mb-1 [&_ol]:mb-1 [&_pre]:my-1 [&_blockquote]:my-1">
                <MarkdownRenderer
                  content={conv.preview}
                  className="text-xs"
                />
              </div>
            )}
          </div>
        ))}

        {/* Quick-chat streaming result */}
        {quickChat && (
          <>
            <div className="border-t" />
            <div className="rounded-md">
              <div
                className="flex items-center gap-1.5 cursor-pointer select-none"
                onClick={() => toggleExpanded("__quick__")}
              >
                {expandedId === "__quick__" ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                )}
                {quickChat.mode === "explain" ? (
                  <Lightbulb className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                ) : (
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                )}
                <span
                  className={`text-[11px] font-medium ${
                    quickChat.mode === "explain"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-blue-600 dark:text-blue-400"
                  }`}
                >
                  {quickChat.mode === "explain"
                    ? "Explanation"
                    : "Chat"}
                </span>
              </div>
              {expandedId === "__quick__" && (
                <div className="mt-1.5">
                  <QuickChatStream
                    paperId={paperId}
                    conversationId={quickChat.conversationId}
                    initialMessage={quickChat.initialMessage}
                    mode={quickChat.mode}
                  />
                </div>
              )}
            </div>
          </>
        )}

        {/* Action bar */}
        {!quickChat && (
          <div className="border-t pt-2">
            <div className="flex gap-1.5">
              {!hasExplains && (
                <button
                  onClick={handleExplainInline}
                  className="h-7 shrink-0 flex items-center gap-1 text-[11px] font-medium px-2 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
                >
                  <Lightbulb className="h-3 w-3" />
                  Explain
                </button>
              )}
              <input
                ref={inputRef}
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onFocus={() => {
                  setPinned(true);
                  onPin();
                }}
                placeholder="Ask about this..."
                className="flex-1 min-w-0 h-7 rounded-md border bg-background px-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleChatSubmit();
                  }
                }}
              />
              <button
                onClick={handleChatSubmit}
                disabled={!chatInput.trim()}
                className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90 transition-colors"
              >
                <Send className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

/** Sub-component that streams a response using the AI SDK useChat hook */
function QuickChatStream({
  paperId,
  conversationId,
  initialMessage,
  mode,
}: {
  paperId: string;
  conversationId: string;
  initialMessage: string;
  mode: "explain" | "chat";
}) {
  const initialSent = useRef(false);
  const [assistantSupport, setAssistantSupport] = useState<{
    citations?: AnswerCitation[];
    artifacts?: Array<{ id: string; kind: string; title: string; payloadJson: string }>;
  } | null>(null);

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

  useEffect(() => {
    if (!initialSent.current) {
      initialSent.current = true;
      sendMessage({ text: initialMessage });
    }
  }, [initialMessage, sendMessage]);

  // Notify highlights changed when streaming finishes
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current === "streaming" && status === "ready") {
      window.dispatchEvent(new CustomEvent("paper-highlights-changed"));
      void fetch(`/api/papers/${paperId}/conversations/${conversationId}/messages`)
        .then((response) => response.json())
        .then(
          (
            history: Array<{
              role: string;
              metadataJson?: string | null;
              artifacts?: Array<{ id: string; kind: string; title: string; payloadJson: string }>;
            }>,
          ) => {
            const assistant = history.findLast((message) => message.role === "assistant");
            if (!assistant) return;
            const metadata = parseChatMessageMetadata(assistant.metadataJson);
            setAssistantSupport({
              citations: metadata?.citations,
              artifacts: assistant.artifacts ?? [],
            });
          },
        )
        .catch(() => {});
    }
    prevStatus.current = status;
  }, [conversationId, paperId, status]);

  const assistantMessage = messages.find((m) => m.role === "assistant");
  const responseText = assistantMessage
    ? assistantMessage.parts
        ?.filter(
          (p): p is { type: "text"; text: string } => p.type === "text"
        )
        .map((p) => p.text)
        .join("") || ""
    : "";
  const inlineArtifacts =
    assistantSupport?.artifacts?.filter(
      (artifact) => artifact.kind === "CODE_SNIPPET",
    ) ?? [];
  const supportArtifacts =
    assistantSupport?.artifacts?.filter(
      (artifact) => artifact.kind !== "CODE_SNIPPET",
    ) ?? [];
  const hasInlineArtifacts = inlineArtifacts.length > 0;

  if (isLoading && !responseText && !hasInlineArtifacts) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        {mode === "explain" ? "Explaining..." : "Thinking..."}
      </div>
    );
  }

  if (!responseText && !hasInlineArtifacts) return null;
  const linkedResponseText = linkifyPaperAnswerContent(responseText, {
    citations: assistantSupport?.citations,
    artifacts: assistantSupport?.artifacts,
  });
  const hasAssistantText = linkedResponseText.trim().length > 0;

  return (
    <div className="max-h-40 overflow-y-auto rounded bg-muted/40 px-2.5 py-1.5 highlight-tooltip-scroll text-xs [&_p]:mb-1 [&_p]:leading-snug [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_ul]:mb-1 [&_ol]:mb-1 [&_pre]:my-1 [&_blockquote]:my-1">
      <ChatArtifactsInline compact artifacts={inlineArtifacts} />
      {hasAssistantText ? (
        <MarkdownRenderer content={linkedResponseText} className="text-xs" />
      ) : null}
      <ChatMessageSupport
        compact
        citations={assistantSupport?.citations}
        artifacts={supportArtifacts}
      />
      {isLoading && (
        <Loader2 className="inline h-3 w-3 animate-spin text-muted-foreground ml-1" />
      )}
    </div>
  );
}
