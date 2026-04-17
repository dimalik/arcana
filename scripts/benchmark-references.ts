import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import {
  scoreExtraction,
  type ExpectedRef,
  type ExtractedRef,
} from "../src/lib/references/benchmark";

const FIXTURES_DIR = join(
  process.cwd(),
  "src/lib/references/__tests__/fixtures",
);
const EXPECTED_DIR = join(FIXTURES_DIR, "expected");
const RECORDED_DIR = join(
  process.cwd(),
  "src/lib/references/__tests__/recorded",
);
const REPORT_PATH = join(
  process.cwd(),
  "docs/superpowers/notes/2026-04-16-reference-extraction-baseline.md",
);

interface ExtractedRefRaw {
  index?: number;
  title: string;
  authors?: string[] | null;
  year?: number | null;
  venue?: string | null;
  doi?: string | null;
  rawCitation: string;
}

interface BaselineSnapshot {
  paperId: string;
  pdfFile: string;
  extractorVersion: string;
  capturedAt: string;
  expected: ExpectedRef[];
  currentPipelineOutput: ExtractedRefRaw[];
}

function listSnapshotFiles(): string[] {
  if (!existsSync(RECORDED_DIR)) {
    return [];
  }

  return readdirSync(RECORDED_DIR)
    .filter((file) => file.startsWith("baseline-refs-") && file.endsWith(".json"))
    .sort();
}

function asExtractedRefs(snapshot: BaselineSnapshot): ExtractedRef[] {
  return snapshot.currentPipelineOutput.map((ref) => ({
    title: ref.title,
    year: ref.year,
    doi: ref.doi,
  }));
}

function loadSnapshot(file: string): BaselineSnapshot {
  return JSON.parse(readFileSync(join(RECORDED_DIR, file), "utf-8")) as BaselineSnapshot;
}

function runScoreMode(): void {
  const files = listSnapshotFiles();
  if (files.length === 0) {
    console.log(
      "No baseline snapshots found. Run --capture first to generate baselines.",
    );
    process.exit(1);
  }

  console.log(`\n=== Baseline Score (${files.length} snapshots) ===\n`);

  let totalMatched = 0;
  let totalMissed = 0;
  let totalExtra = 0;

  for (const file of files) {
    const snapshot = loadSnapshot(file);
    const score = scoreExtraction(snapshot.expected, asExtractedRefs(snapshot));
    totalMatched += score.matched;
    totalMissed += score.missed;
    totalExtra += score.extra;

    console.log(
      `  ${snapshot.pdfFile}: P=${score.precision.toFixed(2)} R=${score.recall.toFixed(2)} ` +
        `F1=${score.f1.toFixed(2)} (${score.matched}/${snapshot.expected.length} matched, ${score.extra} extra)`,
    );
  }

  const totalExpected = totalMatched + totalMissed;
  const totalExtracted = totalMatched + totalExtra;
  const precision = totalExtracted > 0 ? totalMatched / totalExtracted : 0;
  const recall = totalExpected > 0 ? totalMatched / totalExpected : 0;
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  console.log(
    `\n  OVERALL: P=${precision.toFixed(2)} R=${recall.toFixed(2)} F1=${f1.toFixed(2)}`,
  );
  console.log(
    `  (${totalMatched} matched, ${totalMissed} missed, ${totalExtra} extra)\n`,
  );
}

