"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Plus,
  Trash2,
  Loader2,
  MoreVertical,
  FileDown,
  ChevronDown,
  ChevronUp,
  FileText,
  RefreshCw,
  ArrowLeft,
} from "lucide-react";
import { PaperSelector } from "@/components/synthesis/paper-selector";
import { toast } from "sonner";

interface SynthesisSession {
  id: string;
  title: string;
  description: string | null;
  status: string;
  phase: string | null;
  progress: number;
  paperCount: number;
  depth: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  papers: { paper: { title: string } }[];
}

export default function SynthesisPage() {
  const [sessions, setSessions] = useState<SynthesisSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState<string | null>(null);
  const [regeneratingTitle, setRegeneratingTitle] = useState<string | null>(null);
  const [loadingPapers, setLoadingPapers] = useState<string | null>(null);

  const fetchSessions = () => {
    fetch("/api/synthesis")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setSessions(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      const res = await fetch(`/api/synthesis/${id}`, { method: "DELETE" });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        toast.success("Synthesis deleted");
      } else {
        toast.error("Failed to delete");
      }
    } catch {
      toast.error("Failed to delete");
    } finally {
      setDeleting(null);
    }
  };

  const handleExportPdf = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setExporting(id);
    try {
      const res = await fetch(`/api/synthesis/${id}/export?format=pdf`);
      if (!res.ok) {
        toast.error("Export failed");
        return;
      }
      const contentType = res.headers.get("Content-Type") || "";
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] || "synthesis.pdf";

      if (contentType.includes("x-tex")) {
        toast.info("pdflatex unavailable — downloading .tex instead");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting(null);
    }
  };

  const handleRegenerateTitle = async (id: string) => {
    setRegeneratingTitle(id);
    try {
      const res = await fetch(`/api/synthesis/${id}`, { method: "PATCH" });
      if (res.ok) {
        const { title, description } = await res.json();
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, title, description: description ?? s.description } : s))
        );
        toast.success("Title regenerated");
      } else {
        toast.error("Failed to regenerate title");
      }
    } catch {
      toast.error("Failed to regenerate title");
    } finally {
      setRegeneratingTitle(null);
    }
  };

  const handleLoadAllPapers = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setLoadingPapers(id);
    try {
      const res = await fetch(`/api/synthesis/${id}`);
      if (res.ok) {
        const data = await res.json();
        const allPapers = data.papers?.map((sp: { paper: { title: string } }) => ({
          paper: { title: sp.paper.title },
        })) || [];
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, papers: allPapers } : s))
        );
      }
    } catch {
      toast.error("Failed to load papers");
    } finally {
      setLoadingPapers(null);
    }
  };

  const toggleExpand = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (showCreate) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreate(false)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-sm font-medium">New Synthesis</h1>
        </div>
        <PaperSelector />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Research Reviews</span>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          title="New synthesis"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No syntheses yet
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sessions.map((s) => {
            const isRunning = ["PENDING", "PLANNING", "MAPPING", "GRAPHING", "EXPANDING", "REDUCING", "COMPOSING"].includes(s.status);
            const isComplete = s.status === "COMPLETED";
            const percent = Math.round(s.progress * 100);
            const isExpanded = expanded.has(s.id);

            return (
              <Card key={s.id} className="group relative">
                <CardContent className="py-3">
                  <div className="min-w-0">
                    {/* Title row */}
                    <div className="mb-1 pr-16">
                      <Link
                        href={`/synthesis/${s.id}`}
                        className="font-medium text-sm hover:underline"
                      >
                        {s.title}
                      </Link>
                    </div>

                    {/* Description or meta row */}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {s.description ? (
                        <span>{s.description}</span>
                      ) : (
                        <>
                          <span>{s.paperCount} papers</span>
                          <span>({new Date(s.createdAt).toLocaleDateString()})</span>
                        </>
                      )}
                      {s.depth !== "balanced" && <span>{s.depth}</span>}
                      {isRunning && (
                        <span className="text-blue-500">{s.phase || s.status}</span>
                      )}
                      {s.status === "GUIDING" && (
                        <span className="text-indigo-500">awaiting guidance</span>
                      )}
                      {s.status === "FAILED" && (
                        <span className="text-destructive">failed</span>
                      )}
                      {s.status === "CANCELLED" && (
                        <span className="text-muted-foreground">cancelled</span>
                      )}
                    </div>

                    {/* Progress bar for running */}
                    {isRunning && (
                      <div className="mt-1.5">
                        <div className="h-1 rounded-full bg-muted overflow-hidden w-40">
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {s.error && (
                      <p className="text-xs text-destructive mt-1 truncate">{s.error}</p>
                    )}

                    {/* Expandable papers list */}
                    {s.papers.length > 0 && (
                      <>
                        <button
                          onClick={(e) => toggleExpand(e, s.id)}
                          className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
                        >
                          {isExpanded ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )}
                          {isExpanded ? "Hide" : "Show"} papers
                        </button>
                        {isExpanded && (
                          <div className="mt-1.5 rounded-md bg-muted/50 border border-border/50 px-2.5 py-2 space-y-1">
                            {s.papers.map((p, i) => (
                              <div key={i} className="flex items-start gap-1.5">
                                <FileText className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground/50" />
                                <p className="text-[11px] text-foreground/70 leading-snug">
                                  {p.paper.title}
                                </p>
                              </div>
                            ))}
                            {s.paperCount > s.papers.length && (
                              <button
                                onClick={(e) => handleLoadAllPapers(e, s.id)}
                                disabled={loadingPapers === s.id}
                                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground pl-4.5 transition-colors flex items-center gap-1"
                              >
                                {loadingPapers === s.id ? (
                                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                ) : null}
                                + {s.paperCount - s.papers.length} more
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* Action buttons — top right */}
                  <div className="absolute top-2 right-2 flex items-center gap-0.5">
                    {/* PDF export */}
                    {isComplete && (
                      <button
                        onClick={(e) => handleExportPdf(e, s.id)}
                        disabled={exporting === s.id}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        title="Export PDF"
                      >
                        {exporting === s.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <FileDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}

                    {/* Three-dot menu */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                          title="More actions"
                          onClick={(e) => e.preventDefault()}
                        >
                          <MoreVertical className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="w-44 p-1 [&_[role=menuitem]]:px-2.5 [&_[role=menuitem]]:py-1.5 [&_[role=menuitem]]:gap-2 [&_[role=menuitem]]:text-xs"
                      >
                        <DropdownMenuItem
                          onClick={() => handleRegenerateTitle(s.id)}
                          disabled={regeneratingTitle === s.id}
                        >
                          {regeneratingTitle === s.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" />
                          )}
                          Regenerate title
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => handleDelete(s.id)}
                          disabled={deleting === s.id}
                          className="text-destructive focus:text-destructive"
                        >
                          {deleting === s.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
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
      )}
    </div>
  );
}
