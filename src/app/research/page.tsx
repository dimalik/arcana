"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Loader2,
  FlaskConical,
  Upload,
  ArrowRight,
  Layers,
  FileDown,
  MoreVertical,
  Trash2,
  RefreshCw,
  ChevronDown,
  Search,
  BarChart3,
  Compass,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ProjectCard } from "@/components/research/project-card";
import { toast } from "sonner";

type Project = {
  id: string;
  title: string;
  status: string;
  methodology: string | null;
  currentPhase: string;
  createdAt: string;
  updatedAt: string;
  brief: string;
  iterations: { number: number; status: string }[];
  collection: { _count: { papers: number } } | null;
  _count: { hypotheses: number };
  log?: { type: string; content: string; createdAt: string }[];
};

type Review = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  phase: string | null;
  progress: number;
  paperCount: number;
  depth: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
};

const RUNNING_STATUSES = ["PENDING", "PLANNING", "MAPPING", "GRAPHING", "EXPANDING", "REDUCING", "COMPOSING"];

// ── Methodology inference from topic text ─────────────────────────

const METHODOLOGY_PATTERNS: { id: string; patterns: RegExp }[] = [
  { id: "analytical", patterns: /\b(survey|review|comparison|compare\s+(?:different|various)|landscape|state.of.the.art|sota|meta.analysis|systematic\s+review|literature)\b/i },
  { id: "design_science", patterns: /\b(build|implement|create|design|system|tool|framework|prototype|architecture|pipeline|platform)\b/i },
  { id: "exploratory", patterns: /\b(explore|overview|what\s+is|how\s+does|understand|investigate\s+the\s+landscape|broad|emerging)\b/i },
];

function inferMethodology(topic: string): string {
  const t = topic.toLowerCase();
  for (const { id, patterns } of METHODOLOGY_PATTERNS) {
    if (patterns.test(t)) return id;
  }
  return "experimental";
}

const METHODOLOGY_META: Record<string, { label: string; icon: typeof FlaskConical; hint: string }> = {
  experimental: { label: "Experiment", icon: FlaskConical, hint: "Hypotheses + GPU experiments" },
  analytical: { label: "Survey", icon: Search, hint: "Literature review + analysis" },
  design_science: { label: "Build", icon: BarChart3, hint: "Design, implement, evaluate" },
  exploratory: { label: "Explore", icon: Compass, hint: "Open-ended investigation" },
};

// ── Review Card ─────────────────────────────────────────────────────

