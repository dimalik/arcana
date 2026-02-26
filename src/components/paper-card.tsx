"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import {
  Bookmark,
  Users,
  Calendar,
  FileText,
  ExternalLink,
} from "lucide-react";

interface Tag {
  id: string;
  name: string;
  color: string;
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
  readingStatus: string;
  isBookmarked: boolean;
  tags: { tag: Tag }[];
}

interface PaperCardProps {
  paper: PaperCardData;
  onBookmarkToggle: (id: string) => void;
  onStatusChange: (id: string, status: string) => void;
  onDelete?: (id: string) => void;
}

export function PaperCard({
  paper,
  onBookmarkToggle,
  onStatusChange,
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

  return (
    <Card className="transition-colors hover:bg-accent/50">
      <CardContent className="p-4">
        <Link href={`/papers/${paper.id}`} className="block">
          {/* Title + Bookmark */}
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-lg font-semibold leading-tight">
              {paper.title}
            </h3>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onBookmarkToggle(paper.id);
              }}
              className="mt-0.5 shrink-0"
            >
              <Bookmark
                className={`h-5 w-5 ${
                  paper.isBookmarked
                    ? "fill-blue-500 text-blue-500"
                    : "text-muted-foreground"
                }`}
              />
            </button>
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

          {/* Abstract */}
          {paper.abstract && (
            <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
              {paper.abstract}
            </p>
          )}

          {/* Tags */}
          {paper.tags.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {paper.tags.map((pt) => (
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
            </div>
          )}
        </Link>

        {/* Footer */}
        <div className="mt-3 flex items-center justify-between border-t pt-3">
          <div
            className="flex items-center gap-2"
            onClick={(e) => e.preventDefault()}
          >
            <span className="text-xs text-muted-foreground">Status:</span>
            <select
              value={paper.readingStatus}
              onChange={(e) => {
                e.stopPropagation();
                onStatusChange(paper.id, e.target.value);
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-7 rounded-md border bg-background px-2 text-xs"
            >
              <option value="unread">Unread</option>
              <option value="reading">Reading</option>
              <option value="read">Read</option>
            </select>
          </div>

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
