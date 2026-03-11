import { prisma } from "@/lib/prisma";
import { generateLLMResponse, MAX_PAPER_CHARS } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";
import type { SynthesisPlan, PaperDigest, SectionDraft, VizData, CitationGraph, ThinDigest, Guidance, FigureSpec, SynthesisDepth } from "./types";
import { DEPTH_CONFIGS } from "./types";
import {
  PLAN_PROMPT,
  MAP_PROMPT,
  REDUCE_THEMATIC,
  REDUCE_METHODOLOGY,
  REDUCE_META,
  REDUCE_GENERIC,
  COMPOSE_PROMPT,
  VIZ_METHODOLOGY_PROMPT,
} from "./prompts";
import { buildCitationGraph } from "./citation-graph";
import { runExpansionAgent } from "./expansion-agent";
import {
  extractMetrics,
  groupMetrics,
  buildCandidateFigures,
  FIGURE_NARRATIVE_PROMPT,
} from "./figure-builder";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { extractTextFromPdf } from "@/lib/pdf/parser";

// ── Helpers ──

async function updateSession(
  sessionId: string,
  data: { status?: string; phase?: string; progress?: number; plan?: string; output?: string; vizData?: string; error?: string; startedAt?: Date; completedAt?: Date; title?: string; description?: string }
) {
  await prisma.synthesisSession.update({ where: { id: sessionId }, data });
}

function parseJson<T>(raw: string): T {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
    const jsonStart = cleaned.search(/[{\[]/);
    if (jsonStart >= 0) {
      cleaned = cleaned.slice(jsonStart);
    }
  }
  return JSON.parse(cleaned) as T;
}

/**
 * Parse a SectionDraft from LLM output with recovery for truncated JSON.
 * The LLM often exceeds maxTokens, producing incomplete JSON. When that
 * happens, we extract whatever "content" field we can find and use it.
 */
function parseSectionDraft(raw: string, fallbackType: string, fallbackTitle: string): SectionDraft {
  try {
    return parseJson<SectionDraft>(raw);
  } catch {
    // JSON parse failed — likely truncated. Try to extract the "content" field.
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

    // Try to extract the content field value from the partial JSON
    const contentMatch = cleaned.match(/"content"\s*:\s*"([\s\S]+)/);
    if (contentMatch) {
      let content = contentMatch[1];
      // The content string is likely truncated — unescape what we have
      // Remove trailing incomplete escape sequences and close the string
      content = content
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
        .replace(/\\t/g, "\t");
      // Strip any trailing JSON structure remnants
      const lastGoodIdx = content.search(/",\s*"citations"\s*:/);
      if (lastGoodIdx > 0) {
        content = content.slice(0, lastGoodIdx);
      }
      // Also try to extract title
      const titleMatch = cleaned.match(/"title"\s*:\s*"([^"]+)"/);

      console.log(`[synthesis] Recovered ${content.length} chars from truncated JSON for section ${fallbackType}`);
      return {
        sectionType: fallbackType,
        title: titleMatch?.[1] || fallbackTitle,
        content,
        citations: [],
      };
    }

    // Last resort: use the raw text as markdown content
    console.log(`[synthesis] Using raw LLM output as content for section ${fallbackType}`);
    return {
      sectionType: fallbackType,
      title: fallbackTitle,
      content: cleaned,
      citations: [],
    };
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return text.slice(0, head) + "\n\n[... middle omitted ...]\n\n" + text.slice(-tail);
}

function formatDigests(digests: PaperDigest[]): string {
  return digests
    .map(
      (d) =>
        `### Paper: ${d.paperId}\nContribution: ${d.coreContribution}\nMethodology: ${d.methodology}\nFindings: ${d.keyFindings.join("; ")}\nMetrics: ${JSON.stringify(d.metrics)}\nLimitations: ${d.limitations}\nThemes: ${d.themes.join(", ")}`
    )
    .join("\n\n---\n\n");
}

/** Run a batch of promises with concurrency limit */
async function batchProcess<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    if (signal?.aborted) throw new Error("Cancelled");
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((item, j) => fn(item, i + j)));
    results.push(...batchResults);
  }
  return results;
}

