"use client";

import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  RefreshCw,
  Loader2,
  BarChart3,
  PieChart as PieChartIcon,
  Table2,
  GitBranch,
  TrendingUp,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  FileDown,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { VizTimeline } from "./viz-timeline";
import { VizThemes } from "./viz-themes";
import { VizMethodology } from "./viz-methodology";
import { VizCitations } from "./viz-citations";
import { VizFigures } from "./viz-figures";
import { SynthesisDiscover } from "./synthesis-discover";
import type { VizData } from "@/lib/synthesis/types";
import Link from "next/link";

interface SynthesisSection {
  id: string;
  sectionType: string;
  title: string;
  content: string;
  sortOrder: number;
  citations: string | null;
}

interface SynthesisPaperRef {
  paperId: string;
  paper: { id: string; title: string; year: number | null; authors: string | null };
}

interface SynthesisOutputProps {
  sessionId: string;
  title: string;
  description?: string | null;
  paperCount: number;
  sections: SynthesisSection[];
  papers: SynthesisPaperRef[];
  vizData: VizData | null;
  output: string | null;
  createdAt: string;
  onRefresh: () => void;
}

/** Replace [paperId] citations with clickable links */
function processCitations(content: string, paperMap: Map<string, string>): string {
  return content.replace(/\[([a-f0-9-]{36})\]/g, (match, id) => {
    const title = paperMap.get(id);
    if (title) {
      return `[${title.slice(0, 30)}${title.length > 30 ? "..." : ""}](/papers/${id})`;
    }
    return match;
  });
}

