"use client";

import {
  ClipboardCheck,
  FlaskConical,
  BarChart3,
  Link2,
  Sparkles,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";

type ViewTab =
  | "review"
  | "methodology"
  | "results"
  | "connections"
  | "analyze";

const items: { value: ViewTab; icon: LucideIcon; label: string }[] = [
  { value: "review", icon: ClipboardCheck, label: "Review" },
  { value: "methodology", icon: FlaskConical, label: "Methodology" },
  { value: "results", icon: BarChart3, label: "Results" },
  { value: "connections", icon: Link2, label: "Connections" },
  { value: "analyze", icon: Sparkles, label: "Analyze" },
];

interface Props {
  activeView: ViewTab;
  onViewChange: (v: ViewTab) => void;
  chatOpen: boolean;
  onChatToggle: () => void;
}

export function RightPanel({ activeView, onViewChange, chatOpen, onChatToggle }: Props) {
  return (
    <aside className="fixed right-0 top-12 bottom-0 z-40 flex w-10 flex-col items-center bg-card/50">
      {/* View tabs — vertically centered */}
      <div className="flex flex-1 flex-col items-center justify-center">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.value;
          return (
            <button
              key={item.value}
              onClick={() => onViewChange(item.value)}
              className={`group relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="pointer-events-none absolute right-full mr-2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-md opacity-0 transition-all duration-150 translate-x-1 group-hover:opacity-100 group-hover:translate-x-0">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Chat toggle — bottom of strip */}
      <div className="pb-3">
        <button
          onClick={onChatToggle}
          className={`group relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            chatOpen
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          }`}
        >
          <MessageSquare className="h-4 w-4" />
          <span className="pointer-events-none absolute right-full mr-2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-md opacity-0 transition-all duration-150 translate-x-1 group-hover:opacity-100 group-hover:translate-x-0">
            Chat
          </span>
        </button>
      </div>
    </aside>
  );
}
