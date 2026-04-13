"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import {
  Loader2,
  ChevronDown,
  FileText,
  Lightbulb,
  ArrowRight,
  XCircle,
  BarChart3,
  BookOpen,
  FolderOpen,
  ScrollText,
  Image,
  MessageCircle,
  Search,
} from "lucide-react";
import Link from "next/link";
import { ExperimentCard } from "./experiment-card";
import { FilePreview } from "./file-preview";
import { ResearchChat } from "./research-chat";
import { MetricChart } from "./metric-chart";
import { ClaimLedgerPanel } from "./claim-ledger-panel";
import { LineageAuditPanel } from "./lineage-audit-panel";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { shouldHideResearchLogFromTimeline } from "@/lib/research/research-log-policy";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ApproachResult {
  id: string;
  verdict: string | null;
  metrics: string | null;
}

interface Approach {
  id: string;
  name: string;
  status: string;
  parentId: string | null;
  description: string | null;
  results: ApproachResult[];
  children?: {
    id: string;
    name: string;
    status: string;
    results: ApproachResult[];
  }[];
}

interface ExperimentResult {
  id: string;
  scriptName: string;
  metrics: string | null;
  comparison: string | null;
  verdict: string | null;
  reflection: string | null;
  hypothesisId: string | null;
  branchId: string | null;
  jobId: string | null;
  createdAt: string;
  branch: { name: string; status: string } | null;
}

interface ExperimentJob {
  id: string;
  status: string;
  exitCode: number | null;
  command: string;
  startedAt: string | null;
  completedAt: string | null;
  stderr: string | null;
  errorClass: string | null;
  host: { alias: string; gpuType: string | null };
}

interface Hypothesis {
  id: string;
  statement: string;
  status: string;
  rationale: string | null;
  evidence: string | null;
  theme?: string | null;
  parent?: { id: string; statement: string } | null;
}

interface GateStatus {
  met: boolean;
  progress: string;
}

interface LogEntry {
  id: string;
  type: string;
  content: string;
  createdAt: string;
}

export interface ResearchDashboardProps {
  project: {
    id: string;
    title: string;
    brief: string;
    currentPhase: string;
    methodology: string | null;
    status: string;
    hypotheses: Hypothesis[];
    approaches?: Approach[];
    experimentResults?: ExperimentResult[];
    experimentJobs?: ExperimentJob[];
    hypothesesById?: Record<string, string>;
    gates?: Record<string, GateStatus>;
  };
  papers: Array<{ id: string; title: string; authors?: string | null; year?: number | null; processingStatus?: string | null }>;
  iteration: {
    number: number;
    goal: string;
    steps: Array<{ status: string }>;
  } | null;
  onRefresh: () => void;
  logEntries?: LogEntry[];
  summaryShort?: string;
  summaryFull?: string;
}

/* ------------------------------------------------------------------ */
/*  Timeline types                                                     */
/* ------------------------------------------------------------------ */

interface TimelineEntry {
  id: string;
  type:
    | "breakthrough"
    | "experiment"
    | "decision"
    | "dead_end"
    | "observation";
  date: string;
  content?: string;
  result?: ExperimentResult;
  job?: ExperimentJob;
}

type FilterKey = "all" | "notebook" | "experiments" | "claims" | "lineage";

const FILTER_LABELS: Record<FilterKey, string> = {
  all: "All",
  notebook: "Notebook",
  experiments: "Experiments",
  claims: "Claims",
  lineage: "Lineage",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseBrief(brief: string): {
  question?: string;
  subQuestions?: string[];
  methodology?: string;
} {
  try {
    return JSON.parse(brief);
  } catch {
    return { question: brief };
  }
}

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/** Extract the best single metric value from an approach's results */
function bestMetric(results: ApproachResult[]): string | null {
  for (const r of results) {
    if (!r.metrics) continue;
    try {
      const parsed = JSON.parse(r.metrics) as Record<string, unknown>;
      const entries = Object.entries(parsed);
      if (entries.length > 0) {
        const [key, val] = entries[0];
        const formatted =
          typeof val === "number" ? val.toFixed(3) : String(val);
        return `${key}: ${formatted}`;
      }
    } catch {
      /* skip unparseable */
    }
  }
  return null;
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Get the best numeric metric value from experiment results */
/** Names that are clearly config/parameters, not performance metrics */
const PARAM_NAMES = /^(n_seeds?|total_budget|num_|batch_size|lr|learning_rate|epochs?|steps|samples|budget|size|count|length|n_|k_|max_|min_|top_)/i;

/** Names that are clearly performance metrics (prefer these) */
const METRIC_NAMES = /(?:f1|accuracy|acc|precision|recall|auroc|auc|bleu|rouge|perplexity|loss|mse|mae|rmse|r2|score|reward|return|success_rate)/i;

function bestExperimentMetric(
  results: ExperimentResult[]
): { key: string; value: number } | null {
  // Collect all metric entries, filtering out obvious parameters
  const candidates: { key: string; value: number }[] = [];
  for (const r of results) {
    if (!r.metrics) continue;
    try {
      const parsed = JSON.parse(r.metrics) as Record<string, unknown>;
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof val !== "number") continue;
        if (PARAM_NAMES.test(key)) continue; // skip config values
        candidates.push({ key, value: val });
      }
    } catch { /* skip */ }
  }
  if (candidates.length === 0) return null;

  // Prefer recognized metric names
  const recognized = candidates.filter(c => METRIC_NAMES.test(c.key));
  const pool = recognized.length > 0 ? recognized : candidates;

  // For metrics between 0-1 (like f1, accuracy), pick highest
  // For metrics that could be loss/error, pick lowest — but default to highest
  return pool.reduce((best, c) => c.value > best.value ? c : best, pool[0]);
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

/** Hoverable "N papers" badge that shows a popover with the paper list */
/** Scrollable container with a fade gradient that only shows when there's overflow */
function ScrollFadePanel({ children, className }: { children: React.ReactNode; className?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState(false);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Show fade if content overflows AND we're not scrolled to the bottom
    const hasOverflow = el.scrollHeight > el.clientHeight + 10;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    setCanScroll(hasOverflow && !atBottom);
  }, []);

  useEffect(() => {
    checkScroll();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", checkScroll, { passive: true });
    const observer = new ResizeObserver(checkScroll);
    observer.observe(el);
    return () => { el.removeEventListener("scroll", checkScroll); observer.disconnect(); };
  }, [checkScroll]);

  return (
    <div className={`relative ${className || ""}`}>
      {canScroll && (
        <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-background to-transparent pointer-events-none z-10" />
      )}
      <div ref={scrollRef} className="h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pb-8">
        {children}
      </div>
    </div>
  );
}

