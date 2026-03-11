"use client";

import {
  BarChart,
  Bar,
  LineChart,
  Line,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import type { FigureSpec } from "@/lib/synthesis/types";

const DEFAULT_COLORS = [
  "hsl(var(--primary))",
  "#EC4899",
  "#10B981",
  "#F59E0B",
  "#3B82F6",
  "#8B5CF6",
];

function FigureChart({ spec }: { spec: FigureSpec }) {
  const { chartType, xAxis, yAxis, data, series } = spec;

  switch (chartType) {
    case "bar":
      return (
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey={xAxis.key} tick={{ fontSize: 11 }} className="fill-muted-foreground" angle={-30} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" label={{ value: yAxis.label, angle: -90, position: "insideLeft", style: { fontSize: 11 } }} />
            <Tooltip contentStyle={{ fontSize: 12 }} />
            <Bar dataKey={yAxis.key} fill={DEFAULT_COLORS[0]} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      );

    case "grouped_bar": {
      const groups = series || [{ key: yAxis.key, label: yAxis.label }];
      return (
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey={xAxis.key} tick={{ fontSize: 11 }} className="fill-muted-foreground" angle={-30} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" />
            <Tooltip contentStyle={{ fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {groups.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]} radius={[4, 4, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      );
    }

    case "line": {
      const lines = series || [{ key: yAxis.key, label: yAxis.label }];
      return (
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey={xAxis.key} tick={{ fontSize: 11 }} className="fill-muted-foreground" />
            <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" label={{ value: yAxis.label, angle: -90, position: "insideLeft", style: { fontSize: 11 } }} />
            <Tooltip contentStyle={{ fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {lines.map((s, i) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      );
    }

    case "scatter":
      return (
        <ResponsiveContainer width="100%" height={250}>
          <ScatterChart margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey={xAxis.key} name={xAxis.label} tick={{ fontSize: 11 }} className="fill-muted-foreground" label={{ value: xAxis.label, position: "insideBottom", offset: -5, style: { fontSize: 11 } }} />
            <YAxis dataKey={yAxis.key} name={yAxis.label} tick={{ fontSize: 11 }} className="fill-muted-foreground" label={{ value: yAxis.label, angle: -90, position: "insideLeft", style: { fontSize: 11 } }} />
            <Tooltip contentStyle={{ fontSize: 12 }} cursor={{ strokeDasharray: "3 3" }} />
            <Scatter data={data} fill={DEFAULT_COLORS[0]} />
          </ScatterChart>
        </ResponsiveContainer>
      );

    default:
      return <p className="text-sm text-muted-foreground">Unsupported chart type: {chartType}</p>;
  }
}

interface VizFiguresProps {
  figures: FigureSpec[];
}

export function VizFigures({ figures }: VizFiguresProps) {
  if (figures.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        No figure data available.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {figures.map((fig, i) => (
        <div key={i}>
          <h4 className="text-sm font-medium mb-1">{fig.title}</h4>
          <FigureChart spec={fig} />
          <p className="text-xs text-muted-foreground mt-1">{fig.caption}</p>
        </div>
      ))}
    </div>
  );
}
