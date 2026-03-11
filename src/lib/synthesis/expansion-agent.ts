/**
 * LLM-powered expansion agent that analyzes the citation graph
 * to identify high-value external papers worth incorporating.
 */

import { cleanJsonResponse } from "@/lib/llm/prompts";
import type { SynthesisPlan, PaperDigest, CitationGraph, CitationGraphNode, ThinDigest } from "./types";
import { EXPANSION_AGENT_PROMPT, THIN_DIGEST_PROMPT } from "./prompts";

type LLMFn = (system: string, prompt: string, maxTokens?: number) => Promise<string>;

interface ExpansionResult {
  expandedDigests: ThinDigest[];
  updatedGraph: CitationGraph;
}

/**
 * Run the expansion agent to select and digest high-value external papers.
 *
 * 1. Send top external nodes + themes + digest summaries to LLM
 * 2. Parse recommendations (3-8 papers)
 * 3. Generate thin digests for each recommendation
 */
export async function runExpansionAgent(
  graph: CitationGraph,
  digests: PaperDigest[],
  plan: SynthesisPlan,
  llm: LLMFn,
  signal: AbortSignal,
  onProgress?: (progress: number) => void
): Promise<ExpansionResult> {
  const externalNodes = graph.nodes
    .filter((n) => !n.isCorpus)
    .sort((a, b) => b.corpusConnectionCount - a.corpusConnectionCount)
    .slice(0, 50);

  if (externalNodes.length === 0) {
    return { expandedDigests: [], updatedGraph: graph };
  }

  // Format inputs for the LLM
  const externalListing = externalNodes
    .map(
      (n) =>
        `ID: ${n.id} | Title: ${n.title} | Year: ${n.year || "?"} | Citations: ${n.citationCount ?? "?"} | Corpus connections: ${n.corpusConnectionCount}`
    )
    .join("\n");

  const themeListing = plan.themes
    .map((t) => `- ${t.id}: ${t.label} — ${t.description}`)
    .join("\n");

  const digestSummaries = digests
    .slice(0, 30) // Limit to avoid token overflow
    .map((d) => `[${d.paperId}] ${d.coreContribution}`)
    .join("\n");

  // Step 1: Agent analysis — select papers
  if (signal.aborted) throw new Error("Cancelled");
  onProgress?.(0.2);

  const agentRaw = await llm(
    EXPANSION_AGENT_PROMPT.system,
    EXPANSION_AGENT_PROMPT.buildPrompt(externalListing, themeListing, digestSummaries),
    2000
  );

  let recommendations: { nodeId: string; reason: string }[];
  try {
    const parsed = JSON.parse(cleanJsonResponse(agentRaw)) as {
      recommendations: { nodeId: string; reason: string }[];
    };
    recommendations = parsed.recommendations || [];
  } catch {
    console.warn("[expansion-agent] Failed to parse recommendations, skipping expansion");
    return { expandedDigests: [], updatedGraph: graph };
  }

  // Validate that recommended nodeIds exist in our external nodes
  const externalById = new Map(externalNodes.map((n) => [n.id, n]));
  const validRecs = recommendations.filter((r) => externalById.has(r.nodeId));

  if (validRecs.length === 0) {
    return { expandedDigests: [], updatedGraph: graph };
  }

  console.log(`[expansion-agent] ${validRecs.length} papers recommended for expansion`);
  onProgress?.(0.4);

  // Step 2: Generate thin digests for each recommendation
  const expandedDigests: ThinDigest[] = [];
  for (let i = 0; i < validRecs.length; i++) {
    if (signal.aborted) throw new Error("Cancelled");

    const rec = validRecs[i];
    const node = externalById.get(rec.nodeId)!;

    const thinDigest = await generateThinDigest(node, rec.reason, plan, llm);
    if (thinDigest) {
      expandedDigests.push(thinDigest);
    }

    onProgress?.(0.4 + ((i + 1) / validRecs.length) * 0.6);
  }

  console.log(`[expansion-agent] Generated ${expandedDigests.length} thin digests`);

  return { expandedDigests, updatedGraph: graph };
}

async function generateThinDigest(
  node: CitationGraphNode,
  reason: string,
  plan: SynthesisPlan,
  llm: LLMFn
): Promise<ThinDigest | null> {
  try {
    const raw = await llm(
      THIN_DIGEST_PROMPT.system,
      THIN_DIGEST_PROMPT.buildPrompt(
        node.id,
        node.title,
        node.authors.join(", ") || "Unknown",
        node.year?.toString() || "Unknown",
        node.abstract,
        reason,
        plan.themes
      ),
      1500
    );

    const parsed = JSON.parse(cleanJsonResponse(raw)) as PaperDigest;
    return {
      ...parsed,
      paperId: node.id,
      isThin: true,
      externalId: node.id,
    };
  } catch (err) {
    console.warn(`[expansion-agent] Failed to generate thin digest for ${node.id}:`, err);
    // Fallback minimal digest
    return {
      paperId: node.id,
      coreContribution: `${node.title} — referenced by ${node.corpusConnectionCount} corpus papers. ${reason}`,
      methodology: "Unknown — metadata only",
      keyFindings: [],
      themes: [],
      metrics: {},
      limitations: "Limited analysis — based on metadata only, full text not available",
      isThin: true,
      externalId: node.id,
    };
  }
}
