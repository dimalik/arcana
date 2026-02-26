/**
 * Discovery engine: follows citation chains from seed papers to find
 * related work not yet in the user's library.
 */

import { prisma } from "@/lib/prisma";
import { getReferencesForPaper, getCitationsForPaper } from "./s2-graph";
import { searchByTitle, type S2Result } from "@/lib/import/semantic-scholar";
import {
  titleSimilarity,
  findLibraryMatchByIds,
} from "@/lib/references/match";

export interface DiscoveryProgress {
  type: "progress";
  found: number;
  checking: string;
}

export interface DiscoveryProposalEvent {
  type: "proposal";
  proposal: {
    id: string;
    title: string;
    authors: string | null;
    year: number | null;
    venue: string | null;
    citationCount: number | null;
    reason: string;
  };
}

export interface DiscoveryDone {
  type: "done";
  totalFound: number;
}

export interface DiscoveryError {
  type: "error";
  message: string;
}

export type DiscoveryEvent =
  | DiscoveryProgress
  | DiscoveryProposalEvent
  | DiscoveryDone
  | DiscoveryError;

/**
 * Run discovery for a session. Yields progress events as NDJSON.
 */
export async function* runDiscovery(
  sessionId: string,
  seedPaperIds: string[],
  _depth: number
): AsyncGenerator<DiscoveryEvent> {
  try {
    // Load all library papers for dedup
    const libraryPapers = await prisma.paper.findMany({
      select: { id: true, title: true, doi: true, arxivId: true },
    });

    // Track already-seen titles to avoid duplicate proposals within session
    const seenTitles = new Set<string>();
    const seenDois = new Set<string>();
    const seenArxivIds = new Set<string>();
    let totalFound = 0;

    // Load seed papers
    const seedPapers = await prisma.paper.findMany({
      where: { id: { in: seedPaperIds } },
    });

    // For each seed paper, resolve to an external ID and explore
    for (const seed of seedPapers) {
      // Add seed to seen to avoid proposing it back
      seenTitles.add(seed.title);
      if (seed.doi) seenDois.add(seed.doi.toLowerCase());
      if (seed.arxivId) seenArxivIds.add(seed.arxivId);

      yield {
        type: "progress",
        found: totalFound,
        checking: `Looking up "${truncate(seed.title, 60)}" in academic databases...`,
      };

      // Resolve seed paper to an external ID we can use for graph traversal.
      // Always do a title search — this gives us a proper OpenAlex/S2 ID
      // regardless of whether the paper has a DOI stored.
      let externalId: string | null = null;

      // Try DOI first (fast, exact match via OpenAlex)
      if (seed.doi) {
        externalId = `https://doi.org/${seed.doi}`;
      }

      // If no DOI, search by title to get an OpenAlex or S2 ID
      if (!externalId) {
        const result = await searchByTitle(seed.title, seed.year);
        if (result) {
          externalId = result.semanticScholarId;
        }
      }

      if (!externalId) {
        yield {
          type: "progress",
          found: totalFound,
          checking: `Could not find "${truncate(seed.title, 50)}" in databases, skipping...`,
        };
        continue;
      }

      // Get outbound references (papers this seed cites)
      yield {
        type: "progress",
        found: totalFound,
        checking: `Getting references from "${truncate(seed.title, 50)}"...`,
      };

      const references = await getReferencesForPaper(externalId);

      yield {
        type: "progress",
        found: totalFound,
        checking: `Processing ${references.length} references from "${truncate(seed.title, 40)}"...`,
      };

      for (const ref of references) {
        const result = await processCandidate(
          ref,
          `cited_by:${seed.id}`,
          sessionId,
          libraryPapers,
          seenTitles,
          seenDois,
          seenArxivIds
        );
        if (result) {
          totalFound++;
          yield { type: "proposal", proposal: result };
        }
      }

      // Get inbound citations (papers that cite this seed)
      yield {
        type: "progress",
        found: totalFound,
        checking: `Getting papers that cite "${truncate(seed.title, 50)}"...`,
      };

      const citations = await getCitationsForPaper(externalId);

      yield {
        type: "progress",
        found: totalFound,
        checking: `Processing ${citations.length} citations of "${truncate(seed.title, 40)}"...`,
      };

      for (const cit of citations) {
        const result = await processCandidate(
          cit,
          `cites:${seed.id}`,
          sessionId,
          libraryPapers,
          seenTitles,
          seenDois,
          seenArxivIds
        );
        if (result) {
          totalFound++;
          yield { type: "proposal", proposal: result };
        }
      }

      yield {
        type: "progress",
        found: totalFound,
        checking: `Finished "${truncate(seed.title, 50)}" — ${totalFound} papers so far`,
      };
    }

    // Update session status
    await prisma.discoverySession.update({
      where: { id: sessionId },
      data: { status: "COMPLETED", totalFound },
    });

    yield { type: "done", totalFound };
  } catch (err) {
    console.error("[discovery] Error:", err);
    await prisma.discoverySession.update({
      where: { id: sessionId },
      data: { status: "FAILED" },
    });
    yield {
      type: "error",
      message: err instanceof Error ? err.message : "Discovery failed",
    };
  }
}

async function processCandidate(
  candidate: S2Result,
  reason: string,
  sessionId: string,
  libraryPapers: Array<{
    id: string;
    title: string;
    doi: string | null;
    arxivId: string | null;
  }>,
  seenTitles: Set<string>,
  seenDois: Set<string>,
  seenArxivIds: Set<string>
): Promise<DiscoveryProposalEvent["proposal"] | null> {
  if (!candidate.title || candidate.title.length < 5) return null;

  // Dedup by DOI
  if (candidate.doi) {
    const doiLower = candidate.doi.toLowerCase();
    if (seenDois.has(doiLower)) return null;
    seenDois.add(doiLower);
  }

  // Dedup by arXiv ID
  if (candidate.arxivId) {
    if (seenArxivIds.has(candidate.arxivId)) return null;
    seenArxivIds.add(candidate.arxivId);
  }

  // Dedup by title similarity
  const titles = Array.from(seenTitles);
  for (let i = 0; i < titles.length; i++) {
    if (titleSimilarity(candidate.title, titles[i]) >= 0.85) return null;
  }
  seenTitles.add(candidate.title);

  // Check if already in library
  const libraryMatch = findLibraryMatchByIds(
    {
      doi: candidate.doi,
      arxivId: candidate.arxivId,
      title: candidate.title,
    },
    libraryPapers
  );

  const status = libraryMatch ? "ALREADY_IN_LIBRARY" : "PENDING";

  // Create proposal in DB
  const proposal = await prisma.discoveryProposal.create({
    data: {
      sessionId,
      title: candidate.title,
      authors: candidate.authors.length > 0 ? JSON.stringify(candidate.authors) : null,
      year: candidate.year,
      venue: candidate.venue,
      doi: candidate.doi,
      arxivId: candidate.arxivId,
      externalUrl: candidate.externalUrl,
      citationCount: candidate.citationCount,
      openAccessPdfUrl: candidate.openAccessPdfUrl,
      semanticScholarId: candidate.semanticScholarId,
      reason,
      status,
      importedPaperId: libraryMatch?.paperId || null,
    },
  });

  return {
    id: proposal.id,
    title: proposal.title,
    authors: proposal.authors,
    year: proposal.year,
    venue: proposal.venue,
    citationCount: proposal.citationCount,
    reason: proposal.reason,
  };
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}
