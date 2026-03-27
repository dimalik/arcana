"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FlaskConical, Loader2, ArrowRight, Target, CheckCircle,
  AlertTriangle, Sparkles, BookOpen, ChevronDown, Trash2,
} from "lucide-react";
import { toast } from "sonner";

interface PaperOption {
  id: string;
  title: string;
  year: number | null;
  refCount: number;
  hasText: boolean;
}

interface BenchmarkResult {
  id: string;
  title: string;
  status: string;
  currentPhase: string;
  groundTruth: string | null;
  sourcePaperId: string | null;
  hypotheses: { statement: string; status: string }[];
}

interface Evaluation {
  scores: Record<string, number>;
  overallScore: number;
  summary: string;
  whatMatched: string[];
  whatMissed: string[];
  surprises: string[];
  recommendations: string[];
}

interface JudgeVerdict {
  move: number;
  score: number;
  label: string;
  comment: string;
}

interface JudgeReport {
  judge: string;
  verdicts: JudgeVerdict[];
  summary: string;
  overallScore: number;
}

interface JudgePanelData {
  moveCount: number;
  moves: { step: number; type: string; title: string }[];
  judges: JudgeReport[];
}

const SCORE_LABELS: Record<string, string> = {
  problemId: "Problem ID",
  methodProximity: "Method Proximity",
  insightDiscovery: "Insight Discovery",
  experimentalDesign: "Experimental Design",
  novelContributions: "Novel Contributions",
};

