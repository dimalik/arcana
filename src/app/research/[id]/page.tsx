"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pause, Play, MoreVertical, Loader2, RotateCcw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PhaseTabs } from "@/components/research/phase-tabs";
import { ResearchLog } from "@/components/research/research-log";
import { ContextSidebar } from "@/components/research/context-sidebar";
import { LiteraturePhase } from "@/components/research/literature-phase";
import { HypothesisPhase } from "@/components/research/hypothesis-phase";
import { ExperimentPhase } from "@/components/research/experiment-phase";
import { AnalysisPhase } from "@/components/research/analysis-phase";
import { ReflectionPhase } from "@/components/research/reflection-phase";
import { AgentActivityBar, AgentActivityHandle } from "@/components/research/agent-activity-bar";
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
  parent?: { id: string; statement: string } | null;
  children?: { id: string; statement: string; status: string }[];
}

interface LogEntry {
  id: string;
  type: string;
  content: string;
  createdAt: string;
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

  const handlePhaseChange = async (phase: string) => {
    if (!project) return;
    try {
      await fetch(`/api/research/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPhase: phase }),
      });
      setProject({ ...project, currentPhase: phase });
    } catch {
      toast.error("Failed to change phase");
    }
  };

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

  const handleAddNote = async (content: string) => {
    try {
      await fetch(`/api/research/${id}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "user_note", content }),
      });
      fetchProject();
    } catch {
      toast.error("Failed to add note");
    }
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <div className="flex gap-4">
          <Skeleton className="h-96 w-48" />
          <Skeleton className="h-96 flex-1" />
          <Skeleton className="h-96 w-56" />
        </div>
      </div>
    );
  }

  if (!project) return null;

  const papers = project.collection?.papers.map((cp) => cp.paper) || [];
  const activeIteration = project.iterations.find((i) => i.status === "ACTIVE") || project.iterations[0];
  const currentSteps = activeIteration?.steps || [];
  const previousIterations = project.iterations.filter((i) => i.status === "COMPLETED");

  const PHASE_STEP_TYPES: Record<string, string[]> = {
    literature: ["search_papers", "discover_papers"],
    hypothesis: ["formulate_hypothesis", "synthesize"],
    experiment: ["generate_code", "run_experiment"],
    analysis: ["analyze_results", "run_experiment"],
    reflection: [],
  };
  const stepsForPhase = (phase: string) => {
    const types = PHASE_STEP_TYPES[phase];
    if (!types || types.length === 0) return currentSteps;
    return currentSteps.filter((s) => types.includes(s.type));
  };

  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-3 h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push("/research")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-sm font-medium">{project.title}</h1>
          {project.status === "PAUSED" && (
            <span className="text-[10px] text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded-full">Paused</span>
          )}
          {project.status === "COMPLETED" && (
            <span className="text-[10px] text-blue-500 bg-blue-500/10 px-1.5 py-0.5 rounded-full">Completed</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleTogglePause}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title={project.status === "PAUSED" ? "Resume" : "Pause"}
          >
            {project.status === "PAUSED" ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40 p-1 [&_[role=menuitem]]:px-2.5 [&_[role=menuitem]]:py-1.5 [&_[role=menuitem]]:text-xs">
              <DropdownMenuItem onClick={handleRestart} disabled={restarting}>
                {restarting ? (
                  <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> Restarting...</>
                ) : (
                  <><RotateCcw className="h-3 w-3 mr-1.5" /> Restart Agent</>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleArchive} className="text-destructive focus:text-destructive">
                Archive Project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Phase tabs */}
      <div className="shrink-0">
        <PhaseTabs
          current={project.currentPhase}
          onChange={handlePhaseChange}
          counts={{
            literature: stepsForPhase("literature").filter(s => s.status === "COMPLETED").length,
            hypothesis: project.hypotheses.length,
            experiment: stepsForPhase("experiment").filter(s => s.status === "COMPLETED" || s.status === "FAILED").length,
            analysis: stepsForPhase("analysis").filter(s => s.status === "COMPLETED").length,
          }}
        />
      </div>

      {/* Main layout: Log | Content | Context */}
      <div className="flex gap-3 flex-1 min-h-0">
        {/* Left: Research Log */}
        <div className="w-48 shrink-0 rounded-md border border-border overflow-hidden">
          <ResearchLog
            entries={project.log}
            projectId={project.id}
            onAddNote={handleAddNote}
          />
        </div>

        {/* Center: Phase content */}
        <div className="flex-1 min-w-0 overflow-auto">
          {project.currentPhase === "literature" && (
            <LiteraturePhase
              projectId={project.id}
              papers={papers}
              steps={stepsForPhase("literature")}
              onRefresh={fetchProject}
            />
          )}
          {project.currentPhase === "hypothesis" && (
            <HypothesisPhase
              projectId={project.id}
              hypotheses={project.hypotheses}
              steps={stepsForPhase("hypothesis")}
              onRefresh={fetchProject}
            />
          )}
          {project.currentPhase === "experiment" && (
            <ExperimentPhase
              projectId={project.id}
              steps={stepsForPhase("experiment")}
              hypotheses={project.hypotheses}
              onRefresh={fetchProject}
            />
          )}
          {project.currentPhase === "analysis" && (
            <AnalysisPhase
              projectId={project.id}
              steps={stepsForPhase("analysis")}
              hypotheses={project.hypotheses}
              onRefresh={fetchProject}
            />
          )}
          {project.currentPhase === "reflection" && (
            <ReflectionPhase
              projectId={project.id}
              steps={currentSteps}
              currentIteration={activeIteration || null}
              previousIterations={previousIterations}
              onRefresh={fetchProject}
            />
          )}
        </div>

        {/* Right: Context sidebar */}
        <div className="w-56 shrink-0 rounded-md border border-border overflow-hidden">
          <ContextSidebar
            project={project}
            papers={papers.map((p) => ({ id: p.id, title: p.title }))}
            hypotheses={project.hypotheses.map((h) => ({ id: h.id, statement: h.statement, status: h.status }))}
            iteration={activeIteration ? {
              number: activeIteration.number,
              goal: activeIteration.goal,
              steps: activeIteration.steps.map((s) => ({ status: s.status })),
            } : null}
          />
        </div>
      </div>

      {/* Bottom: Agent activity bar — always visible */}
      <div className="shrink-0">
        <AgentActivityBar
          ref={agentRef}
          projectId={project.id}
          onRefresh={fetchProject}
          autoStart={shouldAutoStart}
        />
      </div>
    </div>
  );
}
