"use client";
import type { AgentActionSummary, AnswerCitation } from "@/lib/papers/answer-engine/metadata";
import {
  ArrowUpRight,
  Bot,
  ChevronDown,
  Download,
  FileSearch,
  FileText,
  ImageIcon,
  Layers3,
  Quote,
  Sparkles,
  TableProperties,
  Waypoints,
} from "lucide-react";
import { CodeBlock } from "./code-block";

export interface ConversationArtifactRecord {
  id?: string;
  kind: string;
  title: string;
  payloadJson: string;
}

interface ChatMessageSupportProps {
  citations?: AnswerCitation[];
  agentActions?: AgentActionSummary[];
  artifacts?: ConversationArtifactRecord[];
  compact?: boolean;
  showArtifacts?: boolean;
}

interface VisualArtifactPayload {
  paperId?: string | null;
  figureLabel?: string | null;
  captionText?: string | null;
  description?: string | null;
  imagePath?: string | null;
  pdfPage?: number | null;
  table?: {
    columns?: string[];
    rows?: string[][];
    query?: string | null;
    matches?: Array<{ rowIndex: number; score: number; values: string[] }>;
  } | null;
}

interface CodeArtifactPayload {
  summary?: string | null;
  code?: string | null;
  filename?: string | null;
  language?: string | null;
  assumptions?: string[] | null;
}

