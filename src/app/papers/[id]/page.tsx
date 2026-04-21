"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Trash2,
  FileText,
  Link2,
  FlaskConical,
  BarChart3,
  ClipboardCheck,
  RefreshCw,
  Loader2,
  Pencil,
  X,
  Heart,
  Info,
  Lightbulb,
  Users,
  Building2,
  Fingerprint,
  ExternalLink,
  Clock,
  Sparkles,
  Upload,
  MoreHorizontal,
  GripVertical,
  Search,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { PaperConnections } from "@/components/connections/paper-connections";
import { PaperChat } from "@/components/chat/paper-chat";
import { SelectionHighlighter } from "@/components/chat/selection-highlighter";
import { AnalysisHistory } from "@/components/history/analysis-history";
import { CrossPaperInsights } from "@/components/analysis/cross-paper-insights";
import { parseSummarySections } from "@/lib/papers/parse-sections";
import { usePageInfo } from "@/components/layout/theme-context";
import { RightPanel } from "@/components/paper-detail/right-panel";
import { PdfViewer } from "@/components/paper-detail/pdf-viewer";
import { SectionRewriter } from "@/components/paper-detail/section-rewriter";
import { MetadataDialog } from "@/components/paper-detail/metadata-dialog";
import { getProcessingStatusDisplay } from "@/lib/processing/status-display";

interface Tag {
  id: string;
  name: string;
  color: string;
  score?: number;
}

interface PromptResult {
  id: string;
  promptType: string;
  prompt: string;
  result: string;
  provider: string | null;
  model: string | null;
  createdAt: string;
}

interface Paper {
  id: string;
  title: string;
  abstract: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  sourceType: string;
  sourceUrl: string | null;
  arxivId: string | null;
  filePath: string | null;
  fullText: string | null;
  summary: string | null;
  keyFindings: string | null;
  categories: string | null;
  processingStatus: string;
  processingStep: string | null;
  processingStartedAt: string | null;
  referenceState: string;
  duplicateState?: "active" | "hidden" | "archived" | "collapsed";
  collapsedIntoPaperId?: string | null;
  isLiked: boolean;
  engagementScore: number;
  createdAt: string;
  updatedAt: string;
  tags: { tag: Tag }[];
  promptResults: PromptResult[];
}

type ViewTab =
  | "review"
  | "methodology"
  | "results"
  | "connections"
  | "analyze";

const viewTabs: { value: ViewTab; icon: typeof ClipboardCheck; label: string }[] = [
  { value: "review", icon: ClipboardCheck, label: "Review" },
  { value: "methodology", icon: FlaskConical, label: "Methodology" },
  { value: "results", icon: BarChart3, label: "Results" },
  { value: "connections", icon: Link2, label: "Connections" },
  { value: "analyze", icon: Sparkles, label: "Analyze" },
];

