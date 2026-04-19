"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
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
  MoreVertical,
  MoreHorizontal,
  ArrowUpDown,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { getReferenceStateEmptyMessage } from "@/lib/processing/status-display";
import { buildRawCitationFallbackText } from "@/lib/references/reference-quality";

interface MatchedPaper {
  id: string;
  title: string;
  year: number | null;
  authors: string | null;
}

interface Reference {
  id: string;
  referenceEntryId: string;
  legacyReferenceId: string | null;
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
  linkState: "canonical_entity_linked" | "import_dedup_only_reusable" | "unresolved";
  importReusablePaperId: string | null;
  resolvedEntityId: string | null;
  resolveConfidence: number | null;
  resolveSource: string | null;
}

type ReferenceState =
  | "available"
  | "pending"
  | "extraction_failed"
  | "unavailable_no_pdf";

interface ReferencesResponse {
  referenceState: ReferenceState;
  references: Reference[];
}

export function PaperReferences({ paperId }: { paperId: string }) {
  const [references, setReferences] = useState<Reference[]>([]);
  const [referenceState, setReferenceState] = useState<ReferenceState>("pending");
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [lookingUp, setLookingUp] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"appearance" | "alpha" | "year">("appearance");

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
        const data = (await res.json()) as ReferencesResponse;
        setReferences(data.references);
        setReferenceState(data.referenceState);
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
        await fetchReferences();
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
      // Step 1: Enrich the reference via lookup (Semantic Scholar / OpenAlex)
      const ref = references.find((r) => r.id === refId);
      if (ref && !ref.semanticScholarId) {
        const lookupRes = await fetch(
          `/api/papers/${paperId}/references/${refId}/lookup`,
          { method: "POST" }
        );
        if (lookupRes.ok) {
          const lookupData = await lookupRes.json();
          // Update local state with enriched data
          setReferences((prev) =>
            prev.map((r) => (r.id === refId ? lookupData.reference : r))
          );
        }
        // Continue with import even if lookup fails
      }

      // Step 2: Import to library
      const res = await fetch(
        `/api/papers/${paperId}/references/import`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ referenceId: refId }) }
      );
      if (res.ok) {
        await res.json();
        await fetchReferences();
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
          {getReferenceStateEmptyMessage(referenceState)}
        </CardContent>
      </Card>
    );
  }

  const enrichedCount = references.filter((r) => r.semanticScholarId).length;
  const unenrichedCount = references.length - enrichedCount;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">References</span>
        <div className="flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                title="Sort"
              >
                <ArrowUpDown className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="p-1 [&_[role=menuitem]]:px-2.5 [&_[role=menuitem]]:py-1.5 [&_[role=menuitem]]:gap-2 [&_[role=menuitem]]:text-xs">
              <DropdownMenuItem onClick={() => setSortBy("appearance")}>
                {sortBy === "appearance" ? <CheckCircle2 className="h-4 w-4" /> : <span className="w-4" />}
                Order of appearance
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSortBy("alpha")}>
                {sortBy === "alpha" ? <CheckCircle2 className="h-4 w-4" /> : <span className="w-4" />}
                Alphabetical
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSortBy("year")}>
                {sortBy === "year" ? <CheckCircle2 className="h-4 w-4" /> : <span className="w-4" />}
                By year
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                title="Actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {unenrichedCount > 0 && (
                <DropdownMenuItem
                  onClick={handleEnrich}
                  disabled={enriching}
                >
                  {enriching ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Zap className="h-4 w-4" />
                  )}
                  {enriching && enrichProgress
                    ? `Enriching ${enrichProgress.current}/${enrichProgress.total}...`
                    : enriching
                      ? "Starting..."
                      : "Enrich references"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={handleExtractContexts}
                disabled={extracting}
              >
                {extracting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {extracting ? "Extracting..." : "Extract citation contexts"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {[...references].sort((a, b) => {
        if (sortBy === "alpha") return a.title.localeCompare(b.title);
        if (sortBy === "year") return (b.year ?? 0) - (a.year ?? 0);
        return (a.referenceIndex ?? 0) - (b.referenceIndex ?? 0);
      }).map((ref) => {
        let authors: string[] = [];
        try {
          if (ref.authors) authors = JSON.parse(ref.authors);
        } catch {
          // ignore
        }

        const rawCitationFallback = buildRawCitationFallbackText({
          title: ref.title,
          authors: ref.authors,
          year: ref.year,
          venue: ref.venue,
          rawCitation: ref.rawCitation,
          citationContext: ref.citationContext,
        });

        const isLookingUp = lookingUp.has(ref.id);
        const isImporting = importing.has(ref.id);

        return (
          <Card key={ref.id} className="group relative">
            <CardContent className="py-3">
              <div className="min-w-0">
                <div className="mb-1 pr-16">
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
                  {ref.semanticScholarId && (
                    <CheckCircle2 className="inline h-3.5 w-3.5 text-green-500 ml-1.5 align-text-bottom" />
                  )}
                  {ref.matchedPaper && (
                    <Library className="inline h-3.5 w-3.5 text-green-600 ml-1.5 align-text-bottom" />
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

                {ref.citationContext && (
                  <div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-muted/50 border border-border/50 px-2.5 py-1.5">
                    <Quote className="h-3 w-3 mt-0.5 shrink-0 text-primary/60" />
                    <p className="text-xs text-foreground/80 leading-relaxed">
                      {ref.citationContext}
                    </p>
                  </div>
                )}
                {rawCitationFallback && (
                    <p className="text-xs text-muted-foreground/70 mt-1 line-clamp-2">
                      {rawCitationFallback}
                    </p>
                  )}
              </div>

              {/* Action buttons */}
              <div className="absolute top-2 right-2 flex items-center gap-0.5">
                {/* Import button */}
                {!ref.matchedPaper &&
                  (ref.arxivId || ref.externalUrl || ref.title) && (
                    <button
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                      onClick={() => handleImport(ref.id)}
                      disabled={isImporting}
                      title="Import to library"
                    >
                      {isImporting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}

                {/* Open in new tab — prefer arxiv > doi > semantic scholar */}
                {(() => {
                  const primaryUrl = ref.arxivId
                    ? `https://arxiv.org/abs/${ref.arxivId}`
                    : ref.doi
                      ? `https://doi.org/${ref.doi}`
                      : ref.semanticScholarId
                        ? ref.semanticScholarId.startsWith("s2:")
                          ? `https://www.semanticscholar.org/paper/${ref.semanticScholarId.slice(3)}`
                          : ref.semanticScholarId.startsWith("http")
                            ? ref.semanticScholarId
                            : `https://openalex.org/${ref.semanticScholarId}`
                        : null;
                  return primaryUrl ? (
                    <a
                      href={primaryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                      title="Open in new tab"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : null;
                })()}

                {/* Three-dot menu */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                      title="More actions"
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48 p-1 [&_[role=menuitem]]:px-2.5 [&_[role=menuitem]]:py-1.5 [&_[role=menuitem]]:gap-2 [&_[role=menuitem]]:text-xs">
                    {!ref.semanticScholarId && (
                      <>
                        <DropdownMenuItem
                          onClick={() => handleLookup(ref.id)}
                          disabled={isLookingUp}
                        >
                          {isLookingUp ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Search className="h-4 w-4" />
                          )}
                          Find on Semantic Scholar
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    {ref.arxivId && (
                      <DropdownMenuItem onClick={() => window.open(`https://arxiv.org/abs/${ref.arxivId}`, "_blank")}>
                        <ExternalLink className="h-4 w-4" />
                        Open on arXiv
                      </DropdownMenuItem>
                    )}
                    {ref.doi && (
                      <DropdownMenuItem onClick={() => window.open(`https://doi.org/${ref.doi}`, "_blank")}>
                        <ExternalLink className="h-4 w-4" />
                        Open DOI
                      </DropdownMenuItem>
                    )}
                    {ref.semanticScholarId && (() => {
                      const sid = ref.semanticScholarId!;
                      const href = sid.startsWith("s2:")
                        ? `https://www.semanticscholar.org/paper/${sid.slice(3)}`
                        : sid.startsWith("http") ? sid : `https://openalex.org/${sid}`;
                      const label = sid.startsWith("s2:") ? "Semantic Scholar" : sid.startsWith("https://openalex.org/") ? "OpenAlex" : "Source";
                      return (
                        <DropdownMenuItem onClick={() => window.open(href, "_blank")}>
                          <ExternalLink className="h-4 w-4" />
                          Open on {label}
                        </DropdownMenuItem>
                      );
                    })()}
                    {(ref.arxivId || ref.doi || ref.semanticScholarId) && <DropdownMenuSeparator />}
                    <DropdownMenuItem onClick={() => handleCopyCitation(ref.id, "bibtex")}>
                      <ClipboardCopy className="h-4 w-4" />
                      Copy BibTeX
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleCopyCitation(ref.id, "apa")}>
                      <ClipboardCopy className="h-4 w-4" />
                      Copy APA
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => handleDelete(ref.id)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
