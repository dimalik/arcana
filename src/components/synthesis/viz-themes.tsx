"use client";

import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface ThemeEntry {
  theme: string;
  count: number;
  color: string;
}

interface VizThemesProps {
  data: ThemeEntry[];
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: ThemeEntry }[] }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0].payload;
  return (
    <div className="rounded-lg border bg-background p-2 shadow-md">
      <p className="text-sm font-medium">{entry.theme}</p>
      <p className="text-xs text-muted-foreground">
        {entry.count} paper{entry.count !== 1 ? "s" : ""}
      </p>
    </div>
  );
}

export function VizThemes({ data }: VizThemesProps) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        No theme data available.
      </p>
    );
  }

  return (
    <div className="h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="count"
            nameKey="theme"
            cx="50%"
            cy="50%"
            outerRadius={100}
            label={({ name, value }) => `${name} (${value})`}
            labelLine
          >
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