export default function BenchmarkPage() {
  const router = useRouter();
  const [papers, setPapers] = useState<PaperOption[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selectedPaper, setSelectedPaper] = useState<string>("");
  const [evaluating, setEvaluating] = useState<string | null>(null);
  const [evaluations, setEvaluations] = useState<Record<string, Evaluation>>({});
  const [judging, setJudging] = useState<string | null>(null);
  const [judgePanels, setJudgePanels] = useState<Record<string, JudgePanelData>>({});

  useEffect(() => {
    Promise.all([
      // Load recent papers with references
      fetch("/api/papers?limit=50&sort=newest").then((r) => r.json()),
      // Load existing benchmarks
      fetch("/api/research/benchmark").then((r) => r.json()),
    ]).then(([paperData, benchmarkData]) => {
      // Filter papers that have text and could have references
      const opts = (paperData.papers || []).map((p: { id: string; title: string; year: number | null; fullText?: string; abstract?: string; _count?: { references: number } }) => ({
        id: p.id,
        title: p.title,
        year: p.year,
        refCount: p._count?.references || 0,
        hasText: !!(p.fullText || p.abstract),
      }));
      setPapers(opts);
      if (Array.isArray(benchmarkData)) setBenchmarks(benchmarkData);
    }).catch(() => toast.error("Failed to load data"))
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!selectedPaper) return;
    setCreating(true);
    try {
      const res = await fetch("/api/research/benchmark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperId: selectedPaper }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Benchmark created: ${data.title}`);
      router.push(`/research/${data.projectId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create benchmark");
    }
    setCreating(false);
  };

  const handleJudgePanel = async (projectId: string) => {
    setJudging(projectId);
    try {
      const res = await fetch("/api/research/benchmark/judges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setJudgePanels((prev) => ({ ...prev, [projectId]: data }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Judge panel failed");
    }
    setJudging(null);
  };

  const handleEvaluate = async (projectId: string) => {
    setEvaluating(projectId);
    try {
      const res = await fetch("/api/research/benchmark/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEvaluations((prev) => ({ ...prev, [projectId]: data.evaluation }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Evaluation failed");
    }
    setEvaluating(null);
  };

  const handleDelete = async (projectId: string) => {
    if (!confirm("Delete this benchmark project?")) return;
    try {
      const res = await fetch(`/api/research/${projectId}`, { method: "DELETE" });
      if (res.ok) {
        setBenchmarks((prev) => prev.filter((b) => b.id !== projectId));
        toast.success("Benchmark deleted");
      } else {
        toast.error("Failed to delete");
      }
    } catch { toast.error("Failed to delete"); }
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto py-12 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-sm font-medium tracking-wide text-muted-foreground/80 uppercase">Rediscovery Benchmark</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Test the research agent: give it a paper's references and topic, see if it can independently arrive at the same method.
        </p>
      </div>

      {/* Create new benchmark */}
      <div className="rounded-lg border border-border/60 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-muted-foreground/60" />
          <span className="text-sm font-medium">New Benchmark</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Select a paper from your library. The system will extract a blinded research question (without revealing the method),
          use the paper's references as seed papers, and create a research project for the agent to solve.
        </p>
        <div className="flex gap-2">
          <select
            value={selectedPaper}
            onChange={(e) => setSelectedPaper(e.target.value)}
            className="flex-1 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs focus:outline-none focus:border-foreground/20"
          >
            <option value="">Select a paper...</option>
            {papers.filter((p) => p.hasText).map((p) => (
              <option key={p.id} value={p.id}>
                {p.title.slice(0, 80)}{p.title.length > 80 ? "..." : ""} ({p.year || "?"})
              </option>
            ))}
          </select>
          <button
            onClick={handleCreate}
            disabled={!selectedPaper || creating}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-4 py-2 text-xs font-medium hover:bg-foreground/90 transition-colors disabled:opacity-30"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
            Create
          </button>
        </div>
      </div>

      {/* Existing benchmarks */}
      {benchmarks.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-xs font-medium text-muted-foreground/60 uppercase tracking-wider">Benchmarks</h2>
          {benchmarks.map((b) => {
            const evaluation = evaluations[b.id];
            return (
              <div key={b.id} className="rounded-lg border border-border/50 overflow-hidden">
                {/* Benchmark header */}
                <div className="px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/research/${b.id}`} className="text-sm font-medium hover:underline">
                      {b.title}
                    </Link>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground/50">
                      <span className={b.status === "ACTIVE" ? "text-emerald-500" : b.status === "COMPLETED" ? "text-blue-500" : ""}>{b.status}</span>
                      <span>{b.currentPhase}</span>
                      <span>{b.hypotheses.length} hypotheses</span>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => handleJudgePanel(b.id)}
                      disabled={judging === b.id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-[11px] hover:bg-muted/50 transition-colors disabled:opacity-50"
                    >
                      {judging === b.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
                      Judge Panel
                    </button>
                    <button
                      onClick={() => handleEvaluate(b.id)}
                      disabled={evaluating === b.id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-[11px] hover:bg-muted/50 transition-colors disabled:opacity-50"
                    >
                      {evaluating === b.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                      Evaluate
                    </button>
                    <button
                      onClick={() => handleDelete(b.id)}
                      className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-colors"
                      title="Delete benchmark"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Ground truth (collapsible) */}
                {b.groundTruth && (
                  <details className="border-t border-border/30">
                    <summary className="px-4 py-2 text-[10px] text-muted-foreground/40 cursor-pointer hover:text-muted-foreground/60 flex items-center gap-1">
                      <ChevronDown className="h-2.5 w-2.5" />
                      Ground truth (spoiler)
                    </summary>
                    <div className="px-4 pb-3 text-xs text-muted-foreground/70 leading-relaxed">
                      {b.groundTruth}
                    </div>
                  </details>
                )}

                {/* Evaluation results */}
                {evaluation && (
                  <div className="border-t border-border/30 px-4 py-3 space-y-3 bg-muted/5">
                    {/* Score bar */}
                    <div className="flex items-center gap-3">
                      <div className="text-2xl font-bold">
                        {evaluation.overallScore.toFixed(1)}
                        <span className="text-xs text-muted-foreground/40 font-normal">/5</span>
                      </div>
                      <div className="flex-1 grid grid-cols-5 gap-1">
                        {Object.entries(evaluation.scores).map(([key, score]) => (
                          <div key={key} className="text-center">
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full ${score >= 4 ? "bg-emerald-500" : score >= 3 ? "bg-blue-500" : score >= 2 ? "bg-amber-500" : "bg-red-500"}`}
                                style={{ width: `${(score / 5) * 100}%` }}
                              />
                            </div>
                            <span className="text-[9px] text-muted-foreground/40 mt-0.5 block">{SCORE_LABELS[key] || key}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Summary */}
                    <p className="text-xs text-muted-foreground/70">{evaluation.summary}</p>

                    {/* Details grid */}
                    <div className="grid grid-cols-2 gap-3 text-[11px]">
                      {evaluation.whatMatched.length > 0 && (
                        <div>
                          <span className="text-emerald-500/70 font-medium flex items-center gap-1 mb-1">
                            <CheckCircle className="h-3 w-3" /> Matched
                          </span>
                          <ul className="space-y-0.5 text-muted-foreground/60">
                            {evaluation.whatMatched.map((m, i) => <li key={i}>- {m}</li>)}
                          </ul>
                        </div>
                      )}
                      {evaluation.whatMissed.length > 0 && (
                        <div>
                          <span className="text-amber-500/70 font-medium flex items-center gap-1 mb-1">
                            <AlertTriangle className="h-3 w-3" /> Missed
                          </span>
                          <ul className="space-y-0.5 text-muted-foreground/60">
                            {evaluation.whatMissed.map((m, i) => <li key={i}>- {m}</li>)}
                          </ul>
                        </div>
                      )}
                      {evaluation.surprises.length > 0 && (
                        <div>
                          <span className="text-purple-500/70 font-medium flex items-center gap-1 mb-1">
                            <Sparkles className="h-3 w-3" /> Surprises
                          </span>
                          <ul className="space-y-0.5 text-muted-foreground/60">
                            {evaluation.surprises.map((s, i) => <li key={i}>- {s}</li>)}
                          </ul>
                        </div>
                      )}
                      {evaluation.recommendations.length > 0 && (
                        <div>
                          <span className="text-blue-500/70 font-medium flex items-center gap-1 mb-1">
                            <BookOpen className="h-3 w-3" /> Improve
                          </span>
                          <ul className="space-y-0.5 text-muted-foreground/60">
                            {evaluation.recommendations.map((r, i) => <li key={i}>- {r}</li>)}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Judge panel results */}
                {judgePanels[b.id] && (
                  <div className="border-t border-border/30 px-4 py-3 space-y-4 bg-muted/5">
                    <div className="flex items-center gap-2">
                      <FlaskConical className="h-3.5 w-3.5 text-muted-foreground/60" />
                      <span className="text-xs font-medium">Judge Panel</span>
                      <span className="text-[10px] text-muted-foreground/40">{judgePanels[b.id].moveCount} moves evaluated</span>
                    </div>

                    {judgePanels[b.id].judges.map((judge) => (
                      <div key={judge.judge} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-medium">{judge.judge}</span>
                          <span className="text-[10px] text-muted-foreground/50">{judge.overallScore.toFixed(1)}/5</span>
                        </div>

                        {/* Move heatmap */}
                        <div className="flex gap-px">
                          {judge.verdicts.map((v) => (
                            <div
                              key={v.move}
                              className="group relative flex-1 min-w-[6px]"
                            >
                              <div
                                className={`h-3 rounded-sm ${
                                  v.score >= 2 ? "bg-emerald-500" :
                                  v.score >= 1 ? "bg-emerald-500/50" :
                                  v.score === 0 ? "bg-muted-foreground/15" :
                                  v.score >= -1 ? "bg-amber-500/50" :
                                  "bg-red-500"
                                }`}
                                title={`Move ${v.move}: ${v.comment}`}
                              />
                              {/* Tooltip */}
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-20 w-48 p-2 rounded-md bg-popover border border-border shadow-md text-[10px]">
                                <div className="font-medium mb-0.5">
                                  Move {v.move} — {judgePanels[b.id].moves[v.move - 1]?.title || "?"}
                                </div>
                                <div className={`font-medium ${v.score > 0 ? "text-emerald-500" : v.score < 0 ? "text-red-500" : "text-muted-foreground/50"}`}>
                                  {v.label.toUpperCase()} ({v.score > 0 ? "+" : ""}{v.score})
                                </div>
                                <div className="text-muted-foreground/60 mt-0.5">{v.comment}</div>
                              </div>
                            </div>
                          ))}
                        </div>

                        <p className="text-[10px] text-muted-foreground/50">{judge.summary}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
