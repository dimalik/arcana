"use client";

import type { MouseEvent, ReactNode } from "react";
import { isValidElement, Children } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Components } from "react-markdown";
import { CodeBlock } from "@/components/chat/code-block";

interface PaperArtifactNavigationDetail {
  paperId: string;
  view?: "results" | "review" | "methodology" | "connections" | "analyze";
  pdfPage?: number | null;
}

/**
 * Extract the raw source + language from a <pre> whose only child is a <code>.
 * Returns { source: null } for anything else so the caller can fall back.
 */
function stringifyChildren(children: ReactNode): string {
  let out = "";
  Children.forEach(children, (child) => {
    if (typeof child === "string") out += child;
    else if (typeof child === "number") out += String(child);
    else if (isValidElement(child)) {
      out += stringifyChildren((child.props as { children?: ReactNode }).children);
    }
  });
  return out;
}

function extractCodeFromPre(children: ReactNode): {
  source: string | null;
  language: string | null;
} {
  let codeEl: React.ReactElement<{ className?: string; children?: ReactNode }> | null = null;
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.type === "code") {
      codeEl = child as typeof codeEl;
    }
  });
  if (!codeEl) return { source: null, language: null };
  const props = (codeEl as React.ReactElement<{ className?: string; children?: ReactNode }>).props;
  const langMatch = /language-([\w+-]+)/.exec(props.className ?? "");
  const language = langMatch?.[1] ?? null;
  const source = stringifyChildren(props.children).replace(/\n$/, "");
  return { source, language };
}

/**
 * Normalize LaTeX delimiters so remark-math can parse them.
 * Converts \(...\) → $...$ and \[...\] → $$...$$
 */
function normalizeLatex(text: string): string {
  return text
    .replace(/\\\((.+?)\\\)/g, (_, math) => `$${math}$`)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => `$$${math}$$`);
}

function handleInternalMarkdownLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string | undefined,
) {
  if (typeof window === "undefined" || !href || event.defaultPrevented) return;
  if (!href.startsWith("/")) return;

  const url = new URL(href, window.location.origin);
  const match = url.pathname.match(/^\/papers\/([^/]+)$/);
  if (!match?.[1]) return;

  if (window.location.pathname !== url.pathname) {
    return;
  }

  event.preventDefault();
  window.dispatchEvent(
    new CustomEvent<PaperArtifactNavigationDetail>("paper:open-artifact", {
      detail: {
        paperId: match[1],
        view:
          (url.searchParams.get("view") as PaperArtifactNavigationDetail["view"])
          ?? undefined,
        pdfPage: (() => {
          const raw = url.searchParams.get("page");
          if (!raw) return null;
          const parsed = Number.parseInt(raw, 10);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        })(),
      },
    }),
  );
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-xl font-bold mt-4 mb-2">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-lg font-semibold mt-3 mb-1.5">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-semibold mt-2 mb-1">{children}</h3>
  ),
  p: ({ children }) => <p className="mb-2 leading-relaxed">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-muted-foreground/30 pl-4 italic text-muted-foreground my-2">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="rounded border border-border/50 bg-muted/60 px-1 py-[1px] text-[0.9em] font-mono text-foreground/90">
          {children}
        </code>
      );
    }
    // Fenced code — handled by the <pre> renderer below which extracts the raw source.
    return <code className={className}>{children}</code>;
  },
  pre: ({ children }) => {
    const { source, language } = extractCodeFromPre(children);
    if (source == null) {
      return <pre className="my-2">{children}</pre>;
    }
    return <CodeBlock code={source} language={language} />;
  },
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => handleInternalMarkdownLinkClick(event, href)}
      target={href && (href.startsWith("/") || href.startsWith("#")) ? undefined : "_blank"}
      rel={href && (href.startsWith("/") || href.startsWith("#")) ? undefined : "noopener noreferrer"}
      className="text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-3 py-1.5 bg-muted font-semibold text-left">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-3 py-1.5">{children}</td>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  hr: () => <hr className="my-3 border-border" />,
};

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({
  content,
  className,
}: MarkdownRendererProps) {
  const normalized = normalizeLatex(content);
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
