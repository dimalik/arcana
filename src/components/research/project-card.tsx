"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";

const PHASE_LABELS: Record<string, string> = {
  literature: "Literature",
  hypothesis: "Hypothesis",
  experiment: "Experiment",
  analysis: "Analysis",
  reflection: "Reflection",
};

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "text-emerald-500",
  PAUSED: "text-amber-500",
  COMPLETED: "text-blue-500",
  ARCHIVED: "text-muted-foreground",
  SETUP: "text-muted-foreground",
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
}

export function ProjectCard({ project }: ProjectCardProps) {
  const brief = (() => {
    try { return JSON.parse(project.brief); } catch { return {}; }
  })();
  const iterNum = project.iterations[0]?.number || 0;
  const paperCount = project.collection?._count?.papers || 0;

  return (
    <Link href={`/research/${project.id}`}>
      <Card className="group hover:border-foreground/20 transition-colors">
        <CardContent className="py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium truncate group-hover:underline">
                {project.title}
              </h3>
              {brief.question && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                  {brief.question}
                </p>
              )}
            </div>
            <span className={`text-[11px] shrink-0 ${STATUS_COLORS[project.status] || ""}`}>
              {project.status === "ACTIVE" ? PHASE_LABELS[project.currentPhase] || project.currentPhase : project.status.toLowerCase()}
            </span>
          </div>

          <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground/70">
            {project.methodology && (
              <span>{project.methodology}</span>
            )}
            {iterNum > 0 && <span>Iteration #{iterNum}</span>}
            <span>{paperCount} paper{paperCount !== 1 ? "s" : ""}</span>
            {project._count.hypotheses > 0 && (
              <span>{project._count.hypotheses} hypothes{project._count.hypotheses !== 1 ? "es" : "is"}</span>
            )}
            <span className="ml-auto">
              {new Date(project.updatedAt).toLocaleDateString()}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
