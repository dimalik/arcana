"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, FileText, Brain, Trash2 } from "lucide-react";

interface ContextSidebarProps {
  project: {
    id: string;
    brief: string;
    methodology: string | null;
    currentPhase: string;
  };
  papers: { id: string; title: string }[];
  hypotheses: { id: string; statement: string; status: string }[];
  iteration: { number: number; goal: string; steps: { status: string }[] } | null;
}

const STATUS_DOT: Record<string, string> = {
  PROPOSED: "bg-amber-500",
  TESTING: "bg-blue-500",
  SUPPORTED: "bg-emerald-500",
  REFUTED: "bg-red-500",
  REVISED: "bg-purple-500",
};

interface AgentMemory {
  id: string;
  category: string;
  lesson: string;
  usageCount: number;
}

export function ContextSidebar({ project, papers, hypotheses, iteration }: ContextSidebarProps) {
  const [briefExpanded, setBriefExpanded] = useState(false);
  const [papersExpanded, setPapersExpanded] = useState(false);
  const [memoriesExpanded, setMemoriesExpanded] = useState(false);
  const [memories, setMemories] = useState<AgentMemory[]>([]);

  useEffect(() => {
    fetch("/api/research/memories")
      .then((r) => r.ok ? r.json() : [])
      .then(setMemories)
      .catch(() => {});
  }, []);

  const deleteMemory = async (id: string) => {
    await fetch("/api/research/memories", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setMemories((m) => m.filter((mem) => mem.id !== id));
  };

  const brief = (() => {
    try { return JSON.parse(project.brief); } catch { return {}; }
  })();

  const completedSteps = iteration?.steps.filter((s) => s.status === "COMPLETED").length || 0;
  const totalSteps = iteration?.steps.length || 0;

  return (
    <div className="h-full flex flex-col overflow-auto">
      <div className="px-3 py-2 border-b border-border">
        <span className="text-[11px] font-medium text-muted-foreground">Context</span>
      </div>

      <div className="flex-1 px-3 py-2 space-y-3">
        {/* Brief */}
        <div>
          <button
            onClick={() => setBriefExpanded(!briefExpanded)}
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground w-full"
          >
            {briefExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Research Brief
          </button>
          {briefExpanded && (
            <div className="mt-1 space-y-1 text-[11px] text-muted-foreground">
              <p className="font-medium text-foreground/80">{brief.question}</p>
              {project.methodology && (
                <span className="inline-block rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                  {project.methodology}
                </span>
              )}
              {brief.subQuestions?.length > 0 && (
                <div className="space-y-0.5">
                  {brief.subQuestions.map((q: string, i: number) => (
                    <p key={i} className="text-[10px]">{i + 1}. {q}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Papers */}
        <div>
          <button
            onClick={() => setPapersExpanded(!papersExpanded)}
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground w-full"
          >
            {papersExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Papers ({papers.length})
          </button>
          {papersExpanded && (
            <div className="mt-1 space-y-0.5">
              {papers.slice(0, 15).map((p) => (
                <Link
                  key={p.id}
                  href={`/papers/${p.id}`}
                  className="flex items-start gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <FileText className="h-3 w-3 mt-0.5 shrink-0" />
                  <span className="line-clamp-1">{p.title}</span>
                </Link>
              ))}
              {papers.length > 15 && (
                <p className="text-[10px] text-muted-foreground/50 pl-4">+{papers.length - 15} more</p>
              )}
            </div>
          )}
        </div>

        {/* Hypotheses */}
        {hypotheses.length > 0 && (
          <div>
            <p className="text-[11px] font-medium text-muted-foreground mb-1">Hypotheses</p>
            <div className="space-y-0.5">
              {hypotheses.slice(0, 8).map((h) => (
                <div key={h.id} className="flex items-start gap-1.5">
                  <div className={`h-1.5 w-1.5 rounded-full mt-1.5 shrink-0 ${STATUS_DOT[h.status] || "bg-muted"}`} />
                  <p className="text-[10px] text-muted-foreground line-clamp-1">{h.statement}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Iteration */}
        {iteration && (
          <div>
            <p className="text-[11px] font-medium text-muted-foreground mb-1">
              Iteration #{iteration.number}
            </p>
            <p className="text-[10px] text-muted-foreground">{iteration.goal}</p>
            {totalSteps > 0 && (
              <div className="mt-1 flex items-center gap-1.5">
                <div className="h-1 flex-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${(completedSteps / totalSteps) * 100}%` }}
                  />
                </div>
                <span className="text-[9px] text-muted-foreground/50">
                  {completedSteps}/{totalSteps}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Process Memory */}
        {memories.length > 0 && (
          <div>
            <button
              onClick={() => setMemoriesExpanded(!memoriesExpanded)}
              className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground w-full"
            >
              {memoriesExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              <Brain className="h-3 w-3" />
              Process Memory ({memories.length})
            </button>
            {memoriesExpanded && (
              <div className="mt-1 space-y-1">
                {memories.map((m) => (
                  <div key={m.id} className="group flex items-start gap-1">
                    <span className="text-[9px] text-muted-foreground/50 bg-muted rounded px-1 shrink-0 mt-0.5">
                      {m.category}
                    </span>
                    <p className="text-[10px] text-muted-foreground flex-1 line-clamp-2">{m.lesson}</p>
                    <button
                      onClick={() => deleteMemory(m.id)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground/30 hover:text-destructive transition-opacity shrink-0"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
