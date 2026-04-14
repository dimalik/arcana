"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { MessageCircle, X, Send, Loader2, Sparkles, Copy, BookmarkPlus, Download, Check, RefreshCw, Plus, Trash2, ChevronLeft, History, ArrowUp } from "lucide-react";
import { toast } from "sonner";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { extractArtifacts, ArtifactCard, parseStreamingSegments, StreamingArtifactCard } from "./chat-artifact";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ChatThread {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

const STARTERS = [
  "Summarize what worked and what didn't",
  "What are the key findings so far?",
  "How would I apply this to a new project?",
  "Which experiments should I reproduce?",
];

const STORE_KEY = (projectId: string) => `research-chats-${projectId}`;

function loadThreads(projectId: string): ChatThread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORE_KEY(projectId));
    const threads: ChatThread[] = raw ? JSON.parse(raw) : [];

    // Migrate old single-chat from sessionStorage
    const oldKey = `research-chat-${projectId}`;
    const oldRaw = sessionStorage.getItem(oldKey);
    if (oldRaw && threads.length === 0) {
      const oldMessages: Message[] = JSON.parse(oldRaw);
      if (oldMessages.length > 0) {
        threads.push({
          id: `t-migrated-${Date.now()}`,
          title: deriveTitle(oldMessages),
          messages: oldMessages,
          createdAt: Date.now(),
        });
        localStorage.setItem(STORE_KEY(projectId), JSON.stringify(threads));
        sessionStorage.removeItem(oldKey);
      }
    }

    return threads.filter((t) => t.messages.length > 0);
  } catch { return []; }
}

function saveThreads(projectId: string, threads: ChatThread[]) {
  localStorage.setItem(STORE_KEY(projectId), JSON.stringify(threads));
}

function deriveTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New chat";
  return first.content.slice(0, 40) + (first.content.length > 40 ? "..." : "");
}

// ── Main component ──────────────────────────────────────────────

