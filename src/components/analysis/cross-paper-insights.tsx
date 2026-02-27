"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  AlertTriangle,
  Search,
  GitBranch,
  FlaskConical,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { cleanJsonResponse } from "@/lib/llm/prompts";
import { MethodologyComparator } from "./methodology-comparator";
import Link from "next/link";

interface PromptResult {
  id: string;
  promptType: string;
  prompt: string;
  result: string;
  provider: string | null;
  model: string | null;
  createdAt: string;
}

interface CrossPaperInsightsProps {
  paperId: string;
  promptResults: PromptResult[];
  onUpdate: () => void;
  relatedPapers?: Record<string, string>; // id → title
}

// ── Types for parsed JSON ──

interface Contradiction {
  newPaperClaim: string;
  conflictingPaperId: string;
  conflictingPaperClaim: string;
  severity: "direct" | "methodological" | "tension";
  explanation: string;
}

interface ContradictionResult {
  contradictions: Contradiction[];
  summary: string;
}

interface Gap {
  title: string;
  description: string;
  relevantPaperIds: string[];
  type: "methodological" | "empirical" | "theoretical" | "application" | "scale";
  confidence: number;
}

interface GapResult {
  gaps: Gap[];
  overallAssessment: string;
}

interface TimelineEntry {
  paperId: string;
  year: number;
  role: string;
  contribution: string;
  buildsOn: string[];
  keyAdvance: string;
}

interface TimelineResult {
  timeline: TimelineEntry[];
  narrative: string;
  openQuestions: string[];
}

// ── Severity badge colors ──

const SEVERITY_STYLES: Record<string, { variant: "destructive" | "secondary" | "outline"; label: string }> = {
  direct: { variant: "destructive", label: "Direct" },
  methodological: { variant: "secondary", label: "Methodological" },
  tension: { variant: "outline", label: "Tension" },
};

const GAP_TYPE_STYLES: Record<string, string> = {
  methodological: "bg-purple-500/10 text-purple-700 dark:text-purple-400",
  empirical: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  theoretical: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  application: "bg-green-500/10 text-green-700 dark:text-green-400",
  scale: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
};

const ROLE_STYLES: Record<string, string> = {
  origin: "bg-amber-500 text-white",
  extension: "bg-blue-500 text-white",
  alternative: "bg-purple-500 text-white",
  refinement: "bg-green-500 text-white",
  application: "bg-teal-500 text-white",
  evaluation: "bg-slate-500 text-white",
};

function safeParse<T>(result: string): T | null {
  try {
    return JSON.parse(cleanJsonResponse(result)) as T;
  } catch {
    return null;
  }
}

// ── Contradictions Section ──

function PaperLink({ id, relatedPapers }: { id: string; relatedPapers?: Record<string, string> }) {
  const title = relatedPapers?.[id];
  return (
    <Link href={`/papers/${id}`} className="text-primary hover:underline">
      {title || id.slice(0, 8)}
    </Link>
  );
}

