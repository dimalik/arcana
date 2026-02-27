"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  Save,
  Trash2,
  FileText,
  Network,
  Link2,
  FlaskConical,
  BarChart3,
  ClipboardCheck,
  RefreshCw,
  Loader2,
  Pencil,
  X,
  Heart,
  Flame,
  Brain,
  ArrowLeft,
  Info,
  Lightbulb,
  Users,
  Building2,
  Fingerprint,
  ExternalLink,
  Tags as TagsIcon,
  XCircle,
  Clock,
  Sparkles,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { TagPicker } from "@/components/tags/tag-picker";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { ConceptMindmap } from "@/components/concepts/concept-mindmap";
import { PaperConnections } from "@/components/connections/paper-connections";
import { PaperChat } from "@/components/chat/paper-chat";
import { SelectionHighlighter } from "@/components/chat/selection-highlighter";
import { AnalysisHistory } from "@/components/history/analysis-history";
import { CrossPaperInsights } from "@/components/analysis/cross-paper-insights";
import { parseSummarySections } from "@/lib/papers/parse-sections";

interface Tag {
  id: string;
  name: string;
  color: string;
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
  isLiked: boolean;
  engagementScore: number;
  createdAt: string;
  updatedAt: string;
  tags: { tag: Tag }[];
  promptResults: PromptResult[];
}

const STEP_LABELS: Record<string, string> = {
  extracting_text: "Extracting text...",
  metadata: "Extracting metadata...",
  summarize: "Summarizing...",
  categorize: "Categorizing...",
  linking: "Finding related papers...",
  contradictions: "Detecting contradictions...",
  references: "Extracting references...",
  contexts: "Analyzing citations...",
  distill: "Distilling insights...",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Queued for processing...",
  EXTRACTING_TEXT: "Extracting text...",
  TEXT_EXTRACTED: "Waiting to process...",
};

function getProcessingLabel(paper: Paper): string {
  if (paper.processingStep && STEP_LABELS[paper.processingStep]) {
    return STEP_LABELS[paper.processingStep];
  }
  return STATUS_LABELS[paper.processingStatus] || paper.processingStatus;
}

function isStalled(paper: Paper): boolean {
  // If step is actively set and started > 3 min ago, it's stalled
  if (paper.processingStartedAt) {
    return Date.now() - new Date(paper.processingStartedAt).getTime() > 3 * 60 * 1000;
  }
  // If status is non-terminal but no step has ever started, check createdAt as fallback
  // (covers cases where queue hasn't picked it up in a long time)
  if (
    paper.processingStatus !== "COMPLETED" &&
    paper.processingStatus !== "FAILED" &&
    !paper.processingStep
  ) {
    return Date.now() - new Date(paper.updatedAt || paper.createdAt).getTime() > 5 * 60 * 1000;
  }
  return false;
}

type ViewTab =
  | "review"
  | "methodology"
  | "results"
  | "connections"
  | "analyze"
  | "concepts";

const viewTabs: { value: ViewTab; icon: typeof ClipboardCheck; label: string }[] = [
  { value: "review", icon: ClipboardCheck, label: "Review" },
  { value: "methodology", icon: FlaskConical, label: "Methodology" },
  { value: "results", icon: BarChart3, label: "Results" },
  { value: "connections", icon: Link2, label: "Connections" },
  { value: "analyze", icon: Sparkles, label: "Analyze" },
  { value: "concepts", icon: Network, label: "Concepts" },
];