// ── Guidance application ──

export function applyGuidanceToPlan(plan: SynthesisPlan, guidance: Guidance): SynthesisPlan {
  const result = { ...plan, themes: [...plan.themes], structure: [...plan.structure] };

  // Add new themes
  if (guidance.additionalThemes?.length) {
    for (const t of guidance.additionalThemes) {
      if (!result.themes.some((existing) => existing.id === t.id)) {
        result.themes.push(t);
      }
    }
  }

  // Remove themes
  if (guidance.removedThemes?.length) {
    result.themes = result.themes.filter((t) => !guidance.removedThemes!.includes(t.id));
    // Also remove from structure
    result.structure = result.structure.filter(
      (s) => !s.themes?.every((t) => guidance.removedThemes!.includes(t))
    );
  }

  // Override structure if provided
  if (guidance.sectionOverrides) {
    result.structure = guidance.sectionOverrides;
  }

  return result;
}

// ── Shared paper fetch ──

type PaperData = {
  id: string;
  title: string;
  abstract: string | null;
  summary: string | null;
  fullText: string | null;
  categories: string | null;
  year: number | null;
  authors: string | null;
  doi: string | null;
  arxivId: string | null;
  filePath: string | null;
  sourceUrl: string | null;
};

async function fetchSessionPapers(sessionId: string) {
  const session = await prisma.synthesisSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      papers: {
        include: {
          paper: {
            select: {
              id: true,
              title: true,
              abstract: true,
              summary: true,
              fullText: true,
              categories: true,
              year: true,
              authors: true,
              doi: true,
              arxivId: true,
              filePath: true,
              sourceUrl: true,
            },
          },
        },
      },
    },
  });
  const depth = (session.depth || "balanced") as SynthesisDepth;
  return { session, papers: session.papers.map((sp) => sp.paper) as PaperData[], depth };
}

// ── Phase 1: PLANNING + MAPPING ──

