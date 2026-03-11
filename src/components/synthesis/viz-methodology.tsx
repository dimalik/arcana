"use client";

interface MethodologyPaper {
  id: string;
  title: string;
  approach: string;
  datasets: string[];
  metrics: string[];
}

interface VizMethodologyProps {
  data: {
    papers: MethodologyPaper[];
  };
}

export function VizMethodology({ data }: VizMethodologyProps) {
  if (data.papers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        No methodology data available.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="border border-border px-3 py-2 bg-muted font-semibold text-left">
              Paper
            </th>
            <th className="border border-border px-3 py-2 bg-muted font-semibold text-left">
              Approach
            </th>
            <th className="border border-border px-3 py-2 bg-muted font-semibold text-left">
              Datasets
            </th>
            <th className="border border-border px-3 py-2 bg-muted font-semibold text-left">
              Metrics
            </th>
          </tr>
        </thead>
        <tbody>
          {data.papers.map((p) => (
            <tr key={p.id} className="hover:bg-muted/50">
              <td className="border border-border px-3 py-2 font-medium max-w-[200px] truncate">
                {p.title}
              </td>
              <td className="border border-border px-3 py-2">
                {p.approach}
              </td>
              <td className="border border-border px-3 py-2">
                {p.datasets.join(", ") || "—"}
              </td>
              <td className="border border-border px-3 py-2">
                {p.metrics.join(", ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
