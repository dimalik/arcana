"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pause, Play, MoreVertical, Loader2, RotateCcw, Download, FileText, FolderArchive, Check, Target } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { ResearchDashboard } from "@/components/research/research-dashboard";
import { AgentActivityBar, AgentActivityHandle } from "@/components/research/agent-activity-bar";
import { BenchmarkPanel } from "@/components/research/benchmark-panel";
import { NotificationBell } from "@/components/research/notification-bell";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

interface Paper {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  summary: string | null;
  abstract: string | null;
  processingStatus: string | null;
}

interface Step {
  id: string;
  type: string;
  status: string;
  title: string;
  description: string | null;
  output: string | null;
  input: string | null;
  agentSessionId: string | null;
  discoveryId: string | null;
  synthesisId: string | null;
  sortOrder: number;
}

interface Iteration {
  id: string;
  number: number;
  goal: string;
  status: string;
  reflection: string | null;
  steps: Step[];
}

interface Hypothesis {
  id: string;
  statement: string;
  rationale: string | null;
  status: string;
  evidence: string | null;
  theme?: string | null;
  parent?: { id: string; statement: string } | null;
  children?: { id: string; statement: string; status: string }[];
}

interface LogEntry {
  id: string;
  type: string;
  content: string;
  createdAt: string;
}

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
  children: {
    id: string;
    name: string;
    status: string;
    description: string | null;
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

interface GateStatus {
  met: boolean;
  progress: string;
}

interface Project {
  id: string;
  title: string;
  brief: string;
  status: string;
  methodology: string | null;
  currentPhase: string;
  collectionId: string | null;
  iterations: Iteration[];
  hypotheses: Hypothesis[];
  log: LogEntry[];
  collection: {
    papers: { paper: Paper }[];
  } | null;
  approaches?: Approach[];
  experimentResults?: ExperimentResult[];
  experimentJobs?: ExperimentJob[];
  hypothesesById?: Record<string, string>;
  summaryShort?: string | null;
  summaryFull?: string | null;
  gates?: Record<string, GateStatus>;
  benchmark?: {
    isBenchmark: boolean;
    sourcePaperId: string | null;
    groundTruth: string | null;
  } | null;
}

export default function ResearchWorkspacePage({ params }: { params: { id: string } }) {
  const { id } = params;
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const agentRef = useRef<AgentActivityHandle>(null);

  const fetchProject = useCallback(() => {
    fetch(`/api/research/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then(setProject)
      .catch(() => {
        toast.error("Project not found");
        router.push("/research");
      })
      .finally(() => setLoading(false));
  }, [id, router]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  // Auto-poll while agent is running (fast) or steps are running (slower)
  useEffect(() => {
    const hasRunning = project?.iterations.some((i) =>
      i.steps.some((s) => s.status === "RUNNING")
    );
    if (!hasRunning) return;
    const interval = setInterval(fetchProject, 4000);
    return () => clearInterval(interval);
  }, [project, fetchProject]);

  // Determine if agent should auto-start: project is ACTIVE and has no completed steps
  const shouldAutoStart = project?.status === "ACTIVE" && !project.iterations.some((i) =>
    i.steps.some((s) => s.status === "COMPLETED" || s.status === "RUNNING")
  );

  const handleTogglePause = async () => {
    if (!project) return;
    const newStatus = project.status === "PAUSED" ? "ACTIVE" : "PAUSED";
    try {
      if (newStatus === "PAUSED") {
        agentRef.current?.stop();
      }
      await fetch(`/api/research/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      setProject({ ...project, status: newStatus });
      toast.success(newStatus === "PAUSED" ? "Project paused" : "Project resumed");
      if (newStatus === "ACTIVE") {
        agentRef.current?.start();
      }
    } catch {
      toast.error("Failed");
    }
  };

  const handleArchive = async () => {
    agentRef.current?.stop();
    try {
      await fetch(`/api/research/${id}`, { method: "DELETE" });
      toast.success("Project archived");
      router.push("/research");
    } catch {
      toast.error("Failed to archive");
    }
  };

  const [restarting, setRestarting] = useState(false);

  const handleRestart = async () => {
    if (!project) return;
    setRestarting(true);
    try {
      // Stop current agent if running
      agentRef.current?.stop();

      const res = await fetch(`/api/research/${id}/restart`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to restart");
      const { priorWorkSummary, stepsDeleted, stepsKept } = await res.json();

      toast.success(`Cleaned ${stepsDeleted} stale steps, kept ${stepsKept} completed`);

      // Refresh project state
      await new Promise<void>((resolve) => {
        fetch(`/api/research/${id}`)
          .then((r) => r.json())
          .then((data) => { setProject(data); resolve(); })
          .catch(() => resolve());
      });

      // Restart agent with prior work context
      const restartMessage = priorWorkSummary
        ? `The project was restarted. Here is a summary of prior work — continue from where we left off, do NOT repeat completed steps:\n\n${priorWorkSummary}`
        : "The project was restarted. Continue the research.";

      // Small delay to let state settle
      setTimeout(() => {
        agentRef.current?.start(restartMessage);
      }, 500);
    } catch {
      toast.error("Failed to restart project");
    } finally {
      setRestarting(false);
    }
  };

  const [exportOpen, setExportOpen] = useState(false);
  const [exportResearch, setExportResearch] = useState(true);
  const [exportPapers, setExportPapers] = useState(true);
  const [exportCode, setExportCode] = useState(true);
  const [exportArtifacts, setExportArtifacts] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (!exportResearch) params.set("noResearch", "true");
      if (!exportPapers) params.set("noPapers", "true");
      if (exportPapers) params.set("fullText", "true");
      if (exportCode) params.set("code", "true");
      if (exportArtifacts) params.set("artifacts", "true");
      const url = `/api/research/${id}/export?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to export");
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition");
      const filename = disposition?.match(/filename="(.+)"/)?.[1] || "research_export.json";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("Exported project");
      setExportOpen(false);
    } catch {
      toast.error("Failed to export project");
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <div className="flex gap-4">
          <Skeleton className="h-96 flex-1" />
          <Skeleton className="h-96 w-80" />
        </div>
      </div>
    );
  }

  if (!project) return null;

  const papers = project.collection?.papers.map((cp) => cp.paper) || [];
  const activeIteration = project.iterations.find((i) => i.status === "ACTIVE") || project.iterations[0];
  return (
    <div className="max-w-7xl mx-auto flex flex-col h-[calc(100vh-48px-40px)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0 py-2">
        {/* Left: back + title + badges */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push("/research")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-base font-semibold">{project.title}</h1>
          {project.benchmark?.isBenchmark && (
            <span className="text-[11px] text-purple-500 bg-purple-500/10 px-1.5 py-0.5 rounded-full flex items-center gap-1">
              <Target className="h-2.5 w-2.5" />
              Benchmark
            </span>
          )}
          {project.status === "PAUSED" && (
            <span className="text-[11px] text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded-full">Paused</span>
          )}
          {project.status === "COMPLETED" && (
            <span className="text-[11px] text-blue-500 bg-blue-500/10 px-1.5 py-0.5 rounded-full">Completed</span>
          )}
        </div>

        {/* Center: phase progress dots */}
        <div className="flex items-center gap-2">
          {(["literature", "hypothesis", "experiment", "analysis", "reflection"] as const).map((phase, i) => {
            const PHASE_ORDER = ["literature", "hypothesis", "experiment", "analysis", "reflection"];
            const PHASE_LABELS: Record<string, string> = {
              literature: "Reading papers",
              hypothesis: "Forming hypotheses",
              experiment: "Running experiments",
              analysis: "Analyzing results",
              reflection: "Reflecting & planning",
            };
            const currentIdx = PHASE_ORDER.indexOf(project.currentPhase);
            const isCompleted = i < currentIdx;
            const isCurrent = i === currentIdx;
            const isActive = isCurrent && project.status === "ACTIVE";
            return (
              <div key={phase} className="flex items-center gap-2">
                {i > 0 && <div className={`w-5 h-px ${isCompleted ? "bg-emerald-500" : "bg-border"}`} />}
                <div className="relative" title={`${phase.charAt(0).toUpperCase() + phase.slice(1)}${isCurrent ? " (current)" : isCompleted ? " (done)" : ""}`}>
                  {isActive && (
                    <span className="absolute inset-0 rounded-full animate-ping bg-primary/40" />
                  )}
                  <div className={`relative h-3 w-3 rounded-full transition-colors ${
                    isCompleted ? "bg-emerald-500"
                    : isCurrent ? "bg-primary"
                    : "bg-border"
                  }`} />
                </div>
                {isCurrent && (
                  <span className="text-[11px] text-muted-foreground hidden sm:inline">
                    {PHASE_LABELS[phase]}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Right: notifications + chat + menu */}
        <div className="flex items-center gap-1">
          <NotificationBell projectId={project.id} onOpenInChat={(msg) => {
            window.dispatchEvent(new CustomEvent("arcana:open-chat", { detail: msg }));
          }} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                <MoreVertical className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40 p-1 [&_[role=menuitem]]:px-2.5 [&_[role=menuitem]]:py-1.5 [&_[role=menuitem]]:text-xs">
              <DropdownMenuItem onClick={handleTogglePause}>
                {project.status === "PAUSED" ? (
                  <><Play className="h-3 w-3 mr-1.5" /> Resume Agent</>
                ) : (
                  <><Pause className="h-3 w-3 mr-1.5" /> Pause Agent</>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleRestart} disabled={restarting}>
                {restarting ? (
                  <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> Restarting...</>
                ) : (
                  <><RotateCcw className="h-3 w-3 mr-1.5" /> Restart Agent</>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setExportOpen(true)}>
                <Download className="h-3 w-3 mr-1.5" /> Export
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleArchive} className="text-destructive focus:text-destructive">
                Archive Project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Main content: unified dashboard */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ResearchDashboard
          project={project}
          papers={papers.map(p => ({ id: p.id, title: p.title, authors: p.authors, year: p.year, processingStatus: p.processingStatus }))}
          iteration={activeIteration ? {
            number: activeIteration.number,
            goal: activeIteration.goal,
            steps: activeIteration.steps.map(s => ({ status: s.status })),
          } : null}
          onRefresh={fetchProject}
          logEntries={project.log}
          summaryShort={project.summaryShort || undefined}
          summaryFull={project.summaryFull || undefined}
        />
      </div>

      {/* Benchmark panel — only for benchmark projects */}
      {project.benchmark?.isBenchmark && (
        <div className="shrink-0">
          <BenchmarkPanel
            projectId={project.id}
            groundTruth={project.benchmark.groundTruth}
          />
        </div>
      )}

      {/* Bottom: Agent activity bar — compact by default */}
      <div className="shrink-0">
        <AgentActivityBar
          ref={agentRef}
          projectId={project.id}
          projectStatus={project.status}
          onRefresh={fetchProject}
          autoStart={shouldAutoStart}
        />
      </div>

      {/* Export dialog */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Export Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              {([
                { key: "research", checked: exportResearch, toggle: () => setExportResearch(!exportResearch), label: "Research", desc: "Iterations, hypotheses, findings, and agent memories" },
                { key: "papers", checked: exportPapers, toggle: () => setExportPapers(!exportPapers), label: "Papers", desc: `${papers.length} papers with full text` },
                { key: "code", checked: exportCode, toggle: () => setExportCode(!exportCode), label: "Code", desc: "Experiment scripts and configs" },
                { key: "artifacts", checked: exportArtifacts, toggle: () => setExportArtifacts(!exportArtifacts), label: "Artifacts", desc: "Output files, logs, and results" },
              ] as const).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={opt.toggle}
                  className="flex items-center gap-2.5 w-full rounded-md border border-border/60 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
                >
                  <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                    opt.checked ? "bg-primary border-primary" : "border-muted-foreground/30"
                  }`}>
                    {opt.checked && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                  </div>
                  <div className="min-w-0">
                    <span className="text-xs">{opt.label}</span>
                    <p className="text-[11px] text-muted-foreground/50">{opt.desc}</p>
                  </div>
                </button>
              ))}
            </div>

            <button
              onClick={handleExport}
              disabled={exporting || (!exportResearch && !exportPapers && !exportCode && !exportArtifacts)}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-foreground text-background px-3 py-2 text-xs font-medium hover:bg-foreground/90 transition-colors disabled:opacity-50"
            >
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Export
            </button>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