interface PaperArtifactNavigationDetail {
  paperId: string;
  view: "results" | "review" | "methodology" | "connections" | "analyze";
  pdfPage?: number | null;
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function downloadText(filename: string, content: string, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

function tableToCsv(table: {
  columns?: string[];
  rows?: string[][];
} | null | undefined): string | null {
  if (!table?.columns?.length || !table.rows?.length) return null;
  const toCsvRow = (values: string[]) =>
    values.map((value) => `"${value.replace(/"/g, '""')}"`).join(",");
  return [toCsvRow(table.columns), ...table.rows.map((row) => toCsvRow(row))].join("\n");
}

function buildPaperContextHref(
  paperId: string | null | undefined,
  options?: {
    pdfPage?: number | null;
    view?: "results" | "review" | "methodology" | "connections" | "analyze";
  },
): string | null {
  if (!paperId) return null;
  const params = new URLSearchParams();
  params.set("view", options?.view ?? "results");
  if (options?.pdfPage) {
    params.set("pdf", "1");
    params.set("page", String(options.pdfPage));
  }
  return `/papers/${paperId}?${params.toString()}`;
}

function buildPaperPdfHref(
  paperId: string | null | undefined,
  pdfPage?: number | null,
): string | null {
  if (!paperId) return null;
  const suffix = pdfPage ? `#page=${pdfPage}` : "";
  return `/api/papers/${paperId}/file${suffix}`;
}

function buildPaperAssetUrl(
  paperId: string | null | undefined,
  assetPath: string | null | undefined,
  options?: { download?: boolean },
): string | null {
  if (!paperId || !assetPath) return null;
  const params = new URLSearchParams({
    path: assetPath,
  });
  if (options?.download) {
    params.set("download", "true");
  }
  return `/api/papers/${paperId}/assets?${params.toString()}`;
}

function inferCitationView(sectionPath: string | null | undefined):
  "results" | "review" | "methodology" | "connections" | "analyze" {
  const normalized = (sectionPath ?? "").toLowerCase();
  if (normalized.includes("result") || normalized.includes("table") || normalized.includes("figure")) {
    return "results";
  }
  if (normalized.includes("method")) {
    return "methodology";
  }
  return "review";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacePlainTextWithMarkdownLink(
  content: string,
  label: string,
  href: string,
): string {
  if (!label.trim()) return content;
  const pattern = new RegExp(`(^|[^\\[])(${escapeRegExp(label)})(?!\\]\\()`, "g");
  return content.replace(pattern, (_match, prefix: string, matched: string) =>
    `${prefix}[${matched}](${href})`,
  );
}

export function linkifyPaperAnswerContent(
  content: string,
  params: {
    citations?: AnswerCitation[];
    artifacts?: ConversationArtifactRecord[];
  },
): string {
  let nextContent = content;

  const citations = params.citations ?? [];
  nextContent = nextContent.replace(/\[S(\d+)\](?!\()/g, (match, rawIndex: string) => {
    const index = Number.parseInt(rawIndex, 10) - 1;
    const citation = citations[index];
    if (!citation) return match;
    const href = buildPaperContextHref(citation.paperId, {
      view: inferCitationView(citation.sectionPath),
    });
    return href ? `[S${rawIndex}](${href})` : match;
  });

  // Break up smooshed adjacent citations so `[S1](...)[S2](...)` doesn't render as
  // a single underlined run "S1S2". A hair-space keeps them visually distinct
  // without adding awkward normal-space breaks between trailing punctuation.
  nextContent = nextContent.replace(
    /(\]\([^)]+\))(\[S\d+\]\()/g,
    "$1\u2009$2",
  );

  for (const artifact of params.artifacts ?? []) {
    if (artifact.kind !== "FIGURE_CARD" && artifact.kind !== "TABLE_CARD") {
      continue;
    }
    const payload = parseJson<VisualArtifactPayload>(artifact.payloadJson);
    const href = buildPaperContextHref(payload?.paperId, {
      view: "results",
      pdfPage: payload?.pdfPage,
    });
    const label = payload?.figureLabel ?? artifact.title;
    if (!href || !label) continue;
    nextContent = replacePlainTextWithMarkdownLink(nextContent, label, href);
  }

  return nextContent;
}

function openPaperContextInPlace(
  detail: PaperArtifactNavigationDetail,
  fallbackHref: string,
) {
  if (typeof window === "undefined") return;

  if (window.location.pathname === `/papers/${detail.paperId}`) {
    window.dispatchEvent(
      new CustomEvent<PaperArtifactNavigationDetail>("paper:open-artifact", {
        detail,
      }),
    );
    return;
  }

  window.location.assign(fallbackHref);
}

function OpenInPaperButton({
  paperId,
  pdfPage,
  view = "results",
}: {
  paperId: string | null | undefined;
  pdfPage?: number | null;
  view?: "results" | "review" | "methodology" | "connections" | "analyze";
}) {
  const href = buildPaperContextHref(paperId, { pdfPage, view });
  if (!paperId || !href) return null;
  return (
    <button
      type="button"
      onClick={() => openPaperContextInPlace({ paperId, pdfPage, view }, href)}
      className="inline-flex h-[22px] items-center gap-1 rounded-md border border-border/50 bg-background/60 px-1.5 text-[10px] text-muted-foreground/85 transition-colors hover:border-border hover:bg-accent/50 hover:text-foreground"
      title="Open in paper"
    >
      <ArrowUpRight className="h-3 w-3" />
      Paper
    </button>
  );
}

function TableFigureActions({
  paperId,
  pdfPage,
  imageSrc,
  csv,
  csvFilename,
}: {
  paperId: string | null | undefined;
  pdfPage?: number | null;
  imageSrc?: string | null;
  csv?: string | null;
  csvFilename?: string;
}) {
  const pdfHref = buildPaperPdfHref(paperId, pdfPage);
  const hasAnyAction = Boolean(paperId || imageSrc || csv);
  if (!hasAnyAction && !pdfPage) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground/75">
      {pdfPage ? (
        <span className="inline-flex h-[22px] items-center rounded-md bg-muted/40 px-1.5 font-mono text-[10px] tabular-nums">
          p.{pdfPage}
        </span>
      ) : null}
      <OpenInPaperButton paperId={paperId} pdfPage={pdfPage} view="results" />
      {pdfHref ? (
        <MiniAction href={pdfHref} title="Open PDF">
          <FileText className="h-3 w-3" />
          PDF
        </MiniAction>
      ) : null}
      {imageSrc ? (
        <MiniAction href={imageSrc} title="Open image">
          <ImageIcon className="h-3 w-3" />
          Image
        </MiniAction>
      ) : null}
      {csv && csvFilename ? (
        <MiniAction
          title="Download CSV"
          onClick={() => downloadText(csvFilename, csv, "text/csv")}
        >
          <Download className="h-3 w-3" />
          CSV
        </MiniAction>
      ) : null}
    </div>
  );
}

function artifactKindLabel(kind: string) {
  return kind.toLowerCase().replace(/_/g, " ");
}

const SECTION_TONE: Record<
  "citation" | "agent" | "artifact",
  { icon: typeof Quote; colorClass: string }
> = {
  citation: { icon: Quote, colorClass: "text-sky-600/80 dark:text-sky-300/75" },
  agent: {
    icon: Waypoints,
    colorClass: "text-emerald-600/80 dark:text-emerald-300/75",
  },
  artifact: {
    icon: Layers3,
    colorClass: "text-amber-600/85 dark:text-amber-300/80",
  },
};

function SectionAccent({ tone }: { tone: "citation" | "agent" | "artifact" }) {
  const { icon: Icon, colorClass } = SECTION_TONE[tone];
  return (
    <Icon
      aria-hidden
      className={`mr-2 h-3 w-3 shrink-0 ${colorClass}`}
    />
  );
}

function SupportSection({
  compact,
  title,
  count,
  tone,
  children,
}: {
  compact: boolean;
  title: string;
  count: number;
  tone: "citation" | "agent" | "artifact";
  children: React.ReactNode;
}) {
  return (
    <details className="group border-t border-border/40 pt-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-0.5 py-1 outline-none">
        <SectionAccent tone={tone} />
        <span
          className={
            compact
              ? "text-[10.5px] font-medium tracking-wide text-foreground/80"
              : "text-[11.5px] font-medium tracking-wide text-foreground/85"
          }
          style={{ fontVariant: "small-caps" }}
        >
          {title}
        </span>
        <span className="ml-1.5 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {count}
        </span>
        <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/60 transition-colors group-hover:bg-foreground/5 group-hover:text-foreground/80">
          <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}

const ARTIFACT_KIND_ICON: Record<string, typeof FileText> = {
  RESULT_SUMMARY: FileSearch,
  CLAIM_LIST: FileText,
  CONTRADICTION_TABLE: TableProperties,
  GAP_LIST: FileText,
  TIMELINE: Sparkles,
  METHODOLOGY_COMPARE: TableProperties,
  FIGURE_CARD: ImageIcon,
  TABLE_CARD: TableProperties,
  CODE_SNIPPET: FileText,
};

function ArtifactTitleRow({
  kind,
  title,
  accessory,
}: {
  kind: string;
  title: string;
  accessory?: React.ReactNode;
}) {
  const Icon = ARTIFACT_KIND_ICON[kind] ?? Bot;
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <Icon className="h-3 w-3 text-muted-foreground/60" />
      <p className="truncate text-[12px] font-medium text-foreground/90">{title}</p>
      {accessory ? <div className="ml-auto flex items-center gap-1.5">{accessory}</div> : null}
    </div>
  );
}

function MiniAction({
  children,
  onClick,
  href,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  title: string;
}) {
  const className =
    "inline-flex h-[22px] items-center gap-1 rounded-md border border-border/50 bg-background/60 px-1.5 text-[10px] text-muted-foreground/85 transition-colors hover:border-border hover:bg-accent/50 hover:text-foreground";
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        title={title}
      >
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className} title={title}>
      {children}
    </button>
  );
}

