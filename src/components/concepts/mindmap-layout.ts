import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

interface Concept {
  id: string;
  paperId: string;
  name: string;
  explanation: string;
  parentId: string | null;
  depth: number;
  isExpanded: boolean;
}

interface SharedConceptMatch {
  conceptName: string;
  localConceptId: string;
  matches: { paperId: string; paperTitle: string; conceptId: string }[];
}

const NODE_WIDTHS: Record<string, number> = {
  paper: 200,
  concept: 220,
  prerequisite: 200,
  crossPaper: 180,
};
const NODE_HEIGHTS: Record<string, number> = {
  paper: 44,
  concept: 56,
  prerequisite: 36,
  crossPaper: 36,
};

export function buildFlowGraph(
  concepts: Concept[],
  paperId: string,
  paperTitle: string,
  expandingId: string | null,
  onExpand: (id: string) => void,
  sharedConcepts?: SharedConceptMatch[],
  showCrossPaper?: boolean
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Paper center node
  const paperNodeId = `paper-${paperId}`;
  nodes.push({
    id: paperNodeId,
    type: "paper",
    position: { x: 0, y: 0 },
    data: { label: paperTitle },
  });

  // Concept + prerequisite nodes
  const rootConcepts = concepts.filter((c) => c.parentId === null);

  for (const concept of concepts) {
    const isRoot = concept.parentId === null;
    const nodeType = isRoot ? "concept" : "prerequisite";

    nodes.push({
      id: `concept-${concept.id}`,
      type: nodeType,
      position: { x: 0, y: 0 },
      data: {
        label: concept.name,
        explanation: concept.explanation,
        depth: concept.depth,
        isExpanded: concept.isExpanded,
        isExpanding: expandingId === concept.id,
        onExpand,
        conceptId: concept.id,
      },
    });

    // Edge from parent
    if (isRoot) {
      edges.push({
        id: `edge-paper-${concept.id}`,
        source: paperNodeId,
        target: `concept-${concept.id}`,
        type: "smoothstep",
        style: { strokeWidth: 2 },
      });
    } else {
      edges.push({
        id: `edge-${concept.parentId}-${concept.id}`,
        source: `concept-${concept.parentId}`,
        target: `concept-${concept.id}`,
        type: "smoothstep",
        style: { strokeWidth: 2 },
      });
    }
  }

  // Cross-paper nodes
  if (showCrossPaper && sharedConcepts) {
    const addedPapers = new Set<string>();

    for (const shared of sharedConcepts) {
      for (const match of shared.matches) {
        const crossNodeId = `cross-${match.paperId}`;

        if (!addedPapers.has(match.paperId)) {
          addedPapers.add(match.paperId);
          nodes.push({
            id: crossNodeId,
            type: "crossPaper",
            position: { x: 0, y: 0 },
            data: { label: match.paperTitle, paperId: match.paperId },
          });
        }

        edges.push({
          id: `cross-edge-${shared.localConceptId}-${match.paperId}`,
          source: `concept-${shared.localConceptId}`,
          target: crossNodeId,
          type: "smoothstep",
          animated: true,
          style: {
            strokeWidth: 1.5,
            stroke: "rgb(167 139 250)",
            strokeDasharray: "5 5",
          },
        });
      }
    }
  }

  return { nodes, edges };
}

export function getLayoutedElements(
  nodes: Node[],
  edges: Edge[]
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 80 });

  for (const node of nodes) {
    const width = NODE_WIDTHS[node.type ?? "concept"] ?? 220;
    const height = NODE_HEIGHTS[node.type ?? "concept"] ?? 44;
    g.setNode(node.id, { width, height });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const dagreNode = g.node(node.id);
    const width = NODE_WIDTHS[node.type ?? "concept"] ?? 220;
    const height = NODE_HEIGHTS[node.type ?? "concept"] ?? 44;
    return {
      ...node,
      position: {
        x: dagreNode.x - width / 2,
        y: dagreNode.y - height / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}
