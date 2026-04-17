import path from "path";
import { getDefaultModel } from "../src/lib/llm/auto-process";
import { extractTextFromPdf } from "../src/lib/pdf/parser";
import { prisma } from "../src/lib/prisma";
import { extractReferenceCandidates } from "../src/lib/references/extraction";
import { GrobidReferenceExtractor } from "../src/lib/references/extractors/grobid";
import { loadGrobidConfig } from "../src/lib/references/grobid/config";
import { checkGrobidHealth } from "../src/lib/references/grobid/health";

interface Args {
  paperId?: string;
  pdfPath?: string;
  sampleCount: number;
  grobidOnly: boolean;
  healthOnly: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadGrobidConfig();
  const health = await checkGrobidHealth(config.serverUrl);

  console.log(
    JSON.stringify(
      {
        grobidServerUrl: config.serverUrl,
        grobidHealth: health,
      },
      null,
      2,
    ),
  );

  if (args.healthOnly) {
    return;
  }

  const target = await resolveTarget(args);

  if (args.grobidOnly) {
    const extractor = new GrobidReferenceExtractor({ priority: "interactive" });
    const result = await extractor.extract(target.paperId, target.filePath);
    console.log(
      JSON.stringify(
        {
          mode: "grobid-only",
          target: {
            paperId: target.paperId,
            title: target.title,
            filePath: target.filePath,
          },
          status: result.status,
          errorSummary: result.errorSummary,
          preflight: result.preflight ?? null,
          candidateCount: result.candidates.length,
          sampleReferences: summarizeReferences(
            result.candidates,
            args.sampleCount,
          ),
        },
        null,
        2,
      ),
    );
    return;
  }

  const fullText =
    target.fullText && target.fullText.trim().length > 0
      ? target.fullText
      : await extractTextFromPdf(target.filePath);
  const { provider, modelId, proxyConfig } = await getDefaultModel();
  const result = await extractReferenceCandidates({
    paperId: target.paperId,
    filePath: target.filePath,
    fullText,
    provider,
    modelId,
    proxyConfig,
  });

  console.log(
    JSON.stringify(
      {
        mode: "hybrid",
        llmProvider: provider,
        modelId,
        target: {
          paperId: target.paperId,
          title: target.title,
          filePath: target.filePath,
          usedStoredFullText:
            !!target.fullText && target.fullText.trim().length > 0,
        },
        method: result.method,
        status: result.status,
        extractorVersion: result.extractorVersion,
        fallbackReason: result.fallbackReason ?? null,
        attempts: result.attempts,
        candidateCount: result.candidates.length,
        sampleReferences: summarizeReferences(result.candidates, args.sampleCount),
      },
      null,
      2,
    ),
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sampleCount: 5,
    grobidOnly: false,
    healthOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--paper-id") {
      args.paperId = argv[i + 1];
      i += 1;
    } else if (arg === "--pdf") {
      args.pdfPath = argv[i + 1];
      i += 1;
    } else if (arg === "--sample") {
      args.sampleCount = Number.parseInt(argv[i + 1] ?? "5", 10) || 5;
      i += 1;
    } else if (arg === "--grobid-only") {
      args.grobidOnly = true;
    } else if (arg === "--health") {
      args.healthOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.healthOnly && !args.paperId && !args.pdfPath) {
    printHelpAndExit(1);
  }

  if (args.paperId && args.pdfPath) {
    throw new Error("Pass either --paper-id or --pdf, not both.");
  }

  return args;
}

async function resolveTarget(args: Args): Promise<{
  paperId: string;
  title: string | null;
  filePath: string;
  fullText: string | null;
}> {
  if (args.paperId) {
    const paper = await prisma.paper.findUnique({
      where: { id: args.paperId },
      select: {
        id: true,
        title: true,
        filePath: true,
        fullText: true,
      },
    });
    if (!paper) {
      throw new Error(`Paper not found: ${args.paperId}`);
    }
    if (!paper.filePath) {
      throw new Error(`Paper ${args.paperId} does not have a PDF filePath`);
    }
    return {
      paperId: paper.id,
      title: paper.title,
      filePath: paper.filePath,
      fullText: paper.fullText,
    };
  }

  if (!args.pdfPath) {
    throw new Error("Missing --paper-id or --pdf");
  }

  return {
    paperId: path.basename(args.pdfPath, path.extname(args.pdfPath)),
    title: path.basename(args.pdfPath),
    filePath: args.pdfPath,
    fullText: null,
  };
}

function summarizeReferences(
  refs: Array<{
    referenceIndex: number | null;
    title: string | null;
    authors: string[] | null;
    year: number | null;
    venue: string | null;
    doi: string | null;
    arxivId: string | null;
    rawCitation: string;
  }>,
  sampleCount: number,
) {
  return refs.slice(0, sampleCount).map((ref) => ({
    referenceIndex: ref.referenceIndex,
    title: ref.title,
    authors: ref.authors,
    year: ref.year,
    venue: ref.venue,
    doi: ref.doi,
    arxivId: ref.arxivId,
    rawCitation: ref.rawCitation.slice(0, 300),
  }));
}

function printHelpAndExit(code: number): never {
  console.log(`Usage:
  npx tsx scripts/smoke-grobid-references.ts --health
  npx tsx scripts/smoke-grobid-references.ts --paper-id <paperId> [--sample 5]
  npx tsx scripts/smoke-grobid-references.ts --pdf <path/to/paper.pdf> [--grobid-only] [--sample 5]

Notes:
  --health       Only checks GROBID /api/isalive using GROBID_SERVER_URL
  --grobid-only  Skips the LLM fallback path and runs the GROBID extractor directly
  --sample       Number of references to print in the summary output
`);
  process.exit(code);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
