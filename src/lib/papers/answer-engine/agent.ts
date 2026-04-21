import type {
  ConversationArtifactKind,
  PaperClaimEvidenceType,
} from "@/generated/prisma/client";
import { FIGURE_VIEW_SELECT, mapPaperFiguresToView, type PaperFigureView } from "@/lib/figures/read-model";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import {
  generateStructuredObject,
} from "@/lib/llm/provider";
import {
  paperAnswerAgentActionRuntimeOutputSchema,
  paperAnswerCodeArtifactRuntimeOutputSchema,
  type PaperAnswerAgentActionRuntimeOutput,
  type PaperAnswerCodeArtifactRuntimeOutput,
} from "@/lib/llm/runtime-output-schemas";
import type { LLMProvider } from "@/lib/llm/models";
import type { ProxyConfig } from "@/lib/llm/proxy-settings";
import { normalizeAnalysisText } from "@/lib/papers/analysis/normalization/text";
import { parseSummarySections } from "@/lib/papers/parse-sections";
import { prisma } from "@/lib/prisma";

import type { PaperClaimView } from "../analysis/store";

import type {
  AgentActionSummary,
  AnswerCitation,
  PaperAnswerIntent,
} from "./metadata";

const NON_ASSERTIVE_EVIDENCE_TYPES = new Set<PaperClaimEvidenceType>(["CITING"]);
const STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "does",
  "from",
  "have",
  "into",
  "just",
  "like",
  "more",
  "most",
  "paper",
  "papers",
  "that",
  "their",
  "them",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

const MAX_AGENT_STEPS = 4;
const MAX_SECTION_CHARS = 1800;
const MAX_CITATION_SNIPPET_CHARS = 320;

export interface PaperAgentPaperContext {
  id: string;
  title: string;
  year: number | null;
  abstract: string | null;
  summary: string | null;
  keyFindings: string | null;
  fullText: string | null;
  claims: PaperClaimView[];
}

export interface PaperAgentArtifactDraft {
  kind: ConversationArtifactKind;
  title: string;
  payloadJson: string;
}

export interface PreparedPaperAgentEvidence {
  citations: AnswerCitation[];
  artifacts: PaperAgentArtifactDraft[];
  actions: AgentActionSummary[];
}

type SummarySectionName = "overview" | "methodology" | "results";

interface SectionSnapshot {
  section: SummarySectionName;
  text: string;
}

interface AgentObservation {
  step: number;
  action: string;
  detail: string;
}

interface CodeSnippetArtifactPayload {
  summary: string;
  filename: string;
  language: string;
  code: string;
  assumptions: string[];
}

