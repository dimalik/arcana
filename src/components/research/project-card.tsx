"use client";

import { useState } from "react";
import Link from "next/link";
import {
  BookOpen, FlaskConical, Lightbulb, BarChart3, IterationCcw,
  Pause, Trash2, Search, Compass, ChevronDown,
  FileText, Beaker, Activity,
} from "lucide-react";

const PHASES = ["literature", "hypothesis", "experiment", "analysis", "reflection"] as const;

const PHASE_META: Record<string, { label: string; icon: typeof BookOpen; verb: string }> = {
  literature: { label: "Literature", icon: BookOpen, verb: "Searching papers" },
  hypothesis: { label: "Hypothesis", icon: Lightbulb, verb: "Forming hypotheses" },
  experiment: { label: "Experiment", icon: FlaskConical, verb: "Running experiments" },
  analysis: { label: "Analysis", icon: BarChart3, verb: "Analyzing results" },
  reflection: { label: "Reflection", icon: IterationCcw, verb: "Reflecting on findings" },
};

const METHODOLOGY_LABELS: Record<string, { label: string; icon: typeof FlaskConical }> = {
  experimental: { label: "Experiment", icon: FlaskConical },
  analytical: { label: "Survey", icon: Search },
  design_science: { label: "Build", icon: BarChart3 },
  exploratory: { label: "Explore", icon: Compass },
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
    log?: { type: string; content: string; createdAt: string }[];
  };
  onDelete?: (id: string) => void;
}

export function ProjectCard({ project, onDelete }: ProjectCardProps) {
  const [expanded, setExpanded] = useState(false);

  const brief = (() => {
    try { return JSON.parse(project.brief); } catch { return {}; }
  })();
  const paperCount = project.collection?._count?.papers || 0;
  const isActive = project.status === "ACTIVE";
  const isPaused = project.status === "PAUSED";
  const phaseIdx = PHASES.indexOf(project.currentPhase as typeof PHASES[number]);

  const methMeta = METHODOLOGY_LABELS[project.methodology || ""] || null;
  const MethIcon = methMeta?.icon;
  const constraints: string | undefined = brief.constraints;

  // Latest log entry for live status
  const latestLog = project.log?.[0];
  const liveStatus = (() => {
    if (!latestLog || !isActive) return null;
    // Clean up agent log content for display
    let text = latestLog.content;
    // Strip tool call prefixes like "[search_papers] {...}"
    if (text.startsWith("[")) {
      const closeBracket = text.indexOf("]");
      if (closeBracket > 0) text = text.slice(closeBracket + 1).trim();
    }
    // Strip JSON objects
    if (text.startsWith("{")) return null;
    return text.slice(0, 120);
  })();

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

  const hasDetails = constraints || (brief.question && brief.question !== project.title);

  return (
    <div className="group">
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
          {/* Top row: title + time + actions */}
          <div className="flex items-start justify-between gap-3">
            <Link href={`/research/${project.id}`} className="min-w-0 flex-1">
              <h3 className="text-[13px] font-medium truncate group-hover:text-foreground transition-colors">
                {project.title}
              </h3>
            </Link>
            <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
              {isPaused && (
                <span className="flex items-center gap-1 text-[10px] text-amber-500/80">
                  <Pause className="h-2.5 w-2.5" />
                  paused
                </span>
              )}
              <span className="text-[10px] text-muted-foreground/40">{timeAgo}</span>
              {onDelete && (
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(project.id); }}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/0 group-hover:text-muted-foreground/30 hover:!text-destructive hover:bg-destructive/10 transition-all"
                  title="Delete project"
                >
                  <Trash2 className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          </div>

          {/* Live status line (active projects only) */}
          {isActive && liveStatus && (
            <Link href={`/research/${project.id}`} className="block">
              <div className="flex items-center gap-1.5 mt-1.5">
                <Activity className="h-2.5 w-2.5 text-emerald-500/50 shrink-0 animate-pulse" />
                <p className="text-[10px] text-muted-foreground/50 truncate">{liveStatus}</p>
              </div>
            </Link>
          )}

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
          <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground/40">
            {methMeta && (
              <span className="inline-flex items-center gap-1">
                {MethIcon && <MethIcon className="h-2.5 w-2.5" />}
                {methMeta.label}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <FileText className="h-2.5 w-2.5" />
              {paperCount}
            </span>
            {project._count.hypotheses > 0 && (
              <span className="inline-flex items-center gap-1">
                <Beaker className="h-2.5 w-2.5" />
                {project._count.hypotheses}
              </span>
            )}
            {/* Expand button for details */}
            {hasDetails && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded(!expanded); }}
                className="inline-flex items-center gap-0.5 ml-auto text-muted-foreground/25 hover:text-muted-foreground/50 transition-colors"
              >
                <ChevronDown className={`h-2.5 w-2.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
            )}
          </div>

          {/* Expanded details */}
          {expanded && hasDetails && (
            <div className="mt-2 pt-2 border-t border-border/30 space-y-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-100">
              {brief.question && brief.question !== project.title && (
                <p className="text-[11px] text-muted-foreground/50 leading-relaxed">{brief.question}</p>
              )}
              {constraints && (
                <div className="text-[10px]">
                  <span className="text-muted-foreground/30 uppercase tracking-wider">Constraints</span>
                  <p className="text-muted-foreground/50 mt-0.5">{constraints}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
