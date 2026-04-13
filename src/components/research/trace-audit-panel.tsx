"use client";

import { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock3,
  Loader2,
  Search,
  ServerCrash,
  ShieldAlert,
  TerminalSquare,
  Wrench,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type PostmortemCategory =
  | "agent_reasoning"
  | "validator_miss"
  | "execution_control_plane"
  | "script_runtime"
  | "host_environment";

type PostmortemSeverity = "high" | "medium" | "low";

interface TraceAuditOverview {
  sessions: number;
  events: number;
  blockedEvents: number;
  toolCalls: number;
  errors: number;
  activeRuns: number;
  failedRuns: number;
  postmortems: number;
  categories: Array<{ category: PostmortemCategory; count: number }>;
}

interface TraceAuditSessionSummary {
  runId: string;
  sessionNumbers: number[];
  startedAt: string;
  updatedAt: string;
  endedAt: string;
  eventCount: number;
  thinkingCount: number;
  toolCallCount: number;
  blockedCount: number;
  errorCount: number;
  status: "running" | "completed" | "errored" | "blocked";
  tools: string[];
  lastEventType: string;
  lastEventPreview: string | null;
  categories: PostmortemCategory[];
}

interface TraceAuditPostmortem {
  id: string;
  source: "trace_session" | "experiment_run";
  category: PostmortemCategory;
  severity: PostmortemSeverity;
  title: string;
  summary: string;
  shouldHaveBlockedEarlier: boolean;
  boundary: string;
  recommendedAction: string;
  linkedTraceRunId: string | null;
  linkedExperimentRunId: string | null;
  linkedRemoteJobId: string | null;
  createdAt: string;
  evidence: string[];
}

interface TraceAuditEventRecord {
  id: string;
  runId: string;
  sessionNumber: number;
  sequence: number;
  eventType: string;
  stepNumber: number | null;
  toolName: string | null;
  toolCallId: string | null;
  content: string | null;
  args: unknown | null;
  result: unknown | null;
  activity: unknown | null;
  metadata: unknown | null;
  createdAt: string;
}

interface TraceAuditResponse {
  project: {
    id: string;
    title: string;
    status: string;
    currentPhase: string;
  };
  overview: TraceAuditOverview;
  sessions: TraceAuditSessionSummary[];
  postmortems: TraceAuditPostmortem[];
  total: number;
  returned: number;
  events: TraceAuditEventRecord[];
}

interface TraceAuditPanelProps {
  projectId: string;
}

const CATEGORY_META: Record<PostmortemCategory, { label: string; icon: LucideIcon; tone: string }> = {
  agent_reasoning: {
    label: "Agent reasoning",
    icon: Brain,
    tone: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  validator_miss: {
    label: "Validator miss",
    icon: ShieldAlert,
    tone: "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  execution_control_plane: {
    label: "Control plane",
    icon: Wrench,
    tone: "border-orange-500/20 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  },
  script_runtime: {
    label: "Runtime",
    icon: TerminalSquare,
    tone: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  host_environment: {
    label: "Host / env",
    icon: ServerCrash,
    tone: "border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
  },
};

const SESSION_STATUS_META: Record<TraceAuditSessionSummary["status"], { label: string; tone: string; icon: LucideIcon }> = {
  running: {
    label: "Running",
    tone: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    icon: Clock3,
  },
  completed: {
    label: "Completed",
    tone: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    icon: CheckCircle2,
  },
  errored: {
    label: "Errored",
    tone: "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300",
    icon: XCircle,
  },
  blocked: {
    label: "Blocked",
    tone: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: AlertTriangle,
  },
};

const EVENT_TONE: Record<string, string> = {
  thinking: "text-sky-700 dark:text-sky-300",
  tool_call: "text-foreground",
  tool_result: "text-foreground",
  tool_output: "text-muted-foreground",
  tool_progress: "text-muted-foreground",
  error: "text-red-700 dark:text-red-300",
  done: "text-emerald-700 dark:text-emerald-300",
  text: "text-foreground",
};

function truncate(text: string | null | undefined, max = 160) {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function relativeAge(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return value;
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function sessionSearchText(session: TraceAuditSessionSummary) {
  return [
    session.runId,
    session.status,
    session.tools.join(" "),
    session.lastEventPreview || "",
    session.categories.join(" "),
  ].join(" ").toLowerCase();
}

function eventPreview(event: TraceAuditEventRecord) {
  if (typeof event.content === "string" && event.content.trim()) return truncate(event.content, 220);
  if (event.toolName) return truncate(`${event.toolName}${event.toolCallId ? ` · ${event.toolCallId}` : ""}`, 220);
  return event.eventType;
}

function stringifyValue(value: unknown) {
  if (value == null) return null;
  if (typeof value === "string") return truncate(value, 220);
  try {
    return truncate(JSON.stringify(value), 220);
  } catch {
    return truncate(String(value), 220);
  }
}

export function TraceAuditPanel({ projectId }: TraceAuditPanelProps) {
  const [data, setData] = useState<TraceAuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/research/${projectId}/trace?limit=250`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(typeof body?.error === "string" ? body.error : "Failed to load trace");
        }
        return body as TraceAuditResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setSelectedRunId((current) =>
          current && body.sessions.some((session) => session.runId === current)
            ? current
            : body.sessions[0]?.runId || null
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load trace");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const sessions = data?.sessions || [];
  const filteredSessions = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => sessionSearchText(session).includes(needle));
  }, [deferredQuery, sessions]);

  useEffect(() => {
    if (filteredSessions.length === 0) {
      setSelectedRunId(null);
      return;
    }
    if (!selectedRunId || !filteredSessions.some((session) => session.runId === selectedRunId)) {
      setSelectedRunId(filteredSessions[0].runId);
    }
  }, [filteredSessions, selectedRunId]);

  const selectedSession = filteredSessions.find((session) => session.runId === selectedRunId) || filteredSessions[0] || null;
  const sessionEvents = useMemo(
    () => (data?.events || []).filter((event) => event.runId === selectedSession?.runId),
    [data?.events, selectedSession?.runId],
  );
  const sessionPostmortems = useMemo(
    () => (data?.postmortems || []).filter((postmortem) => postmortem.linkedTraceRunId === selectedSession?.runId),
    [data?.postmortems, selectedSession?.runId],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Building trace audit…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
        <p className="text-xs font-medium text-red-700 dark:text-red-300">Trace unavailable</p>
        <p className="mt-1 text-xs text-red-600/80 dark:text-red-300/80">{error}</p>
      </div>
    );
  }

  const overview = data?.overview;

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Trace Audit</h3>
          {overview && (
            <span className="text-[11px] text-muted-foreground/50">{overview.sessions} session{overview.sessions === 1 ? "" : "s"}</span>
          )}
        </div>
        {overview && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{overview.events} events</span>
            <span>{overview.toolCalls} tool calls</span>
            <span>{overview.blockedEvents} blocked</span>
            <span>{overview.postmortems} postmortem{overview.postmortems === 1 ? "" : "s"}</span>
          </div>
        )}
      </div>

      {overview && overview.categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {overview.categories.map((item) => {
            const meta = CATEGORY_META[item.category];
            const Icon = meta.icon;
            return (
              <span
                key={item.category}
                className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium", meta.tone)}
              >
                <Icon className="h-2.5 w-2.5" />
                {meta.label} {item.count}
              </span>
            );
          })}
        </div>
      )}

      {data?.postmortems && data.postmortems.length > 0 && (
        <div className="rounded-lg border border-border/60 p-3">
          <div className="mb-2.5 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Postmortems</p>
            <span className="text-[10px] text-muted-foreground/40">{data.postmortems.length} findings</span>
          </div>
          <div className="space-y-2">
            {data.postmortems.slice(0, 6).map((postmortem) => {
              const meta = CATEGORY_META[postmortem.category];
              const Icon = meta.icon;
              return (
                <div key={postmortem.id} className="rounded-md border border-border/50 bg-muted/10 p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", meta.tone)}>
                          <Icon className="h-2.5 w-2.5" />
                          {meta.label}
                        </span>
                        <span className={cn(
                          "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                          postmortem.severity === "high" && "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300",
                          postmortem.severity === "medium" && "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                          postmortem.severity === "low" && "border-border/60 bg-muted/30 text-muted-foreground",
                        )}>
                          {postmortem.severity}
                        </span>
                      </div>
                      <p className="mt-2 text-sm font-medium leading-snug text-foreground">{postmortem.title}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{postmortem.summary}</p>
                    </div>
                    <span className="shrink-0 text-[10px] text-muted-foreground/50">{relativeAge(postmortem.createdAt)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                    <span className="rounded-md border border-border/60 px-1.5 py-0.5">boundary: {postmortem.boundary}</span>
                    {postmortem.linkedExperimentRunId && (
                      <span className="rounded-md border border-border/60 px-1.5 py-0.5">run {postmortem.linkedExperimentRunId.slice(0, 8)}</span>
                    )}
                    {postmortem.linkedRemoteJobId && (
                      <span className="rounded-md border border-border/60 px-1.5 py-0.5">job {postmortem.linkedRemoteJobId.slice(0, 8)}</span>
                    )}
                  </div>
                  {postmortem.evidence.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {postmortem.evidence.slice(0, 2).map((evidence, index) => (
                        <p key={`${postmortem.id}-evidence-${index}`} className="text-[11px] leading-5 text-muted-foreground/80">
                          {evidence}
                        </p>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-[11px] leading-5 text-foreground/80">
                    <span className="font-medium">Next:</span> {postmortem.recommendedAction}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {sessions.length > 1 && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/40" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search trace sessions..."
            className="h-8 w-full rounded-md border border-border/60 bg-background pl-8 pr-3 text-xs outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-foreground/20"
          />
        </div>
      )}

      {filteredSessions.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-6 text-center">
          <p className="text-sm font-medium text-foreground">No trace sessions match</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground/60">Try a different tool name, run id, or failure category.</p>
        </div>
      ) : (
        <>
          {filteredSessions.length > 1 && (
            <div className="overflow-hidden rounded-lg border border-border/60">
              <div className="divide-y divide-border/30">
                {filteredSessions.map((session) => {
                  const selected = session.runId === selectedSession?.runId;
                  const statusMeta = SESSION_STATUS_META[session.status];
                  const StatusIcon = statusMeta.icon;
                  return (
                    <button
                      key={session.runId}
                      type="button"
                      onClick={() => startTransition(() => setSelectedRunId(session.runId))}
                      className={cn(
                        "relative w-full px-3 py-2.5 text-left transition-colors",
                        selected ? "bg-muted/40" : "hover:bg-muted/20",
                      )}
                    >
                      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-foreground/30" />}
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{session.runId.slice(0, 8)}</p>
                          <p className="mt-0.5 truncate text-[11px] leading-5 text-muted-foreground">
                            {session.lastEventPreview || "No event preview"}
                          </p>
                        </div>
                        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", statusMeta.tone)}>
                          <StatusIcon className="h-2.5 w-2.5" />
                          {statusMeta.label}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-1 pl-0 text-[10px] text-muted-foreground/50">
                        <span>{session.eventCount} events</span>
                        <span>{session.toolCallCount} tools</span>
                        {session.blockedCount > 0 && <span>{session.blockedCount} blocked</span>}
                        {session.tools.length > 0 && <span>{session.tools.slice(0, 3).join(", ")}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {selectedSession && (
            <div className="space-y-3">
              <div className="rounded-lg border border-border/60 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground/50">Trace session</p>
                    <h3 className="mt-1 text-sm font-semibold text-foreground">{selectedSession.runId}</h3>
                  </div>
                  <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", SESSION_STATUS_META[selectedSession.status].tone)}>
                    {(() => {
                      const StatusIcon = SESSION_STATUS_META[selectedSession.status].icon;
                      return <StatusIcon className="h-2.5 w-2.5" />;
                    })()}
                    {SESSION_STATUS_META[selectedSession.status].label}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>started {formatWhen(selectedSession.startedAt)}</span>
                  <span>updated {formatWhen(selectedSession.updatedAt)}</span>
                  <span>{selectedSession.thinkingCount} thinking</span>
                  <span>{selectedSession.errorCount} errors</span>
                </div>
              </div>

              {sessionPostmortems.length > 0 && (
                <div className="rounded-lg border border-border/60 p-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Session postmortem</p>
                  <div className="space-y-2">
                    {sessionPostmortems.map((postmortem) => {
                      const meta = CATEGORY_META[postmortem.category];
                      const Icon = meta.icon;
                      return (
                        <div key={postmortem.id} className="rounded-md border border-border/50 bg-muted/10 p-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", meta.tone)}>
                              <Icon className="h-2.5 w-2.5" />
                              {meta.label}
                            </span>
                          </div>
                          <p className="mt-2 text-sm font-medium text-foreground">{postmortem.title}</p>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{postmortem.summary}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="rounded-lg border border-border/60 p-3">
                <div className="mb-2.5 flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Event stream</p>
                  <span className="text-[10px] text-muted-foreground/40">{sessionEvents.length} events</span>
                </div>
                <div className="space-y-2">
                  {sessionEvents.slice(-40).map((event) => (
                    <div key={event.id} className="rounded-md border border-border/50 bg-muted/10 p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={cn("text-[10px] font-medium uppercase tracking-wide", EVENT_TONE[event.eventType] || "text-muted-foreground")}>
                              {event.eventType.replace(/_/g, " ")}
                            </span>
                            {event.toolName && (
                              <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {event.toolName}
                              </span>
                            )}
                            {typeof event.stepNumber === "number" && (
                              <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                step {event.stepNumber}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-foreground">{eventPreview(event)}</p>
                          {(event.args != null || event.result != null) && (
                            <div className="mt-1.5 space-y-1 text-[11px] leading-5 text-muted-foreground">
                              {event.args != null && <p><span className="font-medium">args:</span> {stringifyValue(event.args)}</p>}
                              {event.result != null && <p><span className="font-medium">result:</span> {stringifyValue(event.result)}</p>}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 text-[10px] text-muted-foreground/50">{formatWhen(event.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
