"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Loader2, FlaskConical } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
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
  const [filter, setFilter] = useState<"all" | "ACTIVE" | "COMPLETED">("all");
  const [quickTopic, setQuickTopic] = useState("");
  const [creating, setCreating] = useState(false);

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

  const filtered = filter === "all"
    ? projects.filter((p) => p.status !== "ARCHIVED")
    : projects.filter((p) => p.status === filter);

  return (
    <div className="max-w-3xl mx-auto space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Research</span>
          <div className="flex items-center gap-0.5 text-[11px]">
            {(["all", "ACTIVE", "COMPLETED"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2 py-0.5 rounded-md transition-colors ${
                  filter === f
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f === "all" ? "All" : f === "ACTIVE" ? "Active" : "Completed"}
              </button>
            ))}
          </div>
        </div>
        <Link
          href="/research/new"
          className="inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground px-2 py-1 hover:bg-accent transition-colors"
          title="Advanced wizard"
        >
          <Plus className="h-3 w-3" />
          Advanced
        </Link>
      </div>

      {/* Quick-start: just type a topic */}
      <div className="flex gap-2">
        <input
          value={quickTopic}
          onChange={(e) => setQuickTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleQuickCreate()}
          placeholder="What do you want to research? (e.g. efficient attention in LLMs)"
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={creating}
        />
        <button
          onClick={handleQuickCreate}
          disabled={creating || !quickTopic.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-4 py-2 text-xs hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0"
        >
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
          Start
        </button>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-xs">
            No research projects yet. Type a topic above to get started.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}
