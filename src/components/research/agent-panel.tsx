"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Play, Square, Send, Loader2, Bot, Wrench, CheckCircle,
  AlertCircle, ChevronDown, ChevronRight, Terminal,
} from "lucide-react";

interface AgentEvent {
  type: "text" | "tool_call" | "tool_result" | "tool_progress" | "tool_output" | "step_done" | "thinking" | "error" | "done";
  content?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  stepNumber?: number;
}

interface FeedItem {
  id: string;
  type: "text" | "tool_call" | "tool_result" | "error" | "done";
  toolName?: string;
  toolCallId?: string;
  content: string;
  args?: string;
  collapsed?: boolean;
  progress?: string;
  /** Streaming terminal output lines for execute_command / execute_remote */
  outputLines?: string[];
}

const EXECUTION_TOOLS = new Set(["execute_command", "execute_remote"]);

interface AgentPanelProps {
  projectId: string;
  onRefresh: () => void;
}

const TOOL_LABELS: Record<string, string> = {
  search_papers: "Searching papers",
  read_paper: "Reading paper",
  write_file: "Writing file",
  read_file: "Reading file",
  list_files: "Listing files",
  execute_command: "Running command",
  execute_remote: "Running on remote",
  log_finding: "Recording finding",
};

export function AgentPanel({ projectId, onRefresh }: AgentPanelProps) {
  const [running, setRunning] = useState(false);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [currentText, setCurrentText] = useState("");
  const [thinkingMsg, setThinkingMsg] = useState<string | null>(null);
  const [userInput, setUserInput] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const feedEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const itemCounter = useRef(0);
  const startTimeRef = useRef<number>(0);

  const scrollToBottom = useCallback(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [feed, currentText, thinkingMsg, scrollToBottom]);

  // Elapsed time ticker while running
  useEffect(() => {
    if (!running) { setElapsed(0); return; }
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [running]);

  const startAgent = async (message?: string) => {
    if (running) return;
    setRunning(true);
    setCurrentText("");
    setThinkingMsg(null);
    startTimeRef.current = Date.now();

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(`/api/research/${projectId}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        setFeed((f) => [...f, { id: `err-${++itemCounter.current}`, type: "error", content: "Failed to start agent" }]);
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let textAccumulator = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event: AgentEvent = JSON.parse(line.slice(6));

            switch (event.type) {
              case "text":
                setThinkingMsg(null); // Clear thinking as soon as text streams
                textAccumulator += event.content || "";
                setCurrentText(textAccumulator);
                break;

              case "tool_call": {
                setThinkingMsg(null);
                // Flush accumulated text
                if (textAccumulator.trim()) {
                  setFeed((f) => [...f, {
                    id: `text-${++itemCounter.current}`,
                    type: "text",
                    content: textAccumulator.trim(),
                  }]);
                  textAccumulator = "";
                  setCurrentText("");
                }
                setFeed((f) => [...f, {
                  id: `tc-${event.toolCallId || ++itemCounter.current}`,
                  type: "tool_call",
                  toolName: event.toolName,
                  toolCallId: event.toolCallId,
                  content: TOOL_LABELS[event.toolName || ""] || event.toolName || "Tool",
                  args: typeof event.args === "string" ? event.args : JSON.stringify(event.args, null, 2),
                }]);
                break;
              }

              case "tool_progress": {
                // Update the progress text on the most recent tool_call card
                setFeed((f) => {
                  const idx = [...f].reverse().findIndex((item) => item.type === "tool_call");
                  if (idx === -1) return f;
                  const realIdx = f.length - 1 - idx;
                  const updated = [...f];
                  updated[realIdx] = { ...updated[realIdx], progress: event.content || "" };
                  return updated;
                });
                break;
              }

              case "tool_output": {
                // Append a terminal output line to the most recent execution tool_call card
                setFeed((f) => {
                  const idx = [...f].reverse().findIndex(
                    (item) => item.type === "tool_call" && EXECUTION_TOOLS.has(item.toolName || "")
                  );
                  if (idx === -1) return f;
                  const realIdx = f.length - 1 - idx;
                  const updated = [...f];
                  const prev = updated[realIdx];
                  const lines = prev.outputLines || [];
                  // Keep last 200 lines in memory
                  const newLines = [...lines, event.content || ""];
                  updated[realIdx] = {
                    ...prev,
                    outputLines: newLines.length > 200 ? newLines.slice(-200) : newLines,
                  };
                  return updated;
                });
                break;
              }

              case "tool_result": {
                const resultStr = typeof event.result === "string"
                  ? event.result
                  : JSON.stringify(event.result, null, 2);
                setFeed((f) => f.map((item) =>
                  item.toolCallId === event.toolCallId
                    ? { ...item, type: "tool_result" as const, progress: undefined, args: item.args + "\n\n--- Result ---\n" + resultStr }
                    : item
                ));
                break;
              }

              case "step_done":
                // Flush text if any
                if (textAccumulator.trim()) {
                  setFeed((f) => [...f, {
                    id: `text-${++itemCounter.current}`,
                    type: "text",
                    content: textAccumulator.trim(),
                  }]);
                  textAccumulator = "";
                  setCurrentText("");
                }
                break;

              case "thinking":
                setThinkingMsg(event.content || "Thinking...");
                break;

              case "error":
                setThinkingMsg(null);
                setFeed((f) => [...f, {
                  id: `err-${++itemCounter.current}`,
                  type: "error",
                  content: event.content || "Unknown error",
                }]);
                break;

              case "done":
                setThinkingMsg(null);
                if (textAccumulator.trim()) {
                  setFeed((f) => [...f, {
                    id: `text-${++itemCounter.current}`,
                    type: "text",
                    content: textAccumulator.trim(),
                  }]);
                  textAccumulator = "";
                  setCurrentText("");
                }
                setFeed((f) => [...f, {
                  id: `done-${++itemCounter.current}`,
                  type: "done",
                  content: "Agent finished.",
                }]);
                break;
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setFeed((f) => [...f, {
          id: `err-${++itemCounter.current}`,
          type: "error",
          content: (err as Error).message || "Connection lost",
        }]);
      }
    } finally {
      setRunning(false);
      setThinkingMsg(null);
      abortRef.current = null;
      onRefresh();
    }
  };

  const stopAgent = () => {
    abortRef.current?.abort();
    setRunning(false);
    setThinkingMsg(null);
  };

  const handleSend = () => {
    const msg = userInput.trim();
    if (!msg) return;
    setUserInput("");
    setFeed((f) => [...f, {
      id: `user-${++itemCounter.current}`,
      type: "text",
      content: `**You:** ${msg}`,
    }]);
    startAgent(msg);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Feed */}
      <div className="flex-1 overflow-auto space-y-2 p-2 min-h-0">
        {feed.length === 0 && !running && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <Bot className="h-8 w-8 opacity-30" />
            <p className="text-xs">Start the research agent to autonomously search papers, design experiments, and run them.</p>
            <button
              onClick={() => startAgent()}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-4 py-2 text-xs hover:bg-primary/90 transition-colors"
            >
              <Play className="h-3.5 w-3.5" />
              Start Research Agent
            </button>
          </div>
        )}

        {feed.map((item) => (
          <FeedItemCard key={item.id} item={item} />
        ))}

        {/* Streaming text */}
        {currentText && (
          <div className="flex gap-2">
            <Bot className="h-3.5 w-3.5 mt-1 text-blue-500 shrink-0" />
            <div className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed">
              {currentText}
              <span className="inline-block w-1.5 h-3.5 bg-blue-500/50 animate-pulse ml-0.5" />
            </div>
          </div>
        )}

        {running && !currentText && feed.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
            <span>{thinkingMsg || "Working..."}</span>
            {elapsed > 0 && (
              <span className="text-[10px] text-muted-foreground/50 ml-auto tabular-nums">
                {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
              </span>
            )}
          </div>
        )}

        <div ref={feedEndRef} />
      </div>

      {/* Input bar */}
      <div className="border-t border-border p-2 flex items-center gap-2">
        {!running ? (
          <>
            <input
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder={feed.length === 0 ? "Start researching... (or just hit Enter)" : "Guide the agent..."}
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              onClick={() => userInput.trim() ? handleSend() : startAgent()}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              {userInput.trim() ? <Send className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
          </>
        ) : (
          <>
            <span className="flex-1 text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="truncate">{thinkingMsg || "Agent is working..."}</span>
              {elapsed > 0 && (
                <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">
                  {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
                </span>
              )}
            </span>
            <button
              onClick={stopAgent}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Square className="h-3 w-3" />
              Stop
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Feed item renderer ───────────────────────────────────────────

function FeedItemCard({ item }: { item: FeedItem }) {
  const [expanded, setExpanded] = useState(false);

  if (item.type === "text") {
    return (
      <div className="flex gap-2">
        <Bot className="h-3.5 w-3.5 mt-1 text-blue-500 shrink-0" />
        <div className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed prose prose-xs dark:prose-invert max-w-none">
          {item.content}
        </div>
      </div>
    );
  }

  if (item.type === "tool_call" || item.type === "tool_result") {
    const isDone = item.type === "tool_result";
    const isExec = EXECUTION_TOOLS.has(item.toolName || "");
    const hasOutput = (item.outputLines?.length || 0) > 0;
    // Auto-expand execution tools while running
    const showTerminal = isExec && (expanded || (!isDone && hasOutput));

    return (
      <div className={`rounded-md border ${isDone ? "border-emerald-500/20 bg-emerald-500/5" : "border-blue-500/20 bg-blue-500/5"} p-2`}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 w-full text-left"
        >
          {isDone
            ? <CheckCircle className="h-3 w-3 text-emerald-500 shrink-0" />
            : <Loader2 className="h-3 w-3 text-blue-500 animate-spin shrink-0" />
          }
          {isExec
            ? <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
            : <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
          }
          <span className="text-[11px] font-medium flex-1">{item.content}</span>
          {hasOutput && (
            <span className="text-[9px] text-muted-foreground/60 tabular-nums mr-1">{item.outputLines!.length} lines</span>
          )}
          {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        </button>
        {/* Live progress indicator while tool is running */}
        {!isDone && item.progress && !showTerminal && (
          <div className="mt-1 ml-5 text-[10px] text-blue-400 flex items-center gap-1.5 animate-in fade-in">
            <span className="inline-block w-1 h-1 rounded-full bg-blue-400 animate-pulse" />
            {item.progress}
          </div>
        )}
        {/* Terminal output for execution tools */}
        {showTerminal && (
          <TerminalOutput lines={item.outputLines || []} isRunning={!isDone} progress={item.progress} />
        )}
        {/* Args/result for non-execution tools */}
        {expanded && !isExec && item.args && (
          <pre className="mt-1.5 text-[10px] text-muted-foreground bg-background/50 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap">
            {item.args}
          </pre>
        )}
      </div>
    );
  }

  if (item.type === "error") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 p-2">
        <AlertCircle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
        <span className="text-xs text-destructive">{item.content}</span>
      </div>
    );
  }

  if (item.type === "done") {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-emerald-500">
        <CheckCircle className="h-3.5 w-3.5" />
        {item.content}
      </div>
    );
  }

  return null;
}

// ── Terminal output renderer ────────────────────────────────────

function TerminalOutput({ lines, isRunning, progress }: { lines: string[]; isRunning: boolean; progress?: string }) {
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [lines.length]);

  return (
    <div className="mt-1.5 rounded bg-[#0d1117] border border-[#30363d] overflow-hidden">
      {/* Terminal header bar */}
      <div className="flex items-center gap-1.5 px-2 py-1 bg-[#161b22] border-b border-[#30363d]">
        <Terminal className="h-2.5 w-2.5 text-[#7d8590]" />
        <span className="text-[9px] text-[#7d8590] flex-1 font-mono">
          {progress || (isRunning ? "Running..." : `Done — ${lines.length} lines`)}
        </span>
        {isRunning && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        )}
      </div>
      {/* Terminal body */}
      <div
        ref={termRef}
        className="p-2 max-h-64 overflow-auto font-mono text-[10px] leading-[1.6] text-[#e6edf3] selection:bg-blue-500/30"
      >
        {lines.length === 0 && isRunning && (
          <span className="text-[#7d8590]">Waiting for output...</span>
        )}
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            <span className="select-none text-[#7d8590] mr-2 inline-block w-5 text-right text-[8px]">{i + 1}</span>
            {line}
          </div>
        ))}
        {isRunning && (
          <span className="inline-block w-1.5 h-3 bg-[#e6edf3]/50 animate-pulse" />
        )}
      </div>
    </div>
  );
}
