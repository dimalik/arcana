"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Compass,
  Loader2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Download,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

interface DiscoverQuery {
  query: string;
  rationale: string;
  targetGap: string;
}

interface DiscoverCandidate {
  semanticScholarId: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  externalUrl: string;
  citationCount: number | null;
  querySource?: string;
}

interface SynthesisDiscoverProps {
  sessionId: string;
}

export function SynthesisDiscover({ sessionId }: SynthesisDiscoverProps) {
  const [loading, setLoading] = useState(false);
  const [queries, setQueries] = useState<DiscoverQuery[] | null>(null);
  const [candidates, setCandidates] = useState<DiscoverCandidate[]>([]);
  const [queriesExpanded, setQueriesExpanded] = useState(false);
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [imported, setImported] = useState<Set<string>>(new Set());

  const handleDiscover = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/synthesis/${sessionId}/discover`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Discovery failed");
        return;
      }
      const data = await res.json();
      setQueries(data.queries);
      setCandidates(data.candidates);
      toast.success(`Found ${data.candidates.length} candidate papers`);
    } catch {
      toast.error("Failed to discover papers");
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async (candidate: DiscoverCandidate) => {
    const key = candidate.semanticScholarId;
    setImporting((prev) => new Set(prev).add(key));

    try {
      let res: Response;
      if (candidate.arxivId) {
        res = await fetch("/api/papers/import/arxiv", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: candidate.arxivId }),
        });
      } else {
        const url = candidate.doi
          ? `https://doi.org/${candidate.doi}`
          : candidate.externalUrl;
        res = await fetch("/api/papers/import/url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
      }

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Import failed");
        return;
      }

      setImported((prev) => new Set(prev).add(key));
      toast.success(`Imported: ${candidate.title.slice(0, 50)}...`);
    } catch {
      toast.error("Import failed");
    } finally {
      setImporting((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  if (!queries) {
    return (
      <div className="pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDiscover}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Compass className="mr-1.5 h-3.5 w-3.5" />
          )}
          Find Related Papers
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Discovered Papers</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDiscover}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Compass className="mr-1.5 h-3.5 w-3.5" />
          )}
          Re-discover
        </Button>
      </div>

      {/* LLM queries (collapsible) */}
      <button
        onClick={() => setQueriesExpanded(!queriesExpanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {queriesExpanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {queries.length} search queries used
      </button>

      {queriesExpanded && (
        <div className="space-y-2 pl-4">
          {queries.map((q, i) => (
            <div key={i} className="text-xs">
              <p className="font-medium">&ldquo;{q.query}&rdquo;</p>
              <p className="text-muted-foreground">
                {q.rationale}
                {q.targetGap && (
                  <> &middot; Gap: {q.targetGap}</>
                )}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Candidate cards */}
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No new candidates found.</p>
      ) : (
        <div className="space-y-2">
          {candidates.map((c) => {
            const key = c.semanticScholarId;
            const isImported = imported.has(key);
            const isImporting = importing.has(key);
            const authorStr = c.authors.length > 3
              ? `${c.authors.slice(0, 3).join(", ")} et al.`
              : c.authors.join(", ");

            return (
              <Card key={key} className="overflow-hidden">
                <CardContent className="py-3 px-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-tight">
                        {c.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {authorStr}
                        {c.year && <> ({c.year})</>}
                        {c.venue && <> &middot; {c.venue}</>}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        {c.citationCount != null && (
                          <Badge variant="outline" className="text-[10px] py-0">
                            {c.citationCount} citations
                          </Badge>
                        )}
                        {c.arxivId && (
                          <Badge variant="secondary" className="text-[10px] py-0">arXiv</Badge>
                        )}
                        {c.doi && !c.arxivId && (
                          <Badge variant="secondary" className="text-[10px] py-0">DOI</Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {c.externalUrl && (
                        <a
                          href={c.externalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                      {isImported ? (
                        <div className="inline-flex items-center justify-center h-7 w-7 text-green-600">
                          <CheckCircle2 className="h-4 w-4" />
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => handleImport(c)}
                          disabled={isImporting}
                        >
                          {isImporting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Download className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
