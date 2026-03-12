"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ChevronDown, ChevronUp, FileText, Brain, Trash2,
  FolderOpen, File, Download, Eye, X, RefreshCw,
  Image, FileCode, FileSpreadsheet, FileType,
} from "lucide-react";

interface ContextSidebarProps {
  project: {
    id: string;
    brief: string;
    methodology: string | null;
    currentPhase: string;
  };
  papers: { id: string; title: string }[];
  hypotheses: { id: string; statement: string; status: string }[];
  iteration: { number: number; goal: string; steps: { status: string }[] } | null;
}

const STATUS_DOT: Record<string, string> = {
  PROPOSED: "bg-amber-500",
  TESTING: "bg-blue-500",
  SUPPORTED: "bg-emerald-500",
  REFUTED: "bg-red-500",
  REVISED: "bg-purple-500",
};

interface AgentMemory {
  id: string;
  category: string;
  lesson: string;
  usageCount: number;
}

interface FileEntry {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  modified: string;
  children?: FileEntry[];
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50MB

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "svg"].includes(ext || "")) return <Image className="h-3 w-3 shrink-0" />;
  if (["py", "sh", "r", "js", "ts"].includes(ext || "")) return <FileCode className="h-3 w-3 shrink-0" />;
  if (["csv", "tsv", "xlsx"].includes(ext || "")) return <FileSpreadsheet className="h-3 w-3 shrink-0" />;
  if (["json", "yaml", "yml", "toml"].includes(ext || "")) return <FileType className="h-3 w-3 shrink-0" />;
  return <File className="h-3 w-3 shrink-0" />;
}

function isPreviewable(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  return ["py", "txt", "log", "md", "json", "csv", "html", "sh", "yaml", "yml", "toml", "cfg", "ini", "r"].includes(ext || "");
}

