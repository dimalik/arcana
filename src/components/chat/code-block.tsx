"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Download } from "lucide-react";

type TokenKind =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "punct"
  | "operator"
  | "builtin"
  | "decorator"
  | "command"
  | "math"
  | "text";

interface Token {
  kind: TokenKind;
  value: string;
}

const TOKEN_COLORS: Record<TokenKind, string> = {
  keyword: "text-rose-700 dark:text-rose-300/90",
  string: "text-emerald-700 dark:text-emerald-300/90",
  number: "text-amber-700 dark:text-amber-200/95",
  comment: "italic text-neutral-500 dark:text-neutral-500/90",
  punct: "text-neutral-500 dark:text-neutral-500",
  operator: "text-sky-700 dark:text-sky-300/85",
  builtin: "text-violet-700 dark:text-violet-300/90",
  decorator: "text-amber-700 dark:text-amber-300/90",
  command: "text-sky-700 dark:text-sky-300/90",
  math: "text-emerald-700 dark:text-emerald-300/90",
  text: "text-neutral-800 dark:text-neutral-200",
};

const KEYWORDS_BY_LANG: Record<string, Set<string>> = {
  python: new Set([
    "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "finally", "for", "from",
    "global", "if", "import", "in", "is", "lambda", "nonlocal", "not",
    "or", "pass", "raise", "return", "try", "while", "with", "yield",
    "True", "False", "None",
  ]),
  javascript: new Set([
    "async", "await", "break", "case", "catch", "class", "const", "continue",
    "debugger", "default", "delete", "do", "else", "export", "extends",
    "finally", "for", "from", "function", "if", "import", "in", "instanceof",
    "let", "new", "of", "return", "static", "super", "switch", "this",
    "throw", "try", "typeof", "var", "void", "while", "with", "yield",
    "true", "false", "null", "undefined",
  ]),
  typescript: new Set([
    "abstract", "any", "as", "async", "await", "boolean", "break", "case",
    "catch", "class", "const", "constructor", "continue", "debugger",
    "declare", "default", "delete", "do", "else", "enum", "export",
    "extends", "finally", "for", "from", "function", "get", "if",
    "implements", "import", "in", "infer", "instanceof", "interface",
    "is", "keyof", "let", "namespace", "new", "null", "number", "of",
    "override", "private", "protected", "public", "readonly", "return",
    "satisfies", "set", "static", "string", "super", "switch", "symbol",
    "this", "throw", "true", "false", "try", "type", "typeof", "undefined",
    "unknown", "var", "void", "while", "with", "yield",
  ]),
  json: new Set(["true", "false", "null"]),
  bash: new Set([
    "if", "then", "else", "elif", "fi", "case", "esac", "for", "while",
    "until", "do", "done", "function", "return", "in", "select", "time",
    "break", "continue", "export", "local", "readonly", "shift", "source",
    "unset", "true", "false",
  ]),
  sql: new Set([
    "select", "from", "where", "and", "or", "not", "in", "is", "null",
    "insert", "into", "values", "update", "set", "delete", "create",
    "table", "index", "view", "drop", "alter", "add", "column", "as",
    "on", "join", "left", "right", "inner", "outer", "full", "cross",
    "group", "by", "having", "order", "asc", "desc", "limit", "offset",
    "union", "all", "distinct", "case", "when", "then", "else", "end",
    "with", "returning", "primary", "key", "foreign", "references",
    "default", "unique", "constraint", "check", "cascade",
  ]),
};

function tokenizePython(source: string): Token[] {
  return tokenizeGeneric(source, {
    keywords: KEYWORDS_BY_LANG.python,
    stringDelims: ['"""', "'''", '"', "'"],
    lineComment: "#",
    decoratorPrefix: "@",
  });
}

function tokenizeJs(source: string, lang: "javascript" | "typescript"): Token[] {
  return tokenizeGeneric(source, {
    keywords: KEYWORDS_BY_LANG[lang],
    stringDelims: ['"', "'", "`"],
    lineComment: "//",
    blockComment: ["/*", "*/"],
  });
}

function tokenizeJson(source: string): Token[] {
  return tokenizeGeneric(source, {
    keywords: KEYWORDS_BY_LANG.json,
    stringDelims: ['"'],
  });
}

function tokenizeBash(source: string): Token[] {
  return tokenizeGeneric(source, {
    keywords: KEYWORDS_BY_LANG.bash,
    stringDelims: ['"', "'"],
    lineComment: "#",
  });
}

function tokenizeSql(source: string): Token[] {
  return tokenizeGeneric(source, {
    keywords: KEYWORDS_BY_LANG.sql,
    stringDelims: ["'", '"'],
    lineComment: "--",
    blockComment: ["/*", "*/"],
    caseInsensitive: true,
  });
}

