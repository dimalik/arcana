"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface TimelineEntry {
  year: number;
  count: number;
  papers: { id: string; title: string }[];
}

interface VizTimelineProps {
  data: TimelineEntry[];
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: TimelineEntry }[] }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0].payload;
  return (
    <div className="rounded-lg border bg-background p-3 shadow-md max-w-xs">
      <p className="font-medium text-sm">{entry.year}</p>
      <p className="text-xs text-muted-foreground mb-1">
        {entry.count} paper{entry.count !== 1 ? "s" : ""}
      </p>
      <ul className="space-y-0.5">
        {entry.papers.slice(0, 5).map((p) => (
          <li key={p.id} className="text-xs text-muted-foreground truncate">
            {p.title}
          </li>
        ))}
        {entry.papers.length > 5 && (
          <li className="text-xs text-muted-foreground">
            +{entry.papers.length - 5} more
          </li>
        )}
      </ul>
    </div>
  );
}

export function VizTimeline({ data }: VizTimelineProps) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        No year data available.
      </p>
    );
  }

  return (
    <div className="h-[250px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="year" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} className="fill-muted-foreground" />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
