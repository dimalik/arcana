"use client";

import Link from "next/link";
import { BookOpen, FlaskConical, Lightbulb, BarChart3, IterationCcw, Pause, MoreVertical, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const PHASES = ["literature", "hypothesis", "experiment", "analysis", "reflection"] as const;

const PHASE_META: Record<string, { label: string; icon: typeof BookOpen }> = {
  literature: { label: "Literature", icon: BookOpen },
  hypothesis: { label: "Hypothesis", icon: Lightbulb },
  experiment: { label: "Experiment", icon: FlaskConical },
  analysis: { label: "Analysis", icon: BarChart3 },
  reflection: { label: "Reflection", icon: IterationCcw },
};

interface ProjectCardProps {
  project: {
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
  onDelete?: (id: string) => void;
}

export function ProjectCard({ project, onDelete }: ProjectCardProps) {
  const brief = (() => {
    try { return JSON.parse(project.brief); } catch { return {}; }
  })();
  const iterNum = project.iterations[0]?.number || 0;
  const paperCount = project.collection?._count?.papers || 0;
  const isActive = project.status === "ACTIVE";
  const isPaused = project.status === "PAUSED";
  const phaseIdx = PHASES.indexOf(project.currentPhase as typeof PHASES[number]);

  const timeAgo = (() => {
    const diff = Date.now() - new Date(project.updatedAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(project.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  })();

  return (
    <Link href={`/research/${project.id}`} className="block group">
      <div className={`relative rounded-lg border transition-all duration-150 ${
        isActive
          ? "border-emerald-500/20 bg-emerald-500/[0.02] hover:border-emerald-500/40 hover:bg-emerald-500/[0.04]"
          : isPaused
          ? "border-amber-500/15 hover:border-amber-500/30"
          : "border-border/50 hover:border-border"
      }`}>
        {/* Active indicator edge */}
        {isActive && (
          <div className="absolute left-0 top-3 bottom-3 w-[2px] rounded-full bg-emerald-500/60" />
        )}
        {isPaused && (
          <div className="absolute left-0 top-3 bottom-3 w-[2px] rounded-full bg-amber-500/40" />
        )}

        <div className="px-4 py-3">
          {/* Top row: title + status */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-[13px] font-medium truncate group-hover:text-foreground transition-colors">
                {project.title}
              </h3>
              {brief.question && brief.question !== project.title && (
                <p className="text-[11px] text-muted-foreground/70 mt-0.5 line-clamp-1">
                  {brief.question}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0 mt-0.5">
              {isPaused && (
                <span className="flex items-center gap-1 text-[10px] text-amber-500/80 mr-1">
                  <Pause className="h-2.5 w-2.5" />
                  paused
                </span>
              )}
              {onDelete && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      onClick={(e) => e.preventDefault()}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/30 hover:text-foreground hover:bg-accent transition-colors"
                    >
                      <MoreVertical className="h-3 w-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    <DropdownMenuItem
                      onClick={(e) => { e.preventDefault(); onDelete(project.id); }}
                      className="text-xs gap-2 text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <span className="text-[10px] text-muted-foreground/50">{timeAgo}</span>
            </div>
          </div>

          {/* Phase progress track */}
          <div className="flex items-center gap-0.5 mt-2.5">
            {PHASES.map((phase, idx) => {
              const meta = PHASE_META[phase];
              const Icon = meta.icon;
              const isCurrent = project.currentPhase === phase;
              const isCompleted = idx < phaseIdx;

              return (
                <div key={phase} className="flex items-center gap-0.5 flex-1 min-w-0">
                  <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                    isCurrent && isActive
                      ? "bg-emerald-500/10 text-emerald-400"
                      : isCurrent && isPaused
                      ? "bg-amber-500/10 text-amber-400"
                      : isCompleted
                      ? "text-muted-foreground/50"
                      : "text-muted-foreground/20"
                  }`}>
                    <Icon className="h-2.5 w-2.5 shrink-0" />
                    <span className="truncate hidden sm:inline">{meta.label}</span>
                  </div>
                  {idx < PHASES.length - 1 && (
                    <div className={`h-px flex-1 min-w-1 ${
                      isCompleted ? "bg-muted-foreground/20" : "bg-muted-foreground/8"
                    }`} />
                  )}
                </div>
              );
            })}
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground/50">
            {iterNum > 0 && <span>iter {iterNum}</span>}
            <span>{paperCount} paper{paperCount !== 1 ? "s" : ""}</span>
            {project._count.hypotheses > 0 && (
              <span>{project._count.hypotheses} hypothes{project._count.hypotheses !== 1 ? "es" : "is"}</span>
            )}
            {project.methodology && (
              <span className="ml-auto">{project.methodology}</span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
