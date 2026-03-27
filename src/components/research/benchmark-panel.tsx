"use client";

import { useState } from "react";
import { FlaskConical, Sparkles, Loader2, CheckCircle, AlertTriangle, ChevronDown, Target, Eye, EyeOff } from "lucide-react";
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

export function BenchmarkPanel({ projectId, groundTruth }: Props) {
  const [judging, setJudging] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [judges, setJudges] = useState<{ moves: { step: number; type: string; title: string }[]; judges: JudgeReport[] } | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [showGroundTruth, setShowGroundTruth] = useState(false);

  const runJudges = async () => {
    setJudging(true);
    try {
      const res = await fetch("/api/research/benchmark/judges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setJudges(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Judge panel failed");
    }
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
      setEvaluation(data.evaluation);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Evaluation failed");
    }
    setEvaluating(false);
  };

  return (
    <div className="space-y-3">
      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={runJudges}
          disabled={judging}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-[11px] hover:bg-muted/50 transition-colors disabled:opacity-50"
        >
          {judging ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
          Run Judges
        </button>
        <button
          onClick={runEval}
          disabled={evaluating}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-[11px] hover:bg-muted/50 transition-colors disabled:opacity-50"
        >
          {evaluating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          Evaluate
        </button>
        {groundTruth && (
          <button
            onClick={() => setShowGroundTruth(!showGroundTruth)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-[11px] hover:bg-muted/50 transition-colors ml-auto"
          >
            {showGroundTruth ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {showGroundTruth ? "Hide" : "Show"} Ground Truth
          </button>
        )}
      </div>

      {/* Ground truth (collapsible) */}
      {showGroundTruth && groundTruth && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
          <p className="text-[10px] text-amber-500/70 font-medium mb-1">Ground Truth (spoiler)</p>
          <p className="text-xs text-muted-foreground/70 leading-relaxed whitespace-pre-wrap">{groundTruth}</p>
        </div>
      )}

      {/* Evaluation results */}
      {evaluation && (
        <div className="rounded-md border border-border/40 p-3 space-y-3">
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
                  <span className="text-[8px] text-muted-foreground/40 mt-0.5 block">{SCORE_LABELS[key] || key}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground/70">{evaluation.summary}</p>
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
          </div>
        </div>
      )}

      {/* Judge heatmaps */}
      {judges && (
        <div className="space-y-3">
          {judges.judges.map((judge) => (
            <div key={judge.judge} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium">{judge.judge}</span>
                <span className="text-[10px] text-muted-foreground/50">{judge.overallScore.toFixed(1)}/5</span>
              </div>
              <div className="flex gap-px">
                {judge.verdicts.map((v) => (
                  <div key={v.move} className="group relative flex-1 min-w-[4px]">
                    <div
                      className={`h-3 rounded-sm ${
                        v.score >= 2 ? "bg-emerald-500" :
                        v.score >= 1 ? "bg-emerald-500/50" :
                        v.score === 0 ? "bg-muted-foreground/15" :
                        v.score >= -1 ? "bg-amber-500/50" :
                        "bg-red-500"
                      }`}
                    />
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-20 w-48 p-2 rounded-md bg-popover border border-border shadow-md text-[10px]">
                      <div className="font-medium mb-0.5">
                        Move {v.move}: {judges.moves[v.move - 1]?.title || "?"}
                      </div>
                      <div className={v.score > 0 ? "text-emerald-500" : v.score < 0 ? "text-red-500" : "text-muted-foreground/50"}>
                        {v.label.toUpperCase()} ({v.score > 0 ? "+" : ""}{v.score})
                      </div>
                      <div className="text-muted-foreground/60 mt-0.5">{v.comment}</div>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/40">{judge.summary}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
