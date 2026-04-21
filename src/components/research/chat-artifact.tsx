"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Download, Save } from "lucide-react";
import { toast } from "sonner";
import { highlightCode } from "@/lib/highlight";
import {
  CHAT_ARTIFACT_LANG_EXT as LANG_EXT,
  extractFencedArtifacts,
  type FencedArtifact,
} from "@/lib/chat/fenced-artifacts";

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

export type CodeArtifact = FencedArtifact;

/**
 * Parse assistant message content and extract large code blocks as artifacts.
 * Returns { prose: string (with code blocks removed), artifacts: CodeArtifact[] }
 */
export function extractArtifacts(
  content: string,
  minLines: number = 1,
): { prose: string; artifacts: CodeArtifact[] } {
  return extractFencedArtifacts(content, minLines);
}

/** Segment types for streaming content */
export type StreamSegment =
  | { type: "prose"; content: string }
  | { type: "artifact"; artifact: CodeArtifact }
  | { type: "streaming_artifact"; language: string; code: string; lineCount: number };

/**
 * Parse streaming content into segments, detecting in-progress code blocks.
 * Unlike extractArtifacts (for completed messages), this handles partial
 * content where a code fence is open but not yet closed.
 */
export function parseStreamingSegments(
  content: string,
  minLines: number = 1,
): StreamSegment[] {
  const segments: StreamSegment[] = [];
  // Split on code fences, keeping the delimiters
  const parts = content.split(/(```\w*\s*\n)/);

  let inCodeBlock = false;
  let currentLang = "";
  let codeAccum = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const openMatch = part.match(/^```(\w*)\s*\n$/);

    if (!inCodeBlock && openMatch) {
      inCodeBlock = true;
      currentLang = (openMatch[1] || "").toLowerCase();
      codeAccum = "";
      continue;
    }

    if (inCodeBlock) {
      const closeIdx = part.indexOf("```");
      if (closeIdx >= 0) {
        // Block is closed
        const code = (codeAccum + part.slice(0, closeIdx)).trimEnd();
        const lineCount = code.split("\n").length;
        inCodeBlock = false;

        if (lineCount >= minLines) {
          let filename: string | null = null;
          const firstLine = code.split("\n")[0];
          const commentFile = firstLine.match(/^(?:#|\/\/|%|--)\s*(\S+\.\w+)/);
          if (commentFile) filename = commentFile[1];
          if (!filename && currentLang) {
            const ext = LANG_EXT[currentLang] || `.${currentLang}`;
            filename = `artifact${ext}`;
          }
          segments.push({
            type: "artifact",
            artifact: { language: currentLang, code, filename, lineCount },
          });
        } else {
          // Too small — render as inline code in prose
          segments.push({
            type: "prose",
            content: "```" + currentLang + "\n" + code + "```",
          });
        }
        // Remaining text after closing fence
        const after = part.slice(closeIdx + 3);
        if (after.trim()) {
          segments.push({ type: "prose", content: after });
        }
      } else {
        // Still accumulating — block not closed yet
        codeAccum += part;
      }
    } else {
      if (part.trim()) {
        segments.push({ type: "prose", content: part });
      }
    }
  }

  // If we're still inside a code block, it's streaming
  if (inCodeBlock && codeAccum) {
    const lineCount = codeAccum.split("\n").length;
    if (lineCount >= minLines) {
      segments.push({
        type: "streaming_artifact",
        language: currentLang,
        code: codeAccum,
        lineCount,
      });
    } else {
      // Not long enough yet — show as inline code
      segments.push({
        type: "prose",
        content: "```" + currentLang + "\n" + codeAccum,
      });
    }
  }

  return segments;
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

      {/* Code preview / full — syntax highlighted */}
      <div className="overflow-x-auto">
        <pre className="px-3 py-2 text-[11px] leading-relaxed font-mono hljs">
          <code dangerouslySetInnerHTML={{
            __html: highlightCode(
              (expanded ? artifact.code : preview) + (!expanded && hasMore ? "\n..." : ""),
              artifact.language,
            ),
          }} />
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

/**
 * Renders an in-progress artifact being streamed — always expanded, shows cursor.
 */
export function StreamingArtifactCard({
  language,
  code,
  lineCount,
}: {
  language: string;
  code: string;
  lineCount: number;
}) {
  const langLabel = LANG_LABEL[language] || language || "Plain text";

  return (
    <div className="my-2 rounded-lg border border-border/60 bg-muted/10 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/20 border-b border-border/40">
        <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
        <span className="text-xs font-mono text-foreground/60">Writing {langLabel}...</span>
        <span className="ml-auto text-[10px] text-muted-foreground/40">{lineCount} lines</span>
      </div>
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <pre className="px-3 py-2 text-[11px] leading-relaxed font-mono hljs">
          <code dangerouslySetInnerHTML={{ __html: highlightCode(code, language) }} />
          <span className="inline-block w-1.5 h-3 bg-foreground/60 animate-pulse ml-0.5" />
        </pre>
      </div>
    </div>
  );
}
