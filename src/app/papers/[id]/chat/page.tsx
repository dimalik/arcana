"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport } from "ai";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ModelSelector } from "@/components/llm/model-selector";
import { ArrowLeft, Send, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

interface PaperInfo {
  id: string;
  title: string;
  fullText: string | null;
  abstract: string | null;
}

export default function ChatPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [paper, setPaper] = useState<PaperInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<"openai" | "anthropic" | "proxy">("openai");
  const [modelId, setModelId] = useState("gpt-4o-mini");
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: `/api/papers/${id}/llm/chat`,
        body: { provider, modelId },
      }),
    [id, provider, modelId]
  );

  const { messages, sendMessage, status, setMessages } = useChat({
    transport,
  });

  const isLoading = status === "submitted" || status === "streaming";

  useEffect(() => {
    const fetchPaper = async () => {
      const res = await fetch(`/api/papers/${id}`);
      if (!res.ok) {
        router.push("/papers");
        return;
      }
      const data = await res.json();
      setPaper(data);
      setLoading(false);
    };

    const fetchHistory = async () => {
      const res = await fetch(`/api/papers/${id}/llm/chat`);
      const history = await res.json();
      if (history.length > 0) {
        setMessages(
          history.map((m: { id: string; role: string; content: string }) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            parts: [{ type: "text" as const, text: m.content }],
          }))
        );
      }
    };

    fetchPaper();
    fetchHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const clearHistory = () => {
    setMessages([]);
    toast.success("Chat cleared");
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const text = input;
    setInput("");
    await sendMessage({ text });
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!paper) return null;
  const hasText = !!(paper.fullText || paper.abstract);

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="text-lg font-semibold">Chat: {paper.title}</h2>
            <p className="text-sm text-muted-foreground">
              Ask questions about this paper
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ModelSelector
            provider={provider}
            modelId={modelId}
            onProviderChange={setProvider}
            onModelChange={setModelId}
          />
          <Button variant="ghost" size="icon" onClick={clearHistory}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Card className="flex flex-1 flex-col overflow-hidden">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Conversation</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col overflow-hidden p-0">
          {!hasText ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-muted-foreground">
                No text available for this paper.
              </p>
            </div>
          ) : (
            <>
              <ScrollArea className="flex-1 px-4" ref={scrollRef}>
                <div className="space-y-4 py-4">
                  {messages.length === 0 && (
                    <p className="text-center text-sm text-muted-foreground">
                      Start a conversation about this paper. Ask questions,
                      request explanations, or discuss specific sections.
                    </p>
                  )}
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex ${
                        message.role === "user"
                          ? "justify-end"
                          : "justify-start"
                      }`}
                    >
                      <div
                        className={`max-w-[80%] rounded-lg px-4 py-2 ${
                          message.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted"
                        }`}
                      >
                        {message.role === "assistant" ? (
                          <MarkdownRenderer
                            content={
                              message.parts
                                ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
                                .map((p) => p.text)
                                .join("") || ""
                            }
                            className="text-sm"
                          />
                        ) : (
                          <p className="text-sm whitespace-pre-wrap">
                            {message.parts
                              ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
                              .map((p) => p.text)
                              .join("") || ""}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                  {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
                    <div className="flex justify-start">
                      <div className="rounded-lg bg-muted px-4 py-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>

              <div className="border-t p-4">
                <div className="flex gap-2">
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask about this paper..."
                    rows={1}
                    className="min-h-[40px] resize-none"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                  />
                  <Button
                    onClick={handleSend}
                    disabled={isLoading || !input.trim()}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