export function SynthesisOutput({
  sessionId,
  title,
  description,
  paperCount,
  sections,
  papers,
  vizData,
  output,
  createdAt,
  onRefresh,
}: SynthesisOutputProps) {
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [papersExpanded, setPapersExpanded] = useState(false);

  const paperMap = useMemo(
    () => new Map(papers.map((sp) => [sp.paper.id, sp.paper.title])),
    [papers]
  );

  const handleExport = async (format: "pdf" | "tex") => {
    setExporting(true);
    try {
      const res = await fetch(
        `/api/synthesis/${sessionId}/export?format=${format}`
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Export failed" }));
        toast.error(data.error || "Export failed");
        return;
      }

      const contentType = res.headers.get("Content-Type") || "";
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] || `synthesis.${format}`;

      // If we requested PDF but got .tex back, notify user
      const isPdfFallback = format === "pdf" && contentType.includes("x-tex");
      if (isPdfFallback) {
        toast.info("PDF compilation failed — downloading LaTeX source instead. Compile with: pdflatex synthesis.tex");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = isPdfFallback ? filename.replace(".pdf", ".tex") : filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      if (!isPdfFallback) toast.success(`${format.toUpperCase()} downloaded`);
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting(false);
    }
  };

  const handleRegenerate = async (sectionType: string) => {
    setRegenerating(sectionType);
    try {
      const res = await fetch(`/api/synthesis/${sessionId}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionType }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to regenerate");
        return;
      }

      toast.success("Section regenerated");
      onRefresh();
    } catch {
      toast.error("Failed to regenerate section");
    } finally {
      setRegenerating(null);
    }
  };

  const hasViz = vizData && (
    vizData.timeline.length > 0 ||
    vizData.themes.length > 0 ||
    vizData.methodologyMatrix.papers.length > 0 ||
    vizData.citationNetwork.nodes.length > 0 ||
    (vizData.figures && vizData.figures.length > 0)
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{title}</h1>
          {description && (
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
          )}
          <button
            onClick={() => setPapersExpanded((v) => !v)}
            className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
          >
            {papersExpanded ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            {papersExpanded ? "Hide" : "Show"} {paperCount} papers
          </button>
          {papersExpanded && (
            <div className="mt-1.5 rounded-md bg-muted/50 border border-border/50 px-2.5 py-2 space-y-1">
              {papers.map((sp) => (
                <div key={sp.paperId} className="flex items-start gap-1.5">
                  <FileText className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground/50" />
                  <Link
                    href={`/papers/${sp.paper.id}`}
                    className="text-[11px] text-foreground/70 leading-snug hover:text-primary"
                  >
                    {sp.paper.title}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => handleExport("pdf")}
          disabled={exporting}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          title="Export PDF"
        >
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FileDown className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Visualizations */}
      {hasViz && (
        <Tabs defaultValue="timeline">
          <TabsList>
            {vizData!.timeline.length > 0 && (
              <TabsTrigger value="timeline" className="gap-1.5">
                <BarChart3 className="h-3.5 w-3.5" />
                Timeline
              </TabsTrigger>
            )}
            {vizData!.themes.length > 0 && (
              <TabsTrigger value="themes" className="gap-1.5">
                <PieChartIcon className="h-3.5 w-3.5" />
                Themes
              </TabsTrigger>
            )}
            {vizData!.methodologyMatrix.papers.length > 0 && (
              <TabsTrigger value="methods" className="gap-1.5">
                <Table2 className="h-3.5 w-3.5" />
                Methods
              </TabsTrigger>
            )}
            {vizData!.citationNetwork.nodes.length > 0 && (
              <TabsTrigger value="citations" className="gap-1.5">
                <GitBranch className="h-3.5 w-3.5" />
                Citations
              </TabsTrigger>
            )}
            {vizData!.figures && vizData!.figures.length > 0 && (
              <TabsTrigger value="figures" className="gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" />
                Figures
              </TabsTrigger>
            )}
          </TabsList>

          {vizData!.timeline.length > 0 && (
            <TabsContent value="timeline">
              <Card>
                <CardContent className="pt-4">
                  <VizTimeline data={vizData!.timeline} />
                </CardContent>
              </Card>
            </TabsContent>
          )}
          {vizData!.themes.length > 0 && (
            <TabsContent value="themes">
              <Card>
                <CardContent className="pt-4">
                  <VizThemes data={vizData!.themes} />
                </CardContent>
              </Card>
            </TabsContent>
          )}
          {vizData!.methodologyMatrix.papers.length > 0 && (
            <TabsContent value="methods">
              <Card>
                <CardContent className="pt-4">
                  <VizMethodology data={vizData!.methodologyMatrix} />
                </CardContent>
              </Card>
            </TabsContent>
          )}
          {vizData!.citationNetwork.nodes.length > 0 && (
            <TabsContent value="citations">
              <Card>
                <CardContent className="pt-4 h-[400px]">
                  <VizCitations data={vizData!.citationNetwork} />
                </CardContent>
              </Card>
            </TabsContent>
          )}
          {vizData!.figures && vizData!.figures.length > 0 && (
            <TabsContent value="figures">
              <Card>
                <CardContent className="pt-4">
                  <VizFigures figures={vizData!.figures} />
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      )}

      {/* Table of contents */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
            Table of Contents
          </p>
          <nav className="space-y-1">
            {sections.map((sec) => (
              <a
                key={sec.id}
                href={`#section-${sec.id}`}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronRight className="h-3 w-3" />
                {sec.title}
              </a>
            ))}
            <a
              href="#bibliography"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronRight className="h-3 w-3" />
              Bibliography
            </a>
          </nav>
        </CardContent>
      </Card>

      {/* Sections */}
      {sections.map((sec) => (
        <div key={sec.id} id={`section-${sec.id}`} className="scroll-mt-20">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{sec.title}</h2>
              <Badge variant="outline" className="text-[10px]">
                {sec.sectionType}
              </Badge>
            </div>
            {sec.sectionType !== "introduction" && sec.sectionType !== "conclusion" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleRegenerate(sec.sectionType)}
                disabled={regenerating === sec.sectionType}
              >
                {regenerating === sec.sectionType ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                Regenerate
              </Button>
            )}
          </div>
          <Card>
            <CardContent className="pt-4 pb-4">
              <MarkdownRenderer
                content={processCitations(sec.content, paperMap)}
                className="text-sm"
              />
            </CardContent>
          </Card>
        </div>
      ))}

      {/* Bibliography */}
      <div id="bibliography" className="scroll-mt-20">
        <h2 className="text-lg font-semibold mb-2">Bibliography</h2>
        <Card>
          <CardContent className="pt-4 pb-4">
            <ol className="space-y-2 list-decimal list-inside text-sm">
              {papers.map((sp) => {
                const p = sp.paper;
                let authors = "";
                try {
                  authors = JSON.parse(p.authors || "[]").join(", ");
                } catch {
                  authors = p.authors || "";
                }
                return (
                  <li key={p.id}>
                    <Link
                      href={`/papers/${p.id}`}
                      className="text-primary hover:underline font-medium"
                    >
                      {p.title}
                    </Link>
                    {authors && (
                      <span className="text-muted-foreground"> — {authors}</span>
                    )}
                    {p.year && (
                      <span className="text-muted-foreground"> ({p.year})</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>
      </div>

      {/* Paper Discovery */}
      <SynthesisDiscover sessionId={sessionId} />
    </div>
  );
}
