"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { FileCode, Download, X, WrapText, Copy, Check } from "lucide-react";
import { hljs } from "@/lib/highlight";

const EXT_TO_LANG: Record<string, string> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  md: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  r: "r",
  sql: "sql",
  dockerfile: "dockerfile",
  ini: "ini",
  cfg: "ini",
  xml: "xml",
  tex: "latex",
  lua: "lua",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  java: "java",
  rs: "rust",
  go: "go",
};

// Friendly display names
const LANG_LABELS: Record<string, string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  bash: "Shell",
  json: "JSON",
  yaml: "YAML",
  ini: "TOML/INI",
  markdown: "Markdown",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  r: "R",
  dockerfile: "Dockerfile",
  xml: "XML",
  latex: "LaTeX",
  lua: "Lua",
  c: "C",
  cpp: "C++",
  java: "Java",
  rust: "Rust",
  go: "Go",
};

// Files that should wrap lines by default (prose/data, not code)
const WRAP_BY_DEFAULT = new Set(["md", "txt", "log", "csv", "json", "yaml", "yml", "toml", "ini", "cfg", "xml"]);

function getLang(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const base = filename.toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "bash";
  if (base.endsWith(".log") || base.endsWith(".txt")) return null;
  return EXT_TO_LANG[ext] || null;
}

interface FilePreviewProps {
  projectId: string;
  file: { path: string; name: string };
  onClose: () => void;
  onDownload: (path: string, name: string) => void;
}

export function FilePreview({ projectId, file, onClose, onDownload }: FilePreviewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  const [wrap, setWrap] = useState(() => WRAP_BY_DEFAULT.has(ext));

  const lang = useMemo(() => getLang(file.name), [file.name]);

  // Load content
  useEffect(() => {
    setLoading(true);
    setContent(null);
    setTruncated(false);
    fetch(`/api/research/${projectId}/files/download?path=${encodeURIComponent(file.path)}&preview=true`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data) => {
        setContent(data.content);
        setTruncated(data.truncated);
      })
      .catch(() => setContent("Failed to load file."))
      .finally(() => setLoading(false));
  }, [projectId, file.path]);

  // Highlight after content loads
  const highlightedHtml = useMemo(() => {
    if (!content || !lang) return null;
    try {
      const result = hljs.highlight(content, { language: lang });
      return result.value;
    } catch {
      return null;
    }
  }, [content, lang]);

  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Esc to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const lineCount = content ? content.split("\n").length : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-lg w-[90vw] max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium flex-1 truncate">{file.name}</span>
          {lang && (
            <span className="text-[9px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground font-mono shrink-0">
              {LANG_LABELS[lang] || lang}
            </span>
          )}
          {lineCount > 0 && (
            <span className="text-[9px] text-muted-foreground/50 shrink-0">
              {lineCount} lines
            </span>
          )}
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => setWrap((w) => !w)}
              className={`p-1 rounded transition-colors ${wrap ? "text-foreground bg-muted" : "text-muted-foreground hover:text-foreground"}`}
              title={wrap ? "Disable line wrap" : "Enable line wrap"}
            >
              <WrapText className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleCopy}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors"
              title="Copy contents"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={() => onDownload(file.path, file.name)}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors"
              title="Download"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onClose}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">Loading...</div>
          ) : highlightedHtml ? (
            <pre className={`p-3 m-0 bg-transparent ${wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto"}`}>
              <code
                ref={codeRef}
                className={`hljs text-[11px] font-mono leading-relaxed ${wrap ? "" : ""}`}
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            </pre>
          ) : (
            <pre
              className={`text-[11px] font-mono leading-relaxed p-3 text-foreground/90 ${
                wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto"
              }`}
            >
              {content}
            </pre>
          )}
          {truncated && (
            <div className="px-3 pb-2">
              <span className="text-[10px] text-amber-500">[File truncated — download for full content]</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