export async function runPhase1(sessionId: string, signal: AbortSignal): Promise<void> {
  const { provider, modelId, proxyConfig } = await getDefaultModel();

  const llm = (system: string, prompt: string, maxTokens?: number) =>
    generateLLMResponse({ provider, modelId, system, prompt, maxTokens, proxyConfig });

  const { session, papers, depth } = await fetchSessionPapers(sessionId);

  // ════════════════════════════════════════════════════════════
  // PLANNING (0 → 0.05)
  // ════════════════════════════════════════════════════════════
  if (signal.aborted) throw new Error("Cancelled");
  await updateSession(sessionId, { status: "PLANNING", phase: "Analyzing paper corpus...", progress: 0.01 });

  const paperListing = papers
    .map(
      (p) =>
        `ID: ${p.id} | Title: ${p.title} | Year: ${p.year || "?"} | Abstract: ${(p.abstract || p.summary || "").slice(0, 200)}`
    )
    .join("\n");

  let plan: SynthesisPlan;
  if (paperListing.length <= MAX_PAPER_CHARS) {
    const raw = await llm(
      PLAN_PROMPT.system,
      PLAN_PROMPT.buildPrompt(paperListing, session.query || undefined, depth),
      4000
    );
    plan = parseJson<SynthesisPlan>(raw);
  } else {
    const chunkSize = 80;
    const chunks: typeof papers[] = [];
    for (let i = 0; i < papers.length; i += chunkSize) {
      chunks.push(papers.slice(i, i + chunkSize));
    }

    const partialPlans: SynthesisPlan[] = [];
    for (const chunk of chunks) {
      if (signal.aborted) throw new Error("Cancelled");
      const listing = chunk
        .map(
          (p) =>
            `ID: ${p.id} | Title: ${p.title} | Year: ${p.year || "?"} | Abstract: ${(p.abstract || p.summary || "").slice(0, 150)}`
        )
        .join("\n");
      const raw = await llm(
        PLAN_PROMPT.system,
        PLAN_PROMPT.buildPrompt(listing, session.query || undefined, depth),
        4000
      );
      partialPlans.push(parseJson<SynthesisPlan>(raw));
    }

    const themeMap = new Map<string, SynthesisPlan["themes"][0]>();
    const clusterMap = new Map<string, Set<string>>();
    for (const pp of partialPlans) {
      for (const t of pp.themes) {
        if (!themeMap.has(t.id)) themeMap.set(t.id, t);
      }
      for (const [themeId, paperIds] of Object.entries(pp.paperClusters)) {
        const existing = clusterMap.get(themeId) || new Set<string>();
        for (const pid of paperIds) existing.add(pid);
        clusterMap.set(themeId, existing);
      }
    }

    plan = {
      themes: Array.from(themeMap.values()),
      structure: partialPlans[0].structure,
      paperClusters: Object.fromEntries(
        Array.from(clusterMap.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
    };
  }

  await updateSession(sessionId, {
    plan: JSON.stringify(plan),
    progress: 0.05,
    phase: `Identified ${plan.themes.length} themes`,
  });

  // ════════════════════════════════════════════════════════════
  // PDF FETCHING — get full text for papers missing it
  // ════════════════════════════════════════════════════════════
  const papersNeedingPdf = papers.filter((p) => !p.fullText && (p.doi || p.arxivId || p.filePath));
  if (papersNeedingPdf.length > 0) {
    if (signal.aborted) throw new Error("Cancelled");
    await updateSession(sessionId, { phase: `Fetching PDFs for ${papersNeedingPdf.length} papers...`, progress: 0.06 });

    await batchProcess(
      papersNeedingPdf,
      3,
      async (paper) => {
        if (signal.aborted) throw new Error("Cancelled");
        try {
          let pdfPath = paper.filePath;

          // If no local file, try to download
          if (!pdfPath) {
            const result = await findAndDownloadPdf({
              doi: paper.doi,
              arxivId: paper.arxivId,
            });
            if (result) {
              pdfPath = result.filePath;
            }
          }

          // Extract text from PDF
          if (pdfPath) {
            const text = await extractTextFromPdf(pdfPath);
            if (text && text.length > 100) {
              // Update paper in DB with full text
              await prisma.paper.update({
                where: { id: paper.id },
                data: { fullText: text, filePath: pdfPath },
              });
              // Update local reference so MAPPING uses it
              paper.fullText = text;
              if (!paper.filePath) paper.filePath = pdfPath;
              console.log(`[synthesis] Extracted ${text.length} chars from PDF for "${paper.title}"`);
            }
          }
        } catch (err) {
          console.warn(`[synthesis] PDF fetch failed for "${paper.title}":`, err);
        }
      },
      signal
    );
  }

  // ════════════════════════════════════════════════════════════
  // MAPPING (0.08 → 0.45)
  // ════════════════════════════════════════════════════════════
  if (signal.aborted) throw new Error("Cancelled");
  await updateSession(sessionId, { status: "MAPPING", phase: `Analyzing papers (0/${papers.length})...` });

  const mapPaperChars = 15_000;

  await batchProcess(
    papers,
    5,
    async (paper, index) => {
      if (signal.aborted) throw new Error("Cancelled");

      const text = truncate(paper.fullText || paper.summary || paper.abstract || "", mapPaperChars);
      const raw = await llm(
        MAP_PROMPT.system,
        MAP_PROMPT.buildPrompt(paper.id, text, plan.themes),
        2000
      );

      let digest: PaperDigest;
      try {
        digest = parseJson<PaperDigest>(raw);
        digest.paperId = paper.id;
      } catch {
        digest = {
          paperId: paper.id,
          coreContribution: paper.abstract?.slice(0, 200) || "Parse failed",
          methodology: "Unknown",
          keyFindings: [],
          themes: [],
          metrics: {},
          limitations: "Digest extraction failed",
        };
      }

      await prisma.synthesisPaper.updateMany({
        where: { sessionId, paperId: paper.id },
        data: {
          digest: JSON.stringify(digest),
          themes: JSON.stringify(digest.themes),
        },
      });

      const progress = 0.08 + ((index + 1) / papers.length) * 0.37;
      await updateSession(sessionId, {
        progress,
        phase: `Analyzing papers (${index + 1}/${papers.length})...`,
      });
    },
    signal
  );

  // If guided mode, pause at GUIDING
  const freshSession = await prisma.synthesisSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { mode: true },
  });

  if (freshSession.mode === "guided") {
    await updateSession(sessionId, {
      status: "GUIDING",
      phase: "Awaiting expert guidance",
      progress: 0.45,
    });
    console.log(`[synthesis] Phase 1 complete, pausing at GUIDING for session ${sessionId}`);
    return;
  }
}