interface GenericOptions {
  keywords: Set<string>;
  stringDelims: string[];
  lineComment?: string;
  blockComment?: [string, string];
  decoratorPrefix?: string;
  caseInsensitive?: boolean;
}

function tokenizeGeneric(source: string, opts: GenericOptions): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const flush = (buf: string) => {
    if (!buf) return;
    tokens.push({ kind: "text", value: buf });
  };

  let buffer = "";
  while (i < source.length) {
    const rest = source.slice(i);

    // Block comment
    if (opts.blockComment) {
      const [open, close] = opts.blockComment;
      if (rest.startsWith(open)) {
        flush(buffer);
        buffer = "";
        const endIdx = source.indexOf(close, i + open.length);
        const stop = endIdx === -1 ? source.length : endIdx + close.length;
        tokens.push({ kind: "comment", value: source.slice(i, stop) });
        i = stop;
        continue;
      }
    }

    // Line comment
    if (opts.lineComment && rest.startsWith(opts.lineComment)) {
      flush(buffer);
      buffer = "";
      const nl = source.indexOf("\n", i);
      const stop = nl === -1 ? source.length : nl;
      tokens.push({ kind: "comment", value: source.slice(i, stop) });
      i = stop;
      continue;
    }

    // String literal
    let matchedDelim: string | null = null;
    for (const d of opts.stringDelims) {
      if (rest.startsWith(d)) {
        matchedDelim = d;
        break;
      }
    }
    if (matchedDelim) {
      flush(buffer);
      buffer = "";
      let j = i + matchedDelim.length;
      while (j < source.length) {
        if (source[j] === "\\" && j + 1 < source.length) {
          j += 2;
          continue;
        }
        if (source.startsWith(matchedDelim, j)) {
          j += matchedDelim.length;
          break;
        }
        j += 1;
      }
      tokens.push({ kind: "string", value: source.slice(i, j) });
      i = j;
      continue;
    }

    // Number
    const numMatch = rest.match(/^-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numMatch && (buffer === "" || /[\s(,\[{+\-*/=<>!&|^%~?:;]$/.test(buffer))) {
      flush(buffer);
      buffer = "";
      tokens.push({ kind: "number", value: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }

    // Decorator
    if (opts.decoratorPrefix && rest.startsWith(opts.decoratorPrefix)) {
      const m = rest.match(/^@[A-Za-z_][A-Za-z0-9_.]*/);
      if (m) {
        flush(buffer);
        buffer = "";
        tokens.push({ kind: "decorator", value: m[0] });
        i += m[0].length;
        continue;
      }
    }

    // Identifier
    const idMatch = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (idMatch) {
      flush(buffer);
      buffer = "";
      const word = idMatch[0];
      const cmp = opts.caseInsensitive ? word.toLowerCase() : word;
      if (opts.keywords.has(cmp)) {
        tokens.push({ kind: "keyword", value: word });
      } else {
        tokens.push({ kind: "text", value: word });
      }
      i += word.length;
      continue;
    }

    // Punct / operator
    const ch = source[i];
    if (/[{}[\](),;:]/.test(ch)) {
      flush(buffer);
      buffer = "";
      tokens.push({ kind: "punct", value: ch });
      i += 1;
      continue;
    }
    if (/[+\-*/=<>!&|^%~?]/.test(ch)) {
      flush(buffer);
      buffer = "";
      tokens.push({ kind: "operator", value: ch });
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }
  flush(buffer);
  return tokens;
}

function tokenizeLatex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    tokens.push({ kind: "text", value: buffer });
    buffer = "";
  };
  while (i < source.length) {
    const rest = source.slice(i);

    // Line comment %…
    if (rest.startsWith("%")) {
      flush();
      const nl = source.indexOf("\n", i);
      const stop = nl === -1 ? source.length : nl;
      tokens.push({ kind: "comment", value: source.slice(i, stop) });
      i = stop;
      continue;
    }

    // Math environments $…$ or $$…$$
    if (rest.startsWith("$$")) {
      flush();
      const end = source.indexOf("$$", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      tokens.push({ kind: "math", value: source.slice(i, stop) });
      i = stop;
      continue;
    }
    if (rest.startsWith("$")) {
      flush();
      const end = source.indexOf("$", i + 1);
      const stop = end === -1 ? source.length : end + 1;
      tokens.push({ kind: "math", value: source.slice(i, stop) });
      i = stop;
      continue;
    }

    // Command \foo, \foo*, \\, \{, \}
    if (rest.startsWith("\\")) {
      flush();
      const m = rest.match(/^\\(?:[A-Za-z@]+\*?|[\\{}&#_%$^~])/);
      if (m) {
        tokens.push({ kind: "command", value: m[0] });
        i += m[0].length;
        continue;
      }
      tokens.push({ kind: "command", value: "\\" });
      i += 1;
      continue;
    }

    // Braces, brackets
    if (/[{}[\]]/.test(rest[0])) {
      flush();
      tokens.push({ kind: "punct", value: rest[0] });
      i += 1;
      continue;
    }

    // Numbers
    const numMatch = rest.match(/^-?\d+(?:\.\d+)?/);
    if (numMatch && (buffer === "" || /[\s{[(,&=]$/.test(buffer))) {
      flush();
      tokens.push({ kind: "number", value: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }

    buffer += source[i];
    i += 1;
  }
  flush();
  return tokens;
}

function tokenize(source: string, lang: string | undefined | null): Token[] {
  const normalized = (lang ?? "").toLowerCase().trim();
  switch (normalized) {
    case "py":
    case "python":
      return tokenizePython(source);
    case "js":
    case "javascript":
    case "jsx":
      return tokenizeJs(source, "javascript");
    case "ts":
    case "typescript":
    case "tsx":
      return tokenizeJs(source, "typescript");
    case "json":
      return tokenizeJson(source);
    case "sh":
    case "bash":
    case "zsh":
    case "shell":
      return tokenizeBash(source);
    case "sql":
      return tokenizeSql(source);
    case "tex":
    case "latex":
      return tokenizeLatex(source);
    default:
      return [{ kind: "text", value: source }];
  }
}

function HighlightedCode({ code, language }: { code: string; language?: string | null }) {
  const tokens = useMemo(() => tokenize(code, language ?? null), [code, language]);
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} className={TOKEN_COLORS[t.kind]}>
          {t.value}
        </span>
      ))}
    </>
  );
}

interface CodeBlockProps {
  code: string;
  language?: string | null;
  filename?: string | null;
  onDownload?: () => void;
  dense?: boolean;
}

export function CodeBlock({ code, language, filename, onDownload, dense }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  const langLabel = (language ?? "").trim().toLowerCase();
  const lineCount = code.split("\n").length;
  const showLineNumbers = !dense && lineCount > 3 && lineCount < 400;

  return (
    <figure className="group/codeblock my-3 overflow-hidden rounded-lg border border-border/50 bg-background/60 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
      {(filename || langLabel) && (
        <header className="relative flex items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-1.5">
          <span
            aria-hidden
            className="absolute inset-y-1.5 left-0 w-[2px] bg-gradient-to-b from-amber-400/70 via-amber-400/25 to-transparent"
          />
          {filename && (
            <span className="ml-1 truncate font-mono text-[11px] tracking-tight text-foreground/80">
              {filename}
            </span>
          )}
          {langLabel && (
            <span
              className={`font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground/70 ${filename ? "" : "ml-1"}`}
              style={{ fontVariant: "small-caps" }}
            >
              {langLabel}
            </span>
          )}
          <div
            className={`flex items-center gap-0.5 ${filename || langLabel ? "ml-auto" : ""}`}
          >
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-all hover:bg-foreground/5 hover:text-foreground group-hover/codeblock:opacity-100 focus-visible:opacity-100"
              title={copied ? "Copied" : "Copy"}
              aria-label={copied ? "Copied" : "Copy code"}
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-500/90 dark:text-emerald-300" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
            {onDownload && (
              <button
                type="button"
                onClick={onDownload}
                className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-all hover:bg-foreground/5 hover:text-foreground group-hover/codeblock:opacity-100 focus-visible:opacity-100"
                title="Download"
                aria-label="Download code"
              >
                <Download className="h-3 w-3" />
              </button>
            )}
          </div>
        </header>
      )}
      <div className="relative bg-[#f7f6f1] dark:bg-[#0f1117]">
        <pre className="m-0 max-h-[28rem] overflow-x-auto overflow-y-auto bg-transparent p-0 font-mono text-[11.5px] leading-[1.55]">
          {showLineNumbers ? (
            <div className="flex">
              <div
                aria-hidden
                className="shrink-0 select-none border-r border-black/[0.06] bg-black/[0.02] px-2.5 py-3 text-right font-mono text-[10px] leading-[1.55] text-neutral-500 dark:border-white/[0.04] dark:bg-white/[0.02] dark:text-neutral-600"
              >
                {Array.from({ length: lineCount }, (_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              <code className="block flex-1 px-3.5 py-3 font-mono text-neutral-800 dark:text-neutral-200">
                <HighlightedCode code={code} language={language} />
              </code>
            </div>
          ) : (
            <code className="block px-3.5 py-3 font-mono text-neutral-800 dark:text-neutral-200">
              <HighlightedCode code={code} language={language} />
            </code>
          )}
        </pre>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[#f7f6f1] to-transparent dark:from-[#0f1117]"
        />
      </div>
    </figure>
  );
}
