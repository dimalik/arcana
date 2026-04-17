import path from "path";

import { GrobidReferenceExtractor } from "../src/lib/references/extractors/grobid";
import {
  isPromotableResolution,
  resolveReferenceOnline,
} from "../src/lib/references/resolve";

interface Args {
  pdfPaths: string[];
  sampleCount: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const extractor = new GrobidReferenceExtractor({ priority: "interactive" });

  const summaries = [];
  for (const pdfPath of args.pdfPaths) {
    const paperId = path.basename(pdfPath, path.extname(pdfPath));
    const extraction = await extractor.extract(paperId, pdfPath);
    const selected = extraction.candidates
      .filter((candidate) => candidate.title?.trim())
      .slice(0, args.sampleCount);

    const resolutions = [];
    for (const candidate of selected) {
      const resolution = await resolveReferenceOnline({
        title: candidate.title ?? candidate.rawCitation,
        authors: candidate.authors,
        year: candidate.year,
        venue: candidate.venue,
        rawCitation: candidate.rawCitation,
        doi: candidate.doi,
        arxivId: candidate.arxivId,
      });

      resolutions.push({
        referenceIndex: candidate.referenceIndex,
        extracted: {
          title: candidate.title,
          authors: candidate.authors,
          year: candidate.year,
          venue: candidate.venue,
          doi: candidate.doi,
          arxivId: candidate.arxivId,
          rawCitation: candidate.rawCitation.slice(0, 280),
        },
        resolution: resolution
          ? {
              matched: true,
              method: resolution.resolutionMethod,
              confidence: round(resolution.resolutionConfidence),
              matchedFieldCount: resolution.matchedFieldCount,
              promotable: isPromotableResolution({
                resolveSource: resolution.resolutionMethod,
                resolveConfidence: resolution.resolutionConfidence,
                matchedFieldCount: resolution.matchedFieldCount,
              }),
              evidence: resolution.evidence,
              matchedIdentifiers: resolution.matchedIdentifiers,
              candidate: {
                source: resolution.candidate.source,
                semanticScholarId: resolution.candidate.semanticScholarId,
                title: resolution.candidate.title,
                authors: resolution.candidate.authors.slice(0, 5),
                year: resolution.candidate.year,
                venue: resolution.candidate.venue,
                doi: resolution.candidate.doi,
                arxivId: resolution.candidate.arxivId,
                externalUrl: resolution.candidate.externalUrl,
                citationCount: resolution.candidate.citationCount,
              },
            }
          : {
              matched: false,
            },
      });
    }

    summaries.push({
      pdfPath,
      status: extraction.status,
      errorSummary: extraction.errorSummary,
      preflight: extraction.preflight ?? null,
      candidateCount: extraction.candidates.length,
      sampled: resolutions,
    });
  }

  console.log(JSON.stringify({ results: summaries }, null, 2));
}

function parseArgs(argv: string[]): Args {
  const pdfPaths: string[] = [];
  let sampleCount = 5;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pdf") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --pdf");
      }
      pdfPaths.push(value);
      i += 1;
    } else if (arg === "--sample") {
      sampleCount = Number.parseInt(argv[i + 1] ?? "5", 10) || 5;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (pdfPaths.length === 0) {
    printHelpAndExit(1);
  }

  return {
    pdfPaths,
    sampleCount,
  };
}

function printHelpAndExit(code: number): never {
  console.log(`Usage:
  node --import tsx scripts/smoke-reference-resolution.ts --pdf <path/to/paper.pdf> [--pdf <path/to/other.pdf>] [--sample 5]
`);
  process.exit(code);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