function ContradictionsSection({ promptResults, relatedPapers }: { promptResults: PromptResult[]; relatedPapers?: Record<string, string> }) {
  const latest = promptResults
    .filter((pr) => pr.promptType === "detectContradictions")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  if (!latest) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Not yet analyzed. Contradictions are detected automatically when papers are processed with related papers in the library.
        </CardContent>
      </Card>
    );
  }

  const parsed = safeParse<ContradictionResult>(latest.result);
  if (!parsed) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Analysis result could not be parsed.
        </CardContent>
      </Card>
    );
  }

  if (parsed.contradictions.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          {parsed.summary || "No contradictions found with related papers."}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {parsed.summary && (
        <p className="text-sm text-muted-foreground">{parsed.summary}</p>
      )}
      {parsed.contradictions.map((c, i) => {
        const style = SEVERITY_STYLES[c.severity] || SEVERITY_STYLES.tension;
        return (
          <Card key={i}>
            <CardContent className="pt-4 pb-4 space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant={style.variant} className="text-[10px]">
                  {style.label}
                </Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 text-sm">
                <div className="rounded-md bg-muted/50 p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">This paper claims</p>
                  <p>{c.newPaperClaim}</p>
                </div>
                <div className="rounded-md bg-muted/50 p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    Related paper claims
                    {c.conflictingPaperId && (
                      <> — <PaperLink id={c.conflictingPaperId} relatedPapers={relatedPapers} /></>
                    )}
                  </p>
                  <p>{c.conflictingPaperClaim}</p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">{c.explanation}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ── Gaps Section ──

function GapsSection({ paperId, promptResults, onUpdate, relatedPapers }: { paperId: string; promptResults: PromptResult[]; onUpdate: () => void; relatedPapers?: Record<string, string> }) {
  const [loading, setLoading] = useState(false);

  const latest = promptResults
    .filter((pr) => pr.promptType === "findGaps")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  const handleRun = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/papers/${paperId}/llm/gap-finder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to find gaps");
        return;
      }
      toast.success("Gap analysis complete");
      onUpdate();
    } catch {
      toast.error("Failed to find gaps");
    } finally {
      setLoading(false);
    }
  };

  const parsed = latest ? safeParse<GapResult>(latest.result) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRun}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="mr-1.5 h-3.5 w-3.5" />
          )}
          {loading ? "Analyzing..." : "Find Research Gaps"}
        </Button>
      </div>

      {parsed && (
        <>
          {parsed.overallAssessment && (
            <p className="text-sm text-muted-foreground">{parsed.overallAssessment}</p>
          )}
          {parsed.gaps.map((gap, i) => {
            const typeClass = GAP_TYPE_STYLES[gap.type] || "bg-muted text-muted-foreground";
            return (
              <Card key={i}>
                <CardContent className="pt-4 pb-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${typeClass}`}>
                      {gap.type}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {Math.round(gap.confidence * 100)}% confidence
                    </span>
                  </div>
                  <p className="text-sm font-medium">{gap.title}</p>
                  <p className="text-sm text-muted-foreground">{gap.description}</p>
                  {gap.relevantPaperIds && gap.relevantPaperIds.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Related:</span>
                      {gap.relevantPaperIds.map((pid) => (
                        <PaperLink key={pid} id={pid} relatedPapers={relatedPapers} />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </>
      )}

      {!parsed && !loading && !latest && (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Click &quot;Find Research Gaps&quot; to analyze unexplored directions across related papers.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Timeline Section ──

function TimelineSection({ paperId, promptResults, onUpdate, relatedPapers }: { paperId: string; promptResults: PromptResult[]; onUpdate: () => void; relatedPapers?: Record<string, string> }) {
  const [loading, setLoading] = useState(false);

  const latest = promptResults
    .filter((pr) => pr.promptType === "buildTimeline")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  const handleRun = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/papers/${paperId}/llm/timeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to build timeline");
        return;
      }
      toast.success("Timeline built");
      onUpdate();
    } catch {
      toast.error("Failed to build timeline");
    } finally {
      setLoading(false);
    }
  };

  const parsed = latest ? safeParse<TimelineResult>(latest.result) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRun}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitBranch className="mr-1.5 h-3.5 w-3.5" />
          )}
          {loading ? "Building..." : "Build Timeline"}
        </Button>
      </div>

      {parsed && (
        <>
          {parsed.narrative && (
            <p className="text-sm text-muted-foreground">{parsed.narrative}</p>
          )}

          {/* Vertical timeline */}
          <div className="relative ml-3 border-l-2 border-border pl-6 space-y-4">
            {parsed.timeline.map((entry, i) => {
              const roleClass = ROLE_STYLES[entry.role] || "bg-muted text-muted-foreground";
              return (
                <div key={i} className="relative">
                  {/* Timeline dot */}
                  <div className="absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-background bg-border" />
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono text-muted-foreground">{entry.year || "?"}</span>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${roleClass}`}>
                        {entry.role}
                      </span>
                      {entry.paperId && (
                        <PaperLink id={entry.paperId} relatedPapers={relatedPapers} />
                      )}
                    </div>
                    <p className="text-sm">{entry.contribution}</p>
                    {entry.keyAdvance && (
                      <p className="text-xs text-muted-foreground flex items-start gap-1">
                        <ArrowRight className="mt-0.5 h-3 w-3 shrink-0" />
                        {entry.keyAdvance}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {parsed.openQuestions && parsed.openQuestions.length > 0 && (
            <Card>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Open Questions</p>
                <ul className="space-y-1">
                  {parsed.openQuestions.map((q, i) => (
                    <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500/50" />
                      {q}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {!parsed && !loading && !latest && (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Click &quot;Build Timeline&quot; to trace how ideas evolved across related papers.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Main Component ──

export function CrossPaperInsights({ paperId, promptResults, onUpdate, relatedPapers }: CrossPaperInsightsProps) {
  return (
    <div className="space-y-6">
      {/* Methodology Comparison */}
      <section>
        <h3 className="flex items-center gap-2 text-sm font-medium mb-3">
          <FlaskConical className="h-4 w-4 text-purple-500" />
          Methodology Comparison
        </h3>
        <MethodologyComparator paperId={paperId} promptResults={promptResults} onUpdate={onUpdate} />
      </section>

      {/* Contradictions */}
      <section>
        <h3 className="flex items-center gap-2 text-sm font-medium mb-3">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Contradictions
        </h3>
        <ContradictionsSection promptResults={promptResults} relatedPapers={relatedPapers} />
      </section>

      {/* Research Gaps */}
      <section>
        <h3 className="flex items-center gap-2 text-sm font-medium mb-3">
          <Search className="h-4 w-4 text-blue-500" />
          Research Gaps
        </h3>
        <GapsSection paperId={paperId} promptResults={promptResults} onUpdate={onUpdate} relatedPapers={relatedPapers} />
      </section>

      {/* Idea Timeline */}
      <section>
        <h3 className="flex items-center gap-2 text-sm font-medium mb-3">
          <GitBranch className="h-4 w-4 text-green-500" />
          Idea Timeline
        </h3>
        <TimelineSection paperId={paperId} promptResults={promptResults} onUpdate={onUpdate} relatedPapers={relatedPapers} />
      </section>
    </div>
  );
}
