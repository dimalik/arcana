/**
 * Build a citation graph for the synthesis corpus by fetching references
 * from Semantic Scholar / OpenAlex and identifying shared external papers.
 */

import { getReferencesForPaper } from "@/lib/discovery/s2-graph";
import { titleSimilarity } from "@/lib/references/match";
import type { S2Result } from "@/lib/import/semantic-scholar";
import type { CitationGraph, CitationGraphNode } from "./types";

interface CorpusPaper {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  abstract: string | null;
}

/**
 * Build a citation graph from a set of corpus papers.
 *
 * 1. Add all corpus papers as nodes (isCorpus: true)
 * 2. For each corpus paper with doi/arxivId, fetch its references
 * 3. Match references back to corpus (by doi, arxivId, or title similarity)
 * 4. Track external refs and count how many corpus papers reference each
 * 5. Only include external nodes with corpusConnectionCount >= 2
 */
export async function buildCitationGraph(
  corpusPapers: CorpusPaper[],
  signal: AbortSignal,
  onProgress?: (progress: number) => void
): Promise<CitationGraph> {
  const nodes: Map<string, CitationGraphNode> = new Map();
  const edges: { source: string; target: string }[] = [];

  // Index corpus papers for matching
  const corpusByDoi = new Map<string, string>();
  const corpusByArxiv = new Map<string, string>();
  const corpusList = corpusPapers.map((p) => ({
    id: p.id,
    title: p.title,
    doi: p.doi,
    arxivId: p.arxivId,
  }));

  for (const p of corpusPapers) {
    // Add corpus nodes
    let authors: string[] = [];
    try {
      authors = JSON.parse(p.authors || "[]");
    } catch {
      if (p.authors) authors = [p.authors];
    }

    nodes.set(p.id, {
      id: p.id,
      title: p.title,
      authors,
      year: p.year,
      doi: p.doi,
      arxivId: p.arxivId,
      abstract: p.abstract,
      citationCount: null,
      externalUrl: null,
      isCorpus: true,
      corpusConnectionCount: 0,
    });

    if (p.doi) corpusByDoi.set(p.doi.toLowerCase(), p.id);
    if (p.arxivId) corpusByArxiv.set(p.arxivId, p.id);
  }

  // Track external references: key -> { node, referencedBy: Set<corpusId> }
  const externalRefs = new Map<
    string,
    { node: CitationGraphNode; referencedBy: Set<string> }
  >();

  // Fetch references for each corpus paper
  const papersWithIds = corpusPapers.filter((p) => p.doi || p.arxivId);
  let completed = 0;

  for (const paper of papersWithIds) {
    if (signal.aborted) throw new Error("Cancelled");

    const lookupId = paper.doi || paper.arxivId;
    if (!lookupId) continue;

    let refs: S2Result[];
    try {
      refs = await getReferencesForPaper(lookupId);
    } catch (err) {
      console.warn(`[citation-graph] Failed to fetch refs for ${paper.id}:`, err);
      refs = [];
    }

    for (const ref of refs) {
      // Try to match to a corpus paper
      const corpusMatch = matchToCorpus(ref, corpusByDoi, corpusByArxiv, corpusList);

      if (corpusMatch) {
        // Corpus-to-corpus edge
        edges.push({ source: paper.id, target: corpusMatch });
      } else {
        // External reference — track it
        const extId = makeExternalId(ref);
        if (!extId) continue;

        const existing = externalRefs.get(extId);
        if (existing) {
          existing.referencedBy.add(paper.id);
        } else {
          externalRefs.set(extId, {
            node: {
              id: extId,
              title: ref.title,
              authors: ref.authors,
              year: ref.year,
              doi: ref.doi,
              arxivId: ref.arxivId,
              abstract: null, // S2 references don't include abstracts
              citationCount: ref.citationCount,
              externalUrl: ref.externalUrl,
              isCorpus: false,
              corpusConnectionCount: 0,
            },
            referencedBy: new Set([paper.id]),
          });
        }
      }
    }

    completed++;
    onProgress?.(completed / papersWithIds.length);
  }

  // Filter external nodes: only include those referenced by >= 2 corpus papers
  externalRefs.forEach(({ node, referencedBy }, extId) => {
    if (referencedBy.size >= 2) {
      node.corpusConnectionCount = referencedBy.size;
      nodes.set(extId, node);

      // Add edges from each corpus paper to this external node
      referencedBy.forEach((corpusId) => {
        edges.push({ source: corpusId, target: extId });
      });
    }
  });

  console.log(
    `[citation-graph] Built graph: ${nodes.size} nodes (${corpusPapers.length} corpus + ${nodes.size - corpusPapers.length} external), ${edges.length} edges`
  );

  return {
    nodes: Array.from(nodes.values()),
    edges,
  };
}

/** Match an S2Result to a corpus paper by DOI, arxivId, or title similarity */
function matchToCorpus(
  ref: S2Result,
  corpusByDoi: Map<string, string>,
  corpusByArxiv: Map<string, string>,
  corpusList: { id: string; title: string; doi: string | null; arxivId: string | null }[]
): string | null {
  // Exact DOI match
  if (ref.doi) {
    const match = corpusByDoi.get(ref.doi.toLowerCase());
    if (match) return match;
  }

  // Exact arxivId match
  if (ref.arxivId) {
    const match = corpusByArxiv.get(ref.arxivId);
    if (match) return match;
  }

  // Title similarity fallback
  for (const cp of corpusList) {
    if (titleSimilarity(ref.title, cp.title) >= 0.85) {
      return cp.id;
    }
  }

  return null;
}

/** Generate a stable external ID for a reference */
function makeExternalId(ref: S2Result): string | null {
  if (ref.doi) return `ext:doi:${ref.doi.toLowerCase()}`;
  if (ref.arxivId) return `ext:arxiv:${ref.arxivId}`;
  if (ref.title) return `ext:title:${ref.title.toLowerCase().slice(0, 80)}`;
  return null;
}