function ReviewCard({ review, onDelete, onExport, onRegenerateTitle }: {
  review: Review;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onRegenerateTitle: (id: string) => void;
}) {
  const isRunning = RUNNING_STATUSES.includes(review.status);
  const isComplete = review.status === "COMPLETED";
  const isGuiding = review.status === "GUIDING";
  const percent = Math.round(review.progress * 100);

  const timeAgo = (() => {
    const diff = Date.now() - new Date(review.updatedAt || review.createdAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(review.updatedAt || review.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  })();

  return (
    <div className="block group">
      <div className={`relative rounded-lg border transition-all duration-150 ${
        isRunning
          ? "border-blue-500/20 bg-blue-500/[0.02] hover:border-blue-500/40"
          : isGuiding
          ? "border-indigo-500/20 bg-indigo-500/[0.02] hover:border-indigo-500/40"
          : "border-border/50 hover:border-border"
      }`}>
        {isRunning && (
          <div className="absolute left-0 top-3 bottom-3 w-[2px] rounded-full bg-blue-500/60" />
        )}
        {isGuiding && (
          <div className="absolute left-0 top-3 bottom-3 w-[2px] rounded-full bg-indigo-500/60" />
        )}

        <div className="px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Link
                href={`/synthesis/${review.id}`}
                className="text-[13px] font-medium truncate block group-hover:text-foreground transition-colors"
              >
                {review.title}
              </Link>
              {review.description && (
                <p className="text-[11px] text-muted-foreground/70 mt-0.5 line-clamp-1">
                  {review.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0 mt-0.5">
              {isComplete && (
                <button
                  onClick={(e) => { e.preventDefault(); onExport(review.id); }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors"
                  title="Export PDF"
                >
                  <FileDown className="h-3 w-3" />
                </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/30 hover:text-foreground hover:bg-accent transition-colors">
                    <MoreVertical className="h-3 w-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onClick={() => onRegenerateTitle(review.id)} className="text-xs gap-2">
                    <RefreshCw className="h-3.5 w-3.5" />
                    Regenerate title
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onDelete(review.id)} className="text-xs gap-2 text-destructive focus:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="text-[10px] text-muted-foreground/50 ml-0.5">{timeAgo}</span>
            </div>
          </div>

          {/* Type + status */}
          <div className="flex items-center gap-2 mt-2">
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/40">
              <Layers className="h-2.5 w-2.5" />
              Review
            </span>
            <span className="text-[10px] text-muted-foreground/30">{review.paperCount} papers</span>
            {review.depth !== "balanced" && (
              <span className="text-[10px] text-muted-foreground/30">{review.depth}</span>
            )}
            {isRunning && (
              <span className="text-[10px] text-blue-400">{review.phase || review.status}</span>
            )}
            {isGuiding && (
              <span className="text-[10px] text-indigo-400">awaiting guidance</span>
            )}
            {review.status === "FAILED" && (
              <span className="text-[10px] text-destructive">failed</span>
            )}
          </div>

          {isRunning && (
            <div className="mt-2">
              <div className="h-[3px] rounded-full bg-muted overflow-hidden w-32">
                <div className="h-full rounded-full bg-blue-500/70 transition-all" style={{ width: `${percent}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────

export default function ResearchPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [topic, setTopic] = useState("");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string; type: "project" | "review" } | null>(null);
  const [methodologyOverride, setMethodologyOverride] = useState<string | null>(null);
  const [constraints, setConstraints] = useState("");
  const [remoteHosts, setRemoteHosts] = useState<{ id: string; alias: string; gpuType: string | null }[]>([]);
  const [hostsLoading, setHostsLoading] = useState(true);
  const [selectedResources, setSelectedResources] = useState<"all" | "local" | Set<string>>("all");

  // Infer methodology from topic (when user hasn't manually picked)
  const inferredMethodology = useMemo(() => inferMethodology(topic), [topic]);
  const methodology = methodologyOverride ?? inferredMethodology;
  const isAutoMethodology = methodologyOverride === null;

  // Fetch available GPU hosts
  useEffect(() => {
    fetch("/api/research/remote-hosts")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setRemoteHosts(data.map((h: { id: string; alias: string; gpuType: string | null }) => ({ id: h.id, alias: h.alias, gpuType: h.gpuType })));
      })
      .catch(() => {})
      .finally(() => setHostsLoading(false));
  }, []);

  const fetchData = useCallback(() => {
    return Promise.all([
      fetch("/api/research").then((r) => r.json()),
      fetch("/api/synthesis").then((r) => r.json()),
    ])
      .then(([projectData, reviewData]) => {
        if (Array.isArray(projectData)) setProjects(projectData);
        if (Array.isArray(reviewData)) setReviews(reviewData);
      })
      .catch(() => {});
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchData().finally(() => setLoading(false));
  }, [fetchData]);

  // Poll every 10s when there are active/running items
  const hasActive = projects.some((p) => p.status === "ACTIVE") || reviews.some((r) => RUNNING_STATUSES.includes(r.status));
  useEffect(() => {
    if (!hasActive) return;
    const interval = setInterval(fetchData, 10_000);
    return () => clearInterval(interval);
  }, [hasActive, fetchData]);

  const handleCreate = async () => {
    const t = topic.trim();
    if (!t) return;
    setCreating(true);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: t,
          question: t,
          methodology,
          ...(constraints.trim() ? { constraints: constraints.trim() } : {}),
          resources: selectedResources === "all" ? "all"
            : selectedResources === "local" ? "local"
            : Array.from(selectedResources),
        }),
      });
      if (!res.ok) throw new Error();
      const project = await res.json();
      toast.success("Project created");
      router.push(`/research/${project.id}`);
    } catch {
      toast.error("Failed to create project");
    } finally {
      setCreating(false);
    }
  };

  const handleImport = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImporting(true);
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const res = await fetch("/api/research/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Import failed");
        }
        const result = await res.json();
        toast.success(`Imported "${result.title}"`);
        router.push(`/research/${result.id}`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to import");
      } finally {
        setImporting(false);
      }
    };
    input.click();
  };

  // Project actions
  const handleDeleteProject = (id: string) => {
    const proj = projects.find((p) => p.id === id);
    setConfirmDelete({ id, title: proj?.title || "this project", type: "project" });
  };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    const { id, type } = confirmDelete;
    setConfirmDelete(null);
    if (type === "project") {
      const res = await fetch(`/api/research/${id}`, { method: "DELETE" });
      if (res.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== id));
        toast.success("Project deleted");
      } else {
        toast.error("Failed to delete project");
      }
    } else {
      const res = await fetch(`/api/synthesis/${id}`, { method: "DELETE" });
      if (res.ok) {
        setReviews((prev) => prev.filter((r) => r.id !== id));
        toast.success("Review deleted");
      }
    }
  };

  const handleProjectStatusChange = async (id: string, status: string) => {
    const res = await fetch(`/api/research/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      setProjects((prev) => prev.map((p) => p.id === id ? { ...p, status } : p));
      const label = status === "PAUSED" ? "paused" : status === "ACTIVE" ? "resumed" : status === "COMPLETED" ? "completed" : status;
      toast.success(`Project ${label}`);
    } else {
      toast.error("Failed to update project");
    }
  };

  // Review actions
  const handleDeleteReview = (id: string) => {
    const rev = reviews.find((r) => r.id === id);
    setConfirmDelete({ id, title: rev?.title || "this review", type: "review" });
  };

  const handleExportReview = async (id: string) => {
    try {
      const res = await fetch(`/api/synthesis/${id}/export?format=pdf`);
      if (!res.ok) { toast.error("Export failed"); return; }
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] || "synthesis.pdf";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Export failed");
    }
  };

  const handleRegenerateTitle = async (id: string) => {
    const res = await fetch(`/api/synthesis/${id}`, { method: "PATCH" });
    if (res.ok) {
      const { title, description } = await res.json();
      setReviews((prev) =>
        prev.map((r) => (r.id === id ? { ...r, title, description: description ?? r.description } : r))
      );
    }
  };

  // Summary text for collapsed options
  const resourceSummary = (() => {
    if (selectedResources === "local") return "Local";
    if (selectedResources === "all") {
      if (remoteHosts.length === 0) return "Local";
      return "Auto";
    }
    const names = remoteHosts.filter((h) => (selectedResources as Set<string>).has(h.id)).map((h) => h.alias);
    return names.join(", ");
  })();

  // Categorize
  const active = projects.filter((p) => p.status === "ACTIVE");
  const paused = projects.filter((p) => p.status === "PAUSED");
  const completedProjects = projects.filter((p) => p.status === "COMPLETED");
  const archived = projects.filter((p) => p.status === "ARCHIVED");

  const runningReviews = reviews.filter((r) => RUNNING_STATUSES.includes(r.status));
  const guidingReviews = reviews.filter((r) => r.status === "GUIDING");
  const completedReviews = reviews.filter((r) => r.status === "COMPLETED");
  const failedReviews = reviews.filter((r) => r.status === "FAILED" || r.status === "CANCELLED");

  const running = [...active, ...runningReviews, ...guidingReviews];
  const completed = [...completedProjects, ...completedReviews];
  const archivedAll = [...archived, ...failedReviews];
  const hasItems = projects.some((p) => p.status !== "ARCHIVED") || reviews.some((r) => !["FAILED", "CANCELLED"].includes(r.status));

  const canCreate = topic.trim().length > 0;
  const MethIcon = METHODOLOGY_META[methodology]?.icon ?? FlaskConical;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-medium tracking-wide text-muted-foreground/80 uppercase">Research</h1>
        <div className="flex items-center gap-1">
          <button
            onClick={handleImport}
            disabled={importing}
            className="inline-flex items-center gap-1 rounded-md text-[11px] text-muted-foreground/60 hover:text-foreground px-2 py-1 hover:bg-accent transition-colors disabled:opacity-50"
            title="Import project"
          >
            {importing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
            Import
          </button>
        </div>
      </div>

      {/* Create area */}
      <div className="space-y-0">
        {/* Input row */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <FlaskConical className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/30" />
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="What do you want to investigate?"
              className="w-full rounded-lg border border-border/60 bg-muted/20 pl-9 pr-3 py-2.5 text-sm placeholder:text-muted-foreground/30 focus:outline-none focus:border-foreground/20 focus:bg-muted/30 transition-all"
              disabled={creating}
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={creating || !canCreate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-foreground text-background px-4 py-2.5 text-xs font-medium hover:bg-foreground/90 transition-colors disabled:opacity-30 shrink-0"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
          </button>
        </div>

        {/* Settings summary strip — always visible */}
        <button
          onClick={() => setShowOptions(!showOptions)}
          className="w-full flex items-center gap-2 px-1 py-1.5 group text-left"
        >
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <SlidersHorizontal className="h-2.5 w-2.5 text-muted-foreground/25 shrink-0" />
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/40">
              <MethIcon className="h-2.5 w-2.5" />
              {METHODOLOGY_META[methodology]?.label ?? methodology}
              {isAutoMethodology && <span className="text-muted-foreground/25">auto</span>}
            </span>
            <span className="text-muted-foreground/15">·</span>
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/40">
              {remoteHosts.length > 0 && selectedResources !== "local" && <Server className="h-2.5 w-2.5" />}
              {resourceSummary}
            </span>
            {constraints.trim() && (
              <>
                <span className="text-muted-foreground/15">·</span>
                <span className="text-[10px] text-muted-foreground/30 truncate max-w-[200px]">
                  {constraints.trim()}
                </span>
              </>
            )}
          </div>
          <ChevronDown className={`h-2.5 w-2.5 text-muted-foreground/25 group-hover:text-muted-foreground/50 transition-all shrink-0 ${showOptions ? "rotate-180" : ""}`} />
        </button>

        {/* Expanded options panel */}
        {showOptions && (
          <div className="space-y-3 rounded-lg border border-border/40 bg-muted/10 p-3 animate-in fade-in-0 slide-in-from-top-1 duration-150">
            {/* Research approach */}
            <div className="space-y-1.5">
              <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">Approach</span>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(METHODOLOGY_META).map(([id, m]) => (
                  <button
                    key={id}
                    onClick={() => setMethodologyOverride(methodologyOverride === id ? null : id)}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition-all border ${
                      methodology === id
                        ? "border-foreground/20 bg-foreground/5 text-foreground font-medium"
                        : "border-transparent text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50"
                    }`}
                    title={m.hint}
                  >
                    <m.icon className="h-3 w-3" />
                    {m.label}
                    {methodology === id && isAutoMethodology && (
                      <span className="text-[9px] text-muted-foreground/30 ml-0.5">auto</span>
                    )}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/30">
                {methodology === "experimental" && "Will form hypotheses, write experiment code, run on GPU, analyze results"}
                {methodology === "analytical" && "Deep literature search, systematic comparison, synthesis and critique"}
                {methodology === "design_science" && "Iterative design, build, evaluate cycle with artifacts"}
                {methodology === "exploratory" && "Broad search across angles, identify patterns and gaps"}
                {isAutoMethodology && " — inferred from topic, click to override"}
              </p>
            </div>

            {/* Resource selection */}
            <div className="space-y-1.5">
              <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">Resources</span>
              {hostsLoading ? (
                <span className="text-[10px] text-muted-foreground/30">Loading hosts...</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => setSelectedResources("all")}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition-all border ${
                      selectedResources === "all"
                        ? "border-foreground/20 bg-foreground/5 text-foreground font-medium"
                        : "border-transparent text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    Auto
                  </button>
                  <button
                    onClick={() => setSelectedResources("local")}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition-all border ${
                      selectedResources === "local"
                        ? "border-foreground/20 bg-foreground/5 text-foreground font-medium"
                        : "border-transparent text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    Local only
                  </button>
                  {remoteHosts.map((h) => {
                    const isSelected = selectedResources === "all" || (selectedResources instanceof Set && selectedResources.has(h.id));
                    return (
                      <button
                        key={h.id}
                        onClick={() => {
                          if (selectedResources === "all" || selectedResources === "local") {
                            setSelectedResources(new Set([h.id]));
                          } else {
                            const next = new Set(selectedResources);
                            if (next.has(h.id)) {
                              next.delete(h.id);
                              if (next.size === 0) setSelectedResources("all");
                              else setSelectedResources(next);
                            } else {
                              next.add(h.id);
                              if (next.size === remoteHosts.length) setSelectedResources("all");
                              else setSelectedResources(next);
                            }
                          }
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition-all border ${
                          isSelected
                            ? "border-foreground/20 bg-foreground/5 text-foreground font-medium"
                            : "border-transparent text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50"
                        }`}
                      >
                        <Server className="h-3 w-3" />
                        {h.alias}
                        {h.gpuType && <span className="text-muted-foreground/40">{h.gpuType}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground/30">
                {selectedResources === "all" && remoteHosts.length > 0 && "Agent chooses where to run based on task needs"}
                {selectedResources === "all" && remoteHosts.length === 0 && "No remote hosts configured — will run locally"}
                {selectedResources === "local" && "No remote GPU access — agent will only use local execution"}
                {selectedResources instanceof Set && (() => {
                  const names = remoteHosts.filter((h) => (selectedResources as Set<string>).has(h.id)).map((h) => h.alias);
                  return `Experiments will run on ${names.join(", ")}`;
                })()}
              </p>
            </div>

            {/* Constraints / focus */}
            <div className="space-y-1.5">
              <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">Focus & constraints <span className="normal-case tracking-normal">(optional)</span></span>
              <textarea
                value={constraints}
                onChange={(e) => setConstraints(e.target.value)}
                placeholder="e.g., Only open-source models, focus on transformer architectures, must run on single GPU, compare at least 3 baselines..."
                className="w-full rounded-md border border-border/40 bg-background/50 px-3 py-2 text-[12px] placeholder:text-muted-foreground/25 focus:outline-none focus:border-foreground/20 transition-all resize-none"
                rows={2}
              />
            </div>
          </div>
        )}

      </div>

      {/* Project list */}
      {loading ? (
        <div className="space-y-3 pt-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] w-full rounded-lg" />
          ))}
        </div>
      ) : !hasItems ? (
        <div className="rounded-lg border border-dashed border-border/40 py-12 text-center">
          <p className="text-xs text-muted-foreground/50">
            No research yet. Type a topic above to start investigating.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {running.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <h2 className="text-[11px] text-muted-foreground/50 uppercase tracking-wider">Running</h2>
                <span className="text-[10px] text-muted-foreground/30">{running.length}</span>
              </div>
              <div className="space-y-2">
                {running.map((item) =>
                  "methodology" in item ? (
                    <ProjectCard key={item.id} project={item as Project} onDelete={handleDeleteProject} onStatusChange={handleProjectStatusChange} />
                  ) : (
                    <ReviewCard
                      key={item.id}
                      review={item as Review}
                      onDelete={handleDeleteReview}
                      onExport={handleExportReview}
                      onRegenerateTitle={handleRegenerateTitle}
                    />
                  )
                )}
              </div>
            </section>
          )}

          {paused.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-amber-500/60" />
                <h2 className="text-[11px] text-muted-foreground/50 uppercase tracking-wider">Paused</h2>
                <span className="text-[10px] text-muted-foreground/30">{paused.length}</span>
              </div>
              <div className="space-y-2">
                {paused.map((p) => (
                  <ProjectCard key={p.id} project={p} onDelete={handleDeleteProject} onStatusChange={handleProjectStatusChange} />
                ))}
              </div>
            </section>
          )}

          {completed.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="text-[11px] text-muted-foreground/40 uppercase tracking-wider">Completed</h2>
                <span className="text-[10px] text-muted-foreground/30">{completed.length}</span>
              </div>
              <div className="space-y-1.5">
                {completed.map((item) =>
                  "methodology" in item ? (
                    <ProjectCard key={item.id} project={item as Project} onDelete={handleDeleteProject} onStatusChange={handleProjectStatusChange} />
                  ) : (
                    <ReviewCard
                      key={item.id}
                      review={item as Review}
                      onDelete={handleDeleteReview}
                      onExport={handleExportReview}
                      onRegenerateTitle={handleRegenerateTitle}
                    />
                  )
                )}
              </div>
            </section>
          )}

          {archivedAll.length > 0 && (
            <section>
              <button
                onClick={() => setShowArchived(!showArchived)}
                className="text-[11px] text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors"
              >
                {showArchived ? "Hide" : "Show"} {archivedAll.length} archived
              </button>
              {showArchived && (
                <div className="space-y-1.5 mt-2 opacity-50">
                  {archivedAll.map((item) =>
                    "methodology" in item ? (
                      <ProjectCard key={item.id} project={item as Project} onDelete={handleDeleteProject} onStatusChange={handleProjectStatusChange} />
                    ) : (
                      <ReviewCard
                        key={item.id}
                        review={item as Review}
                        onDelete={handleDeleteReview}
                        onExport={handleExportReview}
                        onRegenerateTitle={handleRegenerateTitle}
                      />
                    )
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle className="text-sm">Delete {confirmDelete?.type}?</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">{confirmDelete?.title}</span> will be permanently deleted. This cannot be undone.
          </DialogDescription>
          <DialogFooter className="gap-2 sm:gap-0">
            <button
              onClick={() => setConfirmDelete(null)}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={executeDelete}
              className="rounded-md bg-destructive px-3 py-1.5 text-xs text-destructive-foreground hover:bg-destructive/90 transition-colors"
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
