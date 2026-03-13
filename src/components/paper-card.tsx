"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import {
  Heart,
  Users,
  Calendar,
  FileText,
  ExternalLink,
  Flame,
} from "lucide-react";

interface Tag {
  id: string;
  name: string;
  color: string;
  score?: number;
}

export interface PaperCardData {
  id: string;
  title: string;
  abstract: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  sourceUrl: string | null;
  citationCount: number | null;
  isLiked: boolean;
  engagementScore: number;
  tags: { tag: Tag }[];
  matchFields?: string[];
  processingStatus?: string;
}

interface PaperCardProps {
  paper: PaperCardData;
  onLikeToggle: (id: string) => void;
  onDelete?: (id: string) => void;
}

const HEAT_COLORS = [
  "", // 0 = no indicator
  "text-blue-400",
  "text-yellow-500",
  "text-orange-500",
  "text-red-500",
];

function getHeatLevel(score: number): number {
  if (score <= 0) return 0;
  if (score < 2) return 1;
  if (score < 5) return 2;
  if (score < 12) return 3;
  return 4;
}

export function PaperCard({
  paper,
  onLikeToggle,
}: PaperCardProps) {
  const authors: string[] = paper.authors
    ? JSON.parse(paper.authors)
    : [];
  const displayAuthors =
    authors.length > 3
      ? authors.slice(0, 3).join(", ") + " et al."
      : authors.join(", ");

  const externalUrl =
    paper.sourceUrl || (paper.doi ? `https://doi.org/${paper.doi}` : null);

  const heat = getHeatLevel(paper.engagementScore);

  return (
    <Card className="transition-colors hover:bg-accent/50">
      <CardContent className="p-4">
        <Link href={`/papers/${paper.id}`} className="block">
          {/* Title + Like */}
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-lg font-semibold leading-tight">
              {paper.title}
              {paper.processingStatus === "NO_PDF" && (
                <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-500 align-middle">No PDF</span>
              )}
              {paper.processingStatus === "PENDING" && (
                <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground align-middle">Pending</span>
              )}
              {paper.processingStatus === "FAILED" && (
                <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-destructive/10 text-destructive align-middle">Failed</span>
              )}
            </h3>
            <div className="flex items-center gap-1 shrink-0 mt-0.5">
              {heat > 0 && (
                <Flame className={`h-4 w-4 ${HEAT_COLORS[heat]}`} />
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onLikeToggle(paper.id);
                }}
              >
                <Heart
                  className={`h-5 w-5 ${
                    paper.isLiked
                      ? "fill-red-500 text-red-500"
                      : "text-muted-foreground"
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Metadata row */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {displayAuthors && (
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                <span className="truncate max-w-[300px]">{displayAuthors}</span>
              </span>
            )}
            {paper.year && (
              <span className="flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                {paper.year}
              </span>
            )}
            {paper.citationCount != null && (
              <span className="flex items-center gap-1">
                <FileText className="h-3.5 w-3.5" />
                {paper.citationCount} citations
              </span>
            )}
          </div>

          {/* Match indicator */}
          {paper.matchFields && paper.matchFields.length > 0 && (
            <p className="mt-1.5 text-xs text-muted-foreground/70">
              matches: {paper.matchFields.join(", ")}
            </p>
          )}

          {/* Abstract */}
          {paper.abstract && (
            <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
              {paper.abstract}
            </p>
          )}

          {/* Tags — show top 3 by score, "+N" for the rest */}
          {paper.tags.length > 0 && (() => {
            const sorted = [...paper.tags].sort(
              (a, b) => (b.tag.score ?? 0) - (a.tag.score ?? 0)
            );
            const visible = sorted.slice(0, 3);
            const remaining = sorted.length - visible.length;
            return (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {visible.map((pt) => (
                  <span
                    key={pt.tag.id}
                    className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
                    style={{
                      backgroundColor: pt.tag.color + "20",
                      color: pt.tag.color,
                    }}
                  >
                    {pt.tag.name}
                  </span>
                ))}
                {remaining > 0 && (
                  <span className="text-xs text-muted-foreground">
                    +{remaining}
                  </span>
                )}
              </div>
            );
          })()}
        </Link>

        {/* Footer */}
        <div className="mt-3 flex items-center justify-end border-t pt-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {paper.venue && (
              <span>
                {paper.venue}
                {paper.year ? ` ${paper.year}` : ""}
              </span>
            )}
            {externalUrl && (
              <a
                href={externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
