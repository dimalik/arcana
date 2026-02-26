"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Plus, Loader2 } from "lucide-react";
import Link from "next/link";

// Max depth at which the [+] expand button is shown
const MAX_EXPAND_DEPTH = 2;

interface PaperNodeData {
  label: string;
  [key: string]: unknown;
}

export const PaperNode = memo(function PaperNode({
  data,
}: NodeProps & { data: PaperNodeData }) {
  return (
    <div className="bg-primary text-primary-foreground rounded-xl px-3 py-2 w-[200px] shadow-md">
      <p className="text-xs font-semibold leading-snug text-center line-clamp-2">
        {data.label}
      </p>
      <Handle type="source" position={Position.Right} className="!bg-primary-foreground" />
    </div>
  );
});

interface ConceptNodeData {
  label: string;
  explanation: string;
  isExpanded: boolean;
  isExpanding: boolean;
  onExpand: (id: string) => void;
  conceptId: string;
  selected: boolean;
  [key: string]: unknown;
}

export const ConceptNodeComponent = memo(function ConceptNodeComponent({
  data,
}: NodeProps & { data: ConceptNodeData }) {
  return (
    <div
      className={`bg-card border-2 rounded-lg px-2.5 py-1.5 w-[220px] shadow-sm transition-colors cursor-pointer ${
        data.selected
          ? "border-blue-500 ring-2 ring-blue-500/20"
          : "border-blue-500/40"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-blue-500" />
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold leading-snug">{data.label}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2 leading-tight">
            {data.explanation}
          </p>
        </div>
        {!data.isExpanded && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              data.onExpand(data.conceptId);
            }}
            disabled={data.isExpanding}
            className="shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
            title="Expand prerequisites"
          >
            {data.isExpanding ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : (
              <Plus className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-blue-500" />
    </div>
  );
});

const depthBorderColors: Record<number, string> = {
  1: "border-emerald-500/40",
  2: "border-amber-500/40",
};
const depthSelectedBorderColors: Record<number, string> = {
  1: "border-emerald-500 ring-2 ring-emerald-500/20",
  2: "border-amber-500 ring-2 ring-amber-500/20",
};
const depthHandleColors: Record<number, string> = {
  1: "!bg-emerald-500",
  2: "!bg-amber-500",
};

interface PrerequisiteNodeData {
  label: string;
  explanation: string;
  depth: number;
  isExpanded: boolean;
  isExpanding: boolean;
  onExpand: (id: string) => void;
  conceptId: string;
  selected: boolean;
  [key: string]: unknown;
}

export const PrerequisiteNode = memo(function PrerequisiteNode({
  data,
}: NodeProps & { data: PrerequisiteNodeData }) {
  const borderColor = data.selected
    ? (depthSelectedBorderColors[data.depth] ?? "border-muted-foreground ring-2 ring-muted-foreground/20")
    : (depthBorderColors[data.depth] ?? "border-muted");
  const handleColor = depthHandleColors[data.depth] ?? "!bg-muted-foreground";
  const canExpand = !data.isExpanded && data.depth < MAX_EXPAND_DEPTH;

  return (
    <div
      className={`bg-card border-2 ${borderColor} rounded-lg px-2.5 py-1.5 w-[200px] shadow-sm transition-colors cursor-pointer`}
    >
      <Handle type="target" position={Position.Left} className={handleColor} />
      <div className="flex items-center justify-between gap-1">
        <p className="text-xs font-medium leading-snug truncate flex-1 min-w-0">
          {data.label}
        </p>
        {canExpand && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              data.onExpand(data.conceptId);
            }}
            disabled={data.isExpanding}
            className="shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
            title="Expand prerequisites"
          >
            {data.isExpanding ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : (
              <Plus className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Right} className={handleColor} />
    </div>
  );
});

interface CrossPaperNodeData {
  label: string;
  paperId: string;
  [key: string]: unknown;
}

export const CrossPaperNode = memo(function CrossPaperNode({
  data,
}: NodeProps & { data: CrossPaperNodeData }) {
  return (
    <div className="border-2 border-dashed border-violet-400 bg-violet-50 dark:bg-violet-950/30 rounded-lg px-2.5 py-1.5 w-[180px] shadow-sm">
      <Handle type="target" position={Position.Left} className="!bg-violet-400" />
      <Link
        href={`/papers/${data.paperId}`}
        className="text-xs font-medium text-violet-700 dark:text-violet-300 hover:underline leading-snug block truncate"
      >
        {data.label}
      </Link>
    </div>
  );
});

export const nodeTypes = {
  paper: PaperNode,
  concept: ConceptNodeComponent,
  prerequisite: PrerequisiteNode,
  crossPaper: CrossPaperNode,
};
