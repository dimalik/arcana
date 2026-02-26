"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Trash2,
  Library,
  Sparkles,
  Loader2,
  Quote,
  Search,
  Download,
  ExternalLink,
  CheckCircle2,
  Zap,
  ClipboardCopy,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface MatchedPaper {
  id: string;
  title: string;
  year: number | null;
  authors: string | null;
}

interface Reference {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  rawCitation: string;
  referenceIndex: number | null;
  matchedPaperId: string | null;
  matchConfidence: number | null;
  citationContext: string | null;
  semanticScholarId: string | null;
  arxivId: string | null;
  externalUrl: string | null;
  matchedPaper: MatchedPaper | null;
}

export function PaperReferences({ paperId }: { paperId: string }) {
  const [references, setReferences] = useState<Reference[]>([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [lookingUp, setLookingUp] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState<Set<string>>(new Set());

  const handleExtractContexts = async () => {
    setExtracting(true);
    try {
      const res = await fetch(
        `/api/papers/${paperId}/references/extract-contexts`,
        { method: "POST" }
      );
      if (res.ok) {
        const data = await res.json();
        toast.success(
          `Matched citation contexts to ${data.updated} of ${data.total} references`
        );
        fetchReferences();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to extract contexts");
      }
    } catch {
      toast.error("Failed to extract citation contexts");
    } finally {
      setExtracting(false);
    }
  };

  const fetchReferences = useCallback(async () => {
    try {
      const res = await fetch(`/api/papers/${paperId}/references`);
      if (res.ok) {
        setReferences(await res.json());
      }
    } catch {
      toast.error("Failed to load references");
    } finally {
      setLoading(false);
    }
  }, [paperId]);

  useEffect(() => {
    fetchReferences();
  }, [fetchReferences]);

  const handleDelete = async (referenceId: string) => {
    try {
      const res = await fetch(
        `/api/papers/${paperId}/references?referenceId=${referenceId}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        setReferences((prev) => prev.filter((r) => r.id !== referenceId));
        toast.success("Reference removed");
      }
    } catch {
      toast.error("Failed to remove reference");
    }
  };

  const handleEnrich = async () => {
    setEnriching(true);
    setEnrichProgress(null);
    try {
      const res = await fetch(
        `/api/papers/${paperId}/references/enrich`,
        { method: "POST" }
      );
      if (!res.ok) {
        toast.error("Failed to start enrichment");
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "progress") {
              setEnrichProgress({ current: msg.current, total: msg.total });
            } else if (msg.type === "done") {
              if (msg.rateLimited) {
                toast.error(
                  `Rate limited. Enriched ${msg.enriched} of ${msg.total} before stopping. Try again in a minute.`
                );
              } else {
                toast.success(
                  `Enriched ${msg.enriched} of ${msg.total} references`
                );
              }
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      fetchReferences();
    } catch {
      toast.error("Enrichment failed");
    } finally {
      setEnriching(false);
      setEnrichProgress(null);
    }
  };

  const handleLookup = async (refId: string) => {
    setLookingUp((prev) => new Set(prev).add(refId));
    try {
      const res = await fetch(
        `/api/papers/${paperId}/references/${refId}/lookup`,
        { method: "POST" }
      );
      if (res.ok) {
        const data = await res.json();
        setReferences((prev) =>
          prev.map((r) => (r.id === refId ? data.reference : r))
        );
        toast.success("Reference enriched");
      } else {
        const data = await res.json();
        toast.error(data.error || "Lookup failed");
      }
    } catch {
      toast.error("Lookup failed");
    } finally {
      setLookingUp((prev) => {
        const next = new Set(prev);
        next.delete(refId);
        return next;
      });
    }
  };

  const handleImport = async (refId: string) => {
    setImporting((prev) => new Set(prev).add(refId));
    try {
      const res = await fetch(
        `/api/papers/${paperId}/references/import`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ referenceId: refId }) }
      );
      if (res.ok) {
        const paper = await res.json();
        setReferences((prev) =>
          prev.map((r) =>
            r.id === refId
              ? {
                  ...r,
                  matchedPaperId: paper.id,
                  matchConfidence: 1.0,
                  matchedPaper: {
                    id: paper.id,
                    title: paper.title,
                    year: paper.year,
                    authors: paper.authors,
                  },
                }
              : r
          )
        );
        toast.success("Paper imported to library");
      } else {
        const data = await res.json();
        toast.error(data.error || "Import failed");
      }
    } catch {
      toast.error("Import failed");
    } finally {
      setImporting((prev) => {
        const next = new Set(prev);
        next.delete(refId);
        return next;
      });
    }
  };

  const handleCopyCitation = async (
    refId: string,
    format: "bibtex" | "apa"
  ) => {
    try {
      const res = await fetch(
        `/api/papers/${paperId}/references/${refId}/citation?format=${format}`
      );
      if (res.ok) {
        const data = await res.json();
        await navigator.clipboard.writeText(data.citation);
        toast.success(`${format === "bibtex" ? "BibTeX" : "APA"} copied`);
      } else {
        toast.error("Failed to generate citation");
      }
    } catch {
      toast.error("Failed to copy citation");
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (references.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No references extracted
        </CardContent>
      </Card>
    );
  }

  const matchedCount = references.filter((r) => r.matchedPaper).length;
  const contextCount = references.filter((r) => r.citationContext).length;
  const enrichedCount = references.filter((r) => r.semanticScholarId).length;
  const unenrichedCount = references.length - enrichedCount;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {references.length} reference{references.length !== 1 && "s"}
          {matchedCount > 0 && `, ${matchedCount} in library`}
          {contextCount > 0 && `, ${contextCount} with context`}
          {enrichedCount > 0 && `, ${enrichedCount} enriched`}
        </p>
        <div className="flex items-center gap-2">
          {unenrichedCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleEnrich}
              disabled={enriching}
            >
              {enriching ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5 mr-1.5" />
              )}
              {enriching && enrichProgress
                ? `Enriching ${enrichProgress.current}/${enrichProgress.total}...`
                : enriching
                  ? "Starting..."
                  : "Enrich References"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleExtractContexts}
            disabled={extracting}
          >
            {extracting ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            )}
            {extracting ? "Extracting..." : "Extract Citation Contexts"}
          </Button>
        </div>
      </div>

      {references.map((ref) => {
        let authors: string[] = [];
        try {
          if (ref.authors) authors = JSON.parse(ref.authors);
        } catch {
          // ignore
        }

        const isLookingUp = lookingUp.has(ref.id);
        const isImporting = importing.has(ref.id);

        return (
          <Card key={ref.id} className="group">
            <CardContent className="py-4 flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  {ref.referenceIndex != null && (
                    <Badge variant="outline" className="text-xs shrink-0">
                      {ref.referenceIndex}
                    </Badge>
                  )}
                  {ref.matchedPaper ? (
                    <Link
                      href={`/papers/${ref.matchedPaper.id}`}
                      className="font-medium text-sm hover:underline"
                    >
                      {ref.title}
                    </Link>
                  ) : (
                    <span className="font-medium text-sm">{ref.title}</span>
                  )}
                  {ref.matchedPaper && (
                    <Badge className="text-xs gap-1 bg-green-600 hover:bg-green-700">
                      <Library className="h-3 w-3" />
                      In Library
                    </Badge>
                  )}
                  {ref.semanticScholarId && (
                    <Badge
                      variant="secondary"
                      className="text-xs gap-1"
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      Enriched
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                  {authors.length > 0 && (
                    <span>
                      {authors.slice(0, 3).join(", ")}
                      {authors.length > 3 && " et al."}
                    </span>
                  )}
                  {ref.year && <span>({ref.year})</span>}
                  {ref.venue && (
                    <Badge variant="secondary" className="text-xs">
                      {ref.venue}
                    </Badge>
                  )}
                </div>

                {/* External links */}
                {(ref.doi || ref.arxivId || ref.semanticScholarId) && (
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {ref.doi && (
                      <a
                        href={`https://doi.org/${ref.doi}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        <ExternalLink className="h-3 w-3" />
                        DOI
                      </a>
                    )}
                    {ref.arxivId && (
                      <a
                        href={`https://arxiv.org/abs/${ref.arxivId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        <ExternalLink className="h-3 w-3" />
                        arXiv
                      </a>
                    )}
                    {ref.semanticScholarId && (() => {
                      const id = ref.semanticScholarId!;
                      const isS2 = id.startsWith("s2:");
                      const isOA = id.startsWith("https://openalex.org/");
                      const href = isS2
                        ? `https://www.semanticscholar.org/paper/${id.slice(3)}`
                        : isOA
                          ? id
                          : id.startsWith("http") ? id : `https://openalex.org/${id}`;
                      const label = isS2 ? "S2" : isOA ? "OpenAlex" : "Source";
                      return (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                        >
                          <ExternalLink className="h-3 w-3" />
                          {label}
                        </a>
                      );
                    })()}
                  </div>
                )}

                {ref.citationContext && (
                  <div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-muted/50 border border-border/50 px-2.5 py-1.5">
                    <Quote className="h-3 w-3 mt-0.5 shrink-0 text-primary/60" />
                    <p className="text-xs text-foreground/80 leading-relaxed">
                      {ref.citationContext}
                    </p>
                  </div>
                )}
                {!ref.citationContext &&
                  ref.rawCitation &&
                  ref.rawCitation !== ref.title && (
                    <p className="text-xs text-muted-foreground/70 mt-1 line-clamp-2">
                      {ref.rawCitation}
                    </p>
                  )}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-1 shrink-0">
                {/* Find / Lookup button */}
                {!ref.semanticScholarId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleLookup(ref.id)}
                    disabled={isLookingUp}
                    title="Find on Semantic Scholar"
                  >
                    {isLookingUp ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                  </Button>
                )}

                {/* Import button */}
                {!ref.matchedPaper &&
                  (ref.arxivId || ref.externalUrl || ref.title) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleImport(ref.id)}
                      disabled={isImporting}
                      title="Import to library"
                    >
                      {isImporting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                    </Button>
                  )}

                {/* Cite button */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Copy citation"
                    >
                      <ClipboardCopy className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-40 p-1" align="end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start text-xs"
                      onClick={() => handleCopyCitation(ref.id, "bibtex")}
                    >
                      Copy BibTeX
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start text-xs"
                      onClick={() => handleCopyCitation(ref.id, "apa")}
                    >
                      Copy APA
                    </Button>
                  </PopoverContent>
                </Popover>

                {/* Delete button */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => handleDelete(ref.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
