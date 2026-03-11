"use client";

const PHASES = [
  { id: "literature", label: "Literature" },
  { id: "hypothesis", label: "Hypothesis" },
  { id: "experiment", label: "Experiment" },
  { id: "analysis", label: "Analysis" },
  { id: "reflection", label: "Reflection" },
] as const;

interface PhaseTabsProps {
  current: string;
  onChange: (phase: string) => void;
  /** Number of completed items per phase, used for badges */
  counts?: Record<string, number>;
}

export function PhaseTabs({ current, onChange, counts }: PhaseTabsProps) {
  return (
    <div className="flex items-center gap-0.5 border-b border-border">
      {PHASES.map((p) => {
        const active = current === p.id;
        const count = counts?.[p.id] || 0;
        return (
          <button
            key={p.id}
            onClick={() => onChange(p.id)}
            className={`relative px-3 py-2 text-xs transition-colors ${
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {p.label}
            {count > 0 && (
              <span className={`ml-1 text-[9px] rounded-full px-1 py-0.5 tabular-nums ${
                active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
              }`}>
                {count}
              </span>
            )}
            {active && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t-full" />
            )}
          </button>
        );
      })}
    </div>
  );
}
