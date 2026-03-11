"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport } from "ai";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  ArrowUp,
  Loader2,
  Play,
  Sparkles,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { toast } from "sonner";
import type { SynthesisPlan } from "@/lib/synthesis/types";

interface GuidanceMessage {
  role: string;
  content: string;
  timestamp?: string;
}

interface SynthesisGuideProps {
  sessionId: string;
  title: string;
  plan: SynthesisPlan | null;
  existingMessages: GuidanceMessage[] | null;
  onProceed: () => void;
}

function getMessageText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function SynthesisGuide({
  sessionId,
  title,
  plan,
  existingMessages,
  onProceed,
}: SynthesisGuideProps) {
  const [input, setInput] = useState("");
  const [proceeding, setProceeding] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialSent = useRef(false);
  const historyLoaded = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: `/api/synthesis/${sessionId}/guide`,
      }),
    [sessionId]
  );

  const { messages, sendMessage, status, setMessages } = useChat({
    transport,
  });

  const isLoading = status === "submitted" || status === "streaming";

  // Detect when the agent signals the guidance session is complete
  const guidanceComplete = useMemo(() => {
    // Check if any assistant message contains the "Continue Synthesis" signal
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const text = getMessageText(msg).toLowerCase();
      if (text.includes("continue synthesis") && text.includes("complete")) return true;
      if (text.includes("guidance session is complete")) return true;
    }
    // Also require minimum 4 exchanges (8 messages: 4 user + 4 assistant)
    const userCount = messages.filter((m) => m.role === "user").length;
    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    if (userCount >= 4 && assistantCount >= 4) return true;
    return false;
  }, [messages]);

  // Load existing messages from DB
  useEffect(() => {
    if (historyLoaded.current) return;
    if (!existingMessages?.length) return;

    historyLoaded.current = true;
    const uiMessages: UIMessage[] = existingMessages.map((m, i) => ({
      id: `history-${i}`,
      role: m.role as "user" | "assistant",
      parts: [{ type: "text" as const, text: m.content }],
    }));
    setMessages(uiMessages);
  }, [existingMessages, setMessages]);

  // Send initial message if no history
  useEffect(() => {
    if (initialSent.current) return;
    if (existingMessages?.length) return;
    if (messages.length > 0) return;

    initialSent.current = true;
    sendMessage({
      text: "I'd like guidance on how to structure this synthesis. What aspects should I consider?",
    });
  }, [existingMessages, messages.length, sendMessage]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(() => {
    if (!input.trim() || isLoading) return;
    const text = input.trim();
    setInput("");
    sendMessage({ text });
  }, [input, isLoading, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleProceed = async () => {
    setProceeding(true);
    try {
      const res = await fetch(`/api/synthesis/${sessionId}/proceed`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to proceed");
        return;
      }
      toast.success("Resuming synthesis with your guidance");
      onProceed();
    } catch {
      toast.error("Failed to proceed");
    } finally {
      setProceeding(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-full bg-indigo-500/10 flex items-center justify-center">
          <Sparkles className="h-5 w-5 text-indigo-500" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Expert Guidance</h2>
          <p className="text-sm text-muted-foreground">
            Shape your synthesis with an AI research consultant
          </p>
        </div>
      </div>

      {/* Theme badges */}
      {plan?.themes && plan.themes.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Identified themes
          </p>
          <div className="flex gap-1.5 flex-wrap">
            {plan.themes.map((t) => (
              <Badge key={t.id} variant="secondary" className="text-xs">
                {t.label}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Chat messages */}
      <Card>
        <CardContent className="p-0">
          <div
            ref={scrollRef}
            className="max-h-[50vh] overflow-y-auto p-4 space-y-4"
          >
            {messages.map((msg) => {
              const text = getMessageText(msg);
              if (!text) return null;

              return (
                <div
                  key={msg.id}
                  className={`flex ${
                    msg.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <MarkdownRenderer content={text} />
                    ) : (
                      <p className="whitespace-pre-wrap">{text}</p>
                    )}
                  </div>
                </div>
              );
            })}

            {isLoading && messages[messages.length - 1]?.role === "user" && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-lg px-3 py-2">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t p-3">
            <div className="flex gap-2">
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about synthesis direction, methodology, or search for papers..."
                rows={2}
                className="resize-none text-sm"
                disabled={isLoading}
              />
              <Button
                size="icon"
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className="shrink-0 self-end"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Proceed button */}
      <Button
        onClick={handleProceed}
        disabled={proceeding || isLoading || !guidanceComplete}
        className="w-full"
        size="lg"
      >
        {proceeding ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Play className="mr-2 h-4 w-4" />
        )}
        {proceeding ? "Resuming synthesis..." : "Continue Synthesis"}
      </Button>

      {!guidanceComplete && (
        <p className="text-xs text-center text-muted-foreground">
          Answer the consultant&apos;s questions to unlock the synthesis.
        </p>
      )}
    </div>
  );
}