async function runCaptureMode(): Promise<void> {
  const { extractTextFromPdf } = await import("../src/lib/pdf/parser");
  const { getTextForReferenceExtraction } = await import(
    "../src/lib/references/extract-section"
  );
  const { buildPrompt, cleanJsonResponse } = await import(
    "../src/lib/llm/prompts"
  );
  const { generateLLMResponse } = await import("../src/lib/llm/provider");
  const { getDefaultModel } = await import("../src/lib/llm/auto-process");

  const { provider, modelId, proxyConfig } = await getDefaultModel();
  console.log(`Using provider=${provider} model=${modelId}\n`);

  const pdfs = existsSync(FIXTURES_DIR)
    ? readdirSync(FIXTURES_DIR).filter((file) => file.endsWith(".pdf")).sort()
    : [];
  if (pdfs.length === 0) {
    console.log(`No PDFs in ${FIXTURES_DIR}. Add OA fixture PDFs first.`);
    process.exit(1);
  }

  mkdirSync(RECORDED_DIR, { recursive: true });

  console.log(`=== Capture Mode (${pdfs.length} PDFs) ===\n`);

  for (const pdfFile of pdfs) {
    const name = basename(pdfFile, ".pdf");
    const expectedPath = join(EXPECTED_DIR, `${name}.expected.json`);
    if (!existsSync(expectedPath)) {
      console.log(`  SKIP ${pdfFile}: no ${name}.expected.json found`);
      continue;
    }

    const expected = JSON.parse(
      readFileSync(expectedPath, "utf-8"),
    ) as { refs: ExpectedRef[] };

    console.log(`  Extracting ${pdfFile}...`);
    const fullText = await extractTextFromPdf(join(FIXTURES_DIR, pdfFile));
    const referenceText = getTextForReferenceExtraction(fullText);
    const { system } = buildPrompt("extractReferences", "");
    const prompt = `Here is the reference/bibliography section of the paper:\n\n${referenceText}`;
    const response = await generateLLMResponse({
      provider,
      modelId,
      system,
      prompt,
      maxTokens: 8000,
      proxyConfig,
    });

    let refs: ExtractedRefRaw[] = [];
    try {
      const parsed = JSON.parse(cleanJsonResponse(response)) as unknown;
      refs = Array.isArray(parsed) ? (parsed as ExtractedRefRaw[]) : [];
    } catch {
      console.log(`  ERROR ${pdfFile}: failed to parse LLM output`);
      continue;
    }

    const score = scoreExtraction(expected.refs, refs);
    console.log(
      `  ${pdfFile}: P=${score.precision.toFixed(2)} R=${score.recall.toFixed(2)} ` +
        `F1=${score.f1.toFixed(2)} (${score.matched}/${expected.refs.length} matched, ${refs.length} extracted)`,
    );

    const snapshot: BaselineSnapshot = {
      paperId: name,
      pdfFile,
      extractorVersion: "llm_v1",
      capturedAt: new Date().toISOString(),
      expected: expected.refs,
      currentPipelineOutput: refs,
    };

    const outPath = join(RECORDED_DIR, `baseline-refs-${name}.json`);
    writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");
    console.log(`  Saved snapshot: ${outPath}`);
  }

  console.log(
    "\nDone. Commit the snapshots and run without --capture to verify in CI.\n",
  );
}

function generateBaselineReport(): void {
  const files = listSnapshotFiles();
  if (files.length === 0) {
    console.log("No snapshots to report on. Run --capture first.");
    process.exit(1);
  }

  const lines: string[] = [
    "# Reference Extraction Baseline Report",
    "",
    `**Generated:** ${new Date().toISOString()}`,
    `**Snapshots:** ${files.length}`,
    "",
    "| Paper | P | R | F1 | Matched | Expected | Extracted | Extra |",
    "|-------|---|---|----|---------|---------:|----------:|------:|",
  ];

  let totalMatched = 0;
  let totalMissed = 0;
  let totalExtra = 0;

  for (const file of files) {
    const snapshot = loadSnapshot(file);
    const score = scoreExtraction(snapshot.expected, asExtractedRefs(snapshot));
    totalMatched += score.matched;
    totalMissed += score.missed;
    totalExtra += score.extra;

    lines.push(
      `| ${snapshot.pdfFile} | ${score.precision.toFixed(2)} | ${score.recall.toFixed(2)} | ${score.f1.toFixed(2)} ` +
        `| ${score.matched} | ${snapshot.expected.length} | ${snapshot.currentPipelineOutput.length} | ${score.extra} |`,
    );
  }

  const totalExpected = totalMatched + totalMissed;
  const totalExtracted = totalMatched + totalExtra;
  const precision = totalExtracted > 0 ? totalMatched / totalExtracted : 0;
  const recall = totalExpected > 0 ? totalMatched / totalExpected : 0;
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  lines.push(
    `| **OVERALL** | **${precision.toFixed(2)}** | **${recall.toFixed(2)}** | **${f1.toFixed(2)}** ` +
      `| **${totalMatched}** | **${totalExpected}** | **${totalExtracted}** | **${totalExtra}** |`,
  );

  mkdirSync(join(process.cwd(), "docs/superpowers/notes"), { recursive: true });
  writeFileSync(REPORT_PATH, lines.join("\n") + "\n");
  console.log(`Baseline report written to ${REPORT_PATH}`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--capture")) {
    await runCaptureMode();
    return;
  }

  if (process.argv.includes("--report")) {
    generateBaselineReport();
    return;
  }

  runScoreMode();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