// ── Phase 2: GRAPHING → VISUALIZING ──

export async function runPhase2(sessionId: string, signal: AbortSignal): Promise<void> {
  const { provider, modelId, proxyConfig } = await getDefaultModel();

  const llm = (system: string, prompt: string, maxTokens?: number) =>
    generateLLMResponse({ provider, modelId, system, prompt, maxTokens, proxyConfig });

  const { session, papers, depth } = await fetchSessionPapers(sessionId);
  const depthConfig = DEPTH_CONFIGS[depth];

  // Load plan from DB and apply guidance if present
  let plan: SynthesisPlan = JSON.parse(session.plan!);

  if (session.guidance) {
    try {
      const guidance: Guidance = JSON.parse(session.guidance);
      plan = applyGuidanceToPlan(plan, guidance);
      // Persist the modified plan
      await updateSession(sessionId, { plan: JSON.stringify(plan) });
      console.log(`[synthesis] Applied guidance to plan for session ${sessionId}`);
    } catch (err) {
      console.error("[synthesis] Failed to apply guidance:", err);
    }
  }

  // Load digests from DB
  const synthesisPapers = await prisma.synthesisPaper.findMany({
    where: { sessionId },
    select: { paperId: true, digest: true },
  });

  const digests: PaperDigest[] = synthesisPapers
    .filter((sp) => sp.digest)
    .map((sp) => JSON.parse(sp.digest!) as PaperDigest);

  // ════════════════════════════════════════════════════════════
  // GRAPHING (0.45 → 0.55) — skipped for quick mode
  // ════════════════════════════════════════════════════════════
  let citationGraph: CitationGraph = { nodes: [], edges: [] };
  if (depth !== "quick") {
    try {
      if (signal.aborted) throw new Error("Cancelled");
      await updateSession(sessionId, {
        status: "GRAPHING",
        phase: "Building citation graph...",
        progress: 0.45,
      });

      citationGraph = await buildCitationGraph(
        papers.map((p) => ({
          id: p.id,
          title: p.title,
          authors: p.authors,
          year: p.year,
          doi: p.doi,
          arxivId: p.arxivId,
          abstract: p.abstract,
        })),
        signal,
        (p) => updateSession(sessionId, { progress: 0.45 + p * 0.10 })
      );

      await updateSession(sessionId, { progress: 0.55 });
    } catch (err) {
      if (signal.aborted) throw err;
      console.error("[synthesis] Citation graph building failed:", err);
    }

    // ════════════════════════════════════════════════════════════
    // EXPANDING (0.55 → 0.65) — skipped for quick mode
    // ════════════════════════════════════════════════════════════
    try {
      const hasExternalNodes = citationGraph.nodes.some((n) => !n.isCorpus);
      if (hasExternalNodes) {
        if (signal.aborted) throw new Error("Cancelled");
        await updateSession(sessionId, {
          status: "EXPANDING",
          phase: "Analyzing graph for expansion...",
          progress: 0.55,
        });

        const { expandedDigests, updatedGraph } = await runExpansionAgent(
          citationGraph,
          digests,
          plan,
          llm,
          signal,
          (p) => updateSession(sessionId, { progress: 0.55 + p * 0.10 })
        );

        if (expandedDigests.length > 0) {
          digests.push(...expandedDigests);
          citationGraph = updatedGraph;
          console.log(`[synthesis] Expanded corpus with ${expandedDigests.length} additional papers`);
        }
      }
      await updateSession(sessionId, { progress: 0.65 });
    } catch (err) {
      if (signal.aborted) throw err;
      console.error("[synthesis] Expansion agent failed:", err);
    }
  } else {
    // Quick mode: jump progress ahead
    await updateSession(sessionId, { progress: 0.65 });
  }

  // ════════════════════════════════════════════════════════════
  // REDUCING (0.65 → 0.85)
  // ════════════════════════════════════════════════════════════
  if (signal.aborted) throw new Error("Cancelled");
  await updateSession(sessionId, { status: "REDUCING", phase: "Writing synthesis sections...", progress: 0.65 });

  const sections: SectionDraft[] = [];
  const totalSections = plan.structure.length;

  for (let si = 0; si < plan.structure.length; si++) {
    if (signal.aborted) throw new Error("Cancelled");

    const sec = plan.structure[si];
    const sectionDigests = sec.themes
      ? digests.filter((d) => d.themes.some((t) => sec.themes!.includes(t)))
      : digests;

    if (sectionDigests.length === 0) continue;

    await updateSession(sessionId, {
      phase: `Writing section ${si + 1}/${totalSections}: ${sec.focus.slice(0, 50)}...`,
    });

    let draft: SectionDraft;

    const digestText = formatDigests(sectionDigests);

    const maxTokens = depthConfig.tokensPerSection;
    const lengthGuidance = depthConfig.lengthGuidance || undefined;

    const reduceWithBatching = async (
      system: string,
      buildPromptFn: (text: string) => string
    ): Promise<SectionDraft> => {
      if (digestText.length <= MAX_PAPER_CHARS) {
        const raw = await llm(system, buildPromptFn(digestText), maxTokens);
        return parseSectionDraft(raw, sec.sectionType, sec.focus);
      }

      const subBatchSize = Math.ceil(sectionDigests.length / Math.ceil(digestText.length / MAX_PAPER_CHARS));
      const subDrafts: SectionDraft[] = [];

      for (let i = 0; i < sectionDigests.length; i += subBatchSize) {
        if (signal.aborted) throw new Error("Cancelled");
        const batch = sectionDigests.slice(i, i + subBatchSize);
        const batchText = formatDigests(batch);
        const raw = await llm(system, buildPromptFn(batchText), maxTokens);
        subDrafts.push(parseSectionDraft(raw, sec.sectionType, sec.focus));
      }

      if (subDrafts.length === 1) return subDrafts[0];

      const mergedContent = subDrafts.map((d) => d.content).join("\n\n");
      const mergedCitations = subDrafts.flatMap((d) => d.citations);

      if (mergedContent.length <= MAX_PAPER_CHARS) {
        const mergeRaw = await llm(
          system,
          `Merge and synthesize these section drafts into a single cohesive section:\n\n${mergedContent}`,
          maxTokens
        );
        const merged = parseSectionDraft(mergeRaw, sec.sectionType, sec.focus);
        merged.citations = [...merged.citations, ...mergedCitations];
        return merged;
      }

      return { ...subDrafts[0], content: mergedContent, citations: mergedCitations };
    };

    try {
      switch (sec.sectionType) {
        case "thematic": {
          const themeId = sec.themes?.[0];
          const theme = plan.themes.find((t) => t.id === themeId);
          draft = await reduceWithBatching(
            REDUCE_THEMATIC.system,
            (text) =>
              REDUCE_THEMATIC.buildPrompt(
                theme?.label || sec.focus,
                theme?.description || sec.focus,
                text,
                lengthGuidance
              )
          );
          break;
        }
        case "methodology":
          draft = await reduceWithBatching(
            REDUCE_METHODOLOGY.system,
            (text) => REDUCE_METHODOLOGY.buildPrompt(text, lengthGuidance)
          );
          break;
        case "meta":
          draft = await reduceWithBatching(
            REDUCE_META.system,
            (text) => REDUCE_META.buildPrompt(text, lengthGuidance)
          );
          break;
        default:
          draft = await reduceWithBatching(
            REDUCE_GENERIC.system,
            (text) => REDUCE_GENERIC.buildPrompt(sec.sectionType, sec.focus, text, lengthGuidance)
          );
          break;
      }
    } catch (err) {
      console.error(`[synthesis] Section ${sec.sectionType} failed:`, err);
      draft = {
        sectionType: sec.sectionType,
        title: sec.focus,
        content: `*Section generation failed: ${err instanceof Error ? err.message : "Unknown error"}*`,
        citations: [],
      };
    }

    draft.sectionType = sec.sectionType;
    sections.push(draft);

    await prisma.synthesisSection.create({
      data: {
        sessionId,
        sectionType: draft.sectionType,
        title: draft.title,
        content: draft.content,
        sortOrder: si + 1,
        citations: JSON.stringify(draft.citations),
      },
    });

    const progress = 0.65 + ((si + 1) / totalSections) * 0.20;
    await updateSession(sessionId, { progress });
  }

  // ════════════════════════════════════════════════════════════
  // COMPOSING (0.85 → 0.95)
  // ════════════════════════════════════════════════════════════
  if (signal.aborted) throw new Error("Cancelled");
  await updateSession(sessionId, { status: "COMPOSING", phase: "Composing final synthesis...", progress: 0.85 });

  const allSectionText = sections
    .map((s) => `## ${s.title}\n\n${s.content}`)
    .join("\n\n---\n\n");

  const composeInput = truncate(allSectionText, MAX_PAPER_CHARS);
  const composeGuidance = depthConfig.composeGuidance || undefined;
  const composeRaw = await llm(
    COMPOSE_PROMPT.system,
    COMPOSE_PROMPT.buildPrompt(composeInput, papers.length, session.title, composeGuidance),
    depthConfig.tokensPerSection
  );

  let introduction = "";
  let conclusion = "";
  try {
    const composed = parseJson<{
      introduction: string;
      conclusion: string;
      crossReferences: string[];
      novelInsights: string[];
    }>(composeRaw);
    introduction = composed.introduction;
    conclusion = composed.conclusion;

    if (composed.novelInsights?.length > 0) {
      conclusion += "\n\n### Novel Cross-Paper Insights\n\n" + composed.novelInsights.map((i) => `- ${i}`).join("\n");
    }
  } catch {
    introduction = `# ${session.title}\n\nThis synthesis covers ${papers.length} papers.`;
    conclusion = "## Conclusion\n\n*Conclusion generation failed.*";
  }

  await prisma.synthesisSection.create({
    data: {
      sessionId,
      sectionType: "introduction",
      title: "Introduction",
      content: introduction,
      sortOrder: 0,
      citations: "[]",
    },
  });

  await prisma.synthesisSection.create({
    data: {
      sessionId,
      sectionType: "conclusion",
      title: "Conclusion",
      content: conclusion,
      sortOrder: sections.length + 1,
      citations: "[]",
    },
  });

  const allSections = await prisma.synthesisSection.findMany({
    where: { sessionId },
    orderBy: { sortOrder: "asc" },
  });

  // ── Generate LLM title + description ──
  let synthTitle = session.title;
  try {
    const paperTitles = papers.map((p) => p.title).join("; ");
    const titleRaw = await llm(
      "You generate concise, descriptive titles and one-line descriptions for academic literature reviews.",
      `Given these section titles and paper topics, generate a short academic title (max 10 words) and a one-sentence description (max 25 words) for this synthesis.\n\nPapers: ${paperTitles.slice(0, 2000)}\n\nIntroduction excerpt: ${introduction.slice(0, 500)}\n\nRespond in JSON: {"title": "...", "description": "..."}`,
      200
    );
    const titleParsed = parseJson<{ title: string; description: string }>(titleRaw);
    if (titleParsed.title && titleParsed.description) {
      synthTitle = titleParsed.title;
      await updateSession(sessionId, {
        title: titleParsed.title,
        description: titleParsed.description,
      });
    }
  } catch {
    // Keep existing title, no description
  }

  const corpusBibliography = papers
    .map(
      (p, i) => {
        let authors = "";
        try { authors = JSON.parse(p.authors || "[]").join(", "); } catch { authors = p.authors || ""; }
        return `${i + 1}. **${p.title}** ${authors ? `— ${authors}` : ""}${p.year ? ` (${p.year})` : ""} [View](/papers/${p.id})`;
      }
    )
    .join("\n");

  const expandedPapers = digests.filter((d): d is ThinDigest => "isThin" in d && (d as ThinDigest).isThin);
  const expandedBibliography = expandedPapers
    .map((d, i) => {
      const node = citationGraph.nodes.find((n) => n.id === d.externalId);
      const authors = node?.authors.join(", ") || "";
      const year = node?.year || "";
      const url = node?.externalUrl;
      const link = url ? ` [Link](${url})` : "";
      return `${papers.length + i + 1}. **${node?.title || d.paperId}** ${authors ? `— ${authors}` : ""}${year ? ` (${year})` : ""}${link} *(expanded via citation graph)*`;
    })
    .join("\n");

  const bibliography = expandedBibliography
    ? `${corpusBibliography}\n\n### Expanded Papers\n\n${expandedBibliography}`
    : corpusBibliography;

  const fullOutput = [
    `# ${synthTitle}\n`,
    `*Synthesis of ${papers.length} papers*\n`,
    ...allSections.map((s) => `## ${s.title}\n\n${s.content}`),
    `\n## Bibliography\n\n${bibliography}`,
  ].join("\n\n");

  await updateSession(sessionId, { output: fullOutput, progress: 0.95 });

  // ════════════════════════════════════════════════════════════
  // VISUALIZING (0.95 → 1.0)
  // ════════════════════════════════════════════════════════════
  if (signal.aborted) throw new Error("Cancelled");
  await updateSession(sessionId, { phase: "Generating visualizations...", progress: 0.95 });

  const vizData: VizData = {
    timeline: [],
    themes: [],
    methodologyMatrix: { papers: [] },
    citationNetwork: { nodes: [], edges: [] },
    figures: [],
  };

  const yearMap = new Map<number, { id: string; title: string }[]>();
  for (const p of papers) {
    if (p.year) {
      const list = yearMap.get(p.year) || [];
      list.push({ id: p.id, title: p.title });
      yearMap.set(p.year, list);
    }
  }
  vizData.timeline = Array.from(yearMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([year, pps]) => ({ year, count: pps.length, papers: pps }));

  const THEME_COLORS = ["#6366F1", "#EC4899", "#10B981", "#F59E0B", "#3B82F6", "#8B5CF6", "#EF4444", "#14B8A6"];
  vizData.themes = plan.themes.map((t, i) => ({
    theme: t.label,
    count: (plan.paperClusters[t.id] || []).length,
    color: THEME_COLORS[i % THEME_COLORS.length],
  }));

  if (citationGraph.nodes.length > 0) {
    vizData.citationNetwork.nodes = citationGraph.nodes.map((n) => ({
      id: n.id,
      label: n.title.length > 40 ? n.title.slice(0, 40) + "..." : n.title,
      isCorpus: n.isCorpus,
      corpusConnections: n.corpusConnectionCount,
    }));
    vizData.citationNetwork.edges = citationGraph.edges;
  } else {
    const relations = await prisma.paperRelation.findMany({
      where: {
        sourcePaperId: { in: papers.map((p) => p.id) },
        targetPaperId: { in: papers.map((p) => p.id) },
      },
    });

    vizData.citationNetwork.nodes = papers.map((p) => ({
      id: p.id,
      label: p.title.length > 40 ? p.title.slice(0, 40) + "..." : p.title,
      isCorpus: true,
    }));
    vizData.citationNetwork.edges = relations.map((r) => ({
      source: r.sourcePaperId,
      target: r.targetPaperId,
    }));
  }

  try {
    const methodDigests = digests.filter((d) => d.methodology && d.methodology !== "Unknown");
    if (methodDigests.length > 0) {
      const methodText = truncate(formatDigests(methodDigests), MAX_PAPER_CHARS);
      const vizRaw = await llm(
        VIZ_METHODOLOGY_PROMPT.system,
        VIZ_METHODOLOGY_PROMPT.buildPrompt(methodText),
        3000
      );
      const matrix = parseJson<VizData["methodologyMatrix"]>(vizRaw);
      vizData.methodologyMatrix = matrix;
    }
  } catch (err) {
    console.error("[synthesis] Methodology viz failed:", err);
  }

  // Figures: data-driven — extract real numbers from digests, LLM only picks narrative
  try {
    const paperLabelMap = new Map<string, string>();
    for (const p of papers) {
      let firstAuthor = "Unknown";
      try {
        const authors = JSON.parse(p.authors || "[]");
        if (authors.length > 0) {
          firstAuthor = authors[0].split(" ").pop() || authors[0];
        }
      } catch {
        // ignore
      }
      paperLabelMap.set(p.id, `${firstAuthor} ${p.year || ""}`.trim());
    }

    // Step 1-2: Extract real numeric metrics, group by name
    const allMetrics = extractMetrics(digests, paperLabelMap);
    const minPapersForFigure = digests.length <= 5 ? 2 : 3;
    const metricGroups = groupMetrics(allMetrics, minPapersForFigure);

    if (metricGroups.length > 0) {
      // Step 3: Build candidate figures from real data
      const sectionsList = sections.map((s) => ({ title: s.title, content: s.content }));
      const candidates = buildCandidateFigures(metricGroups, sectionsList);

      if (candidates.length > 0) {
        // Step 4: LLM selects narratively valuable figures and writes captions
        const sectionSummaries = sections
          .map((s) => `### ${s.title}\n${s.content.slice(0, 300)}...`)
          .join("\n\n");

        const narrativeRaw = await llm(
          FIGURE_NARRATIVE_PROMPT.system,
          FIGURE_NARRATIVE_PROMPT.buildPrompt(candidates, sectionSummaries),
          2000
        );

        const narrative = parseJson<{
          selectedFigures: { id: string; title: string; caption: string }[];
        }>(narrativeRaw);

        if (narrative.selectedFigures?.length > 0) {
          const candidateMap = new Map(candidates.map((c) => [c.id, c]));
          const selectedFigures: FigureSpec[] = [];

          for (const sel of narrative.selectedFigures) {
            const candidate = candidateMap.get(sel.id);
            if (!candidate) continue;

            selectedFigures.push({
              chartType: candidate.chartType,
              title: sel.title,
              caption: sel.caption,
              xAxis: candidate.xAxis,
              yAxis: candidate.yAxis,
              data: candidate.data,
              series: candidate.series,
            });
          }

          vizData.figures = selectedFigures;
        } else {
          // Fallback: use top candidates as-is
          vizData.figures = candidates.slice(0, 3).map((c) => ({
            chartType: c.chartType,
            title: c.title,
            caption: c.caption,
            xAxis: c.xAxis,
            yAxis: c.yAxis,
            data: c.data,
            series: c.series,
          }));
        }
      }
    }
  } catch (err) {
    console.error("[synthesis] Figure generation failed:", err);
  }

  await updateSession(sessionId, {
    vizData: JSON.stringify(vizData),
    status: "COMPLETED",
    progress: 1.0,
    phase: "Complete",
    completedAt: new Date(),
  });

  console.log(`[synthesis] Pipeline completed for session ${sessionId}`);
}

// ── Main Pipeline (auto mode wrapper) ──

export async function runSynthesisPipeline(sessionId: string, signal: AbortSignal): Promise<void> {
  await runPhase1(sessionId, signal);

  // If guided, phase1 already set GUIDING status and returned
  const session = await prisma.synthesisSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { status: true },
  });
  if (session.status === "GUIDING") return;

  await runPhase2(sessionId, signal);
}
