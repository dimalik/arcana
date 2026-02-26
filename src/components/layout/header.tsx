"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, Info, FileText, Lightbulb, Tags } from "lucide-react";
import { Users, Building2, Fingerprint, ExternalLink } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const pageTitles: Record<string, string> = {
  "/": "Dashboard",
  "/papers": "Papers",
  "/upload": "Upload Paper",
  "/import": "Import Paper",
  "/tags": "Tags",
  "/collections": "Collections",
  "/settings": "Settings",
};

interface TagInfo {
  id: string;
  name: string;
  color: string;
}

interface PaperInfo {
  title: string;
  year: number | null;
  abstract: string | null;
  authors: string | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  keyFindings: string | null;
  tags: { tag: TagInfo }[];
}

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [paperInfo, setPaperInfo] = useState<PaperInfo | null>(null);

  const paperMatch = pathname.match(/^\/papers\/([^/]+)$/);
  const isPaperDetail = !!paperMatch;

  useEffect(() => {
    if (!paperMatch) {
      setPaperInfo(null);
      return;
    }
    const paperId = paperMatch[1];
    fetch(`/api/papers/${paperId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setPaperInfo({
            title: data.title,
            year: data.year,
            abstract: data.abstract,
            authors: data.authors,
            venue: data.venue,
            doi: data.doi,
            arxivId: data.arxivId,
            keyFindings: data.keyFindings,
            tags: data.tags ?? [],
          });
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const staticTitle = pageTitles[pathname];

  if (!isPaperDetail || !paperInfo) {
    return (
      <header className="flex h-14 items-center border-b px-6 gap-3 min-w-0">
        <h1 className="truncate text-lg font-semibold">
          {staticTitle ?? "Arcana"}
        </h1>
      </header>
    );
  }

  const authors: string[] = paperInfo.authors
    ? JSON.parse(paperInfo.authors)
    : [];
  const keyFindings: string[] = paperInfo.keyFindings
    ? JSON.parse(paperInfo.keyFindings)
    : [];
  const hasMetadata =
    authors.length > 0 || paperInfo.venue || paperInfo.doi || paperInfo.arxivId;

  return (
    <TooltipProvider>
      <header className="flex h-14 items-center border-b px-6 gap-2 min-w-0">
        <button
          onClick={() => router.back()}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-accent text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <h1 className="truncate text-lg font-semibold">
          {paperInfo.title}
          {paperInfo.year && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({paperInfo.year})
            </span>
          )}
        </h1>

        {/* Inline icon popovers */}
        <div className="flex items-center gap-0.5 shrink-0">
          {hasMetadata && (
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                      <Info className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Details</TooltipContent>
              </Tooltip>
              <PopoverContent className="w-80" align="start">
                <div className="space-y-3 text-sm">
                  {authors.length > 0 && (
                    <div className="flex gap-2">
                      <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span>{authors.join(", ")}</span>
                    </div>
                  )}
                  {paperInfo.venue && (
                    <div className="flex items-center gap-2">
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span>{paperInfo.venue}</span>
                    </div>
                  )}
                  {paperInfo.doi && (
                    <div className="flex items-center gap-2">
                      <Fingerprint className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <a
                        href={`https://doi.org/${paperInfo.doi}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline break-all"
                      >
                        {paperInfo.doi}
                      </a>
                    </div>
                  )}
                  {paperInfo.arxivId && (
                    <div className="flex items-center gap-2">
                      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <a
                        href={`https://arxiv.org/abs/${paperInfo.arxivId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        arXiv:{paperInfo.arxivId}
                      </a>
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {paperInfo.abstract && (
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                      <FileText className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Abstract</TooltipContent>
              </Tooltip>
              <PopoverContent className="w-96" align="start">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {paperInfo.abstract}
                </p>
              </PopoverContent>
            </Popover>
          )}

          {keyFindings.length > 0 && (
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                      <Lightbulb className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Key Findings</TooltipContent>
              </Tooltip>
              <PopoverContent className="w-96" align="start">
                <ul className="space-y-1.5">
                  {keyFindings.map((finding, i) => (
                    <li
                      key={i}
                      className="flex gap-2.5 text-sm text-muted-foreground leading-relaxed"
                    >
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500/50" />
                      {finding}
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {/* Tags — top 3 visible, rest in popover */}
        {paperInfo.tags.length > 0 && (
          <div className="flex items-center gap-1 shrink-0 ml-1">
            {paperInfo.tags.slice(0, 3).map((pt) => (
              <span
                key={pt.tag.id}
                className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                style={{
                  backgroundColor: pt.tag.color + "20",
                  color: pt.tag.color,
                }}
              >
                {pt.tag.name}
              </span>
            ))}
            {paperInfo.tags.length > 3 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/80">
                    <Tags className="h-3 w-3" />
                    +{paperInfo.tags.length - 3}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto" align="start">
                  <div className="flex flex-wrap gap-1.5">
                    {paperInfo.tags.slice(3).map((pt) => (
                      <span
                        key={pt.tag.id}
                        className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                        style={{
                          backgroundColor: pt.tag.color + "20",
                          color: pt.tag.color,
                        }}
                      >
                        {pt.tag.name}
                      </span>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        )}
      </header>
    </TooltipProvider>
  );
}
