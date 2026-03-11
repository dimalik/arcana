"use client";

import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import {
  Bot, Square, Send, Loader2, Wrench, CheckCircle,
  AlertCircle, ChevronDown, ChevronUp, Terminal,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────

interface AgentEvent {
  type: "text" | "tool_call" | "tool_result" | "tool_progress" | "tool_output" | "step_done" | "thinking" | "error" | "done" | "heartbeat";
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
  progress?: string;
  outputLines?: string[];
}

const EXECUTION_TOOLS = new Set(["execute_command", "execute_remote"]);

const TOOL_LABELS: Record<string, string> = {
  search_papers: "Searching papers",
  read_paper: "Reading paper",
  write_file: "Writing file",
  read_file: "Reading file",
  list_files: "Listing files",
  execute_command: "Running command",
  execute_remote: "Running on remote",
  log_finding: "Recording finding",
  update_hypothesis: "Updating hypothesis",
  search_library: "Searching library",
  query_insights: "Querying Mind Palace",
  web_search: "Searching the web",
  fetch_webpage: "Reading webpage",
  view_figures: "Viewing paper figures",
};

// ── Public handle for parent component ───────────────────

export interface AgentActivityHandle {
  start: (message?: string) => void;
  stop: () => void;
  isRunning: boolean;
}

interface AgentActivityBarProps {
  projectId: string;
  onRefresh: () => void;
  autoStart?: boolean;
}

// ── Component ────────────────────────────────────────────

export const AgentActivityBar = forwardRef<AgentActivityHandle, AgentActivityBarProps>(
  function AgentActivityBar({ projectId, onRefresh, autoStart }, ref) {
    const [running, setRunning] = useState(false);
    const [feed, setFeed] = useState<FeedItem[]>([]);
    const [currentText, setCurrentText] = useState("");
    const [thinkingMsg, setThinkingMsg] = useState<string | null>(null);
    const [userInput, setUserInput] = useState("");
    const [elapsed, setElapsed] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [statusLine, setStatusLine] = useState<string>("Agent idle");
    const feedEndRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const itemCounter = useRef(0);
    const startTimeRef = useRef<number>(0);
    const autoStarted = useRef(false);
    const runningRef = useRef(false);
    const lastHeardRef = useRef<number>(Date.now());
    const [connectionStale, setConnectionStale] = useState(false);

    // Keep ref in sync
    runningRef.current = running;

    const scrollToBottom = useCallback(() => {
      feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, []);

    useEffect(() => {
      if (expanded) scrollToBottom();
    }, [feed, currentText, thinkingMsg, expanded, scrollToBottom]);

    // Elapsed ticker + stale connection detection
    useEffect(() => {
      if (!running) {
        setConnectionStale(false);
        return;
      }
      const interval = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
        // If no data received for 30s, mark connection as stale
        const silenceMs = Date.now() - lastHeardRef.current;
        setConnectionStale(silenceMs > 30_000);
      }, 1000);
      return () => clearInterval(interval);
    }, [running]);

    const startAgent = useCallback(async (message?: string) => {
      if (runningRef.current) return;
      setRunning(true);
      setCurrentText("");
      setThinkingMsg(null);
      setStatusLine("Starting agent...");
      startTimeRef.current = Date.now();
      lastHeardRef.current = Date.now();
      setConnectionStale(false);

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
          setStatusLine("Agent failed to start");
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let textAccumulator = "";
        let lastRefresh = 0;

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

              // Track connection liveness on every event
              lastHeardRef.current = Date.now();

              switch (event.type) {
                case "heartbeat":
                  // Just keeps the connection alive — no UI update needed
                  break;

                case "text":
                  setThinkingMsg(null);
                  textAccumulator += event.content || "";
                  setCurrentText(textAccumulator);
                  // Update status with first ~80 chars
                  setStatusLine(textAccumulator.slice(0, 80).replace(/\n/g, " ") + (textAccumulator.length > 80 ? "..." : ""));
                  break;

                case "tool_call": {
                  setThinkingMsg(null);
                  const label = TOOL_LABELS[event.toolName || ""] || event.toolName || "Tool";
                  setStatusLine(label + "...");
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
                    content: label,
                    args: typeof event.args === "string" ? event.args : JSON.stringify(event.args, null, 2),
                  }]);
                  break;
                }

                case "tool_progress": {
                  setFeed((f) => {
                    const idx = [...f].reverse().findIndex((item) => item.type === "tool_call");
                    if (idx === -1) return f;
                    const realIdx = f.length - 1 - idx;
                    const updated = [...f];
                    updated[realIdx] = { ...updated[realIdx], progress: event.content || "" };
                    return updated;
                  });
                  setStatusLine(event.content || "Working...");
                  break;
                }

                case "tool_output": {
                  setFeed((f) => {
                    const idx = [...f].reverse().findIndex(
                      (item) => item.type === "tool_call" && EXECUTION_TOOLS.has(item.toolName || "")
                    );
                    if (idx === -1) return f;
                    const realIdx = f.length - 1 - idx;
                    const updated = [...f];
                    const prev = updated[realIdx];
                    const prevLines = prev.outputLines || [];
                    const newLines = [...prevLines, event.content || ""];
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
                  // Refresh project data periodically after tool results
                  const now = Date.now();
                  if (now - lastRefresh > 5000) {
                    lastRefresh = now;
                    onRefresh();
                  }
                  break;
                }

                case "step_done":
                  if (textAccumulator.trim()) {
                    setFeed((f) => [...f, {
                      id: `text-${++itemCounter.current}`,
                      type: "text",
                      content: textAccumulator.trim(),
                    }]);
                    textAccumulator = "";
                    setCurrentText("");
                  }
                  // Refresh project data after each agent step
                  onRefresh();
                  break;

                case "thinking":
                  setThinkingMsg(event.content || "Thinking...");
                  setStatusLine(event.content || "Thinking...");
                  break;

                case "error":
                  setThinkingMsg(null);
                  setStatusLine("Error: " + (event.content || "Unknown"));
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
                  setStatusLine("Agent finished");
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
          setStatusLine("Connection lost");
        }
      } finally {
        setRunning(false);
        setThinkingMsg(null);
        abortRef.current = null;
        onRefresh();
      }
    }, [projectId, onRefresh]);

    const stopAgent = useCallback(() => {
      abortRef.current?.abort();
      setRunning(false);
      setThinkingMsg(null);
      setStatusLine("Agent stopped");
    }, []);

    // Expose handle to parent
    useImperativeHandle(ref, () => ({
      start: startAgent,
      stop: stopAgent,
      get isRunning() { return runningRef.current; },
    }), [startAgent, stopAgent]);

    // Hydrate feed from existing project log + steps on mount
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const res = await fetch(`/api/research/${projectId}`);
          if (!res.ok || cancelled) return;
          const project = await res.json();

          const items: FeedItem[] = [];
          let counter = 0;

          // Build feed from completed steps (most useful signal)
          const allSteps: { type: string; title: string; status: string; output: string | null; completedAt: string | null; sortOrder: number }[] = [];
          for (const iter of project.iterations || []) {
            for (const step of iter.steps || []) {
              allSteps.push(step);
            }
          }
          allSteps.sort((a, b) => a.sortOrder - b.sortOrder);

          for (const step of allSteps) {
            const label = TOOL_LABELS[step.type] || step.type;
            items.push({
              id: `hist-step-${++counter}`,
              type: step.status === "COMPLETED" ? "tool_result" : step.status === "FAILED" ? "error" : "tool_call",
              toolName: step.type,
              content: step.status === "FAILED" ? `Failed: ${step.title}` : `${label}: ${step.title}`,
              args: step.output ? step.output.slice(0, 500) : undefined,
            });
          }

          // Add recent log findings (observations, breakthroughs, decisions) not already covered by steps
          const logEntries = (project.log || [])
            .filter((l: { type: string }) => ["observation", "breakthrough", "dead_end", "decision"].includes(l.type))
            .reverse() // oldest first
            .slice(-10);

          for (const entry of logEntries) {
            // Skip entries that are just tool call logs
            if (entry.content.startsWith("[")) continue;
            const prefix = entry.type === "breakthrough" ? "Breakthrough" : entry.type === "dead_end" ? "Dead end" : "";
            items.push({
              id: `hist-log-${++counter}`,
              type: "text",
              content: prefix ? `**${prefix}:** ${entry.content}` : entry.content,
            });
          }

          if (cancelled) return;

          if (items.length > 0) {
            itemCounter.current = counter;
            setFeed(items);
            const lastStep = allSteps[allSteps.length - 1];
            const hasRunning = allSteps.some((s) => s.status === "RUNNING");
            if (hasRunning) {
              setStatusLine("Agent is working...");
            } else if (lastStep) {
              setStatusLine(`Last: ${lastStep.title.slice(0, 80)}`);
            }
          }
        } catch {
          // Non-critical — just show empty state
        }
      })();

      return () => { cancelled = true; };
    }, [projectId]);

    // Auto-start once on mount
    useEffect(() => {
      if (autoStart && !autoStarted.current) {
        autoStarted.current = true;
        startAgent();
      }
    }, [autoStart, startAgent]);

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

    const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

    // Get the latest execution tool for a quick terminal preview
    const latestExecTool = [...feed].reverse().find(
      (item) => EXECUTION_TOOLS.has(item.toolName || "") && (item.outputLines?.length || 0) > 0
    );
    const lastOutputLine = latestExecTool?.outputLines?.slice(-1)[0];

    return (
      <div className="rounded-md border border-border bg-card overflow-hidden">
        {/* Compact status bar — always visible */}
        <div
          className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {running && connectionStale ? (
            <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          ) : running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500 shrink-0" />
          ) : feed.some((f) => f.type === "done") ? (
            <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
          ) : (
            <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}

          <span className={`text-xs flex-1 truncate ${connectionStale && running ? "text-amber-500" : "text-muted-foreground"}`}>
            {connectionStale && running ? "Waiting for agent response..." : statusLine}
          </span>

          {/* Quick terminal preview when collapsed */}
          {!expanded && running && lastOutputLine && (
            <span className="text-[9px] font-mono text-muted-foreground/50 truncate max-w-[200px]">
              {lastOutputLine}
            </span>
          )}

          {running && connectionStale && (
            <span className="text-[10px] text-amber-500/70 tabular-nums shrink-0">
              no data {Math.floor((Date.now() - lastHeardRef.current) / 1000)}s
            </span>
          )}

          {running && elapsed > 0 && (
            <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">
              {elapsedStr}
            </span>
          )}

          {running && (
            <button
              onClick={(e) => { e.stopPropagation(); stopAgent(); }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
            >
              <Square className="h-2.5 w-2.5" />
              Stop
            </button>
          )}

          {expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
        </div>

        {/* Expanded detail feed */}
        {expanded && (
          <>
            <div className="border-t border-border max-h-80 overflow-auto space-y-1.5 p-2">
              {feed.length === 0 && !running && (
                <p className="text-[11px] text-muted-foreground text-center py-4">
                  No agent activity yet.
                </p>
              )}

              {feed.map((item) => (
                <CompactFeedItem key={item.id} item={item} />
              ))}

              {/* Streaming text */}
              {currentText && (
                <div className="flex gap-2">
                  <Bot className="h-3 w-3 mt-0.5 text-blue-500 shrink-0" />
                  <div className="text-[11px] text-foreground/90 whitespace-pre-wrap leading-relaxed">
                    {currentText.slice(-300)}
                    <span className="inline-block w-1 h-3 bg-blue-500/50 animate-pulse ml-0.5" />
                  </div>
                </div>
              )}

              {running && !currentText && thinkingMsg && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                  {thinkingMsg}
                </div>
              )}

              <div ref={feedEndRef} />
            </div>

            {/* Input bar */}
            <div className="border-t border-border px-2 py-1.5 flex items-center gap-2">
              {!running ? (
                <>
                  <input
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        userInput.trim() ? handleSend() : startAgent();
                      }
                    }}
                    placeholder="Guide the agent or press Enter to restart..."
                    className="flex-1 rounded border border-input bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button
                    onClick={() => userInput.trim() ? handleSend() : startAgent()}
                    className="inline-flex h-6 w-6 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    <Send className="h-3 w-3" />
                  </button>
                </>
              ) : (
                <span className="flex-1 text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Agent is working... {elapsed > 0 && <span className="text-[10px] tabular-nums">{elapsedStr}</span>}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    );
  }
);

// ── Compact feed item renderer ──────────────────────────

function CompactFeedItem({ item }: { item: FeedItem }) {
  const [showDetail, setShowDetail] = useState(false);

  if (item.type === "text") {
    return (
      <div className="flex gap-1.5">
        <Bot className="h-3 w-3 mt-0.5 text-blue-500 shrink-0" />
        <p className="text-[11px] text-foreground/90 whitespace-pre-wrap leading-relaxed line-clamp-3">
          {item.content}
        </p>
      </div>
    );
  }

  if (item.type === "tool_call" || item.type === "tool_result") {
    const isDone = item.type === "tool_result";
    const isExec = EXECUTION_TOOLS.has(item.toolName || "");
    const hasOutput = (item.outputLines?.length || 0) > 0;

    return (
      <div className={`rounded border ${isDone ? "border-emerald-500/20 bg-emerald-500/5" : "border-blue-500/20 bg-blue-500/5"} px-2 py-1`}>
        <button
          onClick={() => setShowDetail(!showDetail)}
          className="flex items-center gap-1.5 w-full text-left"
        >
          {isDone
            ? <CheckCircle className="h-2.5 w-2.5 text-emerald-500 shrink-0" />
            : <Loader2 className="h-2.5 w-2.5 text-blue-500 animate-spin shrink-0" />
          }
          {isExec
            ? <Terminal className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
            : <Wrench className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
          }
          <span className="text-[10px] font-medium flex-1 truncate">{item.content}</span>
          {hasOutput && (
            <span className="text-[9px] text-muted-foreground/60 tabular-nums">{item.outputLines!.length}L</span>
          )}
          {!isDone && item.progress && !showDetail && (
            <span className="text-[9px] text-blue-400 truncate max-w-[150px]">{item.progress}</span>
          )}
        </button>

        {/* Terminal for execution tools */}
        {showDetail && isExec && hasOutput && (
          <TerminalOutput lines={item.outputLines!} isRunning={!isDone} progress={item.progress} />
        )}

        {/* Args/result for non-execution tools */}
        {showDetail && !isExec && item.args && (
          <pre className="mt-1 text-[9px] text-muted-foreground bg-background/50 rounded p-1.5 max-h-40 overflow-auto whitespace-pre-wrap">
            {item.args}
          </pre>
        )}

        {/* Auto-show terminal while running */}
        {!showDetail && !isDone && isExec && hasOutput && (
          <TerminalOutput lines={item.outputLines!} isRunning={true} progress={item.progress} />
        )}
      </div>
    );
  }

  if (item.type === "error") {
    return (
      <div className="flex items-center gap-1.5 rounded border border-destructive/20 bg-destructive/5 px-2 py-1">
        <AlertCircle className="h-2.5 w-2.5 text-destructive shrink-0" />
        <span className="text-[10px] text-destructive truncate">{item.content}</span>
      </div>
    );
  }

  if (item.type === "done") {
    return (
      <div className="flex items-center gap-1.5 py-0.5 text-[10px] text-emerald-500">
        <CheckCircle className="h-2.5 w-2.5" />
        {item.content}
      </div>
    );
  }

  return null;
}

// ── Terminal output renderer ────────────────────────────

function TerminalOutput({ lines, isRunning, progress }: { lines: string[]; isRunning: boolean; progress?: string }) {
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [lines.length]);

  return (
    <div className="mt-1 rounded bg-[#0d1117] border border-[#30363d] overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#161b22] border-b border-[#30363d]">
        <Terminal className="h-2 w-2 text-[#7d8590]" />
        <span className="text-[8px] text-[#7d8590] flex-1 font-mono">
          {progress || (isRunning ? "Running..." : `${lines.length} lines`)}
        </span>
        {isRunning && <span className="inline-block w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />}
      </div>
      <div
        ref={termRef}
        className="p-1.5 max-h-48 overflow-auto font-mono text-[9px] leading-[1.5] text-[#e6edf3] selection:bg-blue-500/30"
      >
        {lines.length === 0 && isRunning && (
          <span className="text-[#7d8590]">Waiting for output...</span>
        )}
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            <span className="select-none text-[#7d8590] mr-1.5 inline-block w-4 text-right text-[7px]">{i + 1}</span>
            {line}
          </div>
        ))}
        {isRunning && <span className="inline-block w-1 h-2.5 bg-[#e6edf3]/50 animate-pulse" />}
      </div>
    </div>
  );
}
