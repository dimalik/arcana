"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, RefreshCw, Sparkles, GitBranch, X } from "lucide-react";
import { toast } from "sonner";
import { nodeTypes } from "./mindmap-nodes";
import { buildFlowGraph, getLayoutedElements } from "./mindmap-layout";

interface Concept {
  id: string;
  paperId: string;
  name: string;
  explanation: string;
  parentId: string | null;
  depth: number;
  isExpanded: boolean;
  createdAt: string;
}

interface SharedConceptMatch {
  conceptName: string;
  localConceptId: string;
  matches: { paperId: string; paperTitle: string; conceptId: string }[];
}

interface ConceptMindmapProps {
  paperId: string;
  paperTitle: string;
  hasText: boolean;
}

function MindmapInner({ paperId, paperTitle, hasText }: ConceptMindmapProps) {
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [showCrossPaper, setShowCrossPaper] = useState(false);
  const [sharedConcepts, setSharedConcepts] = useState<SharedConceptMatch[]>([]);
  const [loadingShared, setLoadingShared] = useState(false);
  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();

  const fetchConcepts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/papers/${paperId}/concepts`);
      if (res.ok) {
        const data = await res.json();
        setConcepts(data);
      }
    } catch {
      // Silently fail on initial load
    } finally {
      setLoading(false);
    }
  }, [paperId]);

  useEffect(() => {
    fetchConcepts();
  }, [fetchConcepts]);

  const expandConcept = useCallback(
    async (conceptId: string) => {
      setExpandingId(conceptId);
      try {
        const res = await fetch(
          `/api/papers/${paperId}/concepts/${conceptId}/expand`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }
        );

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to expand concept");
        }

        const data = await res.json();
        setConcepts(data);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to expand concept"
        );
      } finally {
        setExpandingId(null);
      }
    },
    [paperId]
  );

  const generateConcepts = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/papers/${paperId}/concepts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate concepts");
      }

      const data = await res.json();
      setConcepts(data);
      toast.success("Concepts generated");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to generate concepts"
      );
    } finally {
      setGenerating(false);
    }
  };

  const regenerateConcepts = async () => {
    await fetch(`/api/papers/${paperId}/concepts`, { method: "DELETE" });
    setConcepts([]);
    setSharedConcepts([]);
    setSelectedConceptId(null);
    await generateConcepts();
  };

  const fetchSharedConcepts = useCallback(async () => {
    setLoadingShared(true);
    try {
      const res = await fetch(`/api/papers/${paperId}/concepts/shared`);
      if (res.ok) {
        const data = await res.json();
        setSharedConcepts(data);
      }
    } catch {
      toast.error("Failed to load cross-paper connections");
    } finally {
      setLoadingShared(false);
    }
  }, [paperId]);

  const handleToggleCrossPaper = () => {
    const next = !showCrossPaper;
    setShowCrossPaper(next);
    if (next && sharedConcepts.length === 0) {
      fetchSharedConcepts();
    }
  };

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      // Extract concept id from node id (format: "concept-{uuid}")
      if (node.id.startsWith("concept-")) {
        const conceptId = node.id.replace("concept-", "");
        setSelectedConceptId((prev) => (prev === conceptId ? null : conceptId));
      } else {
        setSelectedConceptId(null);
      }
    },
    []
  );

  const handlePaneClick = useCallback(() => {
    setSelectedConceptId(null);
  }, []);

  const selectedConcept = selectedConceptId
    ? concepts.find((c) => c.id === selectedConceptId) ?? null
    : null;

  // Build and layout the graph whenever concepts or cross-paper state changes
  useEffect(() => {
    if (concepts.length === 0) return;

    const { nodes: rawNodes, edges: rawEdges } = buildFlowGraph(
      concepts,
      paperId,
      paperTitle,
      expandingId,
      expandConcept,
      sharedConcepts,
      showCrossPaper
    );

    // Mark selected node
    const nodesWithSelection = rawNodes.map((n) => {
      if (n.id.startsWith("concept-")) {
        const cid = n.id.replace("concept-", "");
        return { ...n, data: { ...n.data, selected: cid === selectedConceptId } };
      }
      return n;
    });

    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      nodesWithSelection,
      rawEdges
    );

    setNodes(layoutedNodes);
    setEdges(layoutedEdges);

    requestAnimationFrame(() => {
      fitView({ duration: 300, padding: 0.15 });
    });
  }, [concepts, expandingId, expandConcept, showCrossPaper, sharedConcepts, paperId, paperTitle, selectedConceptId, setNodes, setEdges, fitView]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (concepts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Key Concepts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasText ? (
            <p className="text-sm text-muted-foreground">
              No text available. Upload a PDF or add text to generate concepts.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Generate an interactive mindmap of key concepts from this paper.
                Click [+] on any concept to expand its prerequisites.
              </p>
              <Button onClick={generateConcepts} disabled={generating}>
                {generating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Generate Concepts
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 12rem)" }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold">Key Concepts</h3>
        <div className="flex items-center gap-2">
          <Button
            variant={showCrossPaper ? "default" : "outline"}
            size="sm"
            onClick={handleToggleCrossPaper}
            disabled={loadingShared}
          >
            {loadingShared ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <GitBranch className="mr-1 h-3 w-3" />
            )}
            Cross-paper
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={regenerateConcepts}
            disabled={generating}
          >
            {generating ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3 w-3" />
            )}
            Regenerate
          </Button>
        </div>
      </div>

      {/* Graph — fills remaining space */}
      <div className="flex-1 min-h-0 w-full rounded-md border bg-background">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.5}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          <Controls />
          <MiniMap
            zoomable
            pannable
            className="!bg-muted"
          />
        </ReactFlow>
      </div>

      {/* Detail panel for selected concept */}
      {selectedConcept && (
        <div className="mt-2 shrink-0 rounded-lg border-2 border-blue-500/20 bg-blue-50/50 dark:bg-blue-950/20 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <p className="text-sm font-bold">{selectedConcept.name}</p>
                {selectedConcept.parentId && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                    prerequisite
                  </span>
                )}
              </div>
              <p className="text-sm leading-relaxed">
                {selectedConcept.explanation}
              </p>
              {selectedConcept.parentId && (() => {
                const parent = concepts.find((c) => c.id === selectedConcept.parentId);
                return parent ? (
                  <p className="text-xs text-muted-foreground">
                    Required for: <span className="font-medium text-foreground">{parent.name}</span>
                  </p>
                ) : null;
              })()}
              {(() => {
                const children = concepts.filter((c) => c.parentId === selectedConcept.id);
                return children.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Prerequisites: {children.map((c) => c.name).join(", ")}
                  </p>
                ) : null;
              })()}
            </div>
            <button
              onClick={() => setSelectedConceptId(null)}
              className="shrink-0 p-1 rounded hover:bg-muted"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ConceptMindmap(props: ConceptMindmapProps) {
  return (
    <ReactFlowProvider>
      <MindmapInner {...props} />
    </ReactFlowProvider>
  );
}