function PapersPopover({
  papers,
}: {
  papers: Array<{ id: string; title: string; authors?: string | null; year?: number | null; processingStatus?: string | null }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="hover:text-foreground transition-colors underline underline-offset-2 decoration-dotted"
      >
        {papers.length} papers
      </button>
      {open && papers.length > 0 && (
        <div className="fixed right-8 mt-1 w-[320px] max-h-[300px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden rounded-lg border border-border bg-background shadow-xl z-50 animate-in fade-in-0 slide-in-from-top-1 duration-100">
          <div className="px-3 py-2 border-b border-border/40 text-xs font-medium text-muted-foreground">
            {papers.length} papers in collection
          </div>
          <div className="py-1">
            {papers.map((p) => (
              <Link
                key={p.id}
                href={`/papers/${p.id}`}
                className="flex items-start gap-2 px-3 py-1.5 hover:bg-muted/50 transition-colors"
              >
                <FileText className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground/40" />
                <span className="text-xs leading-snug">{p.title}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Collapsible card that shows first N items with "show more" */
function CollapsibleSection<T>({
  title,
  count,
  previewCount,
  items,
  renderItem,
  emptyText,
}: {
  title: string;
  count: number;
  previewCount: number;
  items: T[];
  renderItem: (item: T) => React.ReactNode;
  emptyText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, previewCount);
  const hasMore = items.length > previewCount;

  return (
    <div className="rounded-lg border border-border/60 p-4">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        {count > 0 && (
          <span className="ml-1.5 text-muted-foreground/40">{count}</span>
        )}
      </h3>
      <div className="space-y-2">
        {visible.map(renderItem)}
        {items.length === 0 && (
          <p className="text-xs text-muted-foreground/40">{emptyText}</p>
        )}
      </div>
      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          {expanded
            ? "Show less"
            : `Show ${items.length - previewCount} more`}
        </button>
      )}
    </div>
  );
}

/** Small colored dot indicating hypothesis status */
function HypothesisStatusDot({ status }: { status: string }) {
  switch (status) {
    case "SUPPORTED":
      return (
        <span className="block h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
      );
    case "REFUTED":
      return (
        <span className="flex h-2 w-2 shrink-0 items-center justify-center rounded-full bg-red-500">
          <span className="block h-px w-1 bg-white" />
        </span>
      );
    case "TESTING":
      return (
        <span className="block h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" />
      );
    case "REVISED":
      return (
        <span className="block h-2 w-2 shrink-0 rounded-full bg-amber-500" />
      );
    case "PROPOSED":
    default:
      return (
        <span className="block h-2 w-2 shrink-0 rounded-full border border-muted-foreground/40" />
      );
  }
}

/** Inline label for approach status */
function ApproachStatusLabel({ status }: { status: string }) {
  const styles: Record<string, string> = {
    PROMISING: "text-emerald-600",
    ACTIVE: "text-blue-600",
    ABANDONED: "text-muted-foreground line-through",
    EXHAUSTED: "text-red-600",
  };
  return (
    <span
      className={`text-[11px] ${styles[status] || "text-muted-foreground"}`}
    >
      {status.toLowerCase()}
    </span>
  );
}

/** A running-experiment job pill */
function RunningJobCard({ job }: { job: ExperimentJob }) {
  const scriptName =
    job.command?.match(/python3?\s+(\S+\.py)/)?.[1] ||
    job.command.slice(0, 40);
  const elapsed = job.startedAt ? formatElapsed(job.startedAt) : "";

  return (
    <div className="flex items-center gap-3 rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-3">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
      <span className="text-sm font-mono">{scriptName}</span>
      <span className="text-xs text-muted-foreground">
        on {job.host.alias}
      </span>
      {elapsed && (
        <span className="text-xs text-muted-foreground/50">{elapsed}</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Timeline card renderers                                            */
/* ------------------------------------------------------------------ */

/** Markdown content with a max collapsed height, gradient fade, and click-to-expand */
function ExpandableMarkdown({ content, maxHeight = 120 }: { content: string; maxHeight?: number }) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [needsExpand, setNeedsExpand] = useState(false);

  useEffect(() => {
    if (contentRef.current) {
      setNeedsExpand(contentRef.current.scrollHeight > maxHeight + 10);
    }
  }, [content, maxHeight]);

  const collapsed = needsExpand && !expanded;

  return (
    <div>
      <div
        ref={contentRef}
        className="text-sm leading-relaxed overflow-hidden transition-all prose prose-sm prose-neutral dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-1.5 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_code]:text-xs [&_pre]:text-xs [&_pre]:my-2"
        style={collapsed ? { maxHeight, maskImage: "linear-gradient(to bottom, black 40%, transparent 100%)", WebkitMaskImage: "linear-gradient(to bottom, black 40%, transparent 100%)" } : undefined}
      >
        <MarkdownRenderer content={content} />
      </div>
      {needsExpand && (
        <div className={`flex justify-center ${collapsed ? "-mt-2" : "mt-1"}`}>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs font-medium text-muted-foreground/70 hover:text-foreground bg-background px-4 py-1 rounded-full border border-border/40 hover:border-border transition-colors shadow-sm"
          >
            {expanded ? "Show less" : "Expand"}
          </button>
        </div>
      )}
    </div>
  );
}

function BreakthroughCard({ content, date }: { content: string; date: string }) {
  return (
    <div className="rounded-lg border-l-[3px] border-l-emerald-500 border border-border/40 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Lightbulb className="h-3.5 w-3.5 text-emerald-500" />
        <span className="text-xs font-medium text-emerald-600">Breakthrough</span>
        <span className="text-[11px] text-muted-foreground/40 ml-auto">{timeAgo(date)}</span>
      </div>
      <ExpandableMarkdown content={content} maxHeight={100} />
    </div>
  );
}

function DecisionCard({ content, date }: { content: string; date: string }) {
  return (
    <div className="rounded-lg border-l-[3px] border-l-blue-500 border border-border/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <ArrowRight className="h-3.5 w-3.5 text-blue-500" />
        <span className="text-xs font-medium text-blue-600">Decision</span>
        <span className="text-[11px] text-muted-foreground/40 ml-auto">{timeAgo(date)}</span>
      </div>
      <ExpandableMarkdown content={content} maxHeight={80} />
    </div>
  );
}

function DeadEndCard({ content, date }: { content: string; date: string }) {
  return (
    <div className="rounded-lg border border-border/30 bg-muted/20 p-3">
      <div className="flex items-center gap-2 mb-1">
        <XCircle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
        <span className="text-xs text-muted-foreground/60">Dead End</span>
        <span className="text-[11px] text-muted-foreground/40 ml-auto">{timeAgo(date)}</span>
      </div>
      <ExpandableMarkdown content={content} maxHeight={60} />
    </div>
  );
}

function ObservationCard({ content, date }: { content: string; date: string }) {
  return (
    <div className="rounded-lg border border-border/40 p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="block h-1.5 w-1.5 rounded-full bg-muted-foreground/30 shrink-0" />
        <span className="text-xs text-muted-foreground/60">Observation</span>
        <span className="text-[11px] text-muted-foreground/40 ml-auto">{timeAgo(date)}</span>
      </div>
      <ExpandableMarkdown content={content} maxHeight={80} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Research Tree                                                      */
/* ------------------------------------------------------------------ */

interface ThemeGroup {
  name: string;
  hypotheses: Hypothesis[];
}

function ResearchTree({
  hypotheses,
  approaches,
  experimentResults,
}: {
  hypotheses: Hypothesis[];
  approaches: Approach[];
  experimentResults: ExperimentResult[];
}) {
  const [expandedThemes, setExpandedThemes] = useState<Set<string>>(
    () => new Set()
  );

  // Group hypotheses by theme — only uses the DB theme field
  // Themes are assigned by the agent via log_finding, not by client-side heuristics
  const themes = useMemo(() => {
    const grouped = new Map<string, Hypothesis[]>();
    for (const h of hypotheses) {
      const theme = h.theme || "General";
      if (!grouped.has(theme)) grouped.set(theme, []);
      grouped.get(theme)!.push(h);
    }
    const result: ThemeGroup[] = [];
    grouped.forEach((hyps, name) => result.push({ name, hypotheses: hyps }));
    return result;
  }, [hypotheses]);

  // Auto-expand all themes on first render
  useEffect(() => {
    if (themes.length > 0 && expandedThemes.size === 0) {
      setExpandedThemes(new Set(themes.map((t) => t.name)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themes]);

  const toggleTheme = (name: string) => {
    setExpandedThemes((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Map approaches to hypotheses via experimentResults
  const approachesForHypothesis = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of experimentResults) {
      if (r.hypothesisId && r.branchId) {
        if (!map.has(r.hypothesisId)) map.set(r.hypothesisId, new Set());
        map.get(r.hypothesisId)!.add(r.branchId);
      }
    }
    return map;
  }, [experimentResults]);

  const approachById = useMemo(() => {
    const m = new Map<string, Approach>();
    for (const a of approaches) {
      m.set(a.id, a);
      if (a.children) {
        for (const c of a.children) {
          m.set(c.id, {
            ...c,
            parentId: a.id,
            description: null,
            children: [],
          });
        }
      }
    }
    return m;
  }, [approaches]);

  if (hypotheses.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 p-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
          Research Structure
        </h3>
        <p className="text-xs text-muted-foreground/40">
          No hypotheses yet
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
        Research Structure
      </h3>
      {themes.map((theme) => (
        <div key={theme.name} className="mb-3">
          <button
            onClick={() => toggleTheme(theme.name)}
            className="flex items-center gap-1.5 text-xs font-medium hover:text-foreground transition-colors"
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${expandedThemes.has(theme.name) ? "" : "-rotate-90"}`}
            />
            {theme.name} ({theme.hypotheses.length})
          </button>
          {expandedThemes.has(theme.name) && (
            <div className="ml-2 mt-1 space-y-1.5 border-l-2 border-border/40 pl-3">
              {theme.hypotheses.map((h) => {
                const approachIds = approachesForHypothesis.get(h.id);
                const statusLabel: Record<string, { text: string; cls: string }> = {
                  SUPPORTED: { text: "supported", cls: "text-emerald-600" },
                  REFUTED: { text: "refuted", cls: "text-red-500" },
                  TESTING: { text: "testing", cls: "text-blue-500" },
                  REVISED: { text: "revised", cls: "text-amber-500" },
                  PROPOSED: { text: "proposed", cls: "text-muted-foreground/50" },
                };
                const sl = statusLabel[h.status] || statusLabel.PROPOSED;
                return (
                  <div key={h.id}>
                    <div className="flex items-baseline gap-1.5 group">
                      <span className={`inline-block h-2 w-2 rounded-full shrink-0 translate-y-[-1px] ${
                        h.status === "SUPPORTED" ? "bg-emerald-500"
                        : h.status === "REFUTED" ? "bg-red-500"
                        : h.status === "TESTING" ? "bg-blue-500 animate-pulse"
                        : h.status === "REVISED" ? "bg-amber-500"
                        : "border border-muted-foreground/40"
                      }`} />
                      <span className="text-xs leading-snug min-w-0">
                        <span className="line-clamp-2 group-hover:line-clamp-none transition-all">{h.statement}</span>
                        <span className={`text-[11px] ${sl.cls}`}>{sl.text}</span>
                      </span>
                    </div>
                    {approachIds && approachIds.size > 0 && (
                      <div className="ml-4 mt-0.5 space-y-0.5">
                        {Array.from(approachIds).map((aId) => {
                          const a = approachById.get(aId);
                          if (!a) return null;
                          const expCount = experimentResults.filter(r => r.branchId === aId).length;
                          return (
                            <div key={aId} className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
                              <span className="text-muted-foreground/30">&rarr;</span>
                              <span>{a.name}</span>
                              {expCount > 0 && <span className="text-muted-foreground/40">({expCount} exp)</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function ResearchDashboard({
  project,
  papers,
  iteration,
  onRefresh,
  logEntries,
  summaryShort,
  summaryFull,
}: ResearchDashboardProps) {
  const {
    hypotheses,
    approaches,
    experimentResults,
    experimentJobs,
    hypothesesById,
  } = project;

  const [filter, setFilter] = useState<FilterKey>("all");
  type RightTab = "status" | "summary" | "papers" | "files" | "figures" | "chat";
  const [rightTab, setRightTab] = useState<RightTab>("status");

  // Keyboard shortcuts (ignored when typing in inputs)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        setRightTab("status");
        return;
      }
      if (isTyping) return;
      if (e.key === "c") setRightTab("chat");
      if (e.key === "`" || e.key === "~") {
        e.preventDefault();
        // Toggle the agent console by clicking its expand button
        const consoleToggle = document.querySelector("[data-console-toggle]") as HTMLElement;
        consoleToggle?.click();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Listen for "open in chat" events from notifications
  const [chatPrefill, setChatPrefill] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent).detail as string;
      setChatPrefill(msg);
      setRightTab("chat");
    };
    window.addEventListener("arcana:open-chat", handler);
    return () => window.removeEventListener("arcana:open-chat", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [previewFile, setPreviewFile] = useState<{ name: string; path: string } | null>(null);
  const [lightboxImage, setLightboxImage] = useState<{ name: string; path: string; caption?: string } | null>(null);
  const [fileSearch, setFileSearch] = useState("");
  const [selectedMetric, setSelectedMetric] = useState<string | null>(null);
  const [metricPickerOpen, setMetricPickerOpen] = useState(false);
  // File explorer data for Files tab
  const [fileTree, setFileTree] = useState<{ name: string; path: string; size: number; isDir: boolean }[]>([]);
  useEffect(() => {
    if (rightTab !== "files") return;
    fetch(`/api/research/${project.id}/files`)
      .then(r => r.json())
      .then(data => {
        const flat: { name: string; path: string; size: number; isDir: boolean }[] = [];
        const walk = (items: { name: string; path: string; size: number; isDir: boolean; children?: unknown[] }[]) => {
          for (const f of items) {
            flat.push({ name: f.name, path: f.path, size: f.size, isDir: f.isDir });
            if (f.isDir && f.children) walk(f.children as typeof items);
          }
        };
        if (data.files) walk(data.files);
        setFileTree(flat);
      })
      .catch(() => {});
  }, [project.id, rightTab]);

  // All figure artifacts for Figures tab
  const [allFigures, setAllFigures] = useState<{ filename: string; path: string; caption: string | null; keyTakeaway: string | null; resultId: string | null }[]>([]);
  useEffect(() => {
    if (rightTab !== "figures") return;
    fetch(`/api/research/${project.id}/figures`)
      .then(r => r.json())
      .then(data => setAllFigures(data.figures || []))
      .catch(() => {});
  }, [project.id, rightTab]);

  // Fetch artifacts (figures) linked to experiments via DB relations
  const [artifactsByResult, setArtifactsByResult] = useState<Map<string, { name: string; path: string }[]>>(new Map());

  useEffect(() => {
    fetch(`/api/research/${project.id}/figures`)
      .then(r => r.json())
      .then(data => {
        const byResult = new Map<string, { name: string; path: string }[]>();
        for (const fig of data.figures || []) {
          if (fig.resultId) {
            if (!byResult.has(fig.resultId)) byResult.set(fig.resultId, []);
            byResult.get(fig.resultId)!.push({ name: fig.filename, path: fig.path });
          }
        }
        setArtifactsByResult(byResult);
      })
      .catch(() => {});
  }, [project.id]);

  // Separate running jobs from finished ones
  const runningJobs = (experimentJobs || []).filter(
    (j) => j.status === "RUNNING"
  );

  // Short summary for collapsed view (from API)
  const summaryIntro = summaryShort || null;

  // Build unified timeline
  const timeline = useMemo(() => {
    const entries: TimelineEntry[] = [];

    // Add log entries (filter out agent_suggestion and tool call logs)
    for (const entry of logEntries || []) {
      if (shouldHideResearchLogFromTimeline(entry)) continue;

      // Determine timeline type
      let type: TimelineEntry["type"];
      if (entry.type === "breakthrough") {
        type = "breakthrough";
      } else if (entry.type === "decision") {
        type = "decision";
      } else if (entry.type === "dead_end") {
        type = "dead_end";
      } else if (entry.type === "observation") {
        // Only show observations with meaningful content
        if (entry.content.length <= 50) continue;
        type = "observation";
      } else {
        // Other types like "question", "user_note" - show as observation
        if (entry.content.length <= 50) continue;
        type = "observation";
      }

      entries.push({
        id: entry.id,
        type,
        date: entry.createdAt,
        content: entry.content,
      });
    }

    // Add experiment results
    for (const result of experimentResults || []) {
      const job = experimentJobs?.find((j) => j.id === result.jobId);
      entries.push({
        id: result.id,
        type: "experiment",
        date: result.createdAt,
        result,
        job,
      });
    }

    // Sort by date descending (newest first)
    entries.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    // Take latest 100
    return entries.slice(0, 100);
  }, [logEntries, experimentResults, experimentJobs]);

  // Filter timeline
  const filteredTimeline = useMemo(() => {
    if (filter === "all") return timeline;
    if (filter === "notebook") {
      return timeline.filter(
        (e) => e.type !== "experiment"
      );
    }
    if (filter === "experiments") {
      return timeline.filter((e) => e.type === "experiment");
    }
    return timeline;
  }, [timeline, filter]);

  // Deduplicate approaches for the research tree
  const rootApproaches = useMemo(() => {
    const raw = (approaches || []).filter((a) => !a.parentId);
    const byName = new Map<string, (typeof raw)[0]>();
    for (const a of raw) {
      const existing = byName.get(a.name);
      if (!existing || a.results.length > existing.results.length) {
        byName.set(a.name, a);
      }
    }
    return Array.from(byName.values());
  }, [approaches]);

  // Collect all available metric names across experiments (excluding params)
  const allMetricNames = useMemo(() => {
    const names = new Map<string, number>(); // name → count
    for (const r of experimentResults || []) {
      if (!r.metrics) continue;
      try {
        const parsed = JSON.parse(r.metrics) as Record<string, unknown>;
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val !== "number") continue;
          if (PARAM_NAMES.test(key)) continue;
          names.set(key, (names.get(key) || 0) + 1);
        }
      } catch { /* skip */ }
    }
    return Array.from(names.entries()).sort((a, b) => b[1] - a[1]);
  }, [experimentResults]);

  // Selected metric (or auto-detect best)
  const activeMetric = selectedMetric || (allMetricNames.length > 0 ? allMetricNames[0][0] : null);

  // Best value for the active metric
  const bestExp = useMemo(() => {
    if (!activeMetric) return null;
    let best: { key: string; value: number } | null = null;
    for (const r of experimentResults || []) {
      if (!r.metrics) continue;
      try {
        const parsed = JSON.parse(r.metrics) as Record<string, unknown>;
        const val = parsed[activeMetric];
        if (typeof val === "number" && (best === null || val > best.value)) {
          best = { key: activeMetric, value: val };
        }
      } catch { /* skip */ }
    }
    return best;
  }, [experimentResults, activeMetric]);

  const brief = parseBrief(project.brief);
  const expCount = experimentResults?.length || 0;

  const FILTERS: FilterKey[] = [
    "all",
    "notebook",
    "experiments",
    "claims",
    "lineage",
  ];

  return (
    <div className="flex gap-6 h-full">
      {/* ============================================================ */}
      {/*  Left: Research Narrative — scrollable with bottom fade       */}
      {/* ============================================================ */}
      <ScrollFadePanel className="flex-1 min-w-0">
        <div className="space-y-3">
        {/* Activity indicator — shows when agent is working */}
        {project.status === "ACTIVE" && runningJobs.length === 0 && (
          <div className="flex items-center gap-2.5 rounded-lg border border-border/40 bg-muted/20 px-4 py-2.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
            <span className="text-xs text-muted-foreground">
              Agent is working — {project.currentPhase} phase
            </span>
          </div>
        )}

        {/* Running jobs */}
        {runningJobs.map((job) => (
          <RunningJobCard key={job.id} job={job} />
        ))}

        {/* Filter chips */}
        <div className="flex gap-1.5 mb-4">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                filter === f
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>

        {/* Claims panel (left-side) */}
        {filter === "claims" && (
          <ClaimLedgerPanel projectId={project.id} onRefresh={onRefresh} />
        )}

        {/* Lineage panel (left-side) */}
        {filter === "lineage" && (
          <LineageAuditPanel projectId={project.id} />
        )}

        {/* Timeline entries */}
        {filter !== "claims" && filter !== "lineage" && (
        <div className="space-y-2">
          {filteredTimeline.map((entry) => {
            switch (entry.type) {
              case "breakthrough":
                return (
                  <BreakthroughCard
                    key={entry.id}
                    content={entry.content || ""}
                    date={entry.date}
                  />
                );
              case "experiment":
                return (
                  <div key={entry.id}>
                    {entry.result?.hypothesisId &&
                      hypothesesById?.[entry.result.hypothesisId] && (
                        <p className="text-xs text-muted-foreground mb-1 ml-1">
                          Testing:{" "}
                          {hypothesesById[entry.result.hypothesisId]?.slice(
                            0,
                            80
                          )}
                          {(hypothesesById[entry.result.hypothesisId]?.length ||
                            0) > 80
                            ? "..."
                            : ""}
                        </p>
                      )}
                    <ExperimentCard
                      result={entry.result!}
                      job={entry.job}
                      hypothesisStatement={
                        entry.result?.hypothesisId
                          ? hypothesesById?.[entry.result.hypothesisId]
                          : undefined
                      }
                      projectId={project.id}
                      artifacts={artifactsByResult.get(entry.result!.id) || []}
                    />
                  </div>
                );
              case "decision":
                return (
                  <DecisionCard
                    key={entry.id}
                    content={entry.content || ""}
                    date={entry.date}
                  />
                );
              case "dead_end":
                return (
                  <DeadEndCard
                    key={entry.id}
                    content={entry.content || ""}
                    date={entry.date}
                  />
                );
              case "observation":
                return (
                  <ObservationCard
                    key={entry.id}
                    content={entry.content || ""}
                    date={entry.date}
                  />
                );
              default:
                return null;
            }
          })}

          {/* Empty state */}
          {filteredTimeline.length === 0 && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <p className="text-sm text-muted-foreground">
                {filter === "all"
                  ? "No activity yet"
                  : `No ${FILTER_LABELS[filter].toLowerCase()} entries to show`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground/50">
                Research activity will appear here as the agent works
              </p>
            </div>
          )}
        </div>
        )}
      </div>
      </ScrollFadePanel>

      {/* ============================================================ */}
      {/*  Right: Tabbed panel — adaptive width                         */}
      {/* ============================================================ */}
      {(() => {
        const isContentTab = rightTab !== "status";
        const panelWidth = isContentTab ? "w-[480px]" : "w-80";
        const imgUrl = (filePath: string) => `/api/research/${project.id}/files/download?path=${encodeURIComponent(filePath)}`;

        const TABS: { key: RightTab; icon: typeof BarChart3; label: string }[] = [
          { key: "status", icon: BarChart3, label: "Status" },
          { key: "summary", icon: BookOpen, label: "Summary" },
          { key: "papers", icon: FileText, label: "Papers" },
          { key: "figures", icon: Image, label: "Figures" },
          { key: "files", icon: FolderOpen, label: "Files" },
          { key: "chat", icon: MessageCircle, label: "Chat" },
        ];

        return (
          <div className={`${panelWidth} shrink-0 flex flex-col transition-all duration-200 ease-in-out`}>
            {/* Tab bar */}
            <div className="flex justify-end border-b border-border/40 shrink-0">
              {TABS.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setRightTab(tab.key)}
                  title={tab.label}
                  className={`flex items-center gap-1 px-2.5 py-2 text-[11px] transition-colors border-b-2 ${
                    rightTab === tab.key
                      ? "text-foreground border-foreground"
                      : "text-muted-foreground/50 border-transparent hover:text-muted-foreground"
                  }`}
                >
                  <tab.icon className="h-3 w-3 shrink-0" />
                  <span className={isContentTab ? "" : "hidden"}>{tab.label}</span>
                </button>
              ))}
            </div>

            {/* Chat tab — rendered outside ScrollFadePanel to avoid gradient over input */}
            {rightTab === "chat" && (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0">
                  <ResearchChat projectId={project.id} projectTitle={project.title} externalOpen embedded prefillMessage={chatPrefill} onPrefillConsumed={() => setChatPrefill(null)} />
                </div>
              </div>
            )}

            {/* Other tab content — with scroll fade */}
            {rightTab !== "chat" && (
            <ScrollFadePanel className="flex-1 min-h-0">
              <div className="p-4">

              {/* STATUS TAB */}
              {rightTab === "status" && (
                <div className="space-y-4">
                  {/* Summary preview */}
                  <div className="rounded-lg border border-border/60 p-4">
                    <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Summary</h3>
                    {(summaryShort || summaryFull) ? (
                      <>
                        <p className="text-sm leading-relaxed text-muted-foreground line-clamp-3">{summaryIntro}</p>
                        <button onClick={() => setRightTab("summary")} className="text-xs text-primary mt-1.5 hover:underline">Read full summary</button>
                      </>
                    ) : (
                      <>
                        <p className="text-sm leading-relaxed text-muted-foreground line-clamp-3">{brief.question || project.brief}</p>
                        <p className="text-xs text-muted-foreground/40 mt-2">Summary will appear after first experiments</p>
                      </>
                    )}
                  </div>

                  {/* Progress */}
                  <div className="rounded-lg border border-border/60 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="relative">
                        <button
                          onClick={() => allMetricNames.length > 1 && setMetricPickerOpen(!metricPickerOpen)}
                          className={`text-xs font-medium uppercase tracking-wide text-muted-foreground ${allMetricNames.length > 1 ? "hover:text-foreground cursor-pointer" : ""}`}
                        >
                          {activeMetric ? activeMetric.replace(/_/g, " ") : "Progress"}
                          {allMetricNames.length > 1 && <ChevronDown className="h-3 w-3 inline ml-0.5" />}
                        </button>
                        {metricPickerOpen && (
                          <div className="absolute left-0 top-full mt-1 w-56 max-h-48 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden rounded-lg border border-border bg-background shadow-lg z-50">
                            {allMetricNames.map(([name, count]) => (
                              <button key={name} onClick={() => { setSelectedMetric(name); setMetricPickerOpen(false); }}
                                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors flex justify-between ${name === activeMetric ? "bg-muted font-medium" : ""}`}>
                                <span className="truncate">{name.replace(/_/g, " ")}</span>
                                <span className="text-muted-foreground/40 shrink-0 ml-2">{count}x</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      {bestExp && <span className="text-sm font-mono font-semibold">{bestExp.value.toFixed(3)}</span>}
                    </div>
                    {expCount >= 2 && activeMetric && <MetricChart results={experimentResults || []} compact metricName={activeMetric} />}
                    <div className="flex gap-3 mt-2 text-xs text-muted-foreground">
                      <span>{expCount} experiment{expCount !== 1 ? "s" : ""}</span>
                      <span>Iteration {iteration?.number || 1}</span>
                      <button onClick={() => setRightTab("papers")} className="hover:text-foreground transition-colors underline underline-offset-2 decoration-dotted">{papers.length} papers</button>
                    </div>
                  </div>

                  {/* Research Tree */}
                  <ResearchTree hypotheses={hypotheses} approaches={rootApproaches} experimentResults={experimentResults || []} />
                </div>
              )}

              {/* SUMMARY TAB */}
              {rightTab === "summary" && (
                <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_p]:text-sm [&_p]:leading-relaxed [&_p]:my-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_li]:text-sm [&_code]:text-xs [&_pre]:text-xs [&_pre]:my-2">
                  {summaryFull ? (
                    <MarkdownRenderer content={summaryFull} />
                  ) : (
                    <p className="text-sm text-muted-foreground/50">Summary will appear after first experiments complete.</p>
                  )}
                </div>
              )}

              {/* PAPERS TAB */}
              {rightTab === "papers" && (
                <div className="space-y-1 -mx-4">
                  {papers.map(p => {
                    let authors = "";
                    if (p.authors) {
                      try { authors = JSON.parse(p.authors).slice(0, 3).join(", "); } catch { authors = p.authors; }
                      if (authors.length > 60) authors = authors.slice(0, 60) + "...";
                    }
                    const status = p.processingStatus;
                    const hasIssue = status && !["COMPLETED", "NEEDS_DEFERRED"].includes(status);
                    const statusLabel: Record<string, { text: string; cls: string }> = {
                      PENDING: { text: "queued", cls: "text-muted-foreground/50" },
                      EXTRACTING_TEXT: { text: "extracting...", cls: "text-blue-500" },
                      FAILED: { text: "failed", cls: "text-red-500" },
                      NO_PDF: { text: "no PDF", cls: "text-amber-500" },
                      BATCH_PROCESSING: { text: "processing...", cls: "text-blue-500" },
                    };
                    const sl = status ? statusLabel[status] : null;
                    return (
                      <Link key={p.id} href={`/papers/${p.id}`}
                        className="block px-4 py-2.5 hover:bg-muted/50 transition-colors border-b border-border/10">
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm leading-snug font-medium">{p.title}</p>
                            {(authors || p.year) && (
                              <p className="text-[11px] text-muted-foreground/50 mt-0.5">
                                {authors}{authors && p.year ? " · " : ""}{p.year || ""}
                              </p>
                            )}
                          </div>
                          {hasIssue && sl && (
                            <span className={`text-[11px] shrink-0 mt-0.5 ${sl.cls}`}>{sl.text}</span>
                          )}
                        </div>
                      </Link>
                    );
                  })}
                  {papers.length === 0 && <p className="text-sm text-muted-foreground/50 px-4">No papers in collection yet.</p>}
                </div>
              )}

              {/* FIGURES TAB — falls back to file scan if no artifacts in DB */}
              {rightTab === "figures" && (() => {
                // If DB has artifacts, show them. Otherwise scan files directly.
                if (allFigures.length > 0) {
                  return (
                    <div className="space-y-3">
                      {allFigures.map(fig => (
                        <button key={fig.filename} onClick={() => setLightboxImage({ name: fig.filename, path: fig.path, caption: fig.caption || fig.keyTakeaway || undefined })}
                          className="w-full text-left rounded-lg border border-border/40 overflow-hidden hover:border-foreground/20 transition-colors">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={imgUrl(fig.path)} alt={fig.filename} className="w-full object-contain bg-white" loading="lazy" />
                          <div className="px-3 py-2 bg-muted/20 space-y-0.5">
                            {fig.keyTakeaway && <p className="text-xs font-medium text-foreground/80">{fig.keyTakeaway}</p>}
                            {fig.caption && <p className="text-[11px] text-muted-foreground/60 leading-snug">{fig.caption}</p>}
                            <p className="text-[11px] text-muted-foreground/30 font-mono">{fig.filename}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  );
                }
                // Fallback: show figure files from the file tree
                const figureFiles = fileTree.filter(f => !f.isDir && /\.(png|jpg|jpeg|svg|gif)$/i.test(f.name));
                if (figureFiles.length === 0) return <p className="text-sm text-muted-foreground/50">No figures yet.</p>;
                return (
                  <div className="space-y-3">
                    {figureFiles.map(f => {
                      const label = f.name.replace(/\.(png|jpg|jpeg|svg|gif)$/i, "").replace(/^fig_?\d*_?/, "").replace(/_/g, " ").trim();
                      return (
                        <button key={f.path} onClick={() => setLightboxImage({ name: f.name, path: f.path })}
                          className="w-full text-left rounded-lg border border-border/40 overflow-hidden hover:border-foreground/20 transition-colors">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={imgUrl(f.path)} alt={f.name} className="w-full object-contain bg-white" loading="lazy" />
                          <div className="px-3 py-2 bg-muted/20">
                            <p className="text-xs font-medium text-foreground/80">{label || f.name}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}

              {/* FILES TAB */}
              {rightTab === "files" && (
                <div className="-mx-4">
                  <div className="px-4 pb-2">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/40" />
                      <input
                        value={fileSearch}
                        onChange={(e) => setFileSearch(e.target.value)}
                        placeholder="Filter files..."
                        className="h-8 w-full rounded-md border border-border/60 bg-background pl-8 pr-3 text-xs outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-foreground/20"
                      />
                    </div>
                  </div>
                  <div className="space-y-0.5">
                  {fileTree.filter(f => !f.isDir).filter(f => !fileSearch || f.name.toLowerCase().includes(fileSearch.toLowerCase())).map(f => {
                    const ext = f.name.split(".").pop()?.toLowerCase() || "";
                    const isImage = ["png", "jpg", "jpeg", "svg", "gif"].includes(ext);
                    const isCode = ["py", "js", "ts", "sh", "yaml", "yml", "toml", "cfg", "ini"].includes(ext);
                    const isText = ["txt", "md", "log", "json", "csv", "tsv"].includes(ext);
                    const isPreviewable = (isImage || isCode || isText) && f.size < 500 * 1024;
                    const sizeStr = f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)}MB` : `${Math.round(f.size / 1024)}KB`;
                    const Icon = isImage ? Image : isCode ? ScrollText : FileText;

                    return (
                      <div key={f.path} className="flex items-center gap-2 px-4 py-1.5 hover:bg-muted/30 transition-colors group">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                        {isImage ? (
                          <button onClick={() => setLightboxImage({ name: f.name, path: f.path })}
                            className="text-sm truncate flex-1 min-w-0 text-left hover:underline">{f.name}</button>
                        ) : isPreviewable ? (
                          <button onClick={() => setPreviewFile({ name: f.name, path: f.path })}
                            className="text-sm truncate flex-1 min-w-0 text-left hover:underline">{f.name}</button>
                        ) : (
                          <span className="text-sm truncate flex-1 min-w-0 text-muted-foreground/60">{f.name}</span>
                        )}
                        <span className="text-[11px] text-muted-foreground/30 shrink-0">{sizeStr}</span>
                        <a href={`/api/research/${project.id}/files/download?path=${encodeURIComponent(f.path)}`}
                          download onClick={e => e.stopPropagation()}
                          className="text-[11px] text-muted-foreground/30 hover:text-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">↓</a>
                      </div>
                    );
                  })}
                  {fileTree.filter(f => !f.isDir).filter(f => !fileSearch || f.name.toLowerCase().includes(fileSearch.toLowerCase())).length === 0 && (
                    <p className="text-sm text-muted-foreground/50 px-4 py-4">{fileSearch ? "No files match" : "No files yet."}</p>
                  )}
                  </div>
                </div>
              )}

              {/* File preview modal — uses the existing FilePreview with highlight.js */}
              {previewFile && (
                <FilePreview
                  projectId={project.id}
                  file={previewFile}
                  onClose={() => setPreviewFile(null)}
                  onDownload={(filePath, name) => {
                    const a = document.createElement("a");
                    a.href = `/api/research/${project.id}/files/download?path=${encodeURIComponent(filePath)}`;
                    a.download = name;
                    a.click();
                  }}
                />
              )}

              {/* Image lightbox */}
              {lightboxImage && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => setLightboxImage(null)}>
                  <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center" onClick={e => e.stopPropagation()}>
                    <div className="absolute -top-10 right-0 flex gap-2">
                      <a href={imgUrl(lightboxImage.path)} download
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors">
                        <ChevronDown className="h-4 w-4" />
                      </a>
                      <button onClick={() => setLightboxImage(null)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors">
                        <XCircle className="h-4 w-4" />
                      </button>
                    </div>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imgUrl(lightboxImage.path)} alt={lightboxImage.name}
                      className="max-w-[85vw] max-h-[80vh] min-w-[40vw] object-contain rounded-lg bg-white" />
                    <div className="mt-3 text-center max-w-2xl">
                      {lightboxImage.caption && <p className="text-sm text-white/80">{lightboxImage.caption}</p>}
                      <p className="text-xs text-white/40 mt-1 font-mono">{lightboxImage.name}</p>
                    </div>
                  </div>
                </div>
              )}

              </div>
            </ScrollFadePanel>
            )}
          </div>
        );
      })()}
    </div>
  );
}
