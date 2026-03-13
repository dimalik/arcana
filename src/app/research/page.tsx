"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Loader2, FlaskConical, Upload, ArrowRight } from "lucide-react";
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

export default function ResearchPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [quickTopic, setQuickTopic] = useState("");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    fetch("/api/research")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setProjects(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleQuickCreate = async () => {
    const topic = quickTopic.trim();
    if (!topic) return;
    setCreating(true);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: topic,
          question: topic,
          methodology: "experimental",
        }),
      });
      if (!res.ok) throw new Error("Failed to create");
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
        toast.success(`Imported "${result.title}" — ${result.papersImported} papers, ${result.hypothesesImported} hypotheses`);
        router.push(`/research/${result.id}`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to import");
      } finally {
        setImporting(false);
      }
    };
    input.click();
  };

  const active = projects.filter((p) => p.status === "ACTIVE");
  const paused = projects.filter((p) => p.status === "PAUSED");
  const completed = projects.filter((p) => p.status === "COMPLETED");
  const archived = projects.filter((p) => p.status === "ARCHIVED");

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
            title="Import research project"
          >
            {importing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
            Import
          </button>
          <Link
            href="/research/new"
            className="inline-flex items-center gap-1 rounded-md text-[11px] text-muted-foreground/60 hover:text-foreground px-2 py-1 hover:bg-accent transition-colors"
          >
            <Plus className="h-3 w-3" />
            New
          </Link>
        </div>
      </div>

      {/* Quick create */}
      <div className="relative">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <FlaskConical className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/30" />
            <input
              value={quickTopic}
              onChange={(e) => setQuickTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleQuickCreate()}
              placeholder="What do you want to research?"
              className="w-full rounded-lg border border-border/60 bg-muted/20 pl-9 pr-3 py-2.5 text-sm placeholder:text-muted-foreground/30 focus:outline-none focus:border-foreground/20 focus:bg-muted/30 transition-all"
              disabled={creating}
            />
          </div>
          <button
            onClick={handleQuickCreate}
            disabled={creating || !quickTopic.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-foreground text-background px-4 py-2.5 text-xs font-medium hover:bg-foreground/90 transition-colors disabled:opacity-30 shrink-0"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3 pt-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] w-full rounded-lg" />
          ))}
        </div>
      ) : projects.filter((p) => p.status !== "ARCHIVED").length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/40 py-12 text-center">
          <p className="text-xs text-muted-foreground/50">
            No research projects yet. Type a topic above to begin.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Active projects */}
          {active.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <h2 className="text-[11px] text-muted-foreground/50 uppercase tracking-wider">Running</h2>
                <span className="text-[10px] text-muted-foreground/30">{active.length}</span>
              </div>
              <div className="space-y-2">
                {active.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            </section>
          )}

          {/* Paused projects */}
          {paused.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-amber-500/60" />
                <h2 className="text-[11px] text-muted-foreground/50 uppercase tracking-wider">Paused</h2>
                <span className="text-[10px] text-muted-foreground/30">{paused.length}</span>
              </div>
              <div className="space-y-2">
                {paused.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            </section>
          )}

          {/* Completed projects */}
          {completed.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="text-[11px] text-muted-foreground/40 uppercase tracking-wider">Completed</h2>
                <span className="text-[10px] text-muted-foreground/30">{completed.length}</span>
              </div>
              <div className="space-y-1.5">
                {completed.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            </section>
          )}

          {/* Archived - collapsed by default */}
          {archived.length > 0 && (
            <section>
              <button
                onClick={() => setShowArchived(!showArchived)}
                className="text-[11px] text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors"
              >
                {showArchived ? "Hide" : "Show"} {archived.length} archived
              </button>
              {showArchived && (
                <div className="space-y-1.5 mt-2 opacity-50">
                  {archived.map((p) => (
                    <ProjectCard key={p.id} project={p} />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
