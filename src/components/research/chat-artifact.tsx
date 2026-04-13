"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Download, Save } from "lucide-react";
import { toast } from "sonner";

const LANG_EXT: Record<string, string> = {
  latex: ".tex",
  tex: ".tex",
  python: ".py",
  py: ".py",
  javascript: ".js",
  js: ".js",
  typescript: ".ts",
  ts: ".ts",
  json: ".json",
  yaml: ".yaml",
  yml: ".yaml",
  markdown: ".md",
  md: ".md",
  bash: ".sh",
  sh: ".sh",
  sql: ".sql",
  csv: ".csv",
  html: ".html",
  css: ".css",
  r: ".R",
  julia: ".jl",
  bibtex: ".bib",
  bib: ".bib",
};

const LANG_LABEL: Record<string, string> = {
  latex: "LaTeX",
  tex: "LaTeX",
  python: "Python",
  py: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  json: "JSON",
  markdown: "Markdown",
  bash: "Shell",
  bibtex: "BibTeX",
  bib: "BibTeX",
};

export interface CodeArtifact {
  language: string;
  code: string;
  filename: string | null;
  lineCount: number;
}

/**
 * Parse assistant message content and extract large code blocks as artifacts.
 * Returns { prose: string (with code blocks removed), artifacts: CodeArtifact[] }
 */
export function extractArtifacts(
  content: string,
  minLines: number = 8,
): { prose: string; artifacts: CodeArtifact[] } {
  const artifacts: CodeArtifact[] = [];
  const fencePattern = /```(\w+)?\s*\n([\s\S]*?)```/g;

  const prose = content.replace(fencePattern, (match, lang, code) => {
    const trimmed = code.trimEnd();
    const lines = trimmed.split("\n").length;
    const language = (lang || "").toLowerCase();

    if (lines < minLines) {
      return match; // Keep small code blocks inline
    }

    // Try to derive filename from first comment line or language
    let filename: string | null = null;
    const firstLine = trimmed.split("\n")[0];
    // Patterns: # filename.py, // filename.js, % filename.tex, -- filename.sql
    const commentFile = firstLine.match(/^(?:#|\/\/|%|--)\s*(\S+\.\w+)/);
    if (commentFile) {
      filename = commentFile[1];
    }

    if (!filename && language) {
      const ext = LANG_EXT[language] || `.${language}`;
      const dateStr = new Date().toISOString().slice(0, 10);
      filename = `artifact-${dateStr}${ext}`;
    }

    artifacts.push({ language, code: trimmed, filename, lineCount: lines });
    return ""; // Remove from prose
  });

  return { prose: prose.trim(), artifacts };
}

/**
 * Renders a code artifact as a collapsible card with copy/download/save actions.
 */
export function ArtifactCard({
  artifact,
  projectId,
}: {
  artifact: CodeArtifact;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [filename, setFilename] = useState(
    artifact.filename || `artifact${LANG_EXT[artifact.language] || ".txt"}`,
  );

  const langLabel = LANG_LABEL[artifact.language] || artifact.language || "Plain text";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(artifact.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([artifact.code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleSaveToWorkspace = async () => {
    try {
      const res = await fetch(`/api/research/${projectId}/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, content: artifact.code }),
      });
      if (res.ok) {
        setSaved(true);
        toast.success(`Saved ${filename} to workspace`);
        setTimeout(() => setSaved(false), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save to workspace");
    }
  };

  const previewLines = 6;
  const codeLines = artifact.code.split("\n");
  const preview = codeLines.slice(0, previewLines).join("\n");
  const hasMore = codeLines.length > previewLines;

  return (
    <div className="my-2 rounded-lg border border-border/60 bg-muted/10 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/20 border-b border-border/40">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs font-medium text-foreground hover:text-foreground/80 transition-colors"
        >
          {expanded
            ? <ChevronDown className="h-3 w-3" />
            : <ChevronRight className="h-3 w-3" />}
        </button>

        {editingName ? (
          <input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            onBlur={() => setEditingName(false)}
            onKeyDown={(e) => e.key === "Enter" && setEditingName(false)}
            className="flex-1 bg-background border border-border/60 rounded px-1.5 py-0.5 text-xs outline-none"
            autoFocus
          />
        ) : (
          <button
            onClick={() => setEditingName(true)}
            className="flex-1 text-left text-xs font-mono text-foreground/80 hover:text-foreground truncate"
            title="Click to rename"
          >
            {filename}
          </button>
        )}

        <span className="text-[10px] text-muted-foreground/50">
          {artifact.lineCount} lines · {langLabel}
        </span>

        <div className="flex items-center gap-0.5">
          <button
            onClick={handleCopy}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Copy"
          >
            {copied ? <Check className="h-2.5 w-2.5 text-emerald-500" /> : <Copy className="h-2.5 w-2.5" />}
          </button>
          <button
            onClick={handleDownload}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Download"
          >
            <Download className="h-2.5 w-2.5" />
          </button>
          <button
            onClick={handleSaveToWorkspace}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Save to workspace"
          >
            {saved ? <Check className="h-2.5 w-2.5 text-emerald-500" /> : <Save className="h-2.5 w-2.5" />}
          </button>
        </div>
      </div>

      {/* Code preview / full */}
      <div className="overflow-x-auto">
        <pre className="px-3 py-2 text-[11px] leading-relaxed font-mono text-foreground/80">
          <code>{expanded ? artifact.code : preview}{!expanded && hasMore ? "\n..." : ""}</code>
        </pre>
      </div>

      {/* Expand toggle */}
      {hasMore && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full px-3 py-1.5 text-[10px] text-muted-foreground/40 hover:text-muted-foreground bg-muted/10 hover:bg-muted/20 transition-colors border-t border-border/30"
        >
          Show all {artifact.lineCount} lines
        </button>
      )}
    </div>
  );
}