function tokenize(value: string): string[] {
  return normalizeAnalysisText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function truncate(value: string | null | undefined, maxChars: number): string {
  if (!value) return "";
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

function parseKeyFindings(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function buildSectionSnapshots(paper: PaperAgentPaperContext): Record<SummarySectionName, string> {
  const fromSummary = paper.summary ? parseSummarySections(paper.summary) : {
    overview: "",
    methodology: "",
    results: "",
  };

  return {
    overview:
      fromSummary.overview
      || paper.abstract
      || parseKeyFindings(paper.keyFindings).join("\n")
      || extractFullTextSection(paper.fullText, [
        "abstract",
        "introduction",
        "overview",
      ]),
    methodology:
      fromSummary.methodology
      || extractFullTextSection(paper.fullText, [
        "method",
        "methods",
        "methodology",
        "approach",
        "implementation",
      ]),
    results:
      fromSummary.results
      || extractFullTextSection(paper.fullText, [
        "results",
        "experiments",
        "evaluation",
        "analysis",
        "ablation",
      ]),
  };
}

function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const normalized = trimmed.replace(/^[\d.\s]+/, "").toLowerCase();
  return [
    "abstract",
    "introduction",
    "background",
    "related work",
    "method",
    "methods",
    "methodology",
    "approach",
    "implementation",
    "results",
    "experiments",
    "evaluation",
    "analysis",
    "discussion",
    "limitations",
    "conclusion",
    "appendix",
    "references",
    "acknowledgments",
    "ablation",
  ].some((heading) => normalized === heading || normalized.startsWith(`${heading} `));
}

function extractFullTextSection(
  fullText: string | null,
  headings: string[],
): string {
  if (!fullText) return "";
  const lines = fullText.split(/\r?\n/);
  const normalizedTargets = new Set(headings.map((heading) => heading.toLowerCase()));

  let startIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const normalized = lines[i]?.trim().replace(/^[\d.\s]+/, "").toLowerCase() ?? "";
    if (normalizedTargets.has(normalized)) {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    return "";
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (looksLikeHeading(lines[i] ?? "")) {
      endIndex = i;
      break;
    }
  }

  const section = lines.slice(startIndex, endIndex).join("\n").trim();
  return truncate(section, MAX_SECTION_CHARS);
}

function rankClaimsForQuery(
  claims: PaperClaimView[],
  query: string,
  limit: number,
): PaperClaimView[] {
  const queryTokens = new Set(tokenize(query));
  return claims
    .filter((claim) => !NON_ASSERTIVE_EVIDENCE_TYPES.has(claim.evidenceType))
    .map((claim) => {
      const text = `${claim.text} ${claim.sourceExcerpt} ${claim.sectionPath}`.trim();
      const tokens = tokenize(text);
      let score = claim.confidence;
      for (const token of Array.from(queryTokens)) {
        if (tokens.includes(token)) {
          score += 2;
        } else if (text.toLowerCase().includes(token)) {
          score += 1;
        }
      }

      if (claim.sectionPath?.includes("results")) score += 0.35;
      if (claim.sectionPath?.includes("method")) score += 0.35;
      if (claim.evidenceType === "PRIMARY") score += 0.5;
      return { claim, score };
    })
    .sort((left, right) => right.score - left.score || left.claim.orderIndex - right.claim.orderIndex)
    .slice(0, limit)
    .map((entry) => entry.claim);
}

function citationForSection(
  paper: PaperAgentPaperContext,
  section: SummarySectionName,
  text: string,
): AnswerCitation {
  return {
    paperId: paper.id,
    paperTitle: paper.title,
    snippet: truncate(text, MAX_CITATION_SNIPPET_CHARS),
    sectionPath: section,
    sourceKind: "summary",
  };
}

function citationForClaim(
  paper: PaperAgentPaperContext,
  claim: PaperClaimView,
): AnswerCitation {
  return {
    paperId: paper.id,
    paperTitle: paper.title,
    snippet: truncate(claim.sourceExcerpt || claim.text, MAX_CITATION_SNIPPET_CHARS),
    sectionPath: claim.sectionPath,
    sourceKind: "claim",
  };
}

function citationForFigure(
  paper: PaperAgentPaperContext,
  figure: PaperFigureView,
): AnswerCitation {
  return {
    paperId: paper.id,
    paperTitle: paper.title,
    snippet: truncate(
      [figure.figureLabel, figure.captionText, figure.description]
        .filter(Boolean)
        .join(" — "),
      MAX_CITATION_SNIPPET_CHARS,
    ),
    sectionPath: figure.figureLabel,
    sourceKind: "artifact",
  };
}

function normalizeFigureTarget(value: string): string {
  return normalizeAnalysisText(value)
    .replace(/\bfig\b/g, "figure")
    .replace(/\s+/g, " ")
    .trim();
}

function filterFigures(
  figures: PaperFigureView[],
  kind: "figure" | "table" | "any",
  query?: string,
): PaperFigureView[] {
  const filteredKind = kind === "any"
    ? figures
    : figures.filter((figure) => (kind === "table" ? figure.type === "table" : figure.type !== "table"));

  if (!query) {
    return filteredKind;
  }

  const queryTokens = tokenize(query);
  const scored = filteredKind.map((figure) => {
    const haystack = normalizeAnalysisText(
      `${figure.figureLabel ?? ""} ${figure.captionText ?? ""} ${figure.description ?? ""}`,
    );
    let score = 0;
    for (const token of queryTokens) {
      if (haystack.includes(token)) score += 2;
    }
    if (kind === "table" && /result|metric|benchmark|ablation|score/.test(query.toLowerCase())) {
      score += 1;
    }
    return { figure, score };
  });

  const matching = scored.filter((entry) => entry.score > 0);
  return (matching.length > 0 ? matching : scored)
    .sort((left, right) => right.score - left.score || left.figure.figureIndex - right.figure.figureIndex)
    .map((entry) => entry.figure);
}

function resolveFigureTarget(
  figures: PaperFigureView[],
  target: string,
): PaperFigureView | null {
  const normalizedTarget = normalizeFigureTarget(target);
  const exact = figures.find((figure) =>
    normalizeFigureTarget(
      `${figure.figureLabel ?? ""} ${figure.captionText ?? ""}`,
    ) === normalizedTarget
    || figure.id === target,
  );
  if (exact) return exact;

  const candidates = figures
    .map((figure) => {
      const haystack = normalizeFigureTarget(
        `${figure.figureLabel ?? ""} ${figure.captionText ?? ""} ${figure.description ?? ""}`,
      );
      let score = 0;
      for (const token of normalizedTarget.split(" ")) {
        if (!token) continue;
        if (haystack.includes(token)) score += 1;
      }
      return { figure, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.figure.figureIndex - right.figure.figureIndex);

  return candidates[0]?.figure ?? null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildResultArtifact(
  paper: PaperAgentPaperContext,
  resultsText: string,
  supportingClaims: PaperClaimView[],
): PaperAgentArtifactDraft {
  return {
    kind: "RESULT_SUMMARY",
    title: "Results section",
    payloadJson: JSON.stringify({
      paperId: paper.id,
      paperTitle: paper.title,
      excerpt: truncate(resultsText, 1200),
      claims: supportingClaims.slice(0, 3).map((claim) => ({
        text: claim.text,
        sectionPath: claim.sectionPath,
      })),
    }),
  };
}

function buildFigureArtifact(
  figure: PaperFigureView,
): PaperAgentArtifactDraft {
  return {
    kind: figure.type === "table" ? "TABLE_CARD" : "FIGURE_CARD",
    title: figure.figureLabel || (figure.type === "table" ? "Table" : "Figure"),
    payloadJson: JSON.stringify({
      figureId: figure.id,
      paperId: figure.paperId,
      figureLabel: figure.figureLabel,
      captionText: figure.captionText,
      description:
        figure.type === "table"
          ? truncate(stripHtml(figure.description || ""), 1200)
          : truncate(figure.description, 600),
      type: figure.type,
      imagePath: figure.imagePath,
      pdfPage: figure.pdfPage,
      sourceUrl: figure.sourceUrl,
    }),
  };
}

function buildCodeArtifact(
  payload: CodeSnippetArtifactPayload,
): PaperAgentArtifactDraft {
  return {
    kind: "CODE_SNIPPET",
    title: payload.filename,
    payloadJson: JSON.stringify(payload),
  };
}

function formatFigureInventory(figures: PaperFigureView[]): string {
  if (figures.length === 0) return "none";
  return figures
    .slice(0, 12)
    .map((figure) =>
      `${figure.figureLabel || figure.id} (${figure.type}${figure.pdfPage ? `, p.${figure.pdfPage}` : ""})${figure.captionText ? ` — ${truncate(figure.captionText, 120)}` : ""}`,
    )
    .join("\n");
}

function formatObservations(observations: AgentObservation[]): string {
  if (observations.length === 0) {
    return "No tool observations yet.";
  }
  return observations
    .map(
      (observation) =>
        `Step ${observation.step}: ${observation.action}\n${truncate(observation.detail, 500)}`,
    )
    .join("\n\n");
}

function buildPlannerPrompt(params: {
  paper: PaperAgentPaperContext;
  question: string;
  intent: PaperAnswerIntent;
  selectedText: string | null;
  sections: Record<SummarySectionName, string>;
  figures: PaperFigureView[];
  observations: AgentObservation[];
}): string {
  const sectionAvailability = (["overview", "methodology", "results"] as const)
    .map((section) => `${section}: ${params.sections[section] ? "available" : "missing"}`)
    .join(", ");
  const figureInventory = formatFigureInventory(
    params.figures.filter((figure) => figure.type !== "table"),
  );
  const tableInventory = formatFigureInventory(
    params.figures.filter((figure) => figure.type === "table"),
  );

  return `You are a bounded paper-chat agent. Decide the next best tool call to answer the user's question about a single paper.

Paper: ${params.paper.title}${params.paper.year ? ` (${params.paper.year})` : ""}
Intent: ${params.intent}
Question: ${params.question}
${params.selectedText ? `Selected text:\n${truncate(params.selectedText, 800)}\n` : ""}

Available tools:
- read_section(section): use for overview, methodology, or results
- search_claims(query, limit): use to recover grounded claim excerpts
- list_figures(kind, query, limit): use to inspect available figures or tables
- open_figure(target): use to open one figure/table by label, id, or descriptive target
- finish(answerPlan): use only after enough evidence is gathered

Tool-use policy:
- Prefer results and tables for metric/performance questions.
- Prefer methodology and claims for implementation or snippet questions.
- Prefer figures when the user asks to show, inspect, or explain a figure/diagram/table.
- Do not loop. Gather the minimum evidence required, then finish.

Section availability: ${sectionAvailability}

Available figures:
${figureInventory}

Available tables:
${tableInventory}

Current observations:
${formatObservations(params.observations)}`;
}

async function chooseNextAgentAction(params: {
  paper: PaperAgentPaperContext;
  question: string;
  intent: PaperAnswerIntent;
  selectedText: string | null;
  sections: Record<SummarySectionName, string>;
  figures: PaperFigureView[];
  observations: AgentObservation[];
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
}): Promise<PaperAnswerAgentActionRuntimeOutput> {
  return withPaperLlmContext(
    {
      operation: PAPER_INTERACTIVE_LLM_OPERATIONS.CHAT_AGENT_PLAN,
      paperId: params.paper.id,
      userId: params.userId,
      runtime: "interactive",
      source: "papers.answer_engine.agent",
      metadata: {
        intent: params.intent,
        observationCount: params.observations.length,
      },
    },
    async () => {
      const { object } = await generateStructuredObject({
        provider: params.provider,
        modelId: params.modelId,
        proxyConfig: params.proxyConfig ?? undefined,
        schema: paperAnswerAgentActionRuntimeOutputSchema,
        schemaName: "paperAnswerAgentAction",
        maxTokens: 400,
        system:
          "Return only the next tool action as structured output. Never answer the user directly here.",
        prompt: buildPlannerPrompt(params),
      });
      return object;
    },
  );
}

async function loadPaperFigures(paperId: string): Promise<PaperFigureView[]> {
  const figures = await prisma.paperFigure.findMany({
    select: FIGURE_VIEW_SELECT,
    where: {
      paperId,
      isPrimaryExtraction: true,
    },
    orderBy: [{ pdfPage: "asc" }, { figureIndex: "asc" }],
  });
  return mapPaperFiguresToView(figures);
}

function buildCodeArtifactPrompt(params: {
  paper: PaperAgentPaperContext;
  question: string;
  selectedText: string | null;
  citations: AnswerCitation[];
  artifacts: PaperAgentArtifactDraft[];
  observations: AgentObservation[];
}): string {
  const evidenceLines = params.citations
    .slice(0, 8)
    .map(
      (citation, index) =>
        `[S${index + 1}] ${citation.paperTitle}${citation.sectionPath ? ` / ${citation.sectionPath}` : ""}\n${citation.snippet}`,
    )
    .join("\n\n");
  const artifactLines = params.artifacts
    .map((artifact, index) => `Artifact ${index + 1} (${artifact.kind}): ${artifact.title}\n${artifact.payloadJson}`)
    .join("\n\n");

  return `Create a concise, useful code snippet artifact derived from the paper evidence below.

Paper: ${params.paper.title}${params.paper.year ? ` (${params.paper.year})` : ""}
Question: ${params.question}
${params.selectedText ? `Selected text:\n${truncate(params.selectedText, 800)}\n\n` : ""}Rules:
- The code must be a derived implementation sketch, not a claim of verbatim paper code.
- Keep it compact and runnable-looking.
- Reference the method or result the snippet is based on in the summary.
- If critical details are missing, make assumptions explicit in the assumptions array.
- Prefer Python unless the request strongly implies another language.

Observations:
${formatObservations(params.observations)}

Retrieved sources:
${evidenceLines || "No grounded citations were available."}

Structured artifacts:
${artifactLines || "No structured artifacts attached."}`;
}

async function generateCodeSnippetArtifact(params: {
  paper: PaperAgentPaperContext;
  question: string;
  selectedText: string | null;
  citations: AnswerCitation[];
  artifacts: PaperAgentArtifactDraft[];
  observations: AgentObservation[];
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
}): Promise<CodeSnippetArtifactPayload | null> {
  return withPaperLlmContext(
    {
      operation: PAPER_INTERACTIVE_LLM_OPERATIONS.CHAT_AGENT_CODE,
      paperId: params.paper.id,
      userId: params.userId,
      runtime: "interactive",
      source: "papers.answer_engine.code_artifact",
    },
    async () => {
      const { object } = await generateStructuredObject({
        provider: params.provider,
        modelId: params.modelId,
        proxyConfig: params.proxyConfig ?? undefined,
        schema: paperAnswerCodeArtifactRuntimeOutputSchema,
        schemaName: "paperAnswerCodeArtifact",
        maxTokens: 1200,
        system:
          "Return one compact code artifact as structured output. Do not add prose outside the schema.",
        prompt: buildCodeArtifactPrompt(params),
      });

      if (!object.code?.trim()) {
        return null;
      }
      return object;
    },
  );
}

function dedupeCitations(citations: AnswerCitation[]): AnswerCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = [
      citation.paperId,
      citation.sourceKind,
      citation.sectionPath ?? "",
      citation.snippet,
    ].join("::");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeArtifacts(artifacts: PaperAgentArtifactDraft[]): PaperAgentArtifactDraft[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.kind}::${artifact.title}::${artifact.payloadJson}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function preparePaperAgentEvidence(params: {
  paper: PaperAgentPaperContext;
  question: string;
  intent: PaperAnswerIntent;
  selectedText: string | null;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
}): Promise<PreparedPaperAgentEvidence> {
  const sections = buildSectionSnapshots(params.paper);
  const figures = await loadPaperFigures(params.paper.id);
  const citations: AnswerCitation[] = [];
  const artifacts: PaperAgentArtifactDraft[] = [];
  const observations: AgentObservation[] = [];

  for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
    const action = await chooseNextAgentAction({
      paper: params.paper,
      question: params.question,
      intent: params.intent,
      selectedText: params.selectedText,
      sections,
      figures,
      observations,
      provider: params.provider,
      modelId: params.modelId,
      proxyConfig: params.proxyConfig,
      userId: params.userId,
    });

    if (action.type === "finish") {
      observations.push({
        step,
        action: "finish",
        detail: action.answerPlan,
      });
      break;
    }

    if (action.type === "read_section") {
      const sectionText = sections[action.section];
      if (!sectionText) {
        observations.push({
          step,
          action: `read_section(${action.section})`,
          detail: "Section was not available.",
        });
        continue;
      }

      citations.push(citationForSection(params.paper, action.section, sectionText));
      const supportingClaims = rankClaimsForQuery(
        params.paper.claims,
        `${params.question} ${action.section}`,
        3,
      );

      if (action.section === "results") {
        artifacts.push(buildResultArtifact(params.paper, sectionText, supportingClaims));
      }

      observations.push({
        step,
        action: `read_section(${action.section})`,
        detail: truncate(sectionText, 600),
      });
      continue;
    }

    if (action.type === "search_claims") {
      const rankedClaims = rankClaimsForQuery(
        params.paper.claims,
        action.query,
        action.limit,
      );
      if (rankedClaims.length === 0) {
        observations.push({
          step,
          action: `search_claims(${action.query})`,
          detail: "No relevant claims found.",
        });
        continue;
      }

      citations.push(
        ...rankedClaims.map((claim) => citationForClaim(params.paper, claim)),
      );
      observations.push({
        step,
        action: `search_claims(${action.query})`,
        detail: rankedClaims.map((claim) => `- ${claim.text}`).join("\n"),
      });
      continue;
    }

    if (action.type === "list_figures") {
      const visibleFigures = filterFigures(
        figures,
        action.kind,
        action.query,
      ).slice(0, action.limit);
      observations.push({
        step,
        action: `list_figures(${action.kind}${action.query ? `, ${action.query}` : ""})`,
        detail:
          visibleFigures.length > 0
            ? visibleFigures
                .map(
                  (figure) =>
                    `- ${figure.figureLabel || figure.id} (${figure.type})${figure.captionText ? ` — ${truncate(figure.captionText, 140)}` : ""}`,
                )
                .join("\n")
            : "No matching figures or tables were found.",
      });
      continue;
    }

    if (action.type === "open_figure") {
      const figure = resolveFigureTarget(figures, action.target);
      if (!figure) {
        observations.push({
          step,
          action: `open_figure(${action.target})`,
          detail: "No matching figure or table was found.",
        });
        continue;
      }

      citations.push(citationForFigure(params.paper, figure));
      artifacts.push(buildFigureArtifact(figure));
      observations.push({
        step,
        action: `open_figure(${action.target})`,
        detail: `${figure.figureLabel || figure.id}: ${figure.captionText || figure.description || "Opened without caption."}`,
      });
    }
  }

  if (citations.length === 0) {
    const fallbackClaims = rankClaimsForQuery(params.paper.claims, params.question, 4);
    if (fallbackClaims.length > 0) {
      citations.push(...fallbackClaims.map((claim) => citationForClaim(params.paper, claim)));
    } else if (sections.results) {
      citations.push(citationForSection(params.paper, "results", sections.results));
      artifacts.push(buildResultArtifact(params.paper, sections.results, []));
    } else if (sections.overview) {
      citations.push(citationForSection(params.paper, "overview", sections.overview));
    } else if (params.paper.abstract) {
      citations.push({
        paperId: params.paper.id,
        paperTitle: params.paper.title,
        snippet: truncate(params.paper.abstract, MAX_CITATION_SNIPPET_CHARS),
        sectionPath: "overview",
        sourceKind: "summary",
      });
    }
  }

  if (params.intent === "code") {
    const codeArtifact = await generateCodeSnippetArtifact({
      paper: params.paper,
      question: params.question,
      selectedText: params.selectedText,
      citations,
      artifacts,
      observations,
      provider: params.provider,
      modelId: params.modelId,
      proxyConfig: params.proxyConfig,
      userId: params.userId,
    });
    if (codeArtifact) {
      artifacts.push(buildCodeArtifact(codeArtifact));
      observations.push({
        step: observations.length + 1,
        action: "generate_code_snippet",
        detail: `${codeArtifact.filename}: ${codeArtifact.summary}`,
      });
    }
  }

  return {
    citations: dedupeCitations(citations).slice(0, 8),
    artifacts: dedupeArtifacts(artifacts),
    actions: observations.map((observation) => ({
      step: observation.step,
      action: observation.action,
      detail: observation.detail,
    })),
  };
}
