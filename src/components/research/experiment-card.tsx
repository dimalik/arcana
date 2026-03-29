"use client";

import { useState } from "react";
import {
  ChevronDown,
  Clock,
  Server,
  Image,
  FileText,
  AlertTriangle,
} from "lucide-react";

interface ExperimentCardProps {
  result: {
    id: string;
    scriptName: string;
    metrics: string | null;
    comparison: string | null;
    verdict: string | null;
    reflection: string | null;
    hypothesisId: string | null;
    branchId: string | null;
    jobId: string | null;
    createdAt: string;
    branch: { name: string; status: string } | null;
  };
  job?: {
    id: string;
    status: string;
    exitCode: number | null;
    command: string;
    startedAt: string | null;
    completedAt: string | null;
    stderr: string | null;
    host: { alias: string; gpuType: string | null };
  };
  hypothesisStatement?: string;
  projectId: string;
  artifacts?: { name: string; path: string }[];
}

const VERDICT_STYLES: Record<
  string,
  { border: string; badge: string; label: string }
> = {
  better: {
    border: "border-l-emerald-500",
    badge: "bg-emerald-500/10 text-emerald-600",
    label: "BETTER",
  },
  worse: {
    border: "border-l-red-500",
    badge: "bg-red-500/10 text-red-600",
    label: "WORSE",
  },
  error: {
    border: "border-l-red-500",
    badge: "bg-red-500/10 text-red-600",
    label: "ERROR",
  },
  inconclusive: {
    border: "border-l-amber-500",
    badge: "bg-amber-500/10 text-amber-600",
    label: "INCONCLUSIVE",
  },
};

const APPROACH_STATUS_BADGE: Record<string, string> = {
  ACTIVE: "bg-blue-500/10 text-blue-600",
  PROMISING: "bg-emerald-500/10 text-emerald-600",
  ABANDONED: "bg-muted-foreground/10 text-muted-foreground",
  EXHAUSTED: "bg-red-500/10 text-red-600",
};