export default function PaperDetailPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const initialConversationId = searchParams.get("conv") || undefined;
  const requestedView = searchParams.get("view");
  const requestedPdfPage = (() => {
    const raw = searchParams.get("page");
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  })();
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [reprocessing, setReprocessing] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(() => {
    if (typeof window === "undefined") return 380;
    return parseInt(localStorage.getItem("paper-chat-width") || "380") || 380;
  });

  // Listen for chat width changes from the resize handle
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "paper-chat-width" && e.newValue) setChatWidth(parseInt(e.newValue) || 380);
    };
    window.addEventListener("storage", onStorage);
    // Also poll for same-tab changes (storage event only fires cross-tab)
    if (!chatOpen) return;
    const interval = setInterval(() => {
      const w = parseInt(localStorage.getItem("paper-chat-width") || "380") || 380;
      setChatWidth((prev) => prev !== w ? w : prev);
    }, 100);
    return () => { window.removeEventListener("storage", onStorage); clearInterval(interval); };
  }, [chatOpen]);
  const [locatingPdf, setLocatingPdf] = useState(false);
  const [activeView, setActiveView] = useState<ViewTab>("review");
  const [relatedPaperMap, setRelatedPaperMap] = useState<Record<string, string>>({});
  const [pdfVisible, setPdfVisible] = useState(
    () => searchParams.get("pdf") === "1" || Boolean(requestedPdfPage),
  );
  const [splitRatio, setSplitRatio] = useState(50);
  const [duplicateBannerBusy, setDuplicateBannerBusy] = useState(false);
  const processingDisplay = paper
    ? getProcessingStatusDisplay({
        processingStatus: paper.processingStatus,
        processingStep: paper.processingStep,
        referenceState: paper.referenceState,
      })
    : null;
  const editForm = {
    title: paper?.title || "",
    abstract: paper?.abstract || "",
    authors: paper?.authors ? (() => { try { return JSON.parse(paper.authors).join(", "); } catch { return paper.authors; } })() : "",
    year: paper?.year?.toString() || "",
    venue: paper?.venue || "",
    doi: paper?.doi || "",
  };

  const contentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const { setPageInfo } = usePageInfo();

  // Number key hotkeys: 1-6 switch view tabs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }
      if (e.key === "Escape") {
        if (pdfVisible) {
          setPdfVisible(false);
        }
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        setPdfVisible((v) => !v);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "l") {
        fetch(`/api/papers/${id}/like`, { method: "PATCH" })
          .then((r) => r.ok ? r.json() : null)
          .then((data) => data && setPaper((prev) => prev ? { ...prev, isLiked: data.isLiked } : prev));
        return;
      }
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= viewTabs.length) {
        setActiveView(viewTabs[idx - 1].value);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfVisible]);


  const handlePdfToggle = () => {
    setPdfVisible((v) => !v);
  };

  const handleDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startRatio = splitRatio;
    const container = dividerRef.current?.parentElement;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const newRatio = startRatio + (dx / containerWidth) * 100;
      setSplitRatio(Math.min(80, Math.max(20, newRatio)));
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const fetchPaper = async (options?: { suppressMissingToast?: boolean }) => {
    const res = await fetch(`/api/papers/${id}`);
    if (!res.ok) {
      if (!options?.suppressMissingToast) {
        toast.error("Paper not found");
      }
      router.push("/papers");
      return;
    }
    const data = await res.json();
    const duplicateState =
      res.headers.get("X-Paper-Duplicate-State")
      || data.duplicateState
      || "active";
    const collapsedIntoPaperId =
      res.headers.get("X-Paper-Collapsed-Into-Paper-Id")
      || data.collapsedIntoPaperId
      || null;

    if (duplicateState === "collapsed" && collapsedIntoPaperId && collapsedIntoPaperId !== id) {
      router.replace(`/papers/${collapsedIntoPaperId}`);
      return;
    }

    setPaper({
      ...data,
      duplicateState,
      collapsedIntoPaperId,
    });
    setLoading(false);
  };

  useEffect(() => {
    fetchPaper();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (requestedView && viewTabs.some((tab) => tab.value === requestedView)) {
      setActiveView(requestedView as ViewTab);
    }

    if (searchParams.get("pdf") === "1" || requestedPdfPage) {
      setPdfVisible(true);
    }
  }, [requestedPdfPage, requestedView, searchParams]);

  useEffect(() => {
    if (!paper) return;
    if (paper.processingStatus === "COMPLETED" || paper.processingStatus === "FAILED" || paper.processingStatus === "NO_PDF") {
      return;
    }

    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/papers/${id}`);
        if (!res.ok) return;
        const data = await res.json();
        const duplicateState =
          res.headers.get("X-Paper-Duplicate-State")
          || data.duplicateState
          || "active";
        const collapsedIntoPaperId =
          res.headers.get("X-Paper-Collapsed-Into-Paper-Id")
          || data.collapsedIntoPaperId
          || null;
        if (duplicateState === "collapsed" && collapsedIntoPaperId && collapsedIntoPaperId !== id) {
          router.replace(`/papers/${collapsedIntoPaperId}`);
          return;
        }
        setPaper({
          ...data,
          duplicateState,
          collapsedIntoPaperId,
        });
      } catch {
        // Ignore fetch errors during polling
      }
    }, 3000);

    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper?.processingStatus, id]);

  // Fetch related paper titles lazily when Analyze is opened.
  useEffect(() => {
    if (activeView !== "analyze") return;
    if (Object.keys(relatedPaperMap).length > 0) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/papers/${id}/relations`);
        if (res.ok) {
          const rels: { relatedPaper: { id: string; title: string } }[] = await res.json();
          const map: Record<string, string> = {};
          for (const r of rels) {
            map[r.relatedPaper.id] = r.relatedPaper.title;
          }
          if (!cancelled) {
            setRelatedPaperMap(map);
          }
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeView, id, relatedPaperMap]);

  const processingStatus = paper?.processingStatus;
  useEffect(() => {
    setRelatedPaperMap({});
  }, [id]);

  useEffect(() => {
    if (
      reprocessing &&
      (processingStatus === "COMPLETED" || processingStatus === "FAILED")
    ) {
      setReprocessing(false);
    }
  }, [processingStatus, reprocessing]);

  // Track view engagement once on load
  useEffect(() => {
    fetch(`/api/papers/${id}/engage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "view" }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Push paper info into clean topbar
  useEffect(() => {
    if (!paper) return;
    const authors: string[] = paper.authors ? JSON.parse(paper.authors) : [];
    const keyFindings: string[] = paper.keyFindings ? JSON.parse(paper.keyFindings) : [];
    const tags = [...(paper.tags ?? [])].sort(
      (a, b) => (b.tag.score ?? 0) - (a.tag.score ?? 0)
    );
    const hasMetadata = authors.length > 0 || paper.venue || paper.doi || paper.arxivId;

    setPageInfo({
      title: paper.title + (paper.year ? ` (${paper.year})` : ""),
      meta: (
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
                  {paper.venue && (
                    <div className="flex items-center gap-2">
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span>{paper.venue}</span>
                    </div>
                  )}
                  {paper.doi && (
                    <div className="flex items-center gap-2">
                      <Fingerprint className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">
                        {paper.doi}
                      </a>
                    </div>
                  )}
                  {paper.arxivId && (
                    <div className="flex items-center gap-2">
                      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <a href={`https://arxiv.org/abs/${paper.arxivId}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        arXiv:{paper.arxivId}
                      </a>
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}
          {paper.abstract && (
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
                <p className="text-sm leading-relaxed text-muted-foreground">{paper.abstract}</p>
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
                    <li key={i} className="flex gap-2.5 text-sm text-muted-foreground leading-relaxed">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500/50" />
                      {finding}
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
          {tags.length > 0 && (
            <div className="flex items-center gap-1 ml-1">
              {tags.slice(0, 3).map((pt) => (
                <span
                  key={pt.tag.id}
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{ backgroundColor: pt.tag.color + "20", color: pt.tag.color }}
                >
                  {pt.tag.name}
                </span>
              ))}
              {tags.length > 3 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-xs text-muted-foreground cursor-default">+{tags.length - 3}</span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="flex flex-col gap-1 bg-popover text-popover-foreground border shadow-md">
                    {tags.slice(3).map((pt) => (
                      <span
                        key={pt.tag.id}
                        className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                        style={{ backgroundColor: pt.tag.color + "20", color: pt.tag.color }}
                      >
                        {pt.tag.name}
                      </span>
                    ))}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
          {/* Processing status — minimal inline */}
          {processingDisplay?.label && (
            <span
              className={`ml-1 flex items-center gap-1 text-xs ${
                processingDisplay.tone === "danger"
                  ? "text-destructive"
                  : processingDisplay.tone === "warning"
                    ? "text-amber-500"
                    : "text-muted-foreground"
              }`}
            >
              {processingDisplay.showSpinner && (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              {processingDisplay.label}
            </span>
          )}
        </div>
      ),
      actions: (
        <div className="flex items-center gap-0.5">
          {/* Like */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  fetch(`/api/papers/${id}/like`, { method: "PATCH" })
                    .then((res) => res.ok ? res.json() : null)
                    .then((data) => data && setPaper((prev) => prev ? { ...prev, isLiked: data.isLiked } : prev));
                }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
              >
                <Heart className={`h-4 w-4 ${paper.isLiked ? "fill-red-500 text-red-500" : "text-muted-foreground"}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{paper.isLiked ? "Unlike" : "Like"}</TooltipContent>
          </Tooltip>

          {/* PDF toggle */}
          {paper.filePath && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handlePdfToggle}
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent ${
                    pdfVisible ? "bg-accent text-foreground" : ""
                  }`}
                >
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{pdfVisible ? "Hide PDF" : "View PDF"}</TooltipContent>
            </Tooltip>
          )}

          {/* Overflow menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => { setReprocessing(true); fetch(`/api/papers/${id}/reprocess`, { method: "POST" }).then((r) => { if (r.ok) { toast.success("Reprocessing started"); fetchPaper(); } else { setReprocessing(false); } }); }}>
                <RefreshCw className="h-4 w-4" />
                Reprocess
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setMetadataOpen(true)}>
                <Pencil className="h-4 w-4" />
                Metadata
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
                <Clock className="h-4 w-4" />
                Analysis history
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => {
                  if (!confirm("Delete this paper permanently?")) return;
                  fetch(`/api/papers/${id}`, { method: "DELETE" }).then(() => {
                    toast.success("Paper deleted");
                    router.push("/papers");
                  });
                }}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    });

    return () => setPageInfo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper, pdfVisible, setPageInfo]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!paper) return null;

  const isProcessing =
    paper.processingStatus !== "COMPLETED" &&
    paper.processingStatus !== "FAILED" &&
    paper.processingStatus !== "NO_PDF";

  const authors: string[] = paper.authors
    ? JSON.parse(paper.authors)
    : [];
  const keyFindings: string[] = paper.keyFindings
    ? JSON.parse(paper.keyFindings)
    : [];
  const hasMetadata =
    authors.length > 0 || paper.venue || paper.doi || paper.arxivId;

  return (
    <TooltipProvider>
      <div
        className="flex flex-col h-[calc(100vh-48px)] overflow-hidden transition-[margin-right] duration-200 -my-5"
        style={{ marginRight: chatOpen ? chatWidth : 0 }}
      >
        {(paper.duplicateState === "hidden" || paper.duplicateState === "archived") && (
          <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/30">
            <Info className="h-5 w-5 shrink-0 text-slate-600" />
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                This paper is {paper.duplicateState}
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                The paper remains readable, but it is hidden from active discovery surfaces until restored.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={duplicateBannerBusy}
              onClick={async () => {
                setDuplicateBannerBusy(true);
                try {
                  const res = await fetch(`/api/papers/${id}/duplicate-state`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ duplicateState: "ACTIVE" }),
                  });
                  if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    toast.error(data.error || "Failed to restore paper");
                    return;
                  }
                  toast.success("Paper restored");
                  fetchPaper({ suppressMissingToast: true });
                } catch {
                  toast.error("Failed to restore paper");
                } finally {
                  setDuplicateBannerBusy(false);
                }
              }}
            >
              {duplicateBannerBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Restore
            </Button>
          </div>
        )}

        {/* ── Missing PDF banner ── */}
        {paper.referenceState === "unavailable_no_pdf" && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/30">
            <FileText className="h-5 w-5 shrink-0 text-amber-600" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                No PDF attached
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {paper.abstract
                  ? "Summaries were generated from the abstract only. Attach a PDF for full analysis."
                  : "Attach a PDF to enable text extraction and analysis."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {(paper.doi || paper.arxivId) && (
                <button
                  onClick={async () => {
                    setLocatingPdf(true);
                    try {
                      const res = await fetch(`/api/papers/${id}/locate-pdf`, {
                        method: "POST",
                      });
                      if (res.ok) {
                        toast.success("PDF found — processing started");
                        fetchPaper();
                      } else {
                        const data = await res.json();
                        toast.error(data.error || "Could not find PDF online");
                      }
                    } catch {
                      toast.error("Failed to locate PDF");
                    } finally {
                      setLocatingPdf(false);
                    }
                  }}
                  disabled={locatingPdf}
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-300 dark:hover:bg-amber-950"
                >
                  {locatingPdf ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  {locatingPdf ? "Searching..." : "Locate PDF online"}
                </button>
              )}
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const formData = new FormData();
                    formData.append("file", file);
                    try {
                      const res = await fetch(`/api/papers/${id}/file`, {
                        method: "POST",
                        body: formData,
                      });
                      if (res.ok) {
                        toast.success("PDF attached — processing started");
                        fetchPaper();
                      } else {
                        const data = await res.json();
                        toast.error(data.error || "Failed to attach PDF");
                      }
                    } catch {
                      toast.error("Failed to upload PDF");
                    }
                    e.target.value = "";
                  }}
                />
                <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700">
                  <Upload className="h-3.5 w-3.5" />
                  Attach PDF
                </span>
              </label>
            </div>
          </div>
        )}

        {/* ── View content ── */}
        {pdfVisible ? (
          <div className="flex flex-1 min-h-0">
            <div
              ref={scrollContainerRef}
              className="min-h-0 overflow-y-auto relative py-4"
              style={{ width: `${splitRatio}%` }}
            >
              <div ref={contentRef} className="prose-readable">
                {activeView === "review" && (
                  <>
                    {paper.summary ? (
                      <Card>
                        <CardContent className="pt-6 relative">
                          <div className="absolute top-6 right-4 z-10">
                            <SectionRewriter paperId={paper.id} section="review" onRewritten={fetchPaper} />
                          </div>
                          <MarkdownRenderer
                            content={parseSummarySections(paper.summary).overview}
                            className="text-sm"
                          />
                        </CardContent>
                      </Card>
                    ) : (
                      <Card>
                        <CardContent className="py-8 text-center text-muted-foreground">
                          {isProcessing
                            ? "Processing... review will appear when ready"
                            : "No review available"}
                        </CardContent>
                      </Card>
                    )}
                  </>
                )}

                {activeView === "methodology" && (
                  <>
                    {paper.summary &&
                    parseSummarySections(paper.summary).methodology ? (
                      <Card>
                        <CardContent className="pt-6 relative">
                          <div className="absolute top-6 right-4 z-10">
                            <SectionRewriter paperId={paper.id} section="methodology" onRewritten={fetchPaper} />
                          </div>
                          <MarkdownRenderer
                            content={parseSummarySections(paper.summary).methodology}
                            className="text-sm"
                          />
                        </CardContent>
                      </Card>
                    ) : (
                      <Card>
                        <CardContent className="py-8 text-center text-muted-foreground">
                          {isProcessing
                            ? "Processing... methodology will appear when ready"
                            : "No methodology section available"}
                        </CardContent>
                      </Card>
                    )}
                  </>
                )}

                {activeView === "results" && (
                  <>
                    {paper.summary &&
                    parseSummarySections(paper.summary).results ? (
                      <Card>
                        <CardContent className="pt-6 relative">
                          <div className="absolute top-6 right-4 z-10">
                            <SectionRewriter paperId={paper.id} section="results" onRewritten={fetchPaper} />
                          </div>
                          <MarkdownRenderer
                            content={parseSummarySections(paper.summary).results}
                            className="text-sm"
                          />
                        </CardContent>
                      </Card>
                    ) : (
                      <Card>
                        <CardContent className="py-8 text-center text-muted-foreground">
                          {isProcessing
                            ? "Processing... results will appear when ready"
                            : "No results section available"}
                        </CardContent>
                      </Card>
                    )}
                  </>
                )}

                {activeView === "connections" && (
                  <PaperConnections
                    paperId={paper.id}
                    paperTitle={paper.title}
                  />
                )}

                {activeView === "analyze" && (
                  <CrossPaperInsights
                    paperId={paper.id}
                    promptResults={paper.promptResults}
                    onUpdate={fetchPaper}
                    relatedPapers={relatedPaperMap}
                  />
                )}

              </div>
            </div>
            {/* Draggable divider */}
            <div
              ref={dividerRef}
              onMouseDown={handleDividerMouseDown}
              className="flex w-2 cursor-col-resize items-center justify-center hover:bg-accent transition-colors shrink-0"
            >
              <GripVertical className="h-4 w-4 text-muted-foreground/50" />
            </div>
            <div style={{ width: `${100 - splitRatio}%` }} className="min-h-0">
              <PdfViewer
                paperId={paper.id}
                showOpenInNewTab
                fitSignal={chatOpen ? 1 : 0}
                targetPage={requestedPdfPage}
              />
            </div>
          </div>
        ) : (
          <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto relative py-4">
          <div ref={contentRef} className="prose-readable">
            {activeView === "review" && (
              <>
                {paper.summary ? (
                  <Card>
                    <CardContent className="pt-6 relative">
                      <div className="absolute top-6 right-4 z-10">
                        <SectionRewriter paperId={paper.id} section="review" onRewritten={fetchPaper} />
                      </div>
                      <MarkdownRenderer
                        content={parseSummarySections(paper.summary).overview}
                        className="text-sm"
                      />
                    </CardContent>
                  </Card>
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      {isProcessing
                        ? "Processing... review will appear when ready"
                        : "No review available"}
                    </CardContent>
                  </Card>
                )}
              </>
            )}

            {activeView === "methodology" && (
              <>
                {paper.summary &&
                parseSummarySections(paper.summary).methodology ? (
                  <Card>
                    <CardContent className="pt-6 relative">
                      <div className="absolute top-6 right-4 z-10">
                        <SectionRewriter paperId={paper.id} section="methodology" onRewritten={fetchPaper} />
                      </div>
                      <MarkdownRenderer
                        content={parseSummarySections(paper.summary).methodology}
                        className="text-sm"
                      />
                    </CardContent>
                  </Card>
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      {isProcessing
                        ? "Processing... methodology will appear when ready"
                        : "No methodology section available"}
                    </CardContent>
                  </Card>
                )}
              </>
            )}

            {activeView === "results" && (
              <>
                {paper.summary &&
                parseSummarySections(paper.summary).results ? (
                  <Card>
                    <CardContent className="pt-6 relative">
                      <div className="absolute top-6 right-4 z-10">
                        <SectionRewriter paperId={paper.id} section="results" onRewritten={fetchPaper} />
                      </div>
                      <MarkdownRenderer
                        content={parseSummarySections(paper.summary).results}
                        className="text-sm"
                      />
                    </CardContent>
                  </Card>
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      {isProcessing
                        ? "Processing... results will appear when ready"
                        : "No results section available"}
                    </CardContent>
                  </Card>
                )}
              </>
            )}

            {activeView === "connections" && (
              <PaperConnections
                paperId={paper.id}
                paperTitle={paper.title}
              />
            )}

            {activeView === "analyze" && (
              <CrossPaperInsights
                paperId={paper.id}
                promptResults={paper.promptResults}
                onUpdate={fetchPaper}
                relatedPapers={relatedPaperMap}
              />
            )}

          </div>
          </div>
        )}

        <SelectionHighlighter paperId={paper.id} containerRef={contentRef} scrollContainerRef={scrollContainerRef} />

        <RightPanel
          activeView={activeView}
          onViewChange={setActiveView}
          chatOpen={chatOpen}
          onChatToggle={() => setChatOpen((o) => !o)}
        />
        <PaperChat
          paperId={paper.id}
          hasText={!!(paper.fullText || paper.abstract)}
          initialConversationId={initialConversationId}
          docked
          dockedOpen={chatOpen}
          onDockedToggle={() => setChatOpen((o) => !o)}
          scrollContainerRef={scrollContainerRef}
        />

        <AnalysisHistory
          paperId={paper.id}
          promptResults={paper.promptResults}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          onRestore={fetchPaper}
        />

        <MetadataDialog
          open={metadataOpen}
          onOpenChange={setMetadataOpen}
          paperId={paper.id}
          initial={editForm}
          tags={paper.tags.map((pt) => pt.tag)}
          onSaved={fetchPaper}
        />
      </div>
    </TooltipProvider>
  );
}
