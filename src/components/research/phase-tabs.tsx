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
  /** Gate status for each phase — indicates whether the prerequisite to enter that phase is met */
  gates?: Record<string, { met: boolean; progress: string }>;
}

export function PhaseTabs({ current, onChange, counts, gates }: PhaseTabsProps) {
  const currentIdx = PHASES.findIndex((p) => p.id === current);

  return (
    <div className="flex items-center gap-0.5 border-b border-border">
      {PHASES.map((p, idx) => {
        const active = current === p.id;
        const count = counts?.[p.id] || 0;
        const gate = gates?.[p.id];
        // Show gate indicator for phases AFTER the current phase
        const showGate = gate && idx > currentIdx;
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
            <span className="flex items-center gap-1">
              {showGate && (
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
                    gate.met ? "bg-emerald-500" : "bg-muted-foreground/30"
                  }`}
                  title={gate.met ? `Gate met: ${gate.progress}` : `Gate: ${gate.progress}`}
                />
              )}
              {p.label}
            </span>
            {count > 0 && (
              <span className={`ml-1 text-[9px] rounded-full px-1 py-0.5 tabular-nums ${
                active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
              }`}>
                {count}
              </span>
            )}
            {showGate && !gate.met && (
              <span className="block text-[8px] text-muted-foreground/50 leading-tight">
                {gate.progress}
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
