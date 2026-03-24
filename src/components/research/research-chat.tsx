"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { MessageCircle, X, Send, Loader2, Sparkles, ArrowDown } from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const STARTERS = [
  "Summarize what worked and what didn't",
  "What are the key findings so far?",
  "How would I apply this to a new project?",
  "Which experiments should I reproduce?",
];

export function ResearchChat({ projectId, projectTitle }: { projectId: string; projectTitle: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
      scrollToBottom();
    }
  }, [open, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, scrollToBottom]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || streaming) return;

    const userMsg: Message = { id: `u-${Date.now()}`, role: "user", content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setStreaming(true);
    setStreamingContent("");

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(`/api/research/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) throw new Error("Chat failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        setStreamingContent(accumulated);
      }

      const assistantMsg: Message = { id: `a-${Date.now()}`, role: "assistant", content: accumulated };
      setMessages((prev) => [...prev, assistantMsg]);
      setStreamingContent("");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => [...prev, { id: `e-${Date.now()}`, role: "assistant", content: "Sorry, something went wrong. Try again." }]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <>
      {/* Floating button — hidden when panel is open */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-16 right-8 z-40 inline-flex items-center gap-1.5 rounded-full bg-foreground/90 text-background pl-3 pr-3.5 py-1.5 text-[11px] font-medium shadow-lg hover:bg-foreground hover:shadow-xl transition-all duration-200 backdrop-blur-sm"
          title="Chat about this research"
        >
          <MessageCircle className="h-3 w-3" />
          Ask
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-16 right-8 z-40 w-[400px] max-h-[70vh] flex flex-col rounded-xl border border-border/60 bg-background shadow-2xl animate-in slide-in-from-bottom-2 fade-in-0 duration-200">
          {/* Header */}
          <div className="relative px-4 py-3 border-b border-border/40">
            <button
              onClick={() => setOpen(false)}
              className="absolute -top-2 -right-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted border border-border/60 text-muted-foreground/60 hover:text-foreground hover:bg-accent shadow-sm transition-colors z-10"
            >
              <X className="h-3 w-3" />
            </button>
            <h3 className="text-xs font-medium truncate pr-4">{projectTitle}</h3>
            <p className="text-[10px] text-muted-foreground">Ask about methods, findings, and how to apply them</p>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-[200px] max-h-[calc(70vh-130px)] scrollbar-none" style={{ scrollbarWidth: "none" }}>
            {messages.length === 0 && !streaming && (
              <div className="space-y-3 py-4">
                <div className="flex items-center gap-2 text-muted-foreground/40">
                  <Sparkles className="h-3.5 w-3.5" />
                  <span className="text-[11px]">Try asking</span>
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      onClick={() => sendMessage(s)}
                      className="text-left text-xs text-muted-foreground/60 hover:text-foreground px-3 py-2 rounded-lg border border-border/30 hover:border-border/60 hover:bg-muted/30 transition-all"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <div key={msg.id} className={msg.role === "user" ? "flex justify-end" : ""}>
                {msg.role === "user" ? (
                  <div className="max-w-[85%] px-3 py-2 rounded-xl bg-foreground text-background text-xs leading-relaxed">
                    {msg.content}
                  </div>
                ) : (
                  <div className="text-xs leading-relaxed prose prose-xs dark:prose-invert max-w-none [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_p]:text-xs [&_li]:text-xs [&_code]:text-[10px]">
                    <MarkdownRenderer content={msg.content} />
                  </div>
                )}
              </div>
            ))}

            {streaming && streamingContent && (
              <div className="text-xs leading-relaxed prose prose-xs dark:prose-invert max-w-none [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_p]:text-xs [&_li]:text-xs [&_code]:text-[10px]">
                <MarkdownRenderer content={streamingContent} />
                <span className="inline-block w-1.5 h-3 bg-foreground/60 animate-pulse ml-0.5" />
              </div>
            )}

            {streaming && !streamingContent && (
              <div className="flex items-center gap-2 text-muted-foreground/40">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="text-[10px]">Thinking...</span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-2.5 border-t border-border/40">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about this research..."
                rows={1}
                className="flex-1 resize-none rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-xs placeholder:text-muted-foreground/30 focus:outline-none focus:border-foreground/20 transition-all"
                disabled={streaming}
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={streaming || !input.trim()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-background hover:bg-foreground/90 transition-colors disabled:opacity-30 shrink-0"
              >
                {streaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
