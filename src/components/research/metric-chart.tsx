"use client";

import { useState } from "react";

interface MetricChartProps {
  results: Array<{
    id: string;
    scriptName: string;
    metrics: string | null;
    verdict: string | null;
    createdAt: string;
    branch: { name: string } | null;
  }>;
  compact?: boolean;
  /** If provided, plot this specific metric instead of auto-detecting */
  metricName?: string;
}

interface DataPoint {
  x: number;
  y: number;
  label: string;
  branch: string;
  verdict: string | null;
}

const COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
];

export function MetricChart({ results, compact = false, metricName }: MetricChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // 1. Parse all metrics
  const parsed = results
    .map((r) => {
      let metricsObj: Record<string, unknown> = {};
      try {
        metricsObj = r.metrics ? JSON.parse(r.metrics) : {};
      } catch {
        /* skip unparseable */
      }
      return { ...r, metricsObj };
    })
    .filter((r) => Object.keys(r.metricsObj).length > 0);

  if (parsed.length < 2) return null;

  // 2. Find best metric — prefer recognized performance metrics, skip parameters
  const PARAM_RE = /^(n_seeds?|total_budget|num_|batch_size|lr|learning_rate|epochs?|steps|samples|budget|size|count|length|n_|k_|max_|min_|top_)/i;
  const METRIC_RE = /(?:f1|accuracy|acc|precision|recall|auroc|auc|bleu|rouge|perplexity|loss|mse|mae|rmse|r2|score|reward|return|success_rate)/i;

  const metricCounts = new Map<string, number>();
  for (const r of parsed) {
    for (const key of Object.keys(r.metricsObj)) {
      if (typeof r.metricsObj[key] === "number" && !PARAM_RE.test(key)) {
        metricCounts.set(key, (metricCounts.get(key) || 0) + 1);
      }
    }
  }

  // Sort: recognized metric names first, then by frequency
  const sortedMetrics = Array.from(metricCounts.entries()).sort(
    (a, b) => {
      const aRecognized = METRIC_RE.test(a[0]) ? 1 : 0;
      const bRecognized = METRIC_RE.test(b[0]) ? 1 : 0;
      if (aRecognized !== bRecognized) return bRecognized - aRecognized;
      return b[1] - a[1];
    }
  );
  if (sortedMetrics.length === 0 && !metricName) return null;
  const primaryMetric = metricName || sortedMetrics[0]?.[0] || "value";

  // 3. Extract data points
  const points: DataPoint[] = parsed
    .filter((r) => typeof r.metricsObj[primaryMetric] === "number")
    .map((r, i) => ({
      x: i,
      y: r.metricsObj[primaryMetric] as number,
      label: r.scriptName,
      branch: r.branch?.name || "unlinked",
      verdict: r.verdict,
    }));

  if (points.length < 2) return null;

  // 4. Calculate chart dimensions
  const W = compact ? 400 : 600;
  const H = compact ? 80 : 160;
  const PAD = compact
    ? { top: 8, right: 8, bottom: 8, left: 8 }
    : { top: 20, right: 20, bottom: 30, left: 50 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const rawMin = Math.min(...points.map((p) => p.y));
  const rawMax = Math.max(...points.map((p) => p.y));
  const yMin = rawMin * 0.95;
  const yMax = rawMax * 1.05;
  const yRange = yMax - yMin || 1;

  const scaleX = (i: number) =>
    PAD.left + (i / (points.length - 1)) * chartW;
  const scaleY = (v: number) =>
    PAD.top + chartH - ((v - yMin) / yRange) * chartH;

  // 5. Build path
  const pathD = points
    .map(
      (p, i) => `${i === 0 ? "M" : "L"} ${scaleX(p.x)} ${scaleY(p.y)}`
    )
    .join(" ");

  // 6. Color by branch
  const branches = Array.from(new Set(points.map((p) => p.branch)));
  const branchColor = (b: string) =>
    COLORS[branches.indexOf(b) % COLORS.length];

  // 7. Best point
  const best = points.reduce((a, b) => (a.y > b.y ? a : b));
  const bestIdx = points.indexOf(best);

  // 8. Y-axis ticks (4 values)
  const yTicks: number[] = [];
  for (let i = 0; i <= 3; i++) {
    yTicks.push(yMin + (yRange * i) / 3);
  }

  // 9. Abbreviate script name for x-axis
  const abbreviate = (name: string) => {
    const base = name.replace(/\.py$/, "").replace(/^.*\//, "");
    return base.length > 10 ? base.slice(0, 9) + "\u2026" : base;
  };

  // Show at most ~6 x-axis labels to avoid crowding
  const maxXLabels = 6;
  const xLabelStep =
    points.length <= maxXLabels
      ? 1
      : Math.ceil(points.length / maxXLabels);

  return (
    <div className={`relative ${compact ? "" : "rounded-lg border border-border/60 p-4"}`}>
      {!compact && (
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {primaryMetric}
            <span className="ml-2 text-foreground font-mono">
              {best.y.toFixed(3)}
            </span>
            <span className="ml-1 text-emerald-600 text-[11px]">best</span>
          </h3>
          {branches.length > 1 && (
            <div className="flex items-center gap-3">
              {branches.map((b) => (
                <div key={b} className="flex items-center gap-1">
                  <span
                    className="block h-2 w-2 rounded-full"
                    style={{ backgroundColor: branchColor(b) }}
                  />
                  <span className="text-[10px] text-muted-foreground">
                    {b}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <svg
        viewBox={`0 ${compact ? -55 : 0} ${W} ${H + (compact ? 55 : 0)}`}
        className="w-full"
        style={{ overflow: "visible", maxHeight: compact ? 80 : 160 }}
      >
        {/* Grid lines */}
        {!compact && yTicks.map((tick, i) => (
          <line
            key={i}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={scaleY(tick)}
            y2={scaleY(tick)}
            stroke="currentColor"
            className="text-border"
            strokeWidth={0.5}
            strokeDasharray={i === 0 ? "none" : "3,3"}
          />
        ))}

        {/* Y-axis labels */}
        {!compact && yTicks.map((tick, i) => (
          <text
            key={i}
            x={PAD.left - 6}
            y={scaleY(tick) + 3}
            textAnchor="end"
            className="fill-muted-foreground"
            fontSize={9}
            fontFamily="monospace"
          >
            {tick.toFixed(3)}
          </text>
        ))}

        {/* Line path */}
        <path
          d={pathD}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="opacity-60"
        />

        {/* Data points */}
        {points.map((p, i) => (
          <g key={i}>
            {/* Hover target (larger invisible circle) */}
            <circle
              cx={scaleX(p.x)}
              cy={scaleY(p.y)}
              r={10}
              fill="transparent"
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              style={{ cursor: "pointer" }}
            />
            {/* Visible point */}
            <circle
              cx={scaleX(p.x)}
              cy={scaleY(p.y)}
              r={compact ? (i === bestIdx ? 3.5 : 2) : (i === bestIdx ? 5 : 3.5)}
              fill={branchColor(p.branch)}
              stroke={i === bestIdx ? "#fff" : "none"}
              strokeWidth={i === bestIdx ? 1.5 : 0}
              className="pointer-events-none"
            />
            {/* Best indicator ring */}
            {i === bestIdx && (
              <circle
                cx={scaleX(p.x)}
                cy={scaleY(p.y)}
                r={compact ? 5 : 8}
                fill="none"
                stroke="#10b981"
                strokeWidth={1}
                strokeDasharray="2,2"
                className="pointer-events-none"
              />
            )}
          </g>
        ))}

        {/* X-axis labels */}
        {!compact && points.map(
          (p, i) =>
            i % xLabelStep === 0 && (
              <text
                key={i}
                x={scaleX(p.x)}
                y={H - 6}
                textAnchor="middle"
                className="fill-muted-foreground"
                fontSize={8}
              >
                {abbreviate(p.label)}
              </text>
            )
        )}

        {/* Vertical guide line for hovered point */}
        {hoveredIdx !== null && (() => {
          const p = points[hoveredIdx];
          const tx = scaleX(p.x);
          return (
            <line
              x1={tx} x2={tx}
              y1={PAD.top} y2={PAD.top + chartH}
              stroke="currentColor" className="text-border pointer-events-none"
              strokeWidth={0.5} strokeDasharray="2,2"
            />
          );
        })()}
      </svg>

      {/* HTML tooltip — positioned absolutely over the chart */}
      {hoveredIdx !== null && (() => {
        const p = points[hoveredIdx];
        // Calculate percentage position within the chart for CSS positioning
        const xPct = (scaleX(p.x) / W) * 100;
        const flipLeft = xPct > 60;
        return (
          <div
            className="absolute pointer-events-none z-20"
            style={{
              left: flipLeft ? "auto" : `${xPct}%`,
              right: flipLeft ? `${100 - xPct}%` : "auto",
              bottom: "100%",
              marginBottom: 4,
            }}
          >
            <div className="bg-background border border-border rounded-lg shadow-lg px-3 py-2 text-left whitespace-nowrap">
              <p className="text-xs font-semibold">{p.label}</p>
              <p className="text-xs font-mono mt-0.5">{primaryMetric}: <strong>{p.y.toFixed(4)}</strong></p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {p.branch}{p.verdict ? ` · ${p.verdict}` : ""}
              </p>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
