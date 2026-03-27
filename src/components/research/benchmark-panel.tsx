"use client";

import { useState, useEffect } from "react";
import {
  FlaskConical, Sparkles, Loader2, CheckCircle, AlertTriangle,
  BookOpen, Lightbulb, Eye, EyeOff, Clock, ChevronDown, Target,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

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

interface Evaluation {
  scores: Record<string, number>;
  overallScore: number;
  summary: string;
  whatMatched: string[];
  whatMissed: string[];
  surprises: string[];
  recommendations: string[];
}

interface StoredRun {
  type: "judges" | "evaluation";
  timestamp: number;
  stepCount: number;
  data: {
    moves?: { step: number; type: string; title: string }[];
    judges?: JudgeReport[];
    evaluation?: Evaluation;
  };
}

interface DroppedHint {
  text: string;
  source: "missed" | "improve" | "manual";
  droppedAt: number;
  delivered: boolean;
}

interface Props {
  projectId: string;
  groundTruth: string | null;
}

const SCORE_LABELS: Record<string, string> = {
  problemId: "Problem ID",
  methodProximity: "Method",
  insightDiscovery: "Insight",
  experimentalDesign: "Design",
  novelContributions: "Novel",
};

const STORE_KEY = (id: string) => `benchmark-runs-${id}`;
const HINTS_KEY = (id: string) => `benchmark-hints-${id}`;

function loadRuns(projectId: string): StoredRun[] {
  try { return JSON.parse(localStorage.getItem(STORE_KEY(projectId)) || "[]"); } catch { return []; }
}

function saveRun(projectId: string, run: StoredRun) {
  const runs = loadRuns(projectId);
  runs.unshift(run);
  localStorage.setItem(STORE_KEY(projectId), JSON.stringify(runs.slice(0, 20)));
}

function loadHints(projectId: string): DroppedHint[] {
  try { return JSON.parse(localStorage.getItem(HINTS_KEY(projectId)) || "[]"); } catch { return []; }
}

function saveHints(projectId: string, hints: DroppedHint[]) {
  localStorage.setItem(HINTS_KEY(projectId), JSON.stringify(hints));
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function BenchmarkPanel({ projectId, groundTruth }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [judging, setJudging] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [showGroundTruth, setShowGroundTruth] = useState(false);
  const [selectedVerdict, setSelectedVerdict] = useState<{ judge: string; verdict: JudgeVerdict } | null>(null);
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [activeRunIdx, setActiveRunIdx] = useState(0);
  const [hints, setHints] = useState<DroppedHint[]>([]);

  useEffect(() => {
    setRuns(loadRuns(projectId));
    setHints(loadHints(projectId));
  }, [projectId]);

  const activeRun = runs[activeRunIdx] || null;
  const judges = activeRun?.type === "judges" ? { moves: activeRun.data.moves || [], judges: activeRun.data.judges || [] } : null;
  const evaluation = activeRun?.type === "evaluation" ? activeRun.data.evaluation || null : null;

  // Also find the latest evaluation across all runs for hints
  const latestEval = runs.find((r) => r.type === "evaluation")?.data.evaluation || null;

  const runJudges = async () => {
    setJudging(true);
    try {
      // Find the most recent judge run for incremental evaluation
      const lastJudgeRun = runs.find((r) => r.type === "judges");
      const previousVerdicts: Record<string, { move: number; score: number; label: string; comment: string }[]> = {};
      let previousMoveCount = 0;
      if (lastJudgeRun?.data.judges) {
        for (const j of lastJudgeRun.data.judges) {
          previousVerdicts[j.judge] = j.verdicts;
        }
        previousMoveCount = lastJudgeRun.stepCount;
      }

      const res = await fetch("/api/research/benchmark/judges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, previousVerdicts, previousMoveCount }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const run: StoredRun = { type: "judges", timestamp: Date.now(), stepCount: data.moveCount || 0, data: { moves: data.moves, judges: data.judges } };
      saveRun(projectId, run);
      setRuns(loadRuns(projectId));
      setActiveRunIdx(0);
    } catch (err) { toast.error(err instanceof Error ? err.message : "Judge panel failed"); }
    setJudging(false);
  };

  const runEval = async () => {
    setEvaluating(true);
    try {
      const res = await fetch("/api/research/benchmark/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const run: StoredRun = { type: "evaluation", timestamp: Date.now(), stepCount: 0, data: { evaluation: data.evaluation } };
      saveRun(projectId, run);
      setRuns(loadRuns(projectId));
      setActiveRunIdx(0);
    } catch (err) { toast.error(err instanceof Error ? err.message : "Evaluation failed"); }
    setEvaluating(false);
  };

  const dropHint = async (text: string, source: "missed" | "improve" | "manual") => {
    // Send hint to the agent via research log
    try {
      await fetch(`/api/research/${projectId}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "user_note",
          content: `[ORACLE HINT] ${text}`,
          metadata: JSON.stringify({ oracleHint: true }),
        }),
      });
      const hint: DroppedHint = { text, source, droppedAt: Date.now(), delivered: true };
      const updated = [...hints, hint];
      setHints(updated);
      saveHints(projectId, updated);
      toast.success("Hint dropped — agent will see it next step");
    } catch {
      toast.error("Failed to drop hint");
    }
  };

  // Collect hintable items from latest evaluation
  const hintableItems: { text: string; source: "missed" | "improve" }[] = [];
  if (latestEval) {
    for (const m of latestEval.whatMissed || []) hintableItems.push({ text: m, source: "missed" });
    for (const r of latestEval.recommendations || []) hintableItems.push({ text: r, source: "improve" });
  }

  const alreadyHinted = new Set(hints.map((h) => h.text));

  return (
    <div className="shrink-0">
      {/* Collapsed bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-purple-500/20 bg-purple-500/[0.02] hover:bg-purple-500/[0.05] transition-colors text-left"
      >
        <Target className="h-3.5 w-3.5 text-purple-500/60 shrink-0" />
        <span className="text-xs font-medium flex-1">Benchmark</span>
        {runs.length > 0 && (
          <span className="text-[10px] text-muted-foreground/40">{runs.length} run{runs.length !== 1 ? "s" : ""}</span>
        )}
        {hints.length > 0 && (
          <span className="text-[10px] text-purple-500/50">{hints.length} hint{hints.length !== 1 ? "s" : ""}</span>
        )}
        <ChevronDown className={`h-3 w-3 text-muted-foreground/30 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {/* Expanded panel */}
      {expanded && (
        <div className="border border-t-0 border-purple-500/20 rounded-b-md px-3 py-3 space-y-3 animate-in fade-in-0 slide-in-from-top-1 duration-100">

          {/* Action row */}
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={runJudges} disabled={judging} className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-[10px] hover:bg-muted/50 transition-colors disabled:opacity-50">
              {judging ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
              Judges
            </button>
            <button onClick={runEval} disabled={evaluating} className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-[10px] hover:bg-muted/50 transition-colors disabled:opacity-50">
              {evaluating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              Evaluate
            </button>
            {groundTruth && (
              <button onClick={() => setShowGroundTruth(!showGroundTruth)} className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground/40 hover:text-muted-foreground transition-colors ml-auto">
                {showGroundTruth ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                Ground Truth
              </button>
            )}
          </div>

          {/* Run history pills */}
          {runs.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {runs.map((run, idx) => (
                <button
                  key={idx}
                  onClick={() => { setActiveRunIdx(idx); setSelectedVerdict(null); }}
                  className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${idx === activeRunIdx ? "bg-purple-500/10 text-purple-500" : "text-muted-foreground/30 hover:text-muted-foreground/50"}`}
                >
                  {run.type === "judges" ? "Judges" : "Eval"} {timeAgo(run.timestamp)}{run.stepCount > 0 ? ` · ${run.stepCount} steps` : ""}
                </button>
              ))}
            </div>
          )}

          {/* Ground truth */}
          {showGroundTruth && groundTruth && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5">
              <p className="text-[10px] text-amber-500/70 font-medium mb-1">Ground Truth (spoiler)</p>
              <p className="text-[11px] text-muted-foreground/70 leading-relaxed whitespace-pre-wrap">{groundTruth}</p>
            </div>
          )}

          {/* Evaluation results */}
          {evaluation && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="text-xl font-bold">
                  {evaluation.overallScore.toFixed(1)}<span className="text-[10px] text-muted-foreground/40 font-normal">/5</span>
                </div>
                <div className="flex-1 grid grid-cols-5 gap-1">
                  {Object.entries(evaluation.scores).map(([key, score]) => (
                    <div key={key} className="text-center">
                      <div className="h-1 rounded-full bg-muted overflow-hidden">
                        <div className={`h-full rounded-full ${score >= 4 ? "bg-emerald-500" : score >= 3 ? "bg-blue-500" : score >= 2 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${(score / 5) * 100}%` }} />
                      </div>
                      <span className="text-[8px] text-muted-foreground/30">{SCORE_LABELS[key] || key}</span>
                    </div>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground/60">{evaluation.summary}</p>
              <div className="grid grid-cols-2 gap-2 text-[10px]">
                {evaluation.whatMatched?.length > 0 && (
                  <div>
                    <span className="text-emerald-500/70 font-medium flex items-center gap-1 mb-0.5"><CheckCircle className="h-2.5 w-2.5" /> Matched</span>
                    <ul className="space-y-0.5 text-muted-foreground/50">{evaluation.whatMatched.map((m, i) => <li key={i}>- {m}</li>)}</ul>
                  </div>
                )}
                {evaluation.whatMissed?.length > 0 && (
                  <div>
                    <span className="text-amber-500/70 font-medium flex items-center gap-1 mb-0.5"><AlertTriangle className="h-2.5 w-2.5" /> Missed</span>
                    <ul className="space-y-0.5 text-muted-foreground/50">
                      {evaluation.whatMissed.map((m, i) => (
                        <li key={i} className="flex items-start gap-1">
                          <span className="flex-1">- {m}</span>
                          {!alreadyHinted.has(m) && (
                            <button onClick={() => dropHint(m, "missed")} className="text-purple-500/40 hover:text-purple-500 shrink-0 mt-0.5" title="Drop hint to agent">
                              <Zap className="h-2.5 w-2.5" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {evaluation.surprises?.length > 0 && (
                  <div>
                    <span className="text-purple-500/70 font-medium flex items-center gap-1 mb-0.5"><Lightbulb className="h-2.5 w-2.5" /> Surprises</span>
                    <ul className="space-y-0.5 text-muted-foreground/50">{evaluation.surprises.map((s, i) => <li key={i}>- {s}</li>)}</ul>
                  </div>
                )}
                {evaluation.recommendations?.length > 0 && (
                  <div>
                    <span className="text-blue-500/70 font-medium flex items-center gap-1 mb-0.5"><BookOpen className="h-2.5 w-2.5" /> Improve</span>
                    <ul className="space-y-0.5 text-muted-foreground/50">
                      {evaluation.recommendations.map((r, i) => (
                        <li key={i} className="flex items-start gap-1">
                          <span className="flex-1">- {r}</span>
                          {!alreadyHinted.has(r) && (
                            <button onClick={() => dropHint(r, "improve")} className="text-purple-500/40 hover:text-purple-500 shrink-0 mt-0.5" title="Drop hint to agent">
                              <Zap className="h-2.5 w-2.5" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Judge heatmaps */}
          {judges && judges.judges.length > 0 && (
            <div className="space-y-2">
              {judges.judges.map((judge) => (
                <div key={judge.judge} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium">{judge.judge}</span>
                    <span className="text-[9px] text-muted-foreground/40">{judge.overallScore.toFixed(1)}/5</span>
                  </div>
                  <div className="flex gap-px">
                    {judge.verdicts.map((v) => (
                      <button
                        key={v.move}
                        onClick={() => setSelectedVerdict(selectedVerdict?.judge === judge.judge && selectedVerdict?.verdict.move === v.move ? null : { judge: judge.judge, verdict: v })}
                        className={`flex-1 min-w-[3px] h-3 rounded-sm transition-opacity ${selectedVerdict && !(selectedVerdict.judge === judge.judge && selectedVerdict.verdict.move === v.move) ? "opacity-20" : ""} ${v.score >= 2 ? "bg-emerald-500" : v.score >= 1 ? "bg-emerald-500/50" : v.score === 0 ? "bg-muted-foreground/15" : v.score >= -1 ? "bg-amber-500/50" : "bg-red-500"}`}
                      />
                    ))}
                  </div>
                  <p className="text-[9px] text-muted-foreground/30 line-clamp-1">{judge.summary}</p>
                </div>
              ))}
              {selectedVerdict && (
                <div className="rounded-md border border-border/40 bg-muted/20 p-2 text-[10px] animate-in fade-in-0 duration-100">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-medium">Move {selectedVerdict.verdict.move}: {judges.moves[selectedVerdict.verdict.move - 1]?.title || "?"}</span>
                    <span className="text-[8px] text-muted-foreground/30">{selectedVerdict.judge}</span>
                  </div>
                  <div className={`font-medium ${selectedVerdict.verdict.score > 0 ? "text-emerald-500" : selectedVerdict.verdict.score < 0 ? "text-red-500" : "text-muted-foreground/40"}`}>
                    {selectedVerdict.verdict.label.toUpperCase()} ({selectedVerdict.verdict.score > 0 ? "+" : ""}{selectedVerdict.verdict.score})
                  </div>
                  <p className="text-muted-foreground/50 mt-0.5">{selectedVerdict.verdict.comment}</p>
                </div>
              )}
            </div>
          )}

          {/* Dropped hints log */}
          {hints.length > 0 && (
            <div className="space-y-1">
              <span className="text-[9px] text-muted-foreground/30 uppercase tracking-wider">Hints dropped</span>
              {hints.map((h, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[10px]">
                  <Zap className="h-2.5 w-2.5 text-purple-500/40 shrink-0 mt-0.5" />
                  <span className="text-muted-foreground/50 flex-1">{h.text}</span>
                  <span className="text-[8px] text-muted-foreground/20 shrink-0">{timeAgo(h.droppedAt)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!judges && !evaluation && runs.length === 0 && (
            <p className="text-[10px] text-muted-foreground/30 text-center py-1">
              Run judges or evaluate to assess agent progress.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
