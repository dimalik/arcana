"use client";
import type { AgentActionSummary, AnswerCitation } from "@/lib/papers/answer-engine/metadata";
import { Badge } from "@/components/ui/badge";
import {
  ArrowUpRight,
  Bot,
  Braces,
  ChevronDown,
  Download,
  FileSearch,
  FileText,
  ImageIcon,
  Quote,
  Sparkles,
  TableProperties,
  Waypoints,
} from "lucide-react";

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
      className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[10px] font-medium text-foreground/75 transition-colors hover:bg-accent hover:text-foreground"
    >
      <ArrowUpRight className="h-3 w-3" />
      Open in paper
    </button>
  );
}

function sectionTitleClass(compact: boolean) {
  return compact
    ? "text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70"
    : "text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/70";
}

function sectionBodyClass(compact: boolean) {
  return compact ? "rounded-xl border border-border/50 bg-muted/15 p-2.5" : "rounded-2xl border border-border/50 bg-muted/15 p-3";
}

function SupportSection({
  compact,
  title,
  count,
  icon: Icon,
  children,
}: {
  compact: boolean;
  title: string;
  count: number;
  icon: typeof Quote;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-2xl border border-border/50 bg-muted/10">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground/70" />
        <p className={sectionTitleClass(compact)}>{title}</p>
        <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">
          {count}
        </Badge>
        <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground/70 transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-3 pb-3">
        {children}
      </div>
    </details>
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
      <div className="space-y-3">
        {imageSrc ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageSrc}
              alt={payload?.captionText || payload?.figureLabel || artifact.title}
              className="max-h-44 w-full rounded-xl border border-border/60 object-contain bg-background/80"
            />
          </div>
        ) : null}
        {payload?.captionText ? (
          <p className={`${baseClass} leading-5 text-muted-foreground`}>
            {payload.captionText}
          </p>
        ) : null}
        {payload?.description ? (
          <p className={`${baseClass} leading-5 text-muted-foreground`}>
            {payload.description}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {payload?.pdfPage ? (
            <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">
              PDF page {payload.pdfPage}
            </Badge>
          ) : null}
          <OpenInPaperButton
            paperId={payload?.paperId}
            pdfPage={payload?.pdfPage}
            view="results"
          />
          {payload?.paperId ? (
            <a
              href={buildPaperPdfHref(payload.paperId, payload.pdfPage) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[10px] font-medium text-foreground/75 transition-colors hover:bg-accent hover:text-foreground"
            >
              <FileText className="h-3 w-3" />
              Open PDF
            </a>
          ) : null}
          {imageSrc ? (
            <a
              href={imageSrc}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[10px] font-medium text-foreground/75 transition-colors hover:bg-accent hover:text-foreground"
            >
              <ImageIcon className="h-3 w-3" />
              Open image
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  if (artifact.kind === "TABLE_CARD") {
    const payload = parseJson<VisualArtifactPayload>(artifact.payloadJson);
    const imageSrc = buildPaperAssetUrl(payload?.paperId, payload?.imagePath);
    const csv = tableToCsv(payload?.table);
    return (
      <div className="space-y-3">
        {payload?.captionText ? (
          <p className={`${baseClass} leading-5 text-muted-foreground`}>
            {payload.captionText}
          </p>
        ) : null}
        {payload?.table?.matches?.length ? (
          <div className="space-y-1.5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-2.5">
            <p className={`${baseClass} font-medium text-foreground/80`}>
              Matched rows{payload.table.query ? ` for "${payload.table.query}"` : ""}
            </p>
            {payload.table.matches.slice(0, compact ? 1 : 3).map((match, index) => (
              <p
                key={`${artifact.id ?? artifact.title}-match-${index}`}
                className={`${baseClass} leading-5 text-muted-foreground`}
              >
                Row {match.rowIndex + 1}: {match.values.join(" | ")}
              </p>
            ))}
          </div>
        ) : null}
        {payload?.table?.columns?.length && payload?.table?.rows?.length ? (
          <div className="space-y-2">
            <div className="overflow-x-auto rounded-xl border border-border/60 bg-background/80">
              <table className="min-w-full border-collapse text-[10px]">
                <thead className="bg-muted/30">
                  <tr>
                    {payload.table.columns.map((column, index) => (
                      <th key={`${artifact.id ?? artifact.title}-col-${index}`} className="border-b border-border/60 px-2 py-1.5 text-left font-medium text-foreground/80">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payload.table.rows.slice(0, compact ? 3 : 6).map((row, rowIndex) => (
                    <tr key={`${artifact.id ?? artifact.title}-row-${rowIndex}`} className="border-b border-border/40 last:border-b-0">
                      {row.map((value, cellIndex) => (
                        <td key={`${artifact.id ?? artifact.title}-cell-${rowIndex}-${cellIndex}`} className="px-2 py-1.5 align-top text-muted-foreground">
                          {value}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {payload?.description ? (
          <p className={`${baseClass} leading-5 text-muted-foreground`}>
            {payload.description}
          </p>
        ) : null}
        {imageSrc ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageSrc}
              alt={payload?.captionText || payload?.figureLabel || artifact.title}
              className="max-h-44 w-full rounded-xl border border-border/60 object-contain bg-background/80"
            />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {payload?.pdfPage ? (
            <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">
              PDF page {payload.pdfPage}
            </Badge>
          ) : null}
          <OpenInPaperButton
            paperId={payload?.paperId}
            pdfPage={payload?.pdfPage}
            view="results"
          />
          {payload?.paperId ? (
            <a
              href={buildPaperPdfHref(payload.paperId, payload.pdfPage) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[10px] font-medium text-foreground/75 transition-colors hover:bg-accent hover:text-foreground"
            >
              <FileText className="h-3 w-3" />
              Open PDF
            </a>
          ) : null}
          {imageSrc ? (
            <a
              href={imageSrc}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[10px] font-medium text-foreground/75 transition-colors hover:bg-accent hover:text-foreground"
            >
              <ImageIcon className="h-3 w-3" />
              Open image
            </a>
          ) : null}
          {csv ? (
            <button
              type="button"
              onClick={() =>
                downloadText(
                  `${(payload?.figureLabel || artifact.title || "table").replace(/\s+/g, "_").toLowerCase()}.csv`,
                  csv,
                  "text/csv",
                )
              }
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[10px] font-medium text-foreground/75 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Download className="h-3 w-3" />
              Download CSV
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (artifact.kind === "CODE_SNIPPET") {
    const payload = parseJson<CodeArtifactPayload>(artifact.payloadJson);
    return (
      <div className="space-y-3">
        {payload?.summary ? (
          <p className={`${baseClass} leading-5 text-muted-foreground`}>{payload.summary}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {payload?.filename ? (
            <p className={`${baseClass} text-muted-foreground`}>{payload.filename}</p>
          ) : null}
          {payload?.language ? (
            <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">
              {payload.language}
            </Badge>
          ) : null}
          {payload?.code && payload?.filename ? (
            <button
              type="button"
              onClick={() => downloadText(payload.filename!, payload.code!)}
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[10px] font-medium text-foreground/75 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Download className="h-3 w-3" />
              Download
            </button>
          ) : null}
        </div>
        {payload?.code ? (
          <pre className="overflow-x-auto rounded-xl border border-border/60 bg-background/90 p-3 text-[10px] leading-5 text-muted-foreground">
            {payload.code}
          </pre>
        ) : null}
        {(payload?.assumptions ?? []).length > 0 ? (
          <div className="space-y-1.5 rounded-xl border border-border/50 bg-muted/20 p-2.5">
            {(payload?.assumptions ?? []).slice(0, compact ? 2 : 3).map((assumption, index) => (
              <p
                key={`${artifact.id ?? artifact.title}-assumption-${index}`}
                className={`${baseClass} leading-5 text-muted-foreground`}
              >
                Assumption: {assumption}
              </p>
            ))}
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
}: ChatMessageSupportProps) {
  if (citations.length === 0 && agentActions.length === 0 && artifacts.length === 0) return null;

  const wrapperClass = compact ? "mt-2 space-y-2.5" : "mt-3 space-y-3.5";

  return (
    <div className={wrapperClass}>
      {citations.length > 0 ? (
        <SupportSection compact={compact} title="Sources" count={citations.length} icon={Quote}>
          <div className={`${sectionBodyClass(compact)} space-y-2`}>
            {citations.map((citation, index) => (
              <div
                key={`${citation.paperId}-${index}`}
                id={`source-${index + 1}`}
                className="rounded-xl border border-border/50 bg-background/80 px-3 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.02)]"
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">
                    S{index + 1}
                  </Badge>
                  {citation.sectionPath ? (
                    <Badge variant="outline" className="h-5 rounded-full px-2 text-[10px]">
                      {citation.sectionPath}
                    </Badge>
                  ) : null}
                  <p className={compact ? "text-[10px] font-medium text-foreground/85" : "text-[11px] font-medium text-foreground/85"}>
                    {citation.paperTitle}
                  </p>
                </div>
                <p className={compact ? "text-[10px] leading-5 text-muted-foreground" : "text-[11px] leading-5 text-muted-foreground"}>
                  {citation.snippet}
                </p>
              </div>
            ))}
          </div>
        </SupportSection>
      ) : null}

      {agentActions.length > 0 ? (
        <SupportSection compact={compact} title="Agent Timeline" count={agentActions.length} icon={Waypoints}>
          <div className={`${sectionBodyClass(compact)} relative space-y-2`}>
            <div className="absolute bottom-3 left-[17px] top-3 hidden w-px bg-border/60 sm:block" />
            {agentActions.map((action) => {
              const Icon = timelineIcon(action);
              const evidenceDelta = evidenceDeltaLabel(action);
              const phaseLabel = phaseBadgeLabel(action.phase);
              const hasExpandedDetail =
                Boolean(action.detail)
                && action.detail !== action.outputPreview
                && !compact;
              return (
                <div key={`${action.step}-${action.action}`} className="relative pl-0 sm:pl-10">
                  <div className="absolute left-0 top-2 hidden h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-background sm:flex">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground/75" />
                  </div>
                  <div className="rounded-xl border border-border/50 bg-background/80 px-3 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="h-5 rounded-full px-2 text-[10px]">
                        step {action.step}
                      </Badge>
                      {phaseLabel ? (
                        <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">
                          {phaseLabel}
                        </Badge>
                      ) : null}
                      {action.source === "fallback" ? (
                        <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">
                          fallback
                        </Badge>
                      ) : null}
                      {action.status === "missing" ? (
                        <Badge variant="outline" className="h-5 rounded-full px-2 text-[10px]">
                          no hit
                        </Badge>
                      ) : null}
                      <p className={compact ? "text-[10px] font-medium text-foreground/85" : "text-[11px] font-medium text-foreground/85"}>
                        {action.action}
                      </p>
                    </div>

                    {action.input ? (
                      <p className={compact ? "mb-1 text-[10px] leading-5 text-muted-foreground" : "mb-1 text-[11px] leading-5 text-muted-foreground"}>
                        Input: {action.input}
                      </p>
                    ) : null}

                    <p className={compact ? "text-[10px] leading-5 text-muted-foreground" : "text-[11px] leading-5 text-muted-foreground"}>
                      {action.outputPreview || action.detail}
                    </p>

                    {evidenceDelta ? (
                      <p className={compact ? "mt-1.5 text-[10px] text-muted-foreground/80" : "mt-1.5 text-[11px] text-muted-foreground/80"}>
                        {evidenceDelta}
                      </p>
                    ) : null}

                    {hasExpandedDetail ? (
                      <details className="mt-2">
                        <summary className={compact ? "cursor-pointer text-[10px] text-muted-foreground" : "cursor-pointer text-[11px] text-muted-foreground"}>
                          Show step details
                        </summary>
                        <pre className="mt-2 whitespace-pre-wrap rounded-xl border border-border/50 bg-muted/20 p-2.5 text-[10px] leading-5 text-muted-foreground">
                          {action.detail}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </SupportSection>
      ) : null}

      {artifacts.length > 0 ? (
        <SupportSection compact={compact} title="Artifacts" count={artifacts.length} icon={Braces}>
          <div className={`${sectionBodyClass(compact)} space-y-2`}>
            {artifacts.map((artifact, index) => (
              <div
                key={artifact.id ?? `${artifact.kind}-${artifact.title}`}
                id={`artifact-${index + 1}`}
                className="rounded-xl border border-border/50 bg-background/80 px-3 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.02)]"
              >
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="h-5 rounded-full px-2 text-[10px]">
                    {artifact.kind.toLowerCase().replace(/_/g, " ")}
                  </Badge>
                  <p className={compact ? "text-[10px] font-medium text-foreground/85" : "text-[11px] font-medium text-foreground/85"}>
                    {artifact.title}
                  </p>
                </div>
                <ArtifactPreview artifact={artifact} compact={compact} />
              </div>
            ))}
          </div>
        </SupportSection>
      ) : null}
    </div>
  );
}
