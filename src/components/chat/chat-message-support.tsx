"use client";

import type { AgentActionSummary, AnswerCitation } from "@/lib/papers/answer-engine/metadata";
import { Badge } from "@/components/ui/badge";
import {
  Bot,
  FileSearch,
  FileText,
  ImageIcon,
  Sparkles,
  TableProperties,
} from "lucide-react";

interface ConversationArtifactRecord {
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
  a.remove();
  URL.revokeObjectURL(url);
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
    const payload = parseJson<{
      figureLabel?: string | null;
      captionText?: string | null;
      description?: string | null;
      imagePath?: string | null;
      pdfPage?: number | null;
    }>(artifact.payloadJson);
    const imageSrc = payload?.imagePath
      ? payload.imagePath.startsWith("/")
        ? payload.imagePath
        : `/${payload.imagePath}`
      : null;
    return (
      <div className="space-y-2">
        {imageSrc ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageSrc}
              alt={payload?.captionText || payload?.figureLabel || artifact.title}
              className="max-h-40 rounded border object-contain bg-muted/30"
            />
            <button
              type="button"
              onClick={() => window.open(imageSrc, "_blank", "noopener,noreferrer")}
              className="text-[10px] font-medium text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
            >
              Open image
            </button>
          </div>
        ) : null}
        {payload?.captionText ? (
          <p className={`${baseClass} text-muted-foreground`}>
            {payload.captionText}
          </p>
        ) : null}
        {payload?.description ? (
          <p className={`${baseClass} text-muted-foreground`}>
            {payload.description}
          </p>
        ) : null}
        {payload?.pdfPage ? (
          <p className={`${baseClass} text-muted-foreground`}>
            PDF page {payload.pdfPage}
          </p>
        ) : null}
      </div>
    );
  }

  if (artifact.kind === "TABLE_CARD") {
    const payload = parseJson<{
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
    }>(artifact.payloadJson);
    const imageSrc = payload?.imagePath
      ? payload.imagePath.startsWith("/")
        ? payload.imagePath
        : `/${payload.imagePath}`
      : null;
    const csv = tableToCsv(payload?.table);
    return (
      <div className="space-y-2">
        {payload?.captionText ? (
          <p className={`${baseClass} text-muted-foreground`}>
            {payload.captionText}
          </p>
        ) : null}
        {payload?.table?.matches?.length ? (
          <div className="space-y-1">
            <p className={`${baseClass} font-medium text-foreground/80`}>
              Matched rows{payload.table.query ? ` for "${payload.table.query}"` : ""}
            </p>
            {payload.table.matches.slice(0, compact ? 1 : 3).map((match, index) => (
              <p
                key={`${artifact.id ?? artifact.title}-match-${index}`}
                className={`${baseClass} text-muted-foreground`}
              >
                Row {match.rowIndex + 1}: {match.values.join(" | ")}
              </p>
            ))}
          </div>
        ) : null}
        {payload?.table?.columns?.length && payload?.table?.rows?.length ? (
          <div className="space-y-2">
            <div className="overflow-x-auto rounded border bg-muted/20">
              <table className="min-w-full border-collapse text-[10px]">
                <thead className="bg-muted/40">
                  <tr>
                    {payload.table.columns.map((column, index) => (
                      <th key={`${artifact.id ?? artifact.title}-col-${index}`} className="border-b px-2 py-1 text-left font-medium">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payload.table.rows.slice(0, compact ? 3 : 6).map((row, rowIndex) => (
                    <tr key={`${artifact.id ?? artifact.title}-row-${rowIndex}`} className="border-b last:border-b-0">
                      {row.map((value, cellIndex) => (
                        <td key={`${artifact.id ?? artifact.title}-cell-${rowIndex}-${cellIndex}`} className="px-2 py-1 text-muted-foreground">
                          {value}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                className="text-[10px] font-medium text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
              >
                Download CSV
              </button>
            ) : null}
          </div>
        ) : null}
        {payload?.description ? (
          <p className={`${baseClass} text-muted-foreground`}>
            {payload.description}
          </p>
        ) : null}
        {imageSrc ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageSrc}
              alt={payload?.captionText || payload?.figureLabel || artifact.title}
              className="max-h-40 rounded border object-contain bg-muted/30"
            />
            <button
              type="button"
              onClick={() => window.open(imageSrc, "_blank", "noopener,noreferrer")}
              className="text-[10px] font-medium text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
            >
              Open image
            </button>
          </div>
        ) : null}
        {payload?.pdfPage ? (
          <p className={`${baseClass} text-muted-foreground`}>
            PDF page {payload.pdfPage}
          </p>
        ) : null}
      </div>
    );
  }

  if (artifact.kind === "CODE_SNIPPET") {
    const payload = parseJson<{
      summary?: string | null;
      code?: string | null;
      filename?: string | null;
      language?: string | null;
      assumptions?: string[] | null;
    }>(artifact.payloadJson);
    return (
      <div className="space-y-2">
        {payload?.summary ? (
          <p className={`${baseClass} text-muted-foreground`}>{payload.summary}</p>
        ) : null}
        <div className="flex items-center gap-2">
          {payload?.filename ? (
            <p className={`${baseClass} text-muted-foreground`}>{payload.filename}</p>
          ) : null}
          {payload?.language ? (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {payload.language}
            </Badge>
          ) : null}
          {payload?.code && payload?.filename ? (
            <button
              type="button"
              onClick={() => downloadText(payload.filename!, payload.code!)}
              className="text-[10px] font-medium text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
            >
              Download
            </button>
          ) : null}
        </div>
        {payload?.code ? (
          <pre className="overflow-x-auto rounded border bg-muted/40 p-2 text-[10px] text-muted-foreground">
            {payload.code}
          </pre>
        ) : null}
        {(payload?.assumptions ?? []).length > 0 ? (
          <div className="space-y-1">
            {(payload?.assumptions ?? []).slice(0, compact ? 2 : 3).map((assumption, index) => (
              <p
                key={`${artifact.id ?? artifact.title}-assumption-${index}`}
                className={`${baseClass} text-muted-foreground`}
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

  const wrapperClass = compact ? "mt-2 space-y-2" : "mt-3 space-y-3";

  return (
    <div className={wrapperClass}>
      {citations.length > 0 ? (
        <div className="space-y-1.5">
          <p className={compact ? "text-[10px] font-medium text-muted-foreground" : "text-[11px] font-medium text-muted-foreground"}>
            Sources
          </p>
          <div className="space-y-1.5">
            {citations.map((citation, index) => (
              <div
                key={`${citation.paperId}-${index}`}
                className="rounded-md border bg-background/70 px-2.5 py-2"
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                    S{index + 1}
                  </Badge>
                  <p className={compact ? "text-[10px] font-medium" : "text-[11px] font-medium"}>
                    {citation.paperTitle}
                  </p>
                </div>
                <p className={compact ? "text-[10px] text-muted-foreground" : "text-[11px] text-muted-foreground"}>
                  {citation.snippet}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {agentActions.length > 0 ? (
        <div className="space-y-2">
          <p className={compact ? "text-[10px] font-medium text-muted-foreground" : "text-[11px] font-medium text-muted-foreground"}>
            Agent Timeline
          </p>
          <div className="relative space-y-2">
            <div className="absolute bottom-0 left-[11px] top-1 hidden w-px bg-border/80 sm:block" />
            {agentActions.map((action) => {
              const Icon = timelineIcon(action);
              const evidenceDelta = evidenceDeltaLabel(action);
              const phaseLabel = phaseBadgeLabel(action.phase);
              const hasExpandedDetail =
                Boolean(action.detail)
                && action.detail !== action.outputPreview
                && !compact;
              return (
                <div key={`${action.step}-${action.action}`} className="relative pl-0 sm:pl-7">
                  <div className="absolute left-0 top-2 hidden h-6 w-6 items-center justify-center rounded-full border bg-background sm:flex">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className="rounded-md border bg-background/70 px-2.5 py-2">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                        step {action.step}
                      </Badge>
                      {phaseLabel ? (
                        <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                          {phaseLabel}
                        </Badge>
                      ) : null}
                      {action.source === "fallback" ? (
                        <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                          fallback
                        </Badge>
                      ) : null}
                      {action.status === "missing" ? (
                        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                          no hit
                        </Badge>
                      ) : null}
                      <p className={compact ? "text-[10px] font-medium" : "text-[11px] font-medium"}>
                        {action.action}
                      </p>
                    </div>

                    {action.input ? (
                      <p className={compact ? "mb-1 text-[10px] text-muted-foreground" : "mb-1 text-[11px] text-muted-foreground"}>
                        Input: {action.input}
                      </p>
                    ) : null}

                    <p className={compact ? "text-[10px] text-muted-foreground" : "text-[11px] text-muted-foreground"}>
                      {action.outputPreview || action.detail}
                    </p>

                    {evidenceDelta ? (
                      <p className={compact ? "mt-1 text-[10px] text-muted-foreground" : "mt-1 text-[11px] text-muted-foreground"}>
                        {evidenceDelta}
                      </p>
                    ) : null}

                    {hasExpandedDetail ? (
                      <details className="mt-2">
                        <summary className={compact ? "cursor-pointer text-[10px] text-muted-foreground" : "cursor-pointer text-[11px] text-muted-foreground"}>
                          Show step details
                        </summary>
                        <pre className="mt-2 whitespace-pre-wrap rounded border bg-muted/20 p-2 text-[10px] text-muted-foreground">
                          {action.detail}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {artifacts.length > 0 ? (
        <div className="space-y-1.5">
          <p className={compact ? "text-[10px] font-medium text-muted-foreground" : "text-[11px] font-medium text-muted-foreground"}>
            Artifacts
          </p>
          <div className="space-y-1.5">
            {artifacts.map((artifact) => (
              <div
                key={artifact.id ?? `${artifact.kind}-${artifact.title}`}
                className="rounded-md border bg-background/70 px-2.5 py-2"
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                    {artifact.kind.toLowerCase()}
                  </Badge>
                  <p className={compact ? "text-[10px] font-medium" : "text-[11px] font-medium"}>
                    {artifact.title}
                  </p>
                </div>
                <ArtifactPreview artifact={artifact} compact={compact} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