function parseJson(val: string | null): Record<string, unknown> | null {
  if (!val) return null;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

function formatDuration(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function isImageFile(name: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(name);
}

export function ExperimentCard({
  result,
  job,
  hypothesisStatement,
  projectId,
  artifacts,
}: ExperimentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  const verdictKey = (result.verdict || "").toLowerCase();
  const verdictStyle = VERDICT_STYLES[verdictKey] || {
    border: "border-l-muted-foreground/30",
    badge: "bg-muted text-muted-foreground",
    label: result.verdict?.toUpperCase() || "N/A",
  };

  const metrics = parseJson(result.metrics) as Record<string, number> | null;
  const comparison = parseJson(result.comparison) as Record<string, number> | null;
  const metricsEntries = metrics ? Object.entries(metrics) : [];
  const comparisonEntries = comparison ? Object.entries(comparison) : [];

  const duration = job ? formatDuration(job.startedAt, job.completedAt) : null;
  const isError = verdictKey === "error";

  const imgUrl = (filePath: string) =>
    `/api/research/${projectId}/files/download?path=${encodeURIComponent(filePath)}`;

  // Collapsed one-line summary
  const firstMetric = metricsEntries[0];

  return (
    <>
      <div
        className={`rounded-md border border-border/60 border-l-[3px] ${verdictStyle.border} ${
          isError ? "bg-red-500/[0.02]" : ""
        } overflow-hidden`}
      >
        {/* Collapsed header - always visible */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full px-3 py-2 hover:bg-muted/30 transition-colors text-left"
        >
          <ChevronDown
            className={`h-3 w-3 text-muted-foreground shrink-0 transition-transform ${
              expanded ? "" : "-rotate-90"
            }`}
          />
          <span className="text-[11px] font-mono font-medium truncate">
            {result.scriptName}
          </span>
          {firstMetric && !expanded && (
            <span className="text-[10px] font-mono text-muted-foreground">
              {firstMetric[0]}: {typeof firstMetric[1] === "number" ? firstMetric[1].toFixed(3) : String(firstMetric[1])}
            </span>
          )}
          {duration && !expanded && (
            <span className="text-[9px] text-muted-foreground/50 flex items-center gap-0.5">
              <Clock className="h-2.5 w-2.5" />
              {duration}
            </span>
          )}
          <span className="flex-1" />
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${verdictStyle.badge}`}
          >
            {verdictStyle.label}
          </span>
        </button>

        {/* Expanded details */}
        {expanded && (
          <div className="px-3 pb-3 space-y-2.5">
            {/* Divider */}
            <div className="border-t border-dashed border-border/50" />

            {/* Hypothesis + Approach */}
            {hypothesisStatement && (
              <p className="text-[11px] text-muted-foreground">
                <span className="text-muted-foreground/60">Hypothesis:</span>{" "}
                {hypothesisStatement.length > 100
                  ? hypothesisStatement.slice(0, 100) + "..."
                  : hypothesisStatement}
              </p>
            )}
            {result.branch && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                <span className="text-muted-foreground/60">Approach:</span>{" "}
                {result.branch.name}
                <span
                  className={`text-[9px] px-1 py-0 rounded-full ${
                    APPROACH_STATUS_BADGE[result.branch.status] ||
                    "bg-muted text-muted-foreground"
                  }`}
                >
                  {result.branch.status}
                </span>
              </p>
            )}

            {/* Metrics pills */}
            {metricsEntries.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {metricsEntries.map(([key, value]) => (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1 rounded-md bg-muted/50 border border-border/40 px-2 py-0.5"
                  >
                    <span className="text-[10px] text-muted-foreground">
                      {key}:
                    </span>
                    <span className="text-[10px] font-mono font-medium">
                      {typeof value === "number" ? value.toFixed(3) : String(value)}
                    </span>
                  </span>
                ))}
              </div>
            )}

            {/* Comparison deltas */}
            {comparisonEntries.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <span className="text-[10px] text-muted-foreground/60">
                  vs baseline:
                </span>
                {comparisonEntries.map(([key, delta]) => {
                  const numDelta = typeof delta === "number" ? delta : 0;
                  const isPositive = numDelta > 0;
                  const isNegative = numDelta < 0;
                  return (
                    <span
                      key={key}
                      className={`text-[10px] font-mono ${
                        isPositive
                          ? "text-emerald-600"
                          : isNegative
                          ? "text-red-600"
                          : "text-muted-foreground"
                      }`}
                    >
                      {key}{" "}
                      {isPositive ? "+" : ""}
                      {typeof delta === "number"
                        ? Math.abs(delta) < 1
                          ? (delta * 100).toFixed(1) + "%"
                          : delta.toFixed(3)
                        : String(delta)}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Reflection / Summary */}
            {result.reflection && (
              <p
                className={`text-[11px] italic ${
                  isError ? "text-red-600/80" : "text-muted-foreground/70"
                }`}
              >
                {result.reflection}
              </p>
            )}

            {/* Stderr for errors */}
            {isError && job?.stderr && (
              <pre className="text-[10px] text-red-600/70 bg-red-500/5 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono">
                {job.stderr.split("\n").filter(Boolean).slice(-15).join("\n")}
              </pre>
            )}

            {/* Artifacts */}
            {artifacts && artifacts.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {artifacts.map((artifact) => {
                  const isImg = isImageFile(artifact.name);
                  return (
                    <span key={artifact.path} className="inline-flex items-center gap-1">
                      {isImg ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setLightboxImage(artifact.path);
                          }}
                          className="flex items-center gap-1 rounded border border-border/40 bg-muted/30 px-1.5 py-0.5 hover:bg-muted/60 transition-colors"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={imgUrl(artifact.path)}
                            alt={artifact.name}
                            className="h-[48px] object-contain rounded"
                            loading="lazy"
                          />
                          <span className="text-[9px] text-muted-foreground/60 max-w-[80px] truncate">
                            {artifact.name}
                          </span>
                        </button>
                      ) : (
                        <a
                          href={imgUrl(artifact.path)}
                          download
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 rounded border border-border/40 bg-muted/30 px-1.5 py-0.5 hover:bg-muted/60 transition-colors"
                        >
                          {/\.(json|csv|tsv)$/i.test(artifact.name) ? (
                            <FileText className="h-3 w-3 text-muted-foreground/50" />
                          ) : (
                            <Image className="h-3 w-3 text-muted-foreground/50" />
                          )}
                          <span className="text-[9px] text-muted-foreground/60 max-w-[100px] truncate">
                            {artifact.name}
                          </span>
                        </a>
                      )}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Duration + host */}
            {job && (
              <div className="flex items-center gap-2 text-[9px] text-muted-foreground/50">
                {duration && (
                  <span className="flex items-center gap-0.5">
                    <Clock className="h-2.5 w-2.5" />
                    {duration}
                  </span>
                )}
                <span className="flex items-center gap-0.5">
                  <Server className="h-2.5 w-2.5" />
                  {job.host.alias}
                  {job.host.gpuType && ` (${job.host.gpuType})`}
                </span>
                {isError && job.exitCode != null && (
                  <span className="flex items-center gap-0.5 text-red-500/60">
                    <AlertTriangle className="h-2.5 w-2.5" />
                    exit {job.exitCode}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Lightbox for artifact images */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 animate-in fade-in-0 duration-150"
          onClick={() => setLightboxImage(null)}
        >
          <div
            className="relative max-w-[90vw] max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setLightboxImage(null)}
              className="absolute -top-10 right-0 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
            >
              &times;
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imgUrl(lightboxImage)}
              alt={artifacts?.find((a) => a.path === lightboxImage)?.name || ""}
              className="max-w-full max-h-[85vh] object-contain rounded-lg bg-white"
            />
            <p className="text-center text-xs text-white/50 mt-2">
              {artifacts?.find((a) => a.path === lightboxImage)?.name}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
