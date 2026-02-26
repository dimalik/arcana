"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ProposalCard,
  type Proposal,
} from "@/components/discovery/proposal-card";
import {
  ArrowLeft,
  Loader2,
  Import,
  X,
} from "lucide-react";

interface SessionDetail {
  id: string;
  title: string | null;
  status: string;
  depth: number;
  totalFound: number;
  createdAt: string;
  seedPapers: { id: string; title: string }[];
  proposals: Proposal[];
}

type SortBy = "citations" | "year" | "status";
type StatusFilter = "all" | "PENDING" | "IMPORTED" | "DISMISSED" | "ALREADY_IN_LIBRARY";

export default function SessionDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<SortBy>("citations");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState(false);

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/discovery/${params.sessionId}`);
      if (!res.ok) {
        router.push("/discovery");
        return;
      }
      const data = await res.json();
      setSession(data);
    } catch {
      router.push("/discovery");
    } finally {
      setLoading(false);
    }
  }, [params.sessionId, router]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  const handleImport = async (proposalId: string) => {
    setImportingIds((prev) => new Set(prev).add(proposalId));
    try {
      const res = await fetch(
        `/api/discovery/${params.sessionId}/proposals/${proposalId}/import`,
        { method: "POST" }
      );
      if (res.ok) {
        const paper = await res.json();
        setSession((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            proposals: prev.proposals.map((p) =>
              p.id === proposalId
                ? { ...p, status: "IMPORTED", importedPaperId: paper.id }
                : p
            ),
          };
        });
      }
    } catch {
      // ignore
    } finally {
      setImportingIds((prev) => {
        const next = new Set(prev);
        next.delete(proposalId);
        return next;
      });
    }
  };

  const handleDismiss = async (proposalId: string) => {
    try {
      await fetch(
        `/api/discovery/${params.sessionId}/proposals/${proposalId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "DISMISSED" }),
        }
      );
      setSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          proposals: prev.proposals.map((p) =>
            p.id === proposalId ? { ...p, status: "DISMISSED" } : p
          ),
        };
      });
    } catch {
      // ignore
    }
  };

  const handleRestore = async (proposalId: string) => {
    try {
      await fetch(
        `/api/discovery/${params.sessionId}/proposals/${proposalId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "PENDING" }),
        }
      );
      setSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          proposals: prev.proposals.map((p) =>
            p.id === proposalId ? { ...p, status: "PENDING" } : p
          ),
        };
      });
    } catch {
      // ignore
    }
  };

  const handleBulkImport = async () => {
    if (!session) return;
    setBulkAction(true);
    const pending = session.proposals.filter((p) => p.status === "PENDING");
    for (const proposal of pending) {
      await handleImport(proposal.id);
    }
    setBulkAction(false);
  };

  const handleBulkDismiss = async () => {
    if (!session) return;
    setBulkAction(true);
    const pending = session.proposals.filter((p) => p.status === "PENDING");
    for (const proposal of pending) {
      await handleDismiss(proposal.id);
    }
    setBulkAction(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) return null;

  // Filter + sort
  const filtered =
    statusFilter === "all"
      ? session.proposals
      : session.proposals.filter((p) => p.status === statusFilter);

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "citations") {
      return (b.citationCount ?? -1) - (a.citationCount ?? -1);
    }
    if (sortBy === "year") {
      return (b.year ?? 0) - (a.year ?? 0);
    }
    // Sort by status: PENDING first, then IMPORTED, then ALREADY_IN_LIBRARY, then DISMISSED
    const order: Record<string, number> = {
      PENDING: 0,
      IMPORTED: 1,
      ALREADY_IN_LIBRARY: 2,
      DISMISSED: 3,
    };
    return (order[a.status] ?? 4) - (order[b.status] ?? 4);
  });

  const pendingCount = session.proposals.filter(
    (p) => p.status === "PENDING"
  ).length;
  const importedCount = session.proposals.filter(
    (p) => p.status === "IMPORTED"
  ).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="mb-2 -ml-2"
          onClick={() => router.push("/discovery")}
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to Discovery
        </Button>
        <h1 className="text-2xl font-bold tracking-tight line-clamp-2">
          {session.title || "Discovery Session"}
        </h1>
        <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
          <span>{new Date(session.createdAt).toLocaleDateString()}</span>
          <span>&middot;</span>
          <span>{session.proposals.length} papers found</span>
          <span>&middot;</span>
          <span>{importedCount} imported</span>
          <span>&middot;</span>
          <span>{pendingCount} pending</span>
        </div>

        {/* Seed paper badges */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {session.seedPapers.map((sp) => (
            <Badge key={sp.id} variant="outline" className="text-xs">
              {sp.title.length > 50 ? sp.title.slice(0, 47) + "..." : sp.title}
            </Badge>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Select
            value={sortBy}
            onValueChange={(v) => setSortBy(v as SortBy)}
          >
            <SelectTrigger className="w-[160px] h-8 text-xs">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="citations">Most Cited</SelectItem>
              <SelectItem value="year">Most Recent</SelectItem>
              <SelectItem value="status">By Status</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          >
            <SelectTrigger className="w-[160px] h-8 text-xs">
              <SelectValue placeholder="Filter status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="IMPORTED">Imported</SelectItem>
              <SelectItem value="DISMISSED">Dismissed</SelectItem>
              <SelectItem value="ALREADY_IN_LIBRARY">In Library</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {pendingCount > 0 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={handleBulkDismiss}
              disabled={bulkAction}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Dismiss All ({pendingCount})
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={handleBulkImport}
              disabled={bulkAction}
            >
              {bulkAction ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Import className="mr-1 h-3.5 w-3.5" />
              )}
              Import All ({pendingCount})
            </Button>
          </div>
        )}
      </div>

      {/* Proposals */}
      {sorted.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {session.proposals.length === 0
              ? "No proposals found in this session."
              : "No proposals match the current filter."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {sorted.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              seedPapers={session.seedPapers}
              onImport={handleImport}
              onDismiss={handleDismiss}
              onRestore={handleRestore}
              importing={importingIds.has(proposal.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