export function ContextSidebar({ project, papers, hypotheses, iteration }: ContextSidebarProps) {
  const [briefExpanded, setBriefExpanded] = useState(false);
  const [papersExpanded, setPapersExpanded] = useState(false);
  const [memoriesExpanded, setMemoriesExpanded] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(true);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string } | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [downloadConfirm, setDownloadConfirm] = useState<{ path: string; name: string; size: number } | null>(null);

  useEffect(() => {
    fetch("/api/research/memories")
      .then((r) => r.ok ? r.json() : [])
      .then(setMemories)
      .catch(() => {});
  }, []);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const res = await fetch(`/api/research/${project.id}/files`);
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files || []);
      }
    } catch {
      // Non-critical
    } finally {
      setFilesLoading(false);
    }
  }, [project.id]);

  // Load files on mount and poll every 15s
  useEffect(() => {
    loadFiles();
    const interval = setInterval(loadFiles, 15000);
    return () => clearInterval(interval);
  }, [loadFiles]);

  const deleteMemory = async (id: string) => {
    await fetch("/api/research/memories", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setMemories((m) => m.filter((mem) => mem.id !== id));
  };

  const openPreview = async (filePath: string, fileName: string) => {
    setPreviewFile({ path: filePath, name: fileName });
    setPreviewLoading(true);
    setPreviewContent(null);
    setPreviewTruncated(false);
    try {
      const res = await fetch(
        `/api/research/${project.id}/files/download?path=${encodeURIComponent(filePath)}&preview=true`
      );
      if (res.ok) {
        const data = await res.json();
        setPreviewContent(data.content);
        setPreviewTruncated(data.truncated);
      } else {
        setPreviewContent("Failed to load file.");
      }
    } catch {
      setPreviewContent("Failed to load file.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const downloadFile = (filePath: string, fileName: string, size: number) => {
    if (size > LARGE_FILE_THRESHOLD) {
      setDownloadConfirm({ path: filePath, name: fileName, size });
      return;
    }
    doDownload(filePath, fileName);
  };

  const doDownload = (filePath: string, fileName: string) => {
    setDownloadConfirm(null);
    const url = `/api/research/${project.id}/files/download?path=${encodeURIComponent(filePath)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
  };

  const brief = (() => {
    try { return JSON.parse(project.brief); } catch { return {}; }
  })();

  const completedSteps = iteration?.steps.filter((s) => s.status === "COMPLETED").length || 0;
  const totalSteps = iteration?.steps.length || 0;

  // Count total files recursively
  const countFiles = (entries: FileEntry[]): number =>
    entries.reduce((sum, e) => sum + (e.isDir ? countFiles(e.children || []) : 1), 0);
  const totalFiles = countFiles(files);

  return (
    <div className="h-full flex flex-col overflow-auto">
      <div className="px-3 py-2 border-b border-border">
        <span className="text-[11px] font-medium text-muted-foreground">Context</span>
      </div>

      <div className="flex-1 px-3 py-2 space-y-3">
        {/* Files */}
        <div>
          <div className="flex items-center w-full">
            <button
              onClick={() => setFilesExpanded(!filesExpanded)}
              className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground flex-1"
            >
              {filesExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              <FolderOpen className="h-3 w-3" />
              Files {totalFiles > 0 && `(${totalFiles})`}
            </button>
            {filesExpanded && (
              <button
                onClick={loadFiles}
                disabled={filesLoading}
                className="text-[9px] text-muted-foreground/50 hover:text-muted-foreground flex items-center gap-0.5 transition-colors shrink-0"
              >
                <RefreshCw className={`h-2.5 w-2.5 ${filesLoading ? "animate-spin" : ""}`} />
              </button>
            )}
          </div>
          {filesExpanded && (
            <div className="mt-1">
              {files.length === 0 && !filesLoading && (
                <p className="text-[10px] text-muted-foreground/40 pl-4">No files yet</p>
              )}
              {files.length > 0 && (
                <FileTree
                  entries={files}
                  onPreview={openPreview}
                  onDownload={downloadFile}
                />
              )}
            </div>
          )}
        </div>

        {/* Brief */}
        <div>
          <button
            onClick={() => setBriefExpanded(!briefExpanded)}
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground w-full"
          >
            {briefExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Research Brief
          </button>
          {briefExpanded && (
            <div className="mt-1 space-y-1 text-[11px] text-muted-foreground">
              <p className="font-medium text-foreground/80">{brief.question}</p>
              {project.methodology && (
                <span className="inline-block rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                  {project.methodology}
                </span>
              )}
              {brief.subQuestions?.length > 0 && (
                <div className="space-y-0.5">
                  {brief.subQuestions.map((q: string, i: number) => (
                    <p key={i} className="text-[10px]">{i + 1}. {q}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Papers */}
        <div>
          <button
            onClick={() => setPapersExpanded(!papersExpanded)}
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground w-full"
          >
            {papersExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Papers ({papers.length})
          </button>
          {papersExpanded && (
            <div className="mt-1 space-y-0.5">
              {papers.slice(0, 15).map((p) => (
                <Link
                  key={p.id}
                  href={`/papers/${p.id}`}
                  className="flex items-start gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <FileText className="h-3 w-3 mt-0.5 shrink-0" />
                  <span className="line-clamp-1">{p.title}</span>
                </Link>
              ))}
              {papers.length > 15 && (
                <p className="text-[10px] text-muted-foreground/50 pl-4">+{papers.length - 15} more</p>
              )}
            </div>
          )}
        </div>

        {/* Hypotheses */}
        {hypotheses.length > 0 && (
          <div>
            <p className="text-[11px] font-medium text-muted-foreground mb-1">Hypotheses</p>
            <div className="space-y-0.5">
              {hypotheses.slice(0, 8).map((h) => (
                <div key={h.id} className="flex items-start gap-1.5">
                  <div className={`h-1.5 w-1.5 rounded-full mt-1.5 shrink-0 ${STATUS_DOT[h.status] || "bg-muted"}`} />
                  <p className="text-[10px] text-muted-foreground line-clamp-1">{h.statement}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Iteration */}
        {iteration && (
          <div>
            <p className="text-[11px] font-medium text-muted-foreground mb-1">
              Iteration #{iteration.number}
            </p>
            <p className="text-[10px] text-muted-foreground">{iteration.goal}</p>
            {totalSteps > 0 && (
              <div className="mt-1 flex items-center gap-1.5">
                <div className="h-1 flex-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${(completedSteps / totalSteps) * 100}%` }}
                  />
                </div>
                <span className="text-[9px] text-muted-foreground/50">
                  {completedSteps}/{totalSteps}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Process Memory */}
        {memories.length > 0 && (
          <div>
            <button
              onClick={() => setMemoriesExpanded(!memoriesExpanded)}
              className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground w-full"
            >
              {memoriesExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              <Brain className="h-3 w-3" />
              Process Memory ({memories.length})
            </button>
            {memoriesExpanded && (
              <div className="mt-1 space-y-1">
                {memories.map((m) => (
                  <div key={m.id} className="group flex items-start gap-1">
                    <span className="text-[9px] text-muted-foreground/50 bg-muted rounded px-1 shrink-0 mt-0.5">
                      {m.category}
                    </span>
                    <p className="text-[10px] text-muted-foreground flex-1 line-clamp-2">{m.lesson}</p>
                    <button
                      onClick={() => deleteMemory(m.id)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground/30 hover:text-destructive transition-opacity shrink-0"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* File Preview Modal */}
      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPreviewFile(null)}>
          <div
            className="bg-card border border-border rounded-lg shadow-lg w-[90vw] max-w-2xl max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
              <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium flex-1 truncate">{previewFile.name}</span>
              <span className="text-[9px] text-muted-foreground">{previewFile.path}</span>
              <button
                onClick={() => doDownload(previewFile.path, previewFile.name)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Download"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setPreviewFile(null)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-0">
              {previewLoading ? (
                <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">Loading...</div>
              ) : (
                <pre className="text-[11px] font-mono leading-relaxed p-3 whitespace-pre-wrap break-all text-foreground/90">
                  {previewContent}
                  {previewTruncated && (
                    <span className="text-amber-500 block mt-2">[File truncated — download for full content]</span>
                  )}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Download Confirmation */}
      {downloadConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDownloadConfirm(null)}>
          <div
            className="bg-card border border-border rounded-lg shadow-lg p-4 max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-medium mb-2">Large file download</p>
            <p className="text-xs text-muted-foreground mb-3">
              <strong>{downloadConfirm.name}</strong> is {formatSize(downloadConfirm.size)}. Are you sure you want to download it?
            </p>
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={() => setDownloadConfirm(null)}
                className="px-3 py-1.5 text-xs rounded border border-border hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => doDownload(downloadConfirm.path, downloadConfirm.name)}
                className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Download ({formatSize(downloadConfirm.size)})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── File Tree Component ────────────────────────────────

function FileTree({
  entries,
  onPreview,
  onDownload,
  depth = 0,
}: {
  entries: FileEntry[];
  onPreview: (path: string, name: string) => void;
  onDownload: (path: string, name: string, size: number) => void;
  depth?: number;
}) {
  return (
    <div className={depth > 0 ? "ml-2.5 border-l border-border/50 pl-1.5" : ""}>
      {entries.map((entry) => (
        <FileTreeItem key={entry.path} entry={entry} onPreview={onPreview} onDownload={onDownload} depth={depth} />
      ))}
    </div>
  );
}

function FileTreeItem({
  entry,
  onPreview,
  onDownload,
  depth,
}: {
  entry: FileEntry;
  onPreview: (path: string, name: string) => void;
  onDownload: (path: string, name: string, size: number) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth < 1);

  if (entry.isDir) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground w-full transition-colors"
        >
          {expanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronUp className="h-2.5 w-2.5 rotate-90" />}
          <FolderOpen className="h-3 w-3 text-amber-500/70" />
          <span className="truncate">{entry.name}</span>
        </button>
        {expanded && entry.children && (
          <FileTree entries={entry.children} onPreview={onPreview} onDownload={onDownload} depth={depth + 1} />
        )}
      </div>
    );
  }

  const canPreview = isPreviewable(entry.name);

  const handleClick = () => {
    if (canPreview) {
      onPreview(entry.path, entry.name);
    } else {
      onDownload(entry.path, entry.name, entry.size);
    }
  };

  return (
    <button
      onClick={handleClick}
      className="group grid grid-cols-[auto_1fr_auto] items-center gap-x-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors w-full text-left"
      title={canPreview ? `Preview ${entry.name}` : `Download ${entry.name}`}
    >
      <span className="shrink-0">{fileIcon(entry.name)}</span>
      <span className="truncate min-w-0">{entry.name}</span>
      <span className="text-[8px] text-muted-foreground/40 group-hover:text-muted-foreground/60 tabular-nums text-right w-[3.5rem]">{formatSize(entry.size)}</span>
    </button>
  );
}
