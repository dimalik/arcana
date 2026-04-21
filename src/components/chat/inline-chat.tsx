"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport } from "ai";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { X, Send, Loader2, ArrowUpRight, BookmarkPlus } from "lucide-react";
import { useNotebook } from "@/hooks/use-notebook";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { ChatMessageSupport } from "./chat-message-support";
import {
  parseChatMessageMetadata,
  type AnswerCitation,
} from "@/lib/papers/answer-engine/metadata";

interface ConversationArtifactRecord {
  id?: string;
  kind: string;
  title: string;
  payloadJson: string;
}

interface PersistedInlineMessage {
  id: string;
  role: string;
  content: string;
  metadataJson?: string | null;
  artifacts?: ConversationArtifactRecord[];
}

interface InlineChatProps {
  paperId: string;
  conversationId: string;
  selectedText: string;
  mode: "explain" | "chat";
  yOffset?: number;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onOpenFull: (conversationId: string) => void;
  /** Render inline (no portal, no margin positioning) — used in notebook */
  inline?: boolean;
}

export function InlineChat({
  paperId,
  conversationId,
  selectedText,
  mode,
  yOffset = 0,
  scrollContainerRef,
  onClose,
  onOpenFull,
  inline,
}: InlineChatProps) {
  const [input, setInput] = useState("");
  const [sent, setSent] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [assistantSupport, setAssistantSupport] = useState<{
    citations?: AnswerCitation[];
    artifacts?: ConversationArtifactRecord[];
  } | null>(null);
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

  const previousStatus = useRef(status);
  useEffect(() => {
    if (previousStatus.current === "streaming" && status === "ready") {
      void fetch(`/api/papers/${paperId}/conversations/${conversationId}/messages`)
        .then((response) => response.json())
        .then((history: PersistedInlineMessage[]) => {
          const assistant = history.findLast((message) => message.role === "assistant");
          if (!assistant) return;
          const metadata = parseChatMessageMetadata(assistant.metadataJson);
          setAssistantSupport({
            citations: metadata?.citations,
            artifacts: assistant.artifacts ?? [],
          });
        })
        .catch(() => {});
    }
    previousStatus.current = status;
  }, [conversationId, paperId, status]);

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

  const accentColor = mode === "explain" ? "amber" : "blue";
  const dotBg = mode === "explain" ? "bg-amber-400" : "bg-blue-400";
  const borderAccent =
    mode === "explain" ? "border-l-amber-400" : "border-l-blue-400";

  const container = scrollContainerRef?.current;

  const cardContent = (
    <div
      className={`rounded-lg border ${borderAccent} border-l-2 bg-card shadow-lg overflow-hidden`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-2.5 py-1 border-b bg-muted/30">
        <span className="text-[11px] font-medium text-muted-foreground">
          {mode === "explain" ? "Explanation" : "Quick Chat"}
        </span>
        <div className="flex items-center gap-0.5">
          {(responseText || sent) && (
            <button
              onClick={() => onOpenFull(conversationId)}
              className="text-muted-foreground hover:text-foreground p-0.5"
              title="Continue in full chat"
            >
              <ArrowUpRight className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={inline ? onClose : () => setCollapsed(true)}
            className="text-muted-foreground hover:text-foreground p-0.5"
            title={inline ? "Close" : "Collapse"}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-h-[240px] overflow-y-auto highlight-tooltip-scroll">
        {/* Chat mode: show input before user sends */}
        {mode === "chat" && !sent && (
          <div className="px-2.5 py-2 space-y-1.5">
            <p className="text-[11px] text-muted-foreground line-clamp-2 italic">
              &ldquo;{displayText}&rdquo;
            </p>
            <div className="flex gap-1">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about this..."
                rows={1}
                className="min-h-[28px] resize-none text-xs"
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
                className="h-7 w-7 p-0 shrink-0"
              >
                <Send className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}

        {/* Chat mode: show user question after sending */}
        {mode === "chat" && sent && (
          <div className="px-2.5 pt-2">
            <p className="text-[11px] text-muted-foreground mb-1">
              <span className="italic">&ldquo;{displayText}&rdquo;</span>
              {" — "}
              {messages
                .find((m) => m.role === "user")
                ?.parts?.filter(
                  (p): p is { type: "text"; text: string } =>
                    p.type === "text"
                )
                .map((p) => {
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
          <div className="px-2.5 py-1.5">
            <MarkdownRenderer content={responseText} className="text-xs" />
            <ChatMessageSupport
              compact
              citations={assistantSupport?.citations}
              artifacts={assistantSupport?.artifacts}
            />
            {!isLoading && (
              <div className="mt-1.5 flex justify-end">
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
                  className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 transition-colors disabled:opacity-50"
                >
                  <BookmarkPlus className="h-2.5 w-2.5" />
                  Notebook
                </button>
              </div>
            )}
          </div>
        )}

        {/* Loading: before first token */}
        {isLoading && !responseText && (
          <div className="px-2.5 py-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {mode === "explain" ? "Explaining..." : "Thinking..."}
          </div>
        )}
      </div>
    </div>
  );

  // Inline mode (notebook): render directly, no portal
  if (inline) {
    return (
      <div ref={cardRef} className="animate-in fade-in slide-in-from-bottom-2 duration-150">
        {cardContent}
      </div>
    );
  }

  // Collapsed dot
  if (collapsed) {
    if (!container) return null;
    return createPortal(
      <button
        onClick={() => setCollapsed(false)}
        className={`absolute z-[55] ${dotBg} h-3 w-3 rounded-full shadow-sm hover:scale-125 transition-transform cursor-pointer`}
        style={{ top: yOffset, right: 8 }}
        title={mode === "explain" ? "Explanation" : "Chat"}
      />,
      container
    );
  }

  // Expanded card in margin
  if (!container) return null;
  return createPortal(
    <div
      ref={cardRef}
      className="absolute z-[55] animate-in fade-in slide-in-from-right-2 duration-150"
      style={{ top: yOffset, right: 8, width: 280 }}
    >
      {cardContent}
    </div>,
    container
  );
}
