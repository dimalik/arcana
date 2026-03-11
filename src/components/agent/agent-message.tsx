"use client";

import {
  FileText,
  Globe,
  Search,
  Terminal,
  Pencil,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Clock,
  DollarSign,
} from "lucide-react";
import { useState } from "react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import type { AgentEvent } from "@/lib/agent/types";

const TOOL_ICONS: Record<string, typeof FileText> = {
  Read: FileText,
  Glob: Search,
  Grep: Search,
  WebSearch: Globe,
  WebFetch: Globe,
  Edit: Pencil,
  Write: Pencil,
  Bash: Terminal,
};

function ToolCard({ name, input }: { name: string; input: string }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICONS[name] || Terminal;

  return (
    <div className="rounded-md border bg-muted/30 text-sm">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{name}</span>
        {expanded ? (
          <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="border-t px-3 py-2">
          <pre className="whitespace-pre-wrap break-all text-xs text-muted-foreground max-h-48 overflow-y-auto">
            {input}
          </pre>
        </div>
      )}
    </div>
  );
}

export function AgentMessage({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "text":
      return (
        <div className="text-sm">
          <MarkdownRenderer content={event.content} className="text-sm" />
        </div>
      );

    case "tool":
      return <ToolCard name={event.name} input={event.input} />;

    case "tool_result":
      return null; // Tool results are implicit — the next text block shows reasoning

    case "error":
      return (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{event.message}</span>
        </div>
      );

    case "done":
      return (
        <div className="flex items-center gap-4 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Session complete</span>
          {event.duration != null && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {(event.duration / 1000).toFixed(1)}s
            </span>
          )}
          {event.cost != null && (
            <span className="flex items-center gap-1">
              <DollarSign className="h-3 w-3" />${event.cost.toFixed(4)}
            </span>
          )}
          {event.turns != null && (
            <span>{event.turns} turns</span>
          )}
        </div>
      );

    default:
      return null;
  }
}
