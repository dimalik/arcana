"use client";

import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";

interface CitationNode {
  id: string;
  label: string;
  isCorpus?: boolean;
  corpusConnections?: number;
}

interface CitationEdge {
  source: string;
  target: string;
}

interface VizCitationsProps {
  data: {
    nodes: CitationNode[];
    edges: CitationEdge[];
  };
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 40;

function layoutGraph(
  rawNodes: CitationNode[],
  rawEdges: CitationEdge[]
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", ranksep: 60, nodesep: 30 });

  for (const node of rawNodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of rawEdges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const nodes: Node[] = rawNodes.map((n) => {
    const pos = g.node(n.id);
    const isExternal = n.isCorpus === false;
    return {
      id: n.id,
      data: { label: n.label },
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      style: {
        width: NODE_WIDTH,
        fontSize: 11,
        padding: "4px 8px",
        ...(isExternal
          ? {
              borderStyle: "dashed" as const,
              borderColor: "#8B5CF6",
              background: "rgba(139, 92, 246, 0.08)",
              color: "#7C3AED",
            }
          : {}),
      },
    };
  });

  const edges: Edge[] = rawEdges.map((e, i) => ({
    id: `e-${i}`,
    source: e.source,
    target: e.target,
    animated: true,
    style: { strokeWidth: 1.5 },
  }));

  return { nodes, edges };
}

export function VizCitations({ data }: VizCitationsProps) {
  const { nodes: layoutNodes, edges: layoutEdges } = useMemo(
    () => layoutGraph(data.nodes, data.edges),
    [data]
  );

  const [nodes, , onNodesChange] = useNodesState(layoutNodes);
  const [edges, , onEdgesChange] = useEdgesState(layoutEdges);

  if (data.nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        No citation relationships found between selected papers.
      </p>
    );
  }

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
