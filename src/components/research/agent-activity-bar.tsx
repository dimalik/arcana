"use client";

import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import {
  Bot, Square, Send, Loader2, Wrench, CheckCircle,
  AlertCircle, ChevronDown, ChevronUp, Terminal,
  Play, CirclePause, FileText, Save, Maximize2, X, Pencil,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

type BottomTab = "console" | "notebook";

// ── Types ────────────────────────────────────────────────

interface AgentEvent {
  type: "text" | "tool_call" | "tool_result" | "tool_progress" | "tool_output" | "step_done" | "thinking" | "error" | "done" | "heartbeat";
  content?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  stepNumber?: number;
  activity?: {
    phase: "generating" | "tool_running" | "thinking" | "idle";
    tokens?: number;
    tool?: string;
    stepCount?: number;
    lastEventAgoMs?: number;
  };
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

interface RemoteJobInfo {
  id: string;
  status: string;
  command: string;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  host?: { alias: string; gpuType: string | null };
}

/** Extract the most useful error info from a failed remote job */
function extractJobError(job: RemoteJobInfo): string | null {
  const stderr = (job.stderr || "").trim();
  const stdout = (job.stdout || "").trim();

  // Look for Python tracebacks — most common error
  for (const source of [stderr, stdout]) {
    if (!source) continue;
    const lines = source.split("\n");
    const traceIdx = lines.findLastIndex((l) => l.includes("Traceback"));
    if (traceIdx >= 0) {
      return lines.slice(traceIdx).slice(-12).join("\n");
    }
    // Look for common error patterns
    const errorIdx = lines.findLastIndex((l) => /Error:|Exception:|FAILED|error:/i.test(l));
    if (errorIdx >= 0) {
      return lines.slice(Math.max(0, errorIdx - 2), errorIdx + 3).join("\n");
    }
  }

  // Fall back to last lines of stderr or stdout
  if (stderr) return stderr.split("\n").slice(-5).join("\n");
  if (stdout) return stdout.split("\n").slice(-5).join("\n");
  return null;
}

const EXECUTION_TOOLS = new Set(["execute_command", "execute_remote"]);

const TOOL_LABELS: Record<string, string> = {
  search_papers: "Searching papers",
  read_paper: "Reading paper",
  write_file: "Writing file",
  read_file: "Reading file",
  list_files: "Listing files",
  execute_command: "Running command",
  read_remote_file: "Reading remote file",
  execute_remote: "Running on remote",
  log_finding: "Recording finding",
  update_hypothesis: "Updating hypothesis",
  search_library: "Searching library",
  query_insights: "Querying Mind Palace",
  web_search: "Searching the web",
  fetch_webpage: "Reading webpage",
  view_figures: "Viewing paper figures",
  save_lesson: "Saving lesson",
  complete_iteration: "Advancing iteration",
};

// ── Public handle for parent component ───────────────────

export interface AgentActivityHandle {
  start: (message?: string) => void;
  stop: () => void;
  isRunning: boolean;
}

interface AgentActivityBarProps {
  projectId: string;
  projectStatus?: string;
  onRefresh: () => void;
  autoStart?: boolean;
}

// ── Component ────────────────────────────────────────────

export const AgentActivityBar = forwardRef<AgentActivityHandle, AgentActivityBarProps>(
  function AgentActivityBar({ projectId, projectStatus, onRefresh, autoStart }, ref) {
    const [running, setRunning] = useState(false);
    const [feed, setFeed] = useState<FeedItem[]>([]);
    const [currentText, setCurrentText] = useState("");
    const [thinkingMsg, setThinkingMsg] = useState<string | null>(null);
    const [userInput, setUserInput] = useState("");
    const [elapsed, setElapsed] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [statusLine, setStatusLine] = useState<string>("Ready");
    const [activeTab, setActiveTab] = useState<BottomTab>("console");
    const [fullscreen, setFullscreen] = useState(false);
    const feedEndRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const itemCounter = useRef(0);
    const startTimeRef = useRef<number>(0);
    const autoStarted = useRef(false);
    const runningRef = useRef(false);
    const lastHeardRef = useRef<number>(Date.now());
    const lastActivityRef = useRef<number>(Date.now());
    const tokenCountRef = useRef(0);
    const [connectionStale, setConnectionStale] = useState(false);
    const restartCountRef = useRef(0);
    const stoppedByUserRef = useRef(false);
    const projectStatusRef = useRef(projectStatus);
    projectStatusRef.current = projectStatus;

    // Active remote job tracking (independent of SSE)
    const [activeJob, setActiveJob] = useState<{
      id: string; status: string; host: string; gpu: string | null; command: string | null; stdout: string | null; updatedAt: string;
    } | null>(null);

    // Keep ref in sync
    runningRef.current = running;

    const scrollToBottom = useCallback(() => {
      feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, []);

    useEffect(() => {
      if (expanded) scrollToBottom();
    }, [feed, currentText, thinkingMsg, expanded, scrollToBottom]);

    // Poll remote jobs for this project — provides visibility even without SSE
    useEffect(() => {
      let cancelled = false;
      const poll = async () => {
        try {
          const res = await fetch(`/api/research/remote-jobs?projectId=${projectId}`);
          if (!res.ok || cancelled) return;
          const jobs = await res.json();
          if (!Array.isArray(jobs) || cancelled) return;

          const active = jobs.find((j: { status: string }) =>
            ["SYNCING", "QUEUED", "RUNNING"].includes(j.status)
          );

          if (active) {
            setActiveJob({
              id: active.id,
              status: active.status,
              host: active.host?.alias || "remote",
              gpu: active.host?.gpuType || null,
              command: active.command || null,
              stdout: active.stdout,
              updatedAt: active.updatedAt || active.createdAt,
            });
            // If we're not running the agent but a job is active, update status line
            if (!runningRef.current) {
              const lastLine = active.stdout?.split("\n").filter(Boolean).pop() || "";
              setStatusLine(`${active.host?.alias}: ${active.status.toLowerCase()}${lastLine ? ` — ${lastLine.slice(0, 60)}` : ""}`);
            }
          } else {
            setActiveJob((prev) => {
              if (prev) {
                // Job just completed — find it and update status
                const completed = jobs.find((j: { id: string }) => j.id === prev.id);
                if (completed && !runningRef.current) {
                  const label = completed.status === "COMPLETED" ? "completed" : completed.status.toLowerCase();
                  setStatusLine(`Last job ${label} on ${prev.host}`);
                }
              }
              return null;
            });
          }
        } catch {
          // Non-critical
        }
      };

      // Poll immediately, then every 5s
      poll();
      const interval = setInterval(poll, 5000);
      return () => { cancelled = true; clearInterval(interval); };
    }, [projectId]);

    // Elapsed ticker + stale connection detection
    useEffect(() => {
      if (!running) {
        setConnectionStale(false);
        return;
      }
      const interval = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
        // If no data received for 45s, mark connection as stale (LLM inference can take 30s+)
        const silenceMs = Date.now() - lastHeardRef.current;
        setConnectionStale(silenceMs > 45_000);
      }, 1000);
      return () => clearInterval(interval);
    }, [running]);

    const shouldAutoContinueRef = useRef(false);
    // Keep startAgent ref stable for auto-continue closures
    const startAgentRef = useRef<(message?: string) => void>(() => {});

    const startAgent = useCallback(async (message?: string) => {
      if (runningRef.current) return;
      stoppedByUserRef.current = false;
      setRunning(true);
      setCurrentText("");
      setThinkingMsg(null);
      setStatusLine("Starting agent...");
      startTimeRef.current = Date.now();
      lastHeardRef.current = Date.now();
      lastActivityRef.current = Date.now();
      tokenCountRef.current = 0;
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

        // Read with a timeout — if no data for 60s, the connection is dead
        const READ_TIMEOUT_MS = 60_000;
        const readWithTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              reader.cancel().catch(() => {});
              reject(new Error("Connection timed out — no data received for 60s"));
            }, READ_TIMEOUT_MS);
            reader.read().then(
              (result) => { clearTimeout(timer); resolve(result); },
              (err) => { clearTimeout(timer); reject(err); },
            );
          });
        };

        while (true) {
          const { done, value } = await readWithTimeout();
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
                case "heartbeat": {
                  // Connection is alive — use server-side activity metadata for status
                  const act = event.activity;
                  if (act) {
                    const agoSec = Math.round((act.lastEventAgoMs || 0) / 1000);
                    if (act.phase === "generating") {
                      const tokLabel = act.tokens && act.tokens > 100 ? ` (${Math.round(act.tokens / 4)} tokens)` : "";
                      setStatusLine(`Generating${tokLabel}...`);
                    } else if (act.phase === "tool_running" && act.tool) {
                      const label = TOOL_LABELS[act.tool] || act.tool;
                      setStatusLine(`${label}...`);
                    } else if (act.phase === "thinking") {
                      if (agoSec > 20) {
                        setStatusLine(`Thinking... (${agoSec}s)`);
                      } else {
                        setStatusLine("Thinking...");
                      }
                    }
                  } else if (Date.now() - lastActivityRef.current > 10_000) {
                    setStatusLine("Thinking...");
                  }
                  break;
                }

                case "text":
                  lastActivityRef.current = Date.now();
                  setThinkingMsg(null);
                  textAccumulator += event.content || "";
                  tokenCountRef.current += (event.content || "").length;
                  setCurrentText(textAccumulator);
                  // Update status with first ~80 chars
                  setStatusLine(textAccumulator.slice(0, 80).replace(/\n/g, " ") + (textAccumulator.length > 80 ? "..." : ""));
                  break;

                case "tool_call": {
                  lastActivityRef.current = Date.now();
                  setThinkingMsg(null);
                  const label = TOOL_LABELS[event.toolName || ""] || event.toolName || "Tool";
                  // For execution tools, extract and show the command
                  const argsObj = event.args as Record<string, unknown> | undefined;
                  const command = argsObj?.command as string | undefined;
                  const isExecTool = EXECUTION_TOOLS.has(event.toolName || "");
                  const displayLabel = isExecTool && command
                    ? `${label}: ${command.slice(0, 80)}${command.length > 80 ? "..." : ""}`
                    : label;
                  setStatusLine(displayLabel + "...");
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
                    content: displayLabel,
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
                  lastActivityRef.current = Date.now();
                  const resultStr = typeof event.result === "string"
                    ? event.result
                    : JSON.stringify(event.result, null, 2);
                  setFeed((f) => f.map((item) =>
                    item.toolCallId === event.toolCallId
                      ? { ...item, type: "tool_result" as const, progress: undefined, args: item.args + "\n\n--- Result ---\n" + resultStr }
                      : item
                  ));
                  const toolLabel = TOOL_LABELS[event.toolName || ""] || event.toolName || "tool";
                  setStatusLine(`${toolLabel} done — analyzing results...`);
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

                case "done": {
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

                  // Always auto-continue unless user stopped or project is no longer active
                  const canAutoContinue =
                    projectStatusRef.current === "ACTIVE" &&
                    !stoppedByUserRef.current;

                  if (canAutoContinue) {
                    restartCountRef.current++;
                    setStatusLine(`Continuing (session ${restartCountRef.current + 1})...`);
                    // Flag that we need to auto-continue after the stream closes
                    shouldAutoContinueRef.current = true;
                  } else {
                    setFeed((f) => [...f, {
                      id: `done-${++itemCounter.current}`,
                      type: "done",
                      content: stoppedByUserRef.current
                        ? "Agent stopped by user."
                        : "Agent finished.",
                    }]);
                    setStatusLine(stoppedByUserRef.current ? "Stopped by user" : "Finished — press Resume or send a message");
                  }
                  break;
                }
              }
            } catch {
              // Skip malformed events
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          const errMsg = (err as Error).message || "Connection lost";
          setFeed((f) => [...f, {
            id: `err-${++itemCounter.current}`,
            type: "error",
            content: errMsg,
          }]);
          // Auto-reconnect on unexpected disconnection (not user-initiated)
          if (!stoppedByUserRef.current && projectStatusRef.current === "ACTIVE") {
            setStatusLine("Reconnecting...");
            shouldAutoContinueRef.current = true;
          } else {
            setStatusLine("Connection lost");
          }
        }
      } finally {
        abortRef.current = null;

        // Auto-continue if flagged by the done handler — keep "running" look
        if (shouldAutoContinueRef.current) {
          shouldAutoContinueRef.current = false;
          // Don't set running=false — keep the spinner going during the gap
          setThinkingMsg(null);
          onRefresh();

          // Small delay to let state settle, then restart via the restart API
          setTimeout(async () => {
            try {
              const res = await fetch(`/api/research/${projectId}/restart`, { method: "POST" });
              if (!res.ok) throw new Error("Restart API failed");
              const { priorWorkSummary } = await res.json();

              onRefresh();

              const continuationMessage = priorWorkSummary
                ? `You are automatically continuing the research. Here is a summary of all work so far — continue from where you left off, do NOT repeat completed steps:\n\n${priorWorkSummary}`
                : "You are automatically continuing the research. Continue from where you left off.";

              // Reset running state so startAgent's guard allows the call
              setRunning(false);
              runningRef.current = false;
              startAgentRef.current(continuationMessage);
            } catch (err) {
              console.error("[agent-activity-bar] Auto-continue failed:", err);
              setRunning(false);
              setStatusLine("Auto-continue failed — press Resume to restart");
              setFeed((f) => [...f, {
                id: `err-${++itemCounter.current}`,
                type: "error",
                content: "Auto-continue failed. Use the input below to restart manually.",
              }]);
            }
          }, 500);
        } else {
          setRunning(false);
          setThinkingMsg(null);
          onRefresh();
        }
      }
    }, [projectId, onRefresh]);

    // Keep ref in sync so auto-continue closures always call the latest startAgent
    startAgentRef.current = startAgent;

    const stopAgent = useCallback(() => {
      stoppedByUserRef.current = true;
      shouldAutoContinueRef.current = false;
      abortRef.current?.abort();
      setRunning(false);
      setThinkingMsg(null);
      setStatusLine("Stopped — type a message or press Resume");

      // Signal the server-side agent to stop
      fetch(`/api/research/${projectId}/agent`, { method: "DELETE" }).catch(() => {});

      // Cancel any active remote jobs for this project
      fetch(`/api/research/remote-jobs?projectId=${projectId}`)
        .then((r) => r.json())
        .then((jobs: { id: string; status: string }[]) => {
          for (const job of jobs) {
            if (["RUNNING", "SYNCING", "QUEUED"].includes(job.status)) {
              fetch(`/api/research/remote-jobs/${job.id}`, { method: "DELETE" }).catch(() => {});
            }
          }
          setActiveJob(null);
        })
        .catch(() => {});
    }, [projectId]);

    // Expose handle to parent
    useImperativeHandle(ref, () => ({
      start: startAgent,
      stop: stopAgent,
      get isRunning() { return runningRef.current; },
    }), [startAgent, stopAgent]);

    // Hydrate feed from existing project data + remote jobs on mount
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          // Fetch project data and remote jobs in parallel
          const [projectRes, jobsRes] = await Promise.all([
            fetch(`/api/research/${projectId}`),
            fetch(`/api/research/remote-jobs?projectId=${projectId}`),
          ]);
          if (cancelled) return;
          if (!projectRes.ok) return;

          const project = await projectRes.json();
          const jobs: RemoteJobInfo[] = jobsRes.ok ? await jobsRes.json() : [];

          const items: FeedItem[] = [];
          let counter = 0;

          // Index remote jobs by ID for quick lookup
          const jobById = new Map(jobs.map((j) => [j.id, j]));
          // Track which job IDs we've already shown (to avoid duplicates from log entries)
          const shownJobIds = new Set<string>();

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

            // If step has a linked remote job, show richer info
            let remoteJobId: string | undefined;
            try {
              const out = step.output ? JSON.parse(step.output) : null;
              remoteJobId = out?.remoteJobId;
            } catch { /* ignore */ }

            const linkedJob = remoteJobId ? jobById.get(remoteJobId) : undefined;
            if (linkedJob) shownJobIds.add(linkedJob.id);

            if (step.status === "FAILED" && linkedJob) {
              // Rich failure item with job details
              const scriptMatch = linkedJob.command?.match(/python3?\s+(\S+\.py)/);
              const scriptName = scriptMatch ? scriptMatch[1] : step.title;
              const errorDetail = extractJobError(linkedJob);
              items.push({
                id: `hist-step-${++counter}`,
                type: "error",
                toolName: step.type,
                content: `${scriptName} failed (exit ${linkedJob.exitCode ?? "?"}) on ${linkedJob.host?.alias || "remote"}`,
                args: errorDetail || undefined,
              });
            } else {
              items.push({
                id: `hist-step-${++counter}`,
                type: step.status === "COMPLETED" ? "tool_result" : step.status === "FAILED" ? "error" : "tool_call",
                toolName: step.type,
                content: step.status === "FAILED" ? `Failed: ${step.title}` : `${label}: ${step.title}`,
                args: step.output ? step.output.slice(0, 500) : undefined,
              });
            }
          }

          // Add recent remote job results not already covered by steps
          const recentJobs = jobs
            .filter((j) => !shownJobIds.has(j.id) && (j.status === "COMPLETED" || j.status === "FAILED"))
            .slice(0, 10);

          for (const job of recentJobs) {
            shownJobIds.add(job.id);
            const scriptMatch = job.command?.match(/python3?\s+(\S+\.py)/);
            const scriptName = scriptMatch ? scriptMatch[1] : job.command?.slice(0, 50) || "experiment";

            if (job.status === "FAILED") {
              const errorDetail = extractJobError(job);
              items.push({
                id: `hist-job-${++counter}`,
                type: "error",
                content: `${scriptName} failed (exit ${job.exitCode ?? "?"}) on ${job.host?.alias || "remote"}`,
                args: errorDetail || undefined,
              });
            } else {
              items.push({
                id: `hist-job-${++counter}`,
                type: "tool_result",
                toolName: "execute_remote",
                content: `${scriptName} completed on ${job.host?.alias || "remote"}`,
              });
            }
          }

          // Add recent log findings — but skip job-related entries (we hydrate those from jobs directly)
          const logEntries = (project.log || [])
            .filter((l: { type: string; metadata?: string }) => {
              if (!["observation", "breakthrough", "dead_end", "decision"].includes(l.type)) return false;
              // Skip entries linked to remote jobs — already shown above
              if (l.metadata) {
                try {
                  const meta = JSON.parse(l.metadata);
                  if (meta.remoteJobId) return false;
                } catch { /* keep */ }
              }
              return true;
            })
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
              setStatusLine(`last: ${lastStep.title.slice(0, 70)}`);
            }
          }
        } catch {
          // Non-critical — just show empty state
        }
      })();

      return () => { cancelled = true; };
    }, [projectId]);

    // Auto-start once on mount, or reconnect to running agent
    useEffect(() => {
      if (autoStarted.current) return;
      if (autoStart) {
        autoStarted.current = true;
        startAgent();
        return;
      }
      // If project is ACTIVE and we're not running, check if agent is running server-side
      if (projectStatus === "ACTIVE" && !runningRef.current) {
        let cancelled = false;
        fetch(`/api/research/${projectId}/agent`)
          .then((r) => r.json())
          .then((data) => {
            if (cancelled || autoStarted.current || runningRef.current) return;
            if (data.running) {
              // Agent is running server-side — reconnect via POST to get observer stream
              autoStarted.current = true;
              startAgent();
            }
          })
          .catch(() => {});
        return () => { cancelled = true; };
      }
    }, [autoStart, startAgent, projectId, projectStatus]);

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
      <div className="relative rounded-md border border-border bg-card overflow-visible">
        {/* Compact status bar — always visible */}
        <div
          data-console-toggle
          className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {running && connectionStale ? (
            <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          ) : running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500 shrink-0" />
          ) : activeJob ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-500 shrink-0" />
          ) : projectStatus === "ACTIVE" && feed.length > 0 ? (
            <CirclePause className="h-3.5 w-3.5 text-amber-500/70 shrink-0" />
          ) : feed.some((f) => f.type === "done") ? (
            <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
          ) : (
            <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}

          <span className={`text-xs flex-1 truncate ${
            connectionStale && running ? "text-amber-500"
            : !running && projectStatus === "ACTIVE" && feed.length > 0 ? "text-amber-500/70"
            : activeJob && !running ? "text-cyan-500"
            : "text-muted-foreground"
          }`}>
            {connectionStale && running
              ? `No response for ${Math.floor((Date.now() - lastHeardRef.current) / 1000)}s — connection may be stale`
              : !running && projectStatus === "ACTIVE" && feed.length > 0 && !activeJob
                ? `Agent stopped — ${statusLine}`
                : statusLine}
          </span>

          {/* Quick output preview when collapsed */}
          {!expanded && !running && activeJob?.stdout && (
            <span className="text-[9px] font-mono text-muted-foreground/50 truncate max-w-[250px]">
              {activeJob.stdout.split("\n").filter(Boolean).pop()?.slice(0, 60)}
            </span>
          )}
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

          {running ? (
            <button
              onClick={(e) => { e.stopPropagation(); stopAgent(); }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
            >
              <Square className="h-2.5 w-2.5" />
              Stop
            </button>
          ) : projectStatus === "ACTIVE" && !activeJob && (
            <button
              onClick={(e) => { e.stopPropagation(); startAgent(); }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] bg-primary/10 text-primary hover:bg-primary/20 transition-colors shrink-0"
            >
              <Play className="h-2.5 w-2.5" />
              Resume
            </button>
          )}

          {expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
        </div>

        {/* Expanded detail section — overlays upward */}
        {expanded && (
          <div className="absolute bottom-full left-0 right-0 bg-card border border-border rounded-t-md shadow-lg z-30">
            {/* Tab switcher + expand button */}
            <div className="border-b border-border flex items-center">
              <button
                onClick={() => setActiveTab("console")}
                className={`flex items-center gap-1 px-3 py-1.5 text-[10px] font-medium transition-colors border-b-2 ${
                  activeTab === "console"
                    ? "text-foreground border-foreground"
                    : "text-muted-foreground hover:text-foreground border-transparent"
                }`}
              >
                <Terminal className="h-3 w-3" />
                Console
              </button>
              <button
                onClick={() => setActiveTab("notebook")}
                className={`flex items-center gap-1 px-3 py-1.5 text-[10px] font-medium transition-colors border-b-2 ${
                  activeTab === "notebook"
                    ? "text-foreground border-foreground"
                    : "text-muted-foreground hover:text-foreground border-transparent"
                }`}
              >
                <FileText className="h-3 w-3" />
                Notebook
              </button>
              <div className="flex-1" />
              <button
                onClick={() => setFullscreen(true)}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors mr-1"
                title="Expand"
              >
                <Maximize2 className="h-3 w-3" />
              </button>
            </div>

            {/* Content area — overlays upward so it doesn't push the dashboard */}
            <div className="h-64 flex flex-col">
              {activeTab === "console" ? (
                <>
                  <div className="flex-1 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden space-y-1.5 p-2">
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

                    {/* Live remote job panel — visible even without SSE */}
                    {activeJob && (
                      <div className="rounded border border-cyan-500/20 bg-cyan-500/5 px-2 py-1.5">
                        <div className="flex items-center gap-1.5 mb-1">
                          <Loader2 className="h-2.5 w-2.5 text-cyan-500 animate-spin" />
                          <span className="text-[10px] font-medium">{activeJob.host}</span>
                          {activeJob.gpu && <span className="text-[9px] text-muted-foreground">{activeJob.gpu}</span>}
                          <span className="text-[9px] text-cyan-400">{activeJob.status}</span>
                        </div>
                        {activeJob.command && (
                          <pre className="text-[9px] text-muted-foreground/60 font-mono bg-background/30 rounded px-1.5 py-0.5 mb-1 whitespace-pre-wrap break-all">
                            $ {activeJob.command}
                          </pre>
                        )}
                        {activeJob.stdout && (
                          <pre className="text-[9px] text-muted-foreground bg-background/50 rounded p-1.5 max-h-28 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden whitespace-pre-wrap font-mono">
                            {activeJob.stdout.split("\n").filter(Boolean).slice(-15).join("\n")}
                          </pre>
                        )}
                      </div>
                    )}

                    <div ref={feedEndRef} />
                  </div>

                  {/* Status bar — input moved to Chat tab */}
                  <div className="shrink-0 border-t border-border px-3 py-1.5 flex items-center gap-2">
                    {running ? (
                      <span className="flex-1 text-[11px] text-muted-foreground flex items-center gap-1.5">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Agent is working... {elapsed > 0 && <span className="text-[10px] tabular-nums">{elapsedStr}</span>}
                      </span>
                    ) : (
                      <span className="flex-1 text-[11px] text-muted-foreground">
                        Agent stopped. Use the Chat tab to give directions.
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <NotebookTab projectId={projectId} />
              )}
            </div>
          </div>
        )}

        {/* Fullscreen overlay */}
        {fullscreen && (
          <FullscreenPanel
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onClose={() => setFullscreen(false)}
            projectId={projectId}
            feed={feed}
            currentText={currentText}
            thinkingMsg={thinkingMsg}
            running={running}
            activeJob={activeJob}
            userInput={userInput}
            setUserInput={setUserInput}
            onSend={handleSend}
            onStart={startAgent}
            elapsed={elapsed}
            elapsedStr={elapsedStr}
          />
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

        {/* Command + terminal for execution tools */}
        {showDetail && isExec && (
          <>
            {item.args && (
              <pre className="mt-1 text-[9px] text-muted-foreground/70 font-mono bg-background/50 rounded px-1.5 py-1 whitespace-pre-wrap break-all">
                {(() => {
                  try {
                    const parsed = JSON.parse(item.args);
                    return parsed.command || item.args;
                  } catch { return item.args; }
                })()}
              </pre>
            )}
            {hasOutput && (
              <TerminalOutput lines={item.outputLines!} isRunning={!isDone} progress={item.progress} />
            )}
          </>
        )}

        {/* Args/result for non-execution tools */}
        {showDetail && !isExec && item.args && (
          <pre className="mt-1 text-[9px] text-muted-foreground bg-background/50 rounded p-1.5 max-h-40 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden whitespace-pre-wrap">
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
      <div className="rounded border border-destructive/20 bg-destructive/5 px-2 py-1">
        <button
          onClick={() => setShowDetail(!showDetail)}
          className="flex items-center gap-1.5 w-full text-left"
        >
          <AlertCircle className="h-2.5 w-2.5 text-destructive shrink-0" />
          <span className="text-[10px] text-destructive flex-1 truncate">{item.content}</span>
          {item.args && (
            <ChevronDown className={`h-2.5 w-2.5 text-destructive/40 transition-transform ${showDetail ? "rotate-180" : ""}`} />
          )}
        </button>
        {showDetail && item.args && (
          <pre className="mt-1 text-[9px] text-destructive/70 bg-destructive/5 rounded p-1.5 max-h-40 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden whitespace-pre-wrap font-mono">
            {item.args}
          </pre>
        )}
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

// ── Notebook tab: editable RESEARCH_LOG.md ──────────────

function NotebookTab({ projectId }: { projectId: string }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const lastSaved = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fetchLog = useCallback(async () => {
    try {
      const res = await fetch(`/api/research/${projectId}/log-file`);
      if (res.ok) {
        const data = await res.json();
        const newContent = data.content || "";
        if (!dirty) {
          setContent(newContent);
          lastSaved.current = newContent;
          // Auto-scroll textarea to bottom after fetching new content
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
            }
          });
        }
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [projectId, dirty]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!dirty) fetchLog();
    }, 10_000);
    return () => clearInterval(interval);
  }, [dirty, fetchLog]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/research/${projectId}/log-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        lastSaved.current = content;
        setDirty(false);
      }
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleChange = (value: string) => {
    setContent(value);
    setDirty(value !== lastSaved.current);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (dirty) handleSave();
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1 w-full resize-none bg-transparent px-3 py-2 text-[11px] font-mono leading-relaxed text-foreground/80 focus:outline-none placeholder:text-muted-foreground/40"
        placeholder="Research notebook — add notes, papers to consult, directions to explore. The agent reads this at the start of every session."
        spellCheck={false}
      />
      {dirty && (
        <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-t border-border bg-muted/30">
          <span className="text-[9px] text-muted-foreground">Unsaved changes (Ctrl+S)</span>
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Save className="h-2.5 w-2.5" />}
            Save
          </button>
        </div>
      )}
    </div>
  );
}

// ── Fullscreen panel overlay ────────────────────────────

interface FullscreenPanelProps {
  activeTab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  onClose: () => void;
  projectId: string;
  feed: FeedItem[];
  currentText: string;
  thinkingMsg: string | null;
  running: boolean;
  activeJob: { id: string; status: string; host: string; gpu: string | null; command: string | null; stdout: string | null; updatedAt: string } | null;
  userInput: string;
  setUserInput: (v: string) => void;
  onSend: () => void;
  onStart: (msg?: string) => void;
  elapsed: number;
  elapsedStr: string;
}

function FullscreenPanel({
  activeTab, onTabChange, onClose, projectId,
  feed, currentText, thinkingMsg, running, activeJob,
  userInput, setUserInput, onSend, onStart, elapsed, elapsedStr,
}: FullscreenPanelProps) {
  const feedEndRef = useRef<HTMLDivElement>(null);
  const markdownRef = useRef<HTMLDivElement>(null);
  const nbScrollRef = useRef<HTMLDivElement>(null);
  const nbTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Notebook state
  const [nbContent, setNbContent] = useState("");
  const [nbLoading, setNbLoading] = useState(true);
  const [nbSaving, setNbSaving] = useState(false);
  const [nbDirty, setNbDirty] = useState(false);
  const [nbEditing, setNbEditing] = useState(false);
  const nbLastSaved = useRef("");

  const fetchLog = useCallback(async () => {
    try {
      const res = await fetch(`/api/research/${projectId}/log-file`);
      if (res.ok) {
        const data = await res.json();
        const newContent = data.content || "";
        if (!nbDirty) {
          setNbContent(newContent);
          nbLastSaved.current = newContent;
          // Auto-scroll to bottom after content loads
          requestAnimationFrame(() => {
            if (nbScrollRef.current) nbScrollRef.current.scrollTop = nbScrollRef.current.scrollHeight;
            if (nbTextareaRef.current) nbTextareaRef.current.scrollTop = nbTextareaRef.current.scrollHeight;
          });
        }
      }
    } catch { /* ignore */ }
    setNbLoading(false);
  }, [projectId, nbDirty]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  const handleNbSave = async () => {
    setNbSaving(true);
    try {
      const res = await fetch(`/api/research/${projectId}/log-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: nbContent }),
      });
      if (res.ok) {
        nbLastSaved.current = nbContent;
        setNbDirty(false);
      }
    } catch { /* ignore */ }
    setNbSaving(false);
  };

  const handleNbKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (nbDirty) handleNbSave();
    }
  };

  // Extract headings for table of contents
  const toc = nbContent.split("\n")
    .map((line, i) => {
      const match = line.match(/^(#{1,3})\s+(.+)/);
      if (!match) return null;
      return { level: match[1].length, text: match[2], line: i };
    })
    .filter(Boolean) as { level: number; text: string; line: number }[];

  // Auto-scroll console feed and notebook content
  useEffect(() => {
    if (activeTab === "console") {
      feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [feed, currentText, activeTab]);

  useEffect(() => {
    if (activeTab === "notebook" && !nbEditing) {
      requestAnimationFrame(() => {
        if (nbScrollRef.current) nbScrollRef.current.scrollTop = nbScrollRef.current.scrollHeight;
      });
    } else if (activeTab === "notebook" && nbEditing) {
      requestAnimationFrame(() => {
        if (nbTextareaRef.current) nbTextareaRef.current.scrollTop = nbTextareaRef.current.scrollHeight;
      });
    }
  }, [activeTab, nbContent, nbEditing]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-6 z-50 rounded-lg border border-border bg-card shadow-2xl flex flex-col overflow-hidden">
        {/* Header with tabs */}
        <div className="flex items-center border-b border-border bg-muted/30 px-2">
          <button
            onClick={() => onTabChange("console")}
            className={`flex items-center gap-1 px-3 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === "console"
                ? "text-foreground border-foreground"
                : "text-muted-foreground hover:text-foreground border-transparent"
            }`}
          >
            <Terminal className="h-3.5 w-3.5" />
            Console
          </button>
          <button
            onClick={() => onTabChange("notebook")}
            className={`flex items-center gap-1 px-3 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === "notebook"
                ? "text-foreground border-foreground"
                : "text-muted-foreground hover:text-foreground border-transparent"
            }`}
          >
            <FileText className="h-3.5 w-3.5" />
            Notebook
            {nbDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
          </button>
          <div className="flex-1" />
          {/* Notebook-specific controls */}
          {activeTab === "notebook" && (
            <div className="flex items-center gap-1 mr-2">
              {nbEditing ? (
                <button
                  onClick={() => setNbEditing(false)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <FileText className="h-3 w-3" />
                  Preview
                </button>
              ) : (
                <button
                  onClick={() => setNbEditing(true)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </button>
              )}
              {nbDirty && (
                <button
                  onClick={handleNbSave}
                  disabled={nbSaving}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {nbSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  Save
                </button>
              )}
            </div>
          )}
          <button
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        {activeTab === "console" ? (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden space-y-1.5 p-3">
              {feed.length === 0 && !running && (
                <p className="text-xs text-muted-foreground text-center py-8">No agent activity yet.</p>
              )}
              {feed.map((item) => (
                <CompactFeedItem key={item.id} item={item} />
              ))}
              {currentText && (
                <div className="flex gap-2">
                  <Bot className="h-3.5 w-3.5 mt-0.5 text-blue-500 shrink-0" />
                  <div className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed">
                    {currentText.slice(-500)}
                    <span className="inline-block w-1 h-3 bg-blue-500/50 animate-pulse ml-0.5" />
                  </div>
                </div>
              )}
              {running && !currentText && thinkingMsg && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                  {thinkingMsg}
                </div>
              )}
              {activeJob && (
                <div className="rounded border border-cyan-500/20 bg-cyan-500/5 px-3 py-2">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Loader2 className="h-3 w-3 text-cyan-500 animate-spin" />
                    <span className="text-xs font-medium">{activeJob.host}</span>
                    {activeJob.gpu && <span className="text-[10px] text-muted-foreground">{activeJob.gpu}</span>}
                    <span className="text-[10px] text-cyan-400">{activeJob.status}</span>
                  </div>
                  {activeJob.command && (
                    <pre className="text-[10px] text-muted-foreground/60 font-mono bg-background/30 rounded px-2 py-1 mb-1 whitespace-pre-wrap break-all">
                      $ {activeJob.command}
                    </pre>
                  )}
                  {activeJob.stdout && (
                    <pre className="text-[10px] text-muted-foreground bg-background/50 rounded p-2 max-h-60 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden whitespace-pre-wrap font-mono">
                      {activeJob.stdout.split("\n").filter(Boolean).slice(-30).join("\n")}
                    </pre>
                  )}
                </div>
              )}
              <div ref={feedEndRef} />
            </div>
            {/* Input bar */}
            <div className="shrink-0 border-t border-border px-3 py-2 flex items-center gap-2">
              {!running ? (
                <>
                  <input
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (userInput.trim()) { onSend(); } else { onStart(); }
                      }
                    }}
                    placeholder="Guide the agent or press Enter to restart..."
                    className="flex-1 rounded border border-input bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button
                    onClick={() => userInput.trim() ? onSend() : onStart()}
                    className="inline-flex h-7 w-7 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : (
                <span className="flex-1 text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Agent is working... {elapsed > 0 && <span className="text-[11px] tabular-nums">{elapsedStr}</span>}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex min-h-0">
            {/* Table of contents */}
            {toc.length > 0 && !nbEditing && (
              <div className="w-52 shrink-0 border-r border-border overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden py-3 px-3">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">Contents</p>
                <nav className="space-y-0.5">
                  {toc.map((item, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        if (!markdownRef.current) return;
                        const tag = `h${item.level}`;
                        const headings = Array.from(markdownRef.current.querySelectorAll(tag));
                        for (const el of headings) {
                          if (el.textContent?.trim() === item.text.trim()) {
                            el.scrollIntoView({ behavior: "smooth", block: "start" });
                            break;
                          }
                        }
                      }}
                      className={`block w-full text-left text-[11px] leading-snug py-0.5 text-muted-foreground hover:text-foreground transition-colors truncate ${
                        item.level === 1 ? "font-medium" : item.level === 2 ? "pl-3" : "pl-6 text-[10px]"
                      }`}
                    >
                      {item.text}
                    </button>
                  ))}
                </nav>
              </div>
            )}

            {/* Content */}
            {nbLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : nbEditing ? (
              <textarea
                ref={nbTextareaRef}
                value={nbContent}
                onChange={(e) => {
                  setNbContent(e.target.value);
                  setNbDirty(e.target.value !== nbLastSaved.current);
                }}
                onKeyDown={handleNbKeyDown}
                className="flex-1 w-full resize-none bg-transparent px-6 py-4 text-sm font-mono leading-relaxed text-foreground/80 focus:outline-none placeholder:text-muted-foreground/40"
                placeholder="Research notebook — add notes, papers to consult, directions to explore..."
                spellCheck={false}
                autoFocus
              />
            ) : (
              <div ref={nbScrollRef} className="flex-1 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-6 py-4">
                <div className="prose-sm max-w-none text-[13px] leading-relaxed" ref={markdownRef}>
                  <MarkdownRenderer content={nbContent} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
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
        className="p-1.5 max-h-48 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden font-mono text-[9px] leading-[1.5] text-[#e6edf3] selection:bg-blue-500/30"
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
