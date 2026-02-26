"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChevronRight,
  ChevronDown,
  Plus,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

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

interface ConceptTreeProps {
  paperId: string;
  hasText: boolean;
}

export function ConceptTree({ paperId, hasText }: ConceptTreeProps) {
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

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
      setCollapsedIds(new Set());
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
    setCollapsedIds(new Set());
    await generateConcepts();
  };

  const expandConcept = async (conceptId: string) => {
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
      // Ensure the expanded node is not collapsed
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        next.delete(conceptId);
        return next;
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to expand concept"
      );
    } finally {
      setExpandingId(null);
    }
  };

  const toggleCollapse = (conceptId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(conceptId)) {
        next.delete(conceptId);
      } else {
        next.add(conceptId);
      }
      return next;
    });
  };

  // Build tree structure from flat list
  const rootConcepts = concepts.filter((c) => c.parentId === null);
  const getChildren = (parentId: string) =>
    concepts.filter((c) => c.parentId === parentId);

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
                Generate a hierarchical tree of key concepts from this paper.
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
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Key Concepts</CardTitle>
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
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {rootConcepts.map((concept) => (
            <ConceptNode
              key={concept.id}
              concept={concept}
              getChildren={getChildren}
              collapsedIds={collapsedIds}
              expandingId={expandingId}
              onToggleCollapse={toggleCollapse}
              onExpand={expandConcept}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface ConceptNodeProps {
  concept: Concept;
  getChildren: (parentId: string) => Concept[];
  collapsedIds: Set<string>;
  expandingId: string | null;
  onToggleCollapse: (id: string) => void;
  onExpand: (id: string) => void;
}

function ConceptNode({
  concept,
  getChildren,
  collapsedIds,
  expandingId,
  onToggleCollapse,
  onExpand,
}: ConceptNodeProps) {
  const children = getChildren(concept.id);
  const hasChildren = children.length > 0;
  const isCollapsed = collapsedIds.has(concept.id);
  const isExpanding = expandingId === concept.id;

  return (
    <div style={{ marginLeft: concept.depth * 20 }}>
      <div className="flex items-start gap-1 py-1 group">
        {/* Collapse/expand chevron */}
        {hasChildren ? (
          <button
            onClick={() => onToggleCollapse(concept.id)}
            className="mt-0.5 p-0.5 rounded hover:bg-muted shrink-0"
          >
            {isCollapsed ? (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{concept.name}</span>
            {/* Expand button — show for non-expanded concepts */}
            {!concept.isExpanded && (
              <button
                onClick={() => onExpand(concept.id)}
                disabled={isExpanding}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted shrink-0"
                title="Expand prerequisites"
              >
                {isExpanding ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{concept.explanation}</p>
        </div>
      </div>

      {/* Children */}
      {hasChildren && !isCollapsed && (
        <div>
          {children.map((child) => (
            <ConceptNode
              key={child.id}
              concept={child}
              getChildren={getChildren}
              collapsedIds={collapsedIds}
              expandingId={expandingId}
              onToggleCollapse={onToggleCollapse}
              onExpand={onExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}