export function ResearchChat({ projectId, projectTitle, externalOpen, onExternalClose, embedded, prefillMessage, onPrefillConsumed }: {
  projectId: string; projectTitle: string; externalOpen?: boolean; onExternalClose?: () => void; embedded?: boolean;
  prefillMessage?: string | null; onPrefillConsumed?: () => void;
}) {
  const [open, setOpen] = useState(false);

  // Sync with external open state
  useEffect(() => {
    if (externalOpen) setOpen(true);
  }, [externalOpen]);

  const handleClose = () => {
    setOpen(false);
    onExternalClose?.();
  };
  const [threads, setThreads] = useState<ChatThread[]>(() => loadThreads(projectId));
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => threads[0]?.id ?? null);
  const [showList, setShowList] = useState(false);

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;

  // Persist threads (skip empty ones)
  useEffect(() => {
    const nonEmpty = threads.filter((t) => t.messages.length > 0);
    saveThreads(projectId, nonEmpty);
  }, [projectId, threads]);

  const createThread = () => {
    const t: ChatThread = { id: `t-${Date.now()}`, title: "New chat", messages: [], createdAt: Date.now() };
    setThreads((prev) => [t, ...prev]);
    setActiveThreadId(t.id);
    setShowList(false);
  };

  const deleteThread = (id: string) => {
    setThreads((prev) => prev.filter((t) => t.id !== id));
    if (activeThreadId === id) {
      const remaining = threads.filter((t) => t.id !== id);
      setActiveThreadId(remaining[0]?.id ?? null);
    }
  };

  const updateThreadMessages = (threadId: string, messages: Message[]) => {
    setThreads((prev) => prev.map((t) =>
      t.id === threadId ? { ...t, messages, title: deriveTitle(messages) || t.title } : t
    ));
  };

  const handleOpen = () => {
    setOpen(true);
    if (threads.length === 0) createThread();
    else if (!activeThreadId) setActiveThreadId(threads[0].id);
  };

  // Auto-open and auto-create thread when embedded
  useEffect(() => {
    if (embedded) {
      setOpen(true);
      if (threads.length === 0) {
        const t: ChatThread = { id: `t-${Date.now()}`, title: "New chat", messages: [], createdAt: Date.now() };
        setThreads(prev => [t, ...prev]);
        setActiveThreadId(t.id);
      } else if (!activeThreadId) {
        setActiveThreadId(threads[0].id);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded]);

  // Embedded mode — uses the same ChatView with streaming, clean layout
  if (embedded && open) {
    return (
      <div className="flex flex-col h-full">
        {showList ? (
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30">
              <button onClick={() => setShowList(false)}
                className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/50 transition-colors">
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-[11px] font-medium text-muted-foreground/60">History</span>
              <div className="w-6" />
            </div>
            <div className="flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {threads.filter(t => t.messages.length > 0).map(t => (
                <button key={t.id} onClick={() => { setActiveThreadId(t.id); setShowList(false); }}
                  className={`w-full text-left px-4 py-2.5 border-b border-border/10 hover:bg-muted/50 transition-colors ${t.id === activeThreadId ? "bg-muted/30" : ""}`}>
                  <p className="text-xs truncate">{t.title}</p>
                  <p className="text-[11px] text-muted-foreground/40">{new Date(t.createdAt).toLocaleDateString()}</p>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Top bar: back to list + new conversation + history */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30 shrink-0">
              <button onClick={() => setShowList(true)}
                className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/50 transition-colors"
                title="Chat history">
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-[11px] text-muted-foreground/40 truncate px-2">
                {activeThread?.title !== "New chat" ? activeThread?.title : ""}
              </span>
              <div className="flex items-center gap-0.5">
                <button onClick={() => { createThread(); setShowList(false); }}
                  className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/50 transition-colors"
                  title="New conversation">
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => setShowList(true)}
                  className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/50 transition-colors"
                  title="Chat history">
                  <History className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            {activeThread ? (
              <div className="flex-1 min-h-0 flex flex-col [&>*:first-child]:flex-1 [&>*:first-child]:max-h-none [&>*:first-child]:min-h-0">
              <ChatView
                projectId={projectId}
                thread={activeThread}
                onUpdateMessages={(msgs) => updateThreadMessages(activeThread.id, msgs)}
                initialInput={prefillMessage}
                onInitialInputConsumed={onPrefillConsumed}
              />
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                No conversation selected
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {open && (
        <div className="fixed bottom-16 right-8 z-40 w-[400px] max-h-[70vh] flex flex-col rounded-xl border border-border/60 bg-background shadow-2xl animate-in slide-in-from-bottom-2 fade-in-0 duration-200">
          {/* Header */}
          <div className="relative px-4 py-2.5 border-b border-border/40">
            <div className="flex items-center gap-2">
              {!showList && threads.length > 1 && (
                <button
                  onClick={() => setShowList(true)}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
                  title="All chats"
                >
                  <ChevronLeft className="h-3 w-3" />
                </button>
              )}
              <div className="min-w-0 flex-1">
                <h3 className="text-xs font-medium truncate pr-6">
                  {showList ? "Chats" : (activeThread?.title || projectTitle)}
                </h3>
                {!showList && (
                  <p className="text-[10px] text-muted-foreground">Ask about methods, findings, and how to apply them</p>
                )}
              </div>
              <button
                onClick={createThread}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
                title="New chat"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
          </div>

          {showList ? (
            /* Thread list */
            <div className="flex-1 overflow-y-auto min-h-[200px] max-h-[calc(70vh-80px)] scrollbar-none" style={{ scrollbarWidth: "none" }}>
              {threads.length === 0 ? (
                <div className="p-4 text-center text-xs text-muted-foreground/40">No chats yet</div>
              ) : (
                <div className="py-1">
                  {threads.map((t) => (
                    <div
                      key={t.id}
                      className={`flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-muted/30 transition-colors group/thread ${t.id === activeThreadId ? "bg-muted/20" : ""}`}
                      onClick={() => { setActiveThreadId(t.id); setShowList(false); }}
                    >
                      <MessageCircle className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs truncate">{t.title}</p>
                        <p className="text-[10px] text-muted-foreground/40">{t.messages.length} messages</p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteThread(t.id); }}
                        className="h-5 w-5 inline-flex items-center justify-center rounded opacity-0 group-hover/thread:opacity-100 text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-all"
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeThread ? (
            <ChatView
              projectId={projectId}
              thread={activeThread}
              onUpdateMessages={(msgs) => updateThreadMessages(activeThread.id, msgs)}
            />
          ) : (
            <div className="p-4 text-center text-xs text-muted-foreground/40">
              Create a new chat to get started
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ── Chat view (single thread) ───────────────────────────────────

function ChatView({ projectId, thread, onUpdateMessages, initialInput, onInitialInputConsumed }: {
  projectId: string;
  thread: ChatThread;
  onUpdateMessages: (messages: Message[]) => void;
  initialInput?: string | null;
  onInitialInputConsumed?: () => void;
}) {
  const messages = thread.messages;
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Prefill input from notification "Open in Chat"
  useEffect(() => {
    if (initialInput) {
      setInput(initialInput);
      onInitialInputConsumed?.();
      // Focus the input
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInput]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 100); }, [thread.id]);
  useEffect(() => { scrollToBottom(); }, [messages, streamingContent, scrollToBottom]);

  const streamResponse = async (history: Message[]) => {
    setStreaming(true);
    setStreamingContent("");
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(`/api/research/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map((m) => ({ role: m.role, content: m.content })) }),
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

      const newMsgs = [...history, { id: `a-${Date.now()}`, role: "assistant" as const, content: accumulated }];
      onUpdateMessages(newMsgs);
      setStreamingContent("");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onUpdateMessages([...history, { id: `e-${Date.now()}`, role: "assistant", content: "Something went wrong. Try again." }]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const sendMessage = async (text: string) => {
    if (!text.trim() || streaming) return;
    const newMsgs = [...messages, { id: `u-${Date.now()}`, role: "user" as const, content: text.trim() }];
    onUpdateMessages(newMsgs);
    setInput("");
    await streamResponse(newMsgs);
  };

  const regenerate = async (msgId: string) => {
    if (streaming) return;
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const history = messages.slice(0, idx);
    onUpdateMessages(history);
    await streamResponse(history);
  };

  const editAndResend = async (msgId: string, newContent: string) => {
    if (streaming || !newContent.trim()) return;
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const history = [...messages.slice(0, idx), { ...messages[idx], content: newContent.trim() }];
    onUpdateMessages(history);
    await streamResponse(history);
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-[200px] max-h-[calc(70vh-130px)] scrollbar-none" style={{ scrollbarWidth: "none" }}>
        {messages.length === 0 && !streaming && (
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-2 text-muted-foreground/40">
              <Sparkles className="h-3.5 w-3.5" />
              <span className="text-[11px]">Try asking</span>
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              {STARTERS.map((s) => (
                <button key={s} onClick={() => sendMessage(s)} className="text-left text-xs text-muted-foreground/60 hover:text-foreground px-3 py-2 rounded-lg border border-border/30 hover:border-border/60 hover:bg-muted/30 transition-all">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={msg.role === "user" ? "flex justify-end" : "group/msg"}>
            {msg.role === "user" ? (
              <UserBubble content={msg.content} onEdit={(text) => editAndResend(msg.id, text)} disabled={streaming} />
            ) : (
              <div>
                {(() => {
                  const { prose, artifacts } = extractArtifacts(msg.content);
                  return (
                    <>
                      {artifacts.map((artifact, i) => (
                        <ArtifactCard key={`${msg.id}-artifact-${i}`} artifact={artifact} projectId={projectId} />
                      ))}
                      {prose && (
                        <div className="text-xs leading-relaxed prose prose-xs dark:prose-invert max-w-none [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_p]:text-xs [&_li]:text-xs [&_code]:text-[10px]">
                          <MarkdownRenderer content={prose} />
                        </div>
                      )}
                    </>
                  );
                })()}
                <MessageActions projectId={projectId} content={msg.content} onRegenerate={() => regenerate(msg.id)} />
              </div>
            )}
          </div>
        ))}

        {streaming && streamingContent && (() => {
          const segments = parseStreamingSegments(streamingContent);
          return (
            <div>
              {segments.map((seg, i) => {
                if (seg.type === "artifact") {
                  return <ArtifactCard key={`stream-a-${i}`} artifact={seg.artifact} projectId={projectId} />;
                }
                if (seg.type === "streaming_artifact") {
                  return <StreamingArtifactCard key={`stream-sa-${i}`} language={seg.language} code={seg.code} lineCount={seg.lineCount} />;
                }
                return (
                  <div key={`stream-p-${i}`} className="text-xs leading-relaxed prose prose-xs dark:prose-invert max-w-none [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_p]:text-xs [&_li]:text-xs [&_code]:text-[10px]">
                    <MarkdownRenderer content={seg.content} />
                    {i === segments.length - 1 && seg.type === "prose" && (
                      <span className="inline-block w-1.5 h-3 bg-foreground/60 animate-pulse ml-0.5" />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

        {streaming && !streamingContent && (
          <div className="flex items-center gap-2 text-muted-foreground/40">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="text-[10px]">Thinking...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="px-3 py-2.5 border-t border-border/40">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
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
    </>
  );
}

// ── Editable user message bubble ─────────────────────────────────

function UserBubble({ content, onEdit, disabled }: { content: string; onEdit: (text: string) => void; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const el = textareaRef.current;
      if (el) { el.focus(); el.selectionStart = el.value.length; }
    }
  }, [editing]);

  const submit = () => {
    if (draft.trim() && draft.trim() !== content) onEdit(draft);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="w-full space-y-1">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === "Escape") { setDraft(content); setEditing(false); } }}
          rows={Math.max(3, Math.min(draft.split("\n").length + 1, 10))}
          className="w-full rounded-xl border border-foreground/20 bg-foreground/5 px-3 py-2 text-xs leading-relaxed focus:outline-none focus:border-foreground/40 resize-y min-h-[80px]"
        />
        <div className="flex justify-end gap-1">
          <button onClick={() => { setDraft(content); setEditing(false); }} className="px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground rounded transition-colors">Cancel</button>
          <button onClick={submit} className="px-2 py-0.5 text-[10px] bg-foreground text-background rounded transition-colors">Send</button>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={() => !disabled && setEditing(true)}
      className={`max-w-[85%] px-3 py-2 rounded-xl bg-foreground text-background text-xs leading-relaxed ${disabled ? "" : "cursor-pointer hover:opacity-80"} transition-opacity`}
      title={disabled ? undefined : "Click to edit"}
    >
      {content}
    </div>
  );
}

// ── Message action buttons ──────────────────────────────────────

function MessageActions({ projectId, content, onRegenerate }: { projectId: string; content: string; onRegenerate?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveToLog = async () => {
    try {
      const res = await fetch(`/api/research/${projectId}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "decision", content: content.slice(0, 2000) }),
      });
      if (res.ok) {
        setSaved(true);
        toast.success("Saved to research log");
        setTimeout(() => setSaved(false), 3000);
      } else {
        toast.error("Failed to save");
      }
    } catch {
      toast.error("Failed to save");
    }
  };

  const handleExport = () => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `research-chat-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex items-center gap-0.5 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity">
      <button onClick={handleCopy} className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors" title="Copy">
        {copied ? <Check className="h-2.5 w-2.5 text-emerald-500" /> : <Copy className="h-2.5 w-2.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <button onClick={handleSaveToLog} className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors" title="Save to research log">
        {saved ? <Check className="h-2.5 w-2.5 text-emerald-500" /> : <BookmarkPlus className="h-2.5 w-2.5" />}
        {saved ? "Saved" : "Save to log"}
      </button>
      <button onClick={handleExport} className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors" title="Export as markdown">
        <Download className="h-2.5 w-2.5" />
        Export
      </button>
      <button onClick={onRegenerate} className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors" title="Regenerate response">
        <RefreshCw className="h-2.5 w-2.5" />
        Redo
      </button>
    </div>
  );
}
