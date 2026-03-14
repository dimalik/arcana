"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Loader2,
  FlaskConical,
  Upload,
  ArrowRight,
  Layers,
  FileDown,
  MoreVertical,
  Trash2,
  RefreshCw,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
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

type Mode = "investigate" | "review";

const RUNNING_STATUSES = ["PENDING", "PLANNING", "MAPPING", "GRAPHING", "EXPANDING", "REDUCING", "COMPOSING"];

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
  const [mode, setMode] = useState<Mode>("investigate");

  useEffect(() => {
    Promise.all([
      fetch("/api/research").then((r) => r.json()),
      fetch("/api/synthesis").then((r) => r.json()),
    ])
      .then(([projectData, reviewData]) => {
        if (Array.isArray(projectData)) setProjects(projectData);
        if (Array.isArray(reviewData)) setReviews(reviewData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (mode === "investigate") {
      const t = topic.trim();
      if (!t) return;
      setCreating(true);
      try {
        const res = await fetch("/api/research", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: t, question: t, methodology: "experimental" }),
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
    } else {
      const t = topic.trim();
      if (!t) return;
      setCreating(true);
      try {
        const res = await fetch("/api/synthesis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: t,
            mode: "auto",
            depth: "balanced",
          }),
        });
        if (!res.ok) throw new Error();
        const { id } = await res.json();
        toast.success("Review started");
        router.push(`/synthesis/${id}`);
      } catch {
        toast.error("Failed to start review");
      } finally {
        setCreating(false);
      }
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
  const handleDeleteProject = async (id: string) => {
    if (!confirm("Delete this project?")) return;
    const res = await fetch(`/api/research/${id}`, { method: "DELETE" });
    if (res.ok) {
      setProjects((prev) => prev.filter((p) => p.id !== id));
      toast.success("Project deleted");
    } else {
      toast.error("Failed to delete project");
    }
  };

  // Review actions
  const handleDeleteReview = async (id: string) => {
    if (!confirm("Delete this review?")) return;
    const res = await fetch(`/api/synthesis/${id}`, { method: "DELETE" });
    if (res.ok) {
      setReviews((prev) => prev.filter((r) => r.id !== id));
      toast.success("Review deleted");
    }
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
          <Link
            href="/research/new"
            className="inline-flex items-center gap-1 rounded-md text-[11px] text-muted-foreground/60 hover:text-foreground px-2 py-1 hover:bg-accent transition-colors"
          >
            <Plus className="h-3 w-3" />
            Advanced
          </Link>
        </div>
      </div>

      {/* Unified create area */}
      <div className="space-y-3">
        {/* Mode toggle + input */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            {mode === "investigate" ? (
              <FlaskConical className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/30" />
            ) : (
              <Layers className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/30" />
            )}
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder={mode === "investigate" ? "What do you want to investigate?" : "What topic should be reviewed across your papers?"}
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

        {/* Mode toggle */}
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg bg-muted/30 p-0.5 gap-0.5">
            <button
              onClick={() => setMode("investigate")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all ${
                mode === "investigate"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground/60 hover:text-muted-foreground"
              }`}
            >
              <FlaskConical className="h-3 w-3" />
              Investigate
            </button>
            <button
              onClick={() => setMode("review")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all ${
                mode === "review"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground/60 hover:text-muted-foreground"
              }`}
            >
              <Layers className="h-3 w-3" />
              Review
            </button>
          </div>
          {mode === "investigate" && (
            <span className="text-[10px] text-muted-foreground/30">Hypothesis-driven research with agent</span>
          )}
          {mode === "review" && (
            <span className="text-[10px] text-muted-foreground/30">Auto-finds matching papers and synthesizes a literature review</span>
          )}
        </div>

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
            No research yet. Type a topic above to investigate, or switch to Review to synthesize papers.
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
                    <ProjectCard key={item.id} project={item as Project} onDelete={handleDeleteProject} />
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
                  <ProjectCard key={p.id} project={p} onDelete={handleDeleteProject} />
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
                    <ProjectCard key={item.id} project={item as Project} onDelete={handleDeleteProject} />
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
                      <ProjectCard key={item.id} project={item as Project} onDelete={handleDeleteProject} />
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
    </div>
  );
}