function ArtifactPreview({
  artifact,
  compact,
}: {
  artifact: ConversationArtifactRecord;
  compact: boolean;
}) {
  const baseClass = compact ? "text-[11px]" : "text-xs";

  if (artifact.kind === "RESULT_SUMMARY") {
    const payload = parseJson<{
      excerpt?: string;
      claims?: Array<{ text: string; sectionPath?: string | null }>;
    }>(artifact.payloadJson);
    return (
      <div className="space-y-1">
        {payload?.excerpt ? (
          <p className={`${baseClass} text-muted-foreground`}>
            {payload.excerpt}
          </p>
        ) : null}
        {(payload?.claims ?? []).slice(0, compact ? 1 : 2).map((claim, index) => (
          <p
            key={`${artifact.id ?? artifact.title}-result-claim-${index}`}
            className={`${baseClass} text-muted-foreground`}
          >
            {claim.text}
          </p>
        ))}
      </div>
    );
  }

  if (artifact.kind === "CLAIM_LIST") {
    const payload = parseJson<{
      claims?: Array<{ text: string; rhetoricalRole: string }>;
    }>(artifact.payloadJson);
    const claims = payload?.claims ?? [];
    return (
      <div className="space-y-1">
        {claims.slice(0, compact ? 2 : 3).map((claim, index) => (
          <p key={`${artifact.id}-claim-${index}`} className={`${baseClass} text-muted-foreground`}>
            {claim.text}
          </p>
        ))}
      </div>
    );
  }

  if (artifact.kind === "CONTRADICTION_TABLE") {
    const payload = parseJson<{
      contradictions?: Array<{
        newPaperClaim: string;
        conflictingPaperClaim: string;
      }>;
      summary?: string;
    }>(artifact.payloadJson);
    const first = payload?.contradictions?.[0];
    return (
      <div className="space-y-1">
        {first ? (
          <>
            <p className={`${baseClass} text-muted-foreground`}>{first.newPaperClaim}</p>
            <p className={`${baseClass} text-muted-foreground`}>{first.conflictingPaperClaim}</p>
          </>
        ) : (
          <p className={`${baseClass} text-muted-foreground`}>
            {payload?.summary ?? "No contradiction candidates."}
          </p>
        )}
      </div>
    );
  }

  if (artifact.kind === "GAP_LIST") {
    const payload = parseJson<{
      gaps?: Array<{ title: string }>;
      overallAssessment?: string;
    }>(artifact.payloadJson);
    const gaps = payload?.gaps ?? [];
    return (
      <div className="space-y-1">
        {gaps.length > 0 ? (
          gaps.slice(0, compact ? 2 : 3).map((gap, index) => (
            <p key={`${artifact.id}-gap-${index}`} className={`${baseClass} text-muted-foreground`}>
              {gap.title}
            </p>
          ))
        ) : (
          <p className={`${baseClass} text-muted-foreground`}>
            {payload?.overallAssessment ?? "No structured gaps were produced."}
          </p>
        )}
      </div>
    );
  }

  if (artifact.kind === "TIMELINE") {
    const payload = parseJson<{
      timeline?: Array<{ year: number; keyAdvance: string }>;
      narrative?: string;
    }>(artifact.payloadJson);
    const timeline = payload?.timeline ?? [];
    return (
      <div className="space-y-1">
        {timeline.length > 0 ? (
          timeline.slice(0, compact ? 2 : 3).map((entry, index) => (
            <p key={`${artifact.id}-timeline-${index}`} className={`${baseClass} text-muted-foreground`}>
              {entry.year}: {entry.keyAdvance}
            </p>
          ))
        ) : (
          <p className={`${baseClass} text-muted-foreground`}>
            {payload?.narrative ?? "No timeline entries were produced."}
          </p>
        )}
      </div>
    );
  }

  if (artifact.kind === "METHODOLOGY_COMPARE") {
    const payload = parseJson<{
      verdict?: string;
      comparison?: { papers?: Array<{ title: string; approach: string }> };
    }>(artifact.payloadJson);
    return (
      <div className="space-y-1">
        {(payload?.comparison?.papers ?? []).slice(0, compact ? 2 : 3).map((paper, index) => (
          <p key={`${artifact.id}-method-${index}`} className={`${baseClass} text-muted-foreground`}>
            {paper.title}: {paper.approach}
          </p>
        ))}
        {payload?.verdict ? (
          <p className={`${baseClass} font-medium text-foreground/80`}>{payload.verdict}</p>
        ) : null}
      </div>
    );
  }

  if (artifact.kind === "FIGURE_CARD") {
    const payload = parseJson<VisualArtifactPayload>(artifact.payloadJson);
    const imageSrc = buildPaperAssetUrl(payload?.paperId, payload?.imagePath);
    return (
      <div className="space-y-2">
        {imageSrc ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={imageSrc}
            alt={payload?.captionText || payload?.figureLabel || artifact.title}
            className="max-h-48 w-full rounded-md border border-border/50 object-contain bg-background/60"
          />
        ) : null}
        {payload?.captionText ? (
          <p className={`${baseClass} leading-snug text-muted-foreground`}>
            {payload.captionText}
          </p>
        ) : null}
        {payload?.description && payload.description !== payload.captionText ? (
          <p className={`${baseClass} leading-snug text-muted-foreground`}>
            {payload.description}
          </p>
        ) : null}
        <TableFigureActions
          paperId={payload?.paperId}
          pdfPage={payload?.pdfPage}
          imageSrc={imageSrc}
        />
      </div>
    );
  }

  if (artifact.kind === "TABLE_CARD") {
    const payload = parseJson<VisualArtifactPayload>(artifact.payloadJson);
    const imageSrc = buildPaperAssetUrl(payload?.paperId, payload?.imagePath);
    const csv = tableToCsv(payload?.table);
    const hasTable = Boolean(
      payload?.table?.columns?.length && payload?.table?.rows?.length,
    );
    const matchedRowSet = new Set<number>(
      (payload?.table?.matches ?? []).map((m) => m.rowIndex),
    );
    const hasMatches = matchedRowSet.size > 0;
    const descriptionDiffersFromTable =
      Boolean(payload?.description) &&
      // When we're rendering a structured table, a free-text `description`
      // is almost always a flat-text dump of the same cells — suppress it.
      !hasTable;

    return (
      <div className="space-y-2">
        {payload?.captionText ? (
          <p className={`${baseClass} leading-snug text-muted-foreground`}>
            {payload.captionText}
          </p>
        ) : null}

        {hasMatches && payload?.table?.query ? (
          <p className="text-[10px] text-muted-foreground/75">
            <span className="font-mono uppercase tracking-[0.12em] text-muted-foreground/55">
              match
            </span>
            <span className="mx-1 text-muted-foreground/40">·</span>
            <span className="italic">&ldquo;{payload.table.query}&rdquo;</span>
            <span className="ml-1.5 text-muted-foreground/55">
              ({matchedRowSet.size} row{matchedRowSet.size === 1 ? "" : "s"})
            </span>
          </p>
        ) : null}

        {hasTable ? (
          <div className="overflow-x-auto rounded-md border border-border/50 bg-background/60">
            <table className="min-w-full border-collapse text-[10px] tabular-nums">
              <thead>
                <tr>
                  {payload!.table!.columns!.map((column, index) => (
                    <th
                      key={`${artifact.id ?? artifact.title}-col-${index}`}
                      className="border-b border-border/50 bg-muted/25 px-2 py-1 text-left font-medium text-foreground/75"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payload!.table!.rows!.slice(0, compact ? 4 : 8).map((row, rowIndex) => {
                  const isMatch = matchedRowSet.has(rowIndex);
                  return (
                    <tr
                      key={`${artifact.id ?? artifact.title}-row-${rowIndex}`}
                      className={
                        isMatch
                          ? "bg-amber-400/[0.07] ring-1 ring-inset ring-amber-400/20"
                          : "odd:bg-muted/10"
                      }
                    >
                      {row.map((value, cellIndex) => (
                        <td
                          key={`${artifact.id ?? artifact.title}-cell-${rowIndex}-${cellIndex}`}
                          className="border-b border-border/30 px-2 py-[5px] align-top text-muted-foreground last:border-b-0"
                        >
                          {value}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {descriptionDiffersFromTable ? (
          <p className={`${baseClass} leading-snug text-muted-foreground`}>
            {payload!.description}
          </p>
        ) : null}

        {imageSrc ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={imageSrc}
            alt={payload?.captionText || payload?.figureLabel || artifact.title}
            className="max-h-44 w-full rounded-md border border-border/50 object-contain bg-background/60"
          />
        ) : null}

        <TableFigureActions
          paperId={payload?.paperId}
          pdfPage={payload?.pdfPage}
          imageSrc={imageSrc}
          csv={csv}
          csvFilename={`${(payload?.figureLabel || artifact.title || "table")
            .replace(/\s+/g, "_")
            .toLowerCase()}.csv`}
        />
      </div>
    );
  }

  if (artifact.kind === "CODE_SNIPPET") {
    const payload = parseJson<CodeArtifactPayload>(artifact.payloadJson);
    const filename = payload?.filename ?? artifact.title ?? null;
    return (
      <div className="space-y-2.5">
        {payload?.summary ? (
          <p className={`${baseClass} leading-relaxed text-muted-foreground`}>
            {payload.summary}
          </p>
        ) : null}
        {payload?.code ? (
          <CodeBlock
            code={payload.code}
            language={payload.language ?? null}
            filename={filename}
            dense={compact}
            onDownload={
              payload.code && filename
                ? () => downloadText(filename, payload.code!)
                : undefined
            }
          />
        ) : null}
        {(payload?.assumptions ?? []).length > 0 ? (
          <div className="rounded-md border-l-2 border-amber-400/40 bg-amber-400/[0.035] py-1.5 pl-3 pr-2">
            <p className="mb-0.5 text-[9.5px] font-medium uppercase tracking-[0.16em] text-amber-600/90 dark:text-amber-300/80">
              Assumptions
            </p>
            <ul className={`${baseClass} space-y-0.5 leading-relaxed text-muted-foreground`}>
              {(payload?.assumptions ?? []).slice(0, compact ? 2 : 3).map((assumption, index) => (
                <li key={`${artifact.id ?? artifact.title}-assumption-${index}`}>
                  {assumption}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <p className={`${baseClass} text-muted-foreground`}>
      Structured artifact attached.
    </p>
  );
}

export function ChatArtifactsInline({
  artifacts = [],
  compact = false,
}: {
  artifacts?: ConversationArtifactRecord[];
  compact?: boolean;
}) {
  if (artifacts.length === 0) return null;

  return (
    <div className={compact ? "mb-2 space-y-2" : "mb-3 space-y-2.5"}>
      {artifacts.map((artifact) => {
        // Code snippets render as a single self-contained CodeBlock —
        // no outer chrome, because the CodeBlock header already shows
        // the filename + language + actions. Keeping the old wrapper
        // would produce the duplicate "artifact-...tex" header.
        if (artifact.kind === "CODE_SNIPPET") {
          return (
            <div key={artifact.id ?? `${artifact.kind}-${artifact.title}`}>
              <ArtifactPreview artifact={artifact} compact={compact} />
            </div>
          );
        }
        return (
          <div
            key={artifact.id ?? `${artifact.kind}-${artifact.title}`}
            className={
              compact
                ? "rounded-lg border border-border/50 bg-background/60 px-3 py-2.5"
                : "rounded-lg border border-border/50 bg-background/60 px-3.5 py-3"
            }
          >
            <ArtifactTitleRow kind={artifact.kind} title={artifact.title} />
            <ArtifactPreview artifact={artifact} compact={compact} />
          </div>
        );
      })}
    </div>
  );
}

function timelineIcon(action: AgentActionSummary) {
  switch (action.tool) {
    case "read_section":
      return FileText;
    case "search_claims":
      return FileSearch;
    case "inspect_table":
      return TableProperties;
    case "open_figure":
    case "list_figures":
      return ImageIcon;
    case "generate_code_snippet":
    case "finish":
      return Sparkles;
    default:
      return Bot;
  }
}

/**
 * Snippet text can arrive with raw HTML/LaTeXML markup from the extractor
 * (e.g. GROBID/ltx_logical-block spans). Strip tags, collapse whitespace,
 * and keep the result at a readable length.
 */
function sanitizeCitationSnippet(raw: string, maxLen = 160): string {
  if (!raw) return "";
  const withoutTags = raw
    // Complete tags
    .replace(/<[^>]+>/g, " ")
    // Unclosed / partial trailing tag that got cut mid-attribute
    .replace(/<[^<>]*$/g, " ");
  const withoutEntities = withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => {
      const num = Number.parseInt(n, 10);
      return Number.isFinite(num) && num > 0 && num < 0x110000
        ? String.fromCodePoint(num)
        : "";
    });
  // Strip markdown heading hashes that often leak into extracted excerpts.
  const demarkdowned = withoutEntities.replace(/(^|\s)#{1,6}\s+/g, "$1");
  const collapsed = demarkdowned.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  const slice = collapsed.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * When the snippet repeats the section label the caller already rendered
 * (e.g. the section header says "TABLE 4" and the excerpt starts with
 * "Table 4 — Table 4: Comparison..."), strip the redundant prefix.
 */
function trimRedundantLabelPrefix(
  snippet: string,
  label: string | null,
): string {
  if (!snippet || !label) return snippet;
  let s = snippet;
  const lower = label.toLowerCase();
  for (let i = 0; i < 3; i++) {
    const trimmed = s.trim();
    const lowerTrimmed = trimmed.toLowerCase();
    if (!lowerTrimmed.startsWith(lower)) break;
    const rest = trimmed.slice(label.length).trimStart();
    // Strip common separators between label repetitions.
    const next = rest.replace(/^[—–\-:·,.]+\s*/, "");
    if (next === trimmed) break;
    s = next;
  }
  return s.trim();
}

/**
 * Shorten a section path like "S5.T4.2" / "results.table-4" into a single
 * human label. Falls back to the raw path if nothing shorter can be derived.
 */
function prettifySectionPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.trim();
  if (!normalized) return null;
  // Common LaTeXML label patterns: Sx.Ty -> "Table y", Sx.Fz -> "Figure z".
  const table = /\bT(\d+)\b/.exec(normalized);
  if (table) return `Table ${table[1]}`;
  const figure = /\bF(\d+)\b/.exec(normalized);
  if (figure) return `Figure ${figure[1]}`;
  // Strip leading "S<digits>." crumbs.
  const stripped = normalized.replace(/^S\d+\./i, "").replace(/[._-]+/g, " ");
  return stripped || normalized;
}

interface SectionBucket {
  label: string | null;
  items: Array<{ citation: AnswerCitation; index: number }>;
}

/**
 * Within one paper group, bucket excerpts by their prettified section label
 * so "TABLE 4" only prints once even when multiple excerpts come from it.
 * Preserves the original citation ordering across buckets by recording the
 * first-seen index.
 */
function bucketBySection(
  items: Array<{ citation: AnswerCitation; index: number }>,
): SectionBucket[] {
  const byLabel = new Map<string, SectionBucket>();
  const order: string[] = [];
  for (const item of items) {
    const label = prettifySectionPath(item.citation.sectionPath);
    const key = label ?? "__none__";
    const existing = byLabel.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      byLabel.set(key, { label, items: [item] });
      order.push(key);
    }
  }
  return order.map((key) => byLabel.get(key)!);
}

function CitationGroups({
  citations,
  compact,
}: {
  citations: AnswerCitation[];
  compact: boolean;
}) {
  // Group consecutive citations from the same paper while preserving the
  // original Sn numbering the answer text references.
  type Group = { paperId: string; paperTitle: string; items: Array<{ citation: AnswerCitation; index: number }> };
  const groups: Group[] = [];
  citations.forEach((citation, index) => {
    const last = groups[groups.length - 1];
    if (last && last.paperId === citation.paperId) {
      last.items.push({ citation, index });
    } else {
      groups.push({
        paperId: citation.paperId,
        paperTitle: citation.paperTitle,
        items: [{ citation, index }],
      });
    }
  });

  const bodyClass = compact
    ? "text-[11px] leading-snug text-muted-foreground"
    : "text-[11.5px] leading-snug text-muted-foreground";

  return (
    <div className="space-y-2">
      {groups.map((group, groupIndex) => {
        const href = buildPaperContextHref(group.paperId, { view: "review" });
        return (
          <section key={`${group.paperId}-${groupIndex}`} className="space-y-1.5">
            <div className="flex items-baseline gap-1.5">
              {href ? (
                <a
                  href={href}
                  onClick={(event) => {
                    if (typeof window === "undefined" || event.defaultPrevented)
                      return;
                    if (window.location.pathname === `/papers/${group.paperId}`) {
                      event.preventDefault();
                      window.dispatchEvent(
                        new CustomEvent("paper:open-artifact", {
                          detail: { paperId: group.paperId, view: "review" },
                        }),
                      );
                    }
                  }}
                  className="truncate text-[12px] font-medium text-foreground/90 decoration-foreground/25 underline-offset-4 hover:underline"
                >
                  {group.paperTitle}
                </a>
              ) : (
                <p className="truncate text-[12px] font-medium text-foreground/90">
                  {group.paperTitle}
                </p>
              )}
              <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground/55">
                {group.items.length === 1
                  ? `S${group.items[0].index + 1}`
                  : `${group.items.length} excerpts`}
              </span>
            </div>
            {bucketBySection(group.items).map((bucket, bucketIdx) => (
              <div
                key={`${group.paperId}-${bucket.label ?? "_"}-${bucketIdx}`}
                className="space-y-0.5"
              >
                {bucket.label ? (
                  <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/65">
                    {bucket.label}
                  </div>
                ) : null}
                <ul className="space-y-0.5">
                  {bucket.items.map(({ citation, index }) => {
                    const snippet = trimRedundantLabelPrefix(
                      sanitizeCitationSnippet(citation.snippet),
                      bucket.label,
                    );
                    if (!snippet) return null;
                    return (
                      <li
                        key={`${citation.paperId}-${index}`}
                        id={`source-${index + 1}`}
                        className={`${bodyClass} grid grid-cols-[16px_1fr] gap-x-2`}
                      >
                        <span className="mt-[2px] text-right font-mono text-[9.5px] tabular-nums text-sky-700/80 dark:text-sky-300/80">
                          {index + 1}
                        </span>
                        <span className="min-w-0 text-muted-foreground">
                          {snippet}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function phaseBadgeLabel(phase: AgentActionSummary["phase"]): string | null {
  switch (phase) {
    case "retrieve":
      return "retrieve";
    case "inspect":
      return "inspect";
    case "synthesize":
      return "synthesize";
    default:
      return null;
  }
}

function evidenceDeltaLabel(action: AgentActionSummary): string | null {
  const parts: string[] = [];
  if ((action.citationsAdded ?? 0) > 0) {
    parts.push(`+${action.citationsAdded} source${action.citationsAdded === 1 ? "" : "s"}`);
  }
  if ((action.artifactsAdded ?? 0) > 0) {
    parts.push(`+${action.artifactsAdded} artifact${action.artifactsAdded === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join("  ") : null;
}

export function ChatMessageSupport({
  citations = [],
  agentActions = [],
  artifacts = [],
  compact = false,
  showArtifacts = true,
}: ChatMessageSupportProps) {
  const visibleArtifacts = showArtifacts ? artifacts : [];
  if (citations.length === 0 && agentActions.length === 0 && visibleArtifacts.length === 0) return null;

  const wrapperClass = compact ? "mt-3" : "mt-4";

  return (
    <div className={wrapperClass}>
      {citations.length > 0 ? (
        <SupportSection
          compact={compact}
          title="Sources"
          count={citations.length}
          tone="citation"
        >
          <CitationGroups citations={citations} compact={compact} />
        </SupportSection>
      ) : null}

      {agentActions.length > 0 ? (
        <SupportSection
          compact={compact}
          title="Reasoning trail"
          count={agentActions.length}
          tone="agent"
        >
          <ol className="relative space-y-1.5 pl-5">
            {/* continuous rail */}
            <span
              aria-hidden
              className="absolute left-[7px] top-1 bottom-1 w-px bg-gradient-to-b from-emerald-400/25 via-border/60 to-transparent"
            />
            {agentActions.map((action, idx) => {
              const Icon = timelineIcon(action);
              const evidenceDelta = evidenceDeltaLabel(action);
              const phaseLabel = phaseBadgeLabel(action.phase);
              const hasExpandedDetail =
                Boolean(action.detail) &&
                action.detail !== action.outputPreview &&
                !compact;
              return (
                <li
                  key={`${action.step}-${action.action}`}
                  className="relative"
                >
                  <span className="absolute -left-5 top-[3px] flex h-[14px] w-[14px] items-center justify-center rounded-full border border-emerald-400/35 bg-background">
                    <Icon className="h-[9px] w-[9px] text-emerald-500/90 dark:text-emerald-300/90" />
                  </span>
                  <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground/55">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <span className="text-[12px] font-medium text-foreground/90">
                      {action.action}
                    </span>
                    {action.input ? (
                      <span className="text-[11px] italic text-muted-foreground/70">
                        · {action.input}
                      </span>
                    ) : null}
                    <span className="ml-auto flex items-baseline gap-1.5">
                      {phaseLabel ? (
                        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-emerald-700/75 dark:text-emerald-300/65">
                          {phaseLabel}
                        </span>
                      ) : null}
                      {action.source === "fallback" ? (
                        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-amber-600/75 dark:text-amber-300/65">
                          fallback
                        </span>
                      ) : null}
                      {action.status === "missing" ? (
                        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-rose-600/75 dark:text-rose-300/65">
                          no hit
                        </span>
                      ) : null}
                    </span>
                  </div>

                  <p
                    className={
                      compact
                        ? "text-[11px] leading-snug text-muted-foreground"
                        : "text-[11.5px] leading-snug text-muted-foreground"
                    }
                  >
                    {action.outputPreview || action.detail}
                    {evidenceDelta ? (
                      <span className="ml-1.5 whitespace-nowrap font-mono text-[10px] text-emerald-700/70 dark:text-emerald-300/60">
                        {evidenceDelta}
                      </span>
                    ) : null}
                  </p>

                  {hasExpandedDetail ? (
                    <details className="group/step mt-0.5">
                      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[10px] text-muted-foreground/65 hover:text-foreground/80">
                        <span className="inline-block transition-transform group-open/step:rotate-90">›</span>
                        details
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded-md border-l-2 border-border/60 bg-muted/15 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
                        {action.detail}
                      </pre>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </SupportSection>
      ) : null}

      {visibleArtifacts.length > 0 ? (
        <SupportSection
          compact={compact}
          title="Artifacts"
          count={visibleArtifacts.length}
          tone="artifact"
        >
          <div className="space-y-2.5">
            {visibleArtifacts.map((artifact, index) => {
              if (artifact.kind === "CODE_SNIPPET") {
                return (
                  <div
                    key={artifact.id ?? `${artifact.kind}-${artifact.title}`}
                    id={`artifact-${index + 1}`}
                  >
                    <ArtifactPreview artifact={artifact} compact={compact} />
                  </div>
                );
              }
              return (
                <div
                  key={artifact.id ?? `${artifact.kind}-${artifact.title}`}
                  id={`artifact-${index + 1}`}
                  className="rounded-lg border border-border/50 bg-background/60 px-3.5 py-3"
                >
                  <ArtifactTitleRow kind={artifact.kind} title={artifact.title} />
                  <ArtifactPreview artifact={artifact} compact={compact} />
                </div>
              );
            })}
          </div>
        </SupportSection>
      ) : null}
    </div>
  );
}
