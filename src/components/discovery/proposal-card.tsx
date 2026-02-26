"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ExternalLink,
  Import,
  X,
  ArrowRight,
  ArrowLeft,
  Undo2,
} from "lucide-react";

export interface Proposal {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  externalUrl: string | null;
  citationCount: number | null;
  reason: string;
  status: string;
  importedPaperId: string | null;
}

interface ProposalCardProps {
  proposal: Proposal;
  seedPapers: { id: string; title: string }[];
  onImport: (id: string) => void;
  onDismiss: (id: string) => void;
  onRestore: (id: string) => void;
  importing?: boolean;
}

const STATUS_BADGES: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  PENDING: { label: "Pending", variant: "default" },
  IMPORTED: { label: "Imported", variant: "secondary" },
  DISMISSED: { label: "Dismissed", variant: "outline" },
  ALREADY_IN_LIBRARY: { label: "In Library", variant: "outline" },
};

export function ProposalCard({
  proposal,
  seedPapers,
  onImport,
  onDismiss,
  onRestore,
  importing,
}: ProposalCardProps) {
  const authors = parseAuthors(proposal.authors);
  const reasonText = formatReason(proposal.reason, seedPapers);
  const statusInfo = STATUS_BADGES[proposal.status] || STATUS_BADGES.PENDING;
  const isDismissed = proposal.status === "DISMISSED";
  const isImported = proposal.status === "IMPORTED";
  const isInLibrary = proposal.status === "ALREADY_IN_LIBRARY";
  const isPending = proposal.status === "PENDING";

  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        isDismissed ? "opacity-50" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Title */}
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm leading-snug line-clamp-2">
              {proposal.title}
            </h3>
            <Badge variant={statusInfo.variant} className="shrink-0 text-xs">
              {statusInfo.label}
            </Badge>
          </div>

          {/* Authors + Year + Venue */}
          <div className="mt-1 text-xs text-muted-foreground">
            {authors.length > 0 && (
              <span>
                {authors.length <= 3
                  ? authors.join(", ")
                  : `${authors[0]} et al.`}
              </span>
            )}
            {proposal.year && <span> ({proposal.year})</span>}
            {proposal.venue && <span> &middot; {proposal.venue}</span>}
          </div>

          {/* Citation count + Reason */}
          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            {proposal.citationCount != null && (
              <span>{proposal.citationCount.toLocaleString()} citations</span>
            )}
            <span className="inline-flex items-center gap-1">
              {proposal.reason.startsWith("cited_by:") ? (
                <ArrowLeft className="h-3 w-3" />
              ) : (
                <ArrowRight className="h-3 w-3" />
              )}
              {reasonText}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {proposal.externalUrl && (
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
              <a
                href={proposal.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}

          {isPending && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={() => onDismiss(proposal.id)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="default"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={() => onImport(proposal.id)}
                disabled={importing}
              >
                <Import className="h-3.5 w-3.5" />
                Import
              </Button>
            </>
          )}

          {isDismissed && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1 text-xs"
              onClick={() => onRestore(proposal.id)}
            >
              <Undo2 className="h-3.5 w-3.5" />
              Restore
            </Button>
          )}

          {(isImported || isInLibrary) && proposal.importedPaperId && (
            <Button variant="ghost" size="sm" className="h-8 text-xs" asChild>
              <a href={`/papers/${proposal.importedPaperId}`}>View</a>
            </Button>
          )}
        </div>
      </div>
    </div>
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

function formatReason(
  reason: string,
  seedPapers: { id: string; title: string }[]
): string {
  const match = reason.match(/^(cited_by|cites):(.+)$/);
  if (!match) return reason;

  const [, direction, paperId] = match;
  const seed = seedPapers.find((p) => p.id === paperId);
  const seedTitle = seed
    ? seed.title.length > 40
      ? seed.title.slice(0, 37) + "..."
      : seed.title
    : "seed paper";

  return direction === "cited_by"
    ? `Referenced by "${seedTitle}"`
    : `Cites "${seedTitle}"`;
}
