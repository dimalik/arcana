"use client";

import { useEffect, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ExternalLink,
  Download,
  Import,
  Loader2,
  Library,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  CheckCircle2,
  Compass,
  MoreHorizontal,
  MoreVertical,
  RefreshCw,
  Search,
  Undo2,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface DiscoveryProposal {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  externalUrl: string | null;
  citationCount: number | null;
  semanticScholarId: string | null;
  openAccessPdfUrl: string | null;
  reason: string;
  status: string;
  importedPaper: { id: string; title: string } | null;
}

interface DiscoverySessionResult {
  sessionId: string;
  title: string | null;
  status: string;
  createdAt: string;
  seedPapers: { id: string; title: string }[];
  proposals: DiscoveryProposal[];
}

type SortBy = "citations" | "year" | "alpha";
type StatusFilter = "all" | "pending" | "imported" | "dismissed";

const PAGE_SIZE = 10;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "imported", label: "Imported" },
  { value: "dismissed", label: "Dismissed" },
];

export function DiscoveredPapers({
  paperId,
  paperTitle,
}: {
  paperId: string;
  paperTitle: string;
}) {
  const [sessions, setSessions] = useState<DiscoverySessionResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<SortBy>("citations");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState("");
  const [bulkAction, setBulkAction] = useState<"importing" | "dismissing" | null>(null);
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(
    new Set()
  );

  const fetchDiscoveries = useCallback(async () => {
    try {
      const res = await fetch(`/api/papers/${paperId}/discoveries`);
      if (res.ok) {
        const data: DiscoverySessionResult[] = await res.json();
        setSessions(data.filter((s) => s.proposals.length > 0));
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [paperId]);

  useEffect(() => {
    fetchDiscoveries();
  }, [fetchDiscoveries]);

  const handleDiscover = async () => {
    setDiscovering(true);
    setDiscoveryProgress("Starting discovery...");

    try {
      const res = await fetch("/api/discovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperIds: [paperId] }),
      });

      if (!res.ok || !res.body) {
        toast.error("Failed to start discovery");
        setDiscovering(false);
        setDiscoveryProgress("");
        return;
      }

      const reader = res.body.getReader();
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
            const event = JSON.parse(line);
            if (event.type === "progress") {
              setDiscoveryProgress(`Searching... ${event.found} found`);
            } else if (event.type === "done") {
              setDiscoveryProgress(`Found ${event.totalFound} papers`);
            }
          } catch {
            // skip
          }
        }
      }

      // Refresh inline instead of navigating away
      await fetchDiscoveries();
      toast.success("Discovery complete");
    } catch {
      toast.error("Discovery failed");
    } finally {
      setDiscovering(false);
      setDiscoveryProgress("");
    }
  };

  const updateProposal = (
    sessionId: string,
    proposalId: string,
    update: Partial<DiscoveryProposal>
  ) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.sessionId === sessionId
          ? {
              ...s,
              proposals: s.proposals.map((p) =>
                p.id === proposalId ? { ...p, ...update } : p
              ),
            }
          : s
      )
    );
  };

  const handleImport = async (sessionId: string, proposalId: string) => {
    setImportingIds((prev) => new Set(prev).add(proposalId));
    try {
      const res = await fetch(
        `/api/discovery/${sessionId}/proposals/${proposalId}/import`,
        { method: "POST" }
      );
      if (res.ok) {
        const paper = await res.json();
        updateProposal(sessionId, proposalId, {
          status: "IMPORTED",
          importedPaper: { id: paper.id, title: paper.title },
        });
        toast.success("Paper imported");
      } else {
        toast.error("Import failed");
      }
    } catch {
      toast.error("Import failed");
    } finally {
      setImportingIds((prev) => {
        const next = new Set(prev);
        next.delete(proposalId);
        return next;
      });
    }
  };

  const handleDismiss = async (sessionId: string, proposalId: string) => {
    try {
      await fetch(
        `/api/discovery/${sessionId}/proposals/${proposalId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "DISMISSED" }),
        }
      );
      updateProposal(sessionId, proposalId, { status: "DISMISSED" });
    } catch {
      // ignore
    }
  };

  const handleRestore = async (sessionId: string, proposalId: string) => {
    try {
      await fetch(
        `/api/discovery/${sessionId}/proposals/${proposalId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "PENDING" }),
        }
      );
      updateProposal(sessionId, proposalId, { status: "PENDING" });
    } catch {
      // ignore
    }
  };

  const toggleSession = (sessionId: string) => {
    setCollapsedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  // Flatten all proposals across sessions
  const allProposals = sessions.flatMap((s) =>
    s.proposals.map((p) => ({ ...p, sessionId: s.sessionId }))
  );

  // Apply status filter
  const filtered = statusFilter === "all"
    ? allProposals
    : allProposals.filter((p) => {
        if (statusFilter === "pending") return p.status === "PENDING";
        if (statusFilter === "imported") return p.status === "IMPORTED" || p.status === "ALREADY_IN_LIBRARY";
        if (statusFilter === "dismissed") return p.status === "DISMISSED";
        return true;
      });

  // Counts for filter pills
  const pendingCount = allProposals.filter((p) => p.status === "PENDING").length;
  const importedCount = allProposals.filter((p) => p.status === "IMPORTED" || p.status === "ALREADY_IN_LIBRARY").length;
  const dismissedCount = allProposals.filter((p) => p.status === "DISMISSED").length;
  const filterCounts: Record<StatusFilter, number> = {
    all: allProposals.length,
    pending: pendingCount,
    imported: importedCount,
    dismissed: dismissedCount,
  };

  // Bulk actions
  const handleBulkImport = async () => {
    const pending = filtered.filter((p) => p.status === "PENDING");
    if (pending.length === 0) return;
    setBulkAction("importing");
    let imported = 0;
    for (const p of pending) {
      try {
        const res = await fetch(
          `/api/discovery/${p.sessionId}/proposals/${p.id}/import`,
          { method: "POST" }
        );
        if (res.ok) {
          const paper = await res.json();
          updateProposal(p.sessionId, p.id, {
            status: "IMPORTED",
            importedPaper: { id: paper.id, title: paper.title },
          });
          imported++;
        }
      } catch {
        // continue with next
      }
    }
    toast.success(`Imported ${imported} paper${imported !== 1 ? "s" : ""}`);
    setBulkAction(null);
  };

  const handleBulkDismiss = async () => {
    const pending = filtered.filter((p) => p.status === "PENDING");
    if (pending.length === 0) return;
    setBulkAction("dismissing");
    for (const p of pending) {
      try {
        await fetch(
          `/api/discovery/${p.sessionId}/proposals/${p.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "DISMISSED" }),
          }
        );
        updateProposal(p.sessionId, p.id, { status: "DISMISSED" });
      } catch {
        // continue
      }
    }
    toast.success("All pending dismissed");
    setBulkAction(null);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <>
        <Separator />
        <section>
          <h3 className="text-sm font-medium mb-2">Discover More</h3>
          <p className="text-sm text-muted-foreground mb-3">
            Find related papers to &ldquo;{paperTitle}&rdquo; by following
            citation chains.
          </p>
          <Button
            variant="outline"
            onClick={handleDiscover}
            disabled={discovering}
          >
            {discovering ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {discoveryProgress || "Starting..."}
              </>
            ) : (
              <>
                <Compass className="mr-2 h-4 w-4" />
                Start Discovery
              </>
            )}
          </Button>
        </section>
      </>
    );
  }

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "alpha") return a.title.localeCompare(b.title);
    if (sortBy === "year") return (b.year ?? 0) - (a.year ?? 0);
    return (b.citationCount ?? 0) - (a.citationCount ?? 0);
  });

  const visible = sorted.slice(0, visibleCount);
  const hasMore = sorted.length > visibleCount;

  return (
    <>
      <Separator />
      <section>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Discovered Papers</span>
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
                <DropdownMenuContent
                  align="end"
                  className="p-1 [&_[role=menuitem]]:px-2.5 [&_[role=menuitem]]:py-1.5 [&_[role=menuitem]]:gap-2 [&_[role=menuitem]]:text-xs"
                >
                  <DropdownMenuItem onClick={() => setSortBy("citations")}>
                    {sortBy === "citations" ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <span className="w-4" />
                    )}
                    Most cited
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSortBy("year")}>
                    {sortBy === "year" ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <span className="w-4" />
                    )}
                    Most recent
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSortBy("alpha")}>
                    {sortBy === "alpha" ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <span className="w-4" />
                    )}
                    Alphabetical
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
                  <DropdownMenuItem
                    onClick={handleDiscover}
                    disabled={discovering}
                  >
                    {discovering ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    {discovering
                      ? discoveryProgress || "Starting..."
                      : "Redo discovery"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Status filter pills */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => {
                  setStatusFilter(f.value);
                  setVisibleCount(PAGE_SIZE);
                }}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  statusFilter === f.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                {f.label}
                <span className="opacity-70">{filterCounts[f.value]}</span>
              </button>
            ))}

            {/* Bulk action buttons */}
            {pendingCount > 0 && statusFilter !== "dismissed" && statusFilter !== "imported" && (
              <div className="flex items-center gap-1 ml-auto">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs px-2"
                  onClick={handleBulkImport}
                  disabled={bulkAction !== null}
                >
                  {bulkAction === "importing" ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Import className="h-3 w-3 mr-1" />
                  )}
                  Import all ({pendingCount})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs px-2"
                  onClick={handleBulkDismiss}
                  disabled={bulkAction !== null}
                >
                  {bulkAction === "dismissing" ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <X className="h-3 w-3 mr-1" />
                  )}
                  Dismiss all ({pendingCount})
                </Button>
              </div>
            )}
          </div>

          {sessions.length > 1 &&
            sessions.map((session) => {
              const isCollapsed = collapsedSessions.has(session.sessionId);
              return (
                <button
                  key={session.sessionId}
                  onClick={() => toggleSession(session.sessionId)}
                  className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                  {session.title ||
                    `Discovery ${new Date(session.createdAt).toLocaleDateString()}`}
                  <span className="font-normal">
                    ({session.proposals.length})
                  </span>
                </button>
              );
            })}

          {visible.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              sessionId={proposal.sessionId}
              importing={importingIds.has(proposal.id)}
              onImport={handleImport}
              onDismiss={handleDismiss}
              onRestore={handleRestore}
            />
          ))}

          {sorted.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No proposals match this filter.
            </p>
          )}

          {hasMore && (
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground py-2 hover:bg-accent/50 rounded-md transition-colors"
            >
              Load more ({sorted.length - visibleCount} remaining)
            </button>
          )}
        </div>
      </section>
    </>
  );
}

// ── Proposal card (matches references pattern) ──────────────────────

function ProposalCard({
  proposal,
  sessionId,
  importing,
  onImport,
  onDismiss,
  onRestore,
}: {
  proposal: DiscoveryProposal;
  sessionId: string;
  importing: boolean;
  onImport: (sessionId: string, proposalId: string) => void;
  onDismiss: (sessionId: string, proposalId: string) => void;
  onRestore: (sessionId: string, proposalId: string) => void;
}) {
  const authors = parseAuthors(proposal.authors);
  const isDismissed = proposal.status === "DISMISSED";
  const isImported = proposal.status === "IMPORTED";
  const isInLibrary = proposal.status === "ALREADY_IN_LIBRARY";
  const isPending = proposal.status === "PENDING";

  const reasonMatch = proposal.reason.match(/^(cited_by|cites):(.+)$/);
  const isCitedBy = reasonMatch?.[1] === "cited_by";

  // Primary external URL: prefer arxiv > doi > externalUrl > semantic scholar
  const primaryUrl = proposal.arxivId
    ? `https://arxiv.org/abs/${proposal.arxivId}`
    : proposal.doi
      ? `https://doi.org/${proposal.doi}`
      : proposal.externalUrl
        ? proposal.externalUrl
        : proposal.semanticScholarId
          ? `https://www.semanticscholar.org/paper/${proposal.semanticScholarId}`
          : null;

  return (
    <Card
      className={`group relative transition-colors ${isDismissed ? "opacity-50" : ""}`}
    >
      <CardContent className="py-3">
        <div className="min-w-0">
          <div className="mb-1 pr-20">
            {(isImported || isInLibrary) && proposal.importedPaper ? (
              <Link
                href={`/papers/${proposal.importedPaper.id}`}
                className="font-medium text-sm hover:underline"
              >
                {proposal.title}
              </Link>
            ) : (
              <span className="font-medium text-sm">{proposal.title}</span>
            )}
            {(isImported || isInLibrary) && (
              <Library className="inline h-3.5 w-3.5 text-green-600 ml-1.5 align-text-bottom" />
            )}
            <StatusBadge status={proposal.status} />
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
            {authors.length > 0 && (
              <span>
                {authors.slice(0, 3).join(", ")}
                {authors.length > 3 && " et al."}
              </span>
            )}
            {proposal.year && <span>({proposal.year})</span>}
            {proposal.venue && (
              <Badge variant="secondary" className="text-xs">
                {proposal.venue}
              </Badge>
            )}
            {proposal.citationCount != null && (
              <>
                <span className="text-muted-foreground/50">&middot;</span>
                <span>{proposal.citationCount.toLocaleString()} cit.</span>
              </>
            )}
            <span className="text-muted-foreground/50">&middot;</span>
            <span className="inline-flex items-center gap-0.5">
              {isCitedBy ? (
                <ArrowLeft className="h-2.5 w-2.5" />
              ) : (
                <ArrowRight className="h-2.5 w-2.5" />
              )}
              {isCitedBy ? "cited by seed" : "cites seed"}
            </span>
          </div>
        </div>

        {/* Action buttons — absolute positioned like references */}
        <div className="absolute top-2 right-2 flex items-center gap-0.5">
          {/* Import button (icon only) */}
          {isPending && (
            <button
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              onClick={() => onImport(sessionId, proposal.id)}
              disabled={importing}
              title="Import to library"
            >
              {importing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
            </button>
          )}

          {/* Open in new tab */}
          {primaryUrl && (
            <a
              href={primaryUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              title="Open in new tab"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}

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
            <DropdownMenuContent
              align="end"
              className="w-48 p-1 [&_[role=menuitem]]:px-2.5 [&_[role=menuitem]]:py-1.5 [&_[role=menuitem]]:gap-2 [&_[role=menuitem]]:text-xs"
            >
              {/* Search via topbar */}
              <DropdownMenuItem
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("topbar-search", {
                      detail: { query: proposal.title },
                    })
                  )
                }
              >
                <Search className="h-4 w-4" />
                Search in sources
              </DropdownMenuItem>
              <DropdownMenuSeparator />

              {/* External links */}
              {proposal.arxivId && (
                <DropdownMenuItem
                  onClick={() =>
                    window.open(
                      `https://arxiv.org/abs/${proposal.arxivId}`,
                      "_blank"
                    )
                  }
                >
                  <ExternalLink className="h-4 w-4" />
                  Open on arXiv
                </DropdownMenuItem>
              )}
              {proposal.doi && (
                <DropdownMenuItem
                  onClick={() =>
                    window.open(
                      `https://doi.org/${proposal.doi}`,
                      "_blank"
                    )
                  }
                >
                  <ExternalLink className="h-4 w-4" />
                  Open DOI
                </DropdownMenuItem>
              )}
              {proposal.semanticScholarId && (
                <DropdownMenuItem
                  onClick={() =>
                    window.open(
                      `https://www.semanticscholar.org/paper/${proposal.semanticScholarId}`,
                      "_blank"
                    )
                  }
                >
                  <ExternalLink className="h-4 w-4" />
                  Open on Semantic Scholar
                </DropdownMenuItem>
              )}
              {proposal.openAccessPdfUrl && (
                <DropdownMenuItem
                  onClick={() =>
                    window.open(proposal.openAccessPdfUrl!, "_blank")
                  }
                >
                  <ExternalLink className="h-4 w-4" />
                  Open PDF
                </DropdownMenuItem>
              )}

              {(proposal.arxivId ||
                proposal.doi ||
                proposal.semanticScholarId ||
                proposal.openAccessPdfUrl) && <DropdownMenuSeparator />}

              {/* Status actions */}
              {isPending && (
                <DropdownMenuItem
                  onClick={() => onDismiss(sessionId, proposal.id)}
                  className="text-destructive focus:text-destructive"
                >
                  <X className="h-4 w-4" />
                  Dismiss
                </DropdownMenuItem>
              )}
              {isDismissed && (
                <DropdownMenuItem
                  onClick={() => onRestore(sessionId, proposal.id)}
                >
                  <Undo2 className="h-4 w-4" />
                  Restore
                </DropdownMenuItem>
              )}
              {(isImported || isInLibrary) && proposal.importedPaper && (
                <DropdownMenuItem
                  onClick={() =>
                    window.open(
                      `/papers/${proposal.importedPaper!.id}`,
                      "_self"
                    )
                  }
                >
                  <Library className="h-4 w-4" />
                  View in library
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<
    string,
    { label: string; variant: "default" | "secondary" | "outline" }
  > = {
    PENDING: { label: "Pending", variant: "default" },
    IMPORTED: { label: "Imported", variant: "secondary" },
    DISMISSED: { label: "Dismissed", variant: "outline" },
    ALREADY_IN_LIBRARY: { label: "In Library", variant: "outline" },
  };
  const info = config[status] || config.PENDING;
  return (
    <Badge
      variant={info.variant}
      className="shrink-0 text-[10px] h-4 px-1.5 ml-1.5 align-text-bottom inline-flex"
    >
      {info.label}
    </Badge>
  );
}

function parseAuthors(authors: string | null): string[] {
  if (!authors) return [];
  try {
    return JSON.parse(authors);
  } catch {
    return [];
  }
}