export default function PaperDetailPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const initialConversationId = searchParams.get("conv") || undefined;
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeView, setActiveView] = useState<ViewTab>("review");
  const [relatedPaperMap, setRelatedPaperMap] = useState<Record<string, string>>({});
  const [editForm, setEditForm] = useState({
    title: "",
    abstract: "",
    authors: "",
    year: "",
    venue: "",
    doi: "",
  });

  const contentRef = useRef<HTMLDivElement>(null);

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
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= viewTabs.length) {
        setActiveView(viewTabs[idx - 1].value);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const fetchPaper = async () => {
    const res = await fetch(`/api/papers/${id}`);
    if (!res.ok) {
      toast.error("Paper not found");
      router.push("/papers");
      return;
    }
    const data = await res.json();
    setPaper(data);
    setEditForm({
      title: data.title || "",
      abstract: data.abstract || "",
      authors: data.authors ? JSON.parse(data.authors).join(", ") : "",
      year: data.year?.toString() || "",
      venue: data.venue || "",
      doi: data.doi || "",
    });
    setLoading(false);
  };

  useEffect(() => {
    fetchPaper();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!paper) return;
    if (paper.processingStatus === "COMPLETED" || paper.processingStatus === "FAILED") {
      return;
    }

    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/papers/${id}`);
        if (!res.ok) return;
        const data = await res.json();
        setPaper(data);
        setEditForm({
          title: data.title || "",
          abstract: data.abstract || "",
          authors: data.authors ? JSON.parse(data.authors).join(", ") : "",
          year: data.year?.toString() || "",
          venue: data.venue || "",
          doi: data.doi || "",
        });
      } catch {
        // Ignore fetch errors during polling
      }
    }, 3000);

    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper?.processingStatus, id]);

  // Fetch related paper titles for clickable links in Analyze tab
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/papers/${id}/relations`);
        if (res.ok) {
          const rels: { relatedPaper: { id: string; title: string } }[] = await res.json();
          const map: Record<string, string> = {};
          for (const r of rels) {
            map[r.relatedPaper.id] = r.relatedPaper.title;
          }
          setRelatedPaperMap(map);
        }
      } catch {
        // ignore
      }
    })();
  }, [id]);

  const processingStatus = paper?.processingStatus;
  useEffect(() => {
    if (
      reprocessing &&
      (processingStatus === "COMPLETED" || processingStatus === "FAILED")
    ) {
      setReprocessing(false);
    }
  }, [processingStatus, reprocessing]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/papers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editForm.title,
          abstract: editForm.abstract || undefined,
          authors: editForm.authors
            ? editForm.authors.split(",").map((a) => a.trim())
            : undefined,
          year: editForm.year ? parseInt(editForm.year) : undefined,
          venue: editForm.venue || undefined,
          doi: editForm.doi || undefined,
        }),
      });
      if (res.ok) {
        toast.success("Paper updated");
        setEditing(false);
        fetchPaper();
      }
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this paper permanently?")) return;
    await fetch(`/api/papers/${id}`, { method: "DELETE" });
    toast.success("Paper deleted");
    router.push("/papers");
  };

  const handleReprocess = async () => {
    setReprocessing(true);
    try {
      const res = await fetch(`/api/papers/${id}/reprocess`, {
        method: "POST",
      });
      if (res.ok) {
        toast.success("Reprocessing started");
        fetchPaper();
      } else {
        toast.error("Failed to start reprocessing");
        setReprocessing(false);
      }
    } catch {
      toast.error("Failed to start reprocessing");
      setReprocessing(false);
    }
  };

  const handleLikeToggle = async () => {
    const res = await fetch(`/api/papers/${id}/like`, { method: "PATCH" });
    if (res.ok && paper) {
      const { isLiked } = await res.json();
      setPaper({ ...paper, isLiked });
    }
  };

  const handleDistill = async () => {
    setDistilling(true);
    try {
      const res = await fetch(`/api/papers/${id}/distill`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        toast.success(`${data.created} insights extracted`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to distill insights");
      }
    } catch {
      toast.error("Failed to distill insights");
    } finally {
      setDistilling(false);
    }
  };

  // Track view engagement once on load
  useEffect(() => {
    fetch(`/api/papers/${id}/engage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "view" }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
    paper.processingStatus !== "FAILED";

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
      <div className="space-y-3">
        {/* ── Paper title bar ── */}
        <div className="flex items-center gap-2 min-w-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => router.back()}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-accent text-muted-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Back</TooltipContent>
          </Tooltip>

          <h1 className="truncate text-lg font-semibold">
            {paper.title}
            {paper.year && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({paper.year})
              </span>
            )}
          </h1>

          {/* Metadata popovers */}
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
                        <a
                          href={`https://doi.org/${paper.doi}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline break-all"
                        >
                          {paper.doi}
                        </a>
                      </div>
                    )}
                    {paper.arxivId && (
                      <div className="flex items-center gap-2">
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <a
                          href={`https://arxiv.org/abs/${paper.arxivId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
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
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {paper.abstract}
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

          {/* Tags */}
          {paper.tags.length > 0 && (
            <div className="flex items-center gap-1 shrink-0 ml-1">
              {paper.tags.slice(0, 3).map((pt) => (
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
              {paper.tags.length > 3 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/80">
                      <TagsIcon className="h-3 w-3" />
                      +{paper.tags.length - 3}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto" align="start">
                    <div className="flex flex-wrap gap-1.5">
                      {paper.tags.slice(3).map((pt) => (
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
        </div>

        {/* ── Toolbar: view icons (left) | action icons (right) ── */}
        <div className="flex items-center justify-between">
          {/* View switcher icons */}
          <div className="flex items-center gap-0.5">
            {viewTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <Tooltip key={tab.value}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setActiveView(tab.value)}
                      className={`inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                        activeView === tab.value
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{tab.label}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          {/* Action icons */}
          <div className="flex items-center gap-0.5">
            {(() => {
              const heat = paper.engagementScore <= 0 ? 0 : paper.engagementScore < 2 ? 1 : paper.engagementScore < 5 ? 2 : paper.engagementScore < 12 ? 3 : 4;
              const heatColors = ["", "text-blue-400", "text-yellow-500", "text-orange-500", "text-red-500"];
              return heat > 0 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex h-9 w-9 items-center justify-center">
                      <Flame className={`h-4 w-4 ${heatColors[heat]}`} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Engagement: {paper.engagementScore.toFixed(1)}</TooltipContent>
                </Tooltip>
              ) : null;
            })()}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleLikeToggle}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent"
                >
                  <Heart
                    className={`h-4 w-4 ${
                      paper.isLiked
                        ? "fill-red-500 text-red-500"
                        : "text-muted-foreground"
                    }`}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {paper.isLiked ? "Unlike" : "Like"}
              </TooltipContent>
            </Tooltip>

            {paper.filePath && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={`/api/papers/${id}/file`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent"
                  >
                    <FileText className="h-4 w-4 text-muted-foreground" />
                  </a>
                </TooltipTrigger>
                <TooltipContent>View PDF</TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleReprocess}
                  disabled={reprocessing}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent disabled:opacity-50"
                >
                  {reprocessing ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <RefreshCw className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {reprocessing ? "Processing..." : "Reprocess"}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleDistill}
                  disabled={distilling}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent disabled:opacity-50"
                >
                  {distilling ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <Brain className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {distilling ? "Distilling..." : "Distill insights"}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setHistoryOpen(true)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent"
                >
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Analysis history</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setEditing(!editing)}
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent ${
                    editing ? "bg-accent" : ""
                  }`}
                >
                  {editing ? (
                    <X className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {editing ? "Cancel editing" : "Edit metadata"}
              </TooltipContent>
            </Tooltip>

            <div className="mx-1 h-5 w-px bg-border" />

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleDelete}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Delete paper</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Processing status */}
        {(isProcessing || paper.processingStatus === "FAILED") && (
          <div className="flex items-center gap-1.5">
            {isProcessing && (
              <>
                <Badge variant="secondary" className="gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {getProcessingLabel(paper)}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/papers/${id}/cancel`, { method: "POST" });
                      if (res.ok) {
                        toast.success("Processing cancelled");
                        fetchPaper();
                      } else {
                        toast.error("Failed to cancel");
                      }
                    } catch {
                      toast.error("Failed to cancel");
                    }
                  }}
                >
                  <XCircle className="mr-1 h-3 w-3" />
                  Cancel
                </Button>
                {isStalled(paper) && (
                  <>
                    <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600">
                      Possibly stalled
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={async () => {
                        try {
                          const res = await fetch(`/api/papers/${id}/retry`, { method: "POST" });
                          if (res.ok) {
                            toast.success("Paper re-enqueued for processing");
                            fetchPaper();
                          } else {
                            toast.error("Failed to retry");
                          }
                        } catch {
                          toast.error("Failed to retry");
                        }
                      }}
                    >
                      <RefreshCw className="mr-1 h-3 w-3" />
                      Retry
                    </Button>
                  </>
                )}
              </>
            )}
            {paper.processingStatus === "FAILED" && (
              <Badge variant="destructive">Failed</Badge>
            )}
          </div>
        )}

        {/* ── Missing PDF banner ── */}
        {!paper.filePath && (paper.processingStatus === "COMPLETED" || paper.processingStatus === "PENDING") && (
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
        )}

        {/* ── Edit form (toggle) ── */}
        {editing && (
          <Card>
            <CardContent className="pt-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label>Title</Label>
                  <Input
                    value={editForm.title}
                    onChange={(e) =>
                      setEditForm({ ...editForm, title: e.target.value })
                    }
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label>Authors (comma-separated)</Label>
                  <Input
                    value={editForm.authors}
                    onChange={(e) =>
                      setEditForm({ ...editForm, authors: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label>Year</Label>
                  <Input
                    type="number"
                    value={editForm.year}
                    onChange={(e) =>
                      setEditForm({ ...editForm, year: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label>Venue</Label>
                  <Input
                    value={editForm.venue}
                    onChange={(e) =>
                      setEditForm({ ...editForm, venue: e.target.value })
                    }
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label>DOI</Label>
                  <Input
                    value={editForm.doi}
                    onChange={(e) =>
                      setEditForm({ ...editForm, doi: e.target.value })
                    }
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label>Abstract</Label>
                  <Textarea
                    rows={4}
                    value={editForm.abstract}
                    onChange={(e) =>
                      setEditForm({ ...editForm, abstract: e.target.value })
                    }
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label className="mb-2 block">Tags</Label>
                  <TagPicker
                    paperId={paper.id}
                    currentTags={paper.tags.map((pt) => pt.tag)}
                    onUpdate={fetchPaper}
                  />
                </div>
                <div className="sm:col-span-2 flex gap-2">
                  <Button onClick={handleSave} disabled={saving} size="sm">
                    <Save className="mr-2 h-3.5 w-3.5" />
                    {saving ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── View content ── */}
        <div ref={contentRef}>
          {activeView === "review" && (
            <>
              {paper.summary ? (
                <Card>
                  <CardContent className="pt-6">
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
                  <CardContent className="pt-6">
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
                  <CardContent className="pt-6">
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

          {activeView === "concepts" && (
            <ConceptMindmap
              paperId={paper.id}
              paperTitle={paper.title}
              hasText={!!(paper.fullText || paper.abstract)}
            />
          )}
        </div>

        <SelectionHighlighter paperId={paper.id} containerRef={contentRef} />

        <PaperChat
          paperId={paper.id}
          hasText={!!(paper.fullText || paper.abstract)}
          initialConversationId={initialConversationId}
        />

        <AnalysisHistory
          paperId={paper.id}
          promptResults={paper.promptResults}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          onRestore={fetchPaper}
        />
      </div>
    </TooltipProvider>
  );
}
