/**
 * Unified figure extraction orchestrator.
 *
 * Runs all applicable extraction sources for a paper based on its identity
 * (DOI → PMC/JATS + publisher, arXivId → arXiv HTML, always → PDF fallback),
 * merges results by figure identity, and reconciles the database.
 *
 * IMPORTANT: merge input comes from extractor return values, NOT DB reads.
 * This ensures reruns are idempotent — stale rows from prior runs never
 * leak into the merge input.
 */

import { prisma } from "@/lib/prisma";
import { writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import path from "path";
import { extractFiguresFromPdf } from "./pdf-figure-pipeline";
import { extractFiguresWithGrobid, isGrobidConfigured } from "./grobid-tei-extractor";
import { downloadPmcFigures } from "./pmc-jats-extractor";
import { downloadFiguresFromHtml } from "@/lib/import/figure-downloader";
import { extractWithPublisherParser } from "./publisher-parsers";
import {
  persistExtractionEvidence,
  type ExtractionSourceBatch,
} from "./extraction-foundation";
import {
  prepareCapabilitySnapshotForExtraction,
  type CapabilitySnapshotContext,
} from "./capability-substrate";
import { createIdentityResolutionSnapshot } from "./identity-resolution";
import {
  createProjectionRunSnapshot,
  publishProjectionRun,
} from "./projection-publication";
import {
  acquirePaperWorkLease,
  releasePaperWorkLease,
} from "./publication-guards";
import { mergeFigureSources, type MergeableFigure } from "./source-merger";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Accept: "text/html,application/xhtml+xml,*/*",
};

export interface ExtractionReport {
  paperId: string;
  sources: {
    method: string;
    attempted: boolean;
    figuresFound: number;
    error?: string;
  }[];
  totalFigures: number;
  figuresWithImages: number;
  gapPlaceholders: number;
  /** Number of merged figures that failed to persist to DB. */
  persistErrors: number;
}

export interface FigureExtractionPaperInput {
  id: string;
  title: string | null;
  filePath: string | null;
  doi: string | null;
  arxivId: string | null;
  sourceUrl: string | null;
}

export interface FigureSourceCollectionResult {
  sourceBatches: ExtractionSourceBatch[];
  allSources: MergeableFigure[][];
  sourceReport: ExtractionReport["sources"];
}

export async function collectFigureSourceBatches(
  paper: FigureExtractionPaperInput,
  capabilitySnapshot: CapabilitySnapshotContext,
  opts?: { maxPages?: number; skipPdf?: boolean },
): Promise<FigureSourceCollectionResult> {
  const capabilityBySource = new Map(
    capabilitySnapshot.entries.map((entry) => [entry.source, entry]),
  );

  const sourceBatches: ExtractionSourceBatch[] = [];
  const allSources: MergeableFigure[][] = [];
  const sourceReport: ExtractionReport["sources"] = [];

  if (capabilityBySource.get("pmc_jats")?.status === "usable") {
    try {
      const result = await downloadPmcFigures(paper.id, paper.doi!);
      const figures = result.figures.map(toMergeable);
      sourceReport.push({ method: "pmc_jats", attempted: true, figuresFound: result.downloaded });
      sourceBatches.push({ method: "pmc_jats", attempted: true, figures });
      if (figures.length > 0) allSources.push(figures);
    } catch (err) {
      const error = (err as Error).message;
      sourceReport.push({ method: "pmc_jats", attempted: true, figuresFound: 0, error });
      sourceBatches.push({ method: "pmc_jats", attempted: true, figures: [], error });
    }
  } else {
    sourceReport.push({ method: "pmc_jats", attempted: false, figuresFound: 0 });
    sourceBatches.push({ method: "pmc_jats", attempted: false, figures: [] });
  }

  if (capabilityBySource.get("arxiv_html")?.status === "usable") {
    try {
      const result = await downloadFiguresFromHtml(paper.id, {
        arxivId: paper.arxivId,
        doi: null,
      });
      const figures = result.figures.map(toMergeable);
      sourceReport.push({ method: "arxiv_html", attempted: true, figuresFound: result.downloaded });
      sourceBatches.push({ method: "arxiv_html", attempted: true, figures });
      if (figures.length > 0) allSources.push(figures);
    } catch (err) {
      const error = (err as Error).message;
      sourceReport.push({ method: "arxiv_html", attempted: true, figuresFound: 0, error });
      sourceBatches.push({ method: "arxiv_html", attempted: true, figures: [], error });
    }
  } else {
    sourceReport.push({ method: "arxiv_html", attempted: false, figuresFound: 0 });
    sourceBatches.push({ method: "arxiv_html", attempted: false, figures: [] });
  }

  if (capabilityBySource.get("publisher_html")?.status === "usable") {
    try {
      const pubResult = await tryPublisherFigures(paper.id, paper.doi!);
      const figures = pubResult.figures.map(toMergeable);
      sourceReport.push({ method: "publisher_html", attempted: true, figuresFound: pubResult.downloaded });
      sourceBatches.push({ method: "publisher_html", attempted: true, figures });
      if (figures.length > 0) allSources.push(figures);
    } catch (err) {
      const error = (err as Error).message;
      sourceReport.push({ method: "publisher_html", attempted: true, figuresFound: 0, error });
      sourceBatches.push({ method: "publisher_html", attempted: true, figures: [], error });
    }
  } else {
    sourceReport.push({ method: "publisher_html", attempted: false, figuresFound: 0 });
    sourceBatches.push({ method: "publisher_html", attempted: false, figures: [] });
  }

  const coveredLabels = new Set<string>();
  for (const srcArray of allSources) {
    for (const fig of srcArray) {
      if (fig.figureLabel && (fig.confidence === "high" || fig.confidence === "medium")) {
        coveredLabels.add(fig.figureLabel.toLowerCase().replace(/^fig\.?\s*/i, "figure ").trim());
      }
    }
  }

  if (paper.filePath && !opts?.skipPdf && isGrobidConfigured()) {
    try {
      const figures = await extractFiguresWithGrobid(path.resolve(process.cwd(), paper.filePath));
      sourceReport.push({ method: "grobid_tei", attempted: true, figuresFound: figures.length });
      sourceBatches.push({ method: "grobid_tei", attempted: true, figures });
      if (figures.length > 0) allSources.push(figures);
    } catch (err) {
      const error = (err as Error).message;
      sourceReport.push({ method: "grobid_tei", attempted: true, figuresFound: 0, error });
      sourceBatches.push({ method: "grobid_tei", attempted: true, figures: [], error });
    }
  } else {
    sourceReport.push({ method: "grobid_tei", attempted: false, figuresFound: 0 });
    sourceBatches.push({ method: "grobid_tei", attempted: false, figures: [] });
  }

  if (paper.filePath && !opts?.skipPdf) {
    try {
      const pdfFigures = await extractFiguresFromPdf(
        paper.filePath,
        paper.id,
        { maxPages: opts?.maxPages || 50, coveredLabels },
      );
      const figures = pdfFigures.map((figure) => toMergeable({
        ...figure,
        sourceUrl: null,
      }));
      sourceReport.push({ method: "pdf_fallback", attempted: true, figuresFound: pdfFigures.length });
      sourceBatches.push({ method: "pdf_fallback", attempted: true, figures });
      allSources.push(figures);
    } catch (err) {
      const error = (err as Error).message;
      sourceReport.push({ method: "pdf_fallback", attempted: true, figuresFound: 0, error });
      sourceBatches.push({ method: "pdf_fallback", attempted: true, figures: [], error });
    }
  } else {
    sourceReport.push({ method: "pdf_fallback", attempted: false, figuresFound: 0 });
    sourceBatches.push({ method: "pdf_fallback", attempted: false, figures: [] });
  }

  return {
    sourceBatches,
    allSources,
    sourceReport,
  };
}

/** Convert an extractor record to MergeableFigure (fills missing fields with null). */
function toMergeable(rec: {
  figureLabel?: string | null;
  captionText?: string | null;
  captionSource: string;
  sourceMethod: string;
  sourceUrl?: string | null;
  confidence: string;
  imagePath?: string | null;
  assetHash?: string | null;
  pdfPage?: number | null;
  bbox?: string | null;
  type: string;
  width?: number | null;
  height?: number | null;
  tableHtml?: string;
  description?: string | null;
  cropOutcome?: "success" | "rejected" | "failed" | null;
}): MergeableFigure {
  return {
    figureLabel: rec.figureLabel ?? null,
    captionText: rec.captionText ?? null,
    captionSource: rec.captionSource,
    sourceMethod: rec.sourceMethod,
    sourceUrl: rec.sourceUrl ?? null,
    confidence: rec.confidence,
    description: rec.tableHtml || rec.description || null,
    imagePath: rec.imagePath ?? null,
    assetHash: rec.assetHash ?? null,
    pdfPage: rec.pdfPage ?? null,
    bbox: rec.bbox ?? null,
    type: rec.type,
    width: rec.width ?? null,
    height: rec.height ?? null,
    cropOutcome: rec.cropOutcome ?? null,
  };
}

/**
 * Run all applicable extraction sources for a paper and merge results.
 */
export async function extractAllFigures(
  paperId: string,
  opts?: { maxPages?: number; skipPdf?: boolean },
): Promise<ExtractionReport> {
  const paper = await prisma.paper.findUnique({
    where: { id: paperId },
    select: {
      id: true,
      title: true,
      filePath: true,
      doi: true,
      arxivId: true,
      sourceUrl: true,
    },
  });

  if (!paper) throw new Error(`Paper ${paperId} not found`);

  const report: ExtractionReport = {
    paperId,
    sources: [],
    totalFigures: 0,
    figuresWithImages: 0,
    gapPlaceholders: 0,
    persistErrors: 0,
  };

  const capabilitySnapshot = await prisma.$transaction((tx) => prepareCapabilitySnapshotForExtraction(tx, {
    id: paper.id,
    doi: paper.doi,
    arxivId: paper.arxivId,
    sourceUrl: paper.sourceUrl,
  }));
  const { sourceBatches, allSources, sourceReport } = await collectFigureSourceBatches(
    paper,
    capabilitySnapshot,
    opts,
  );
  report.sources = sourceReport;

  // ── Merge ─────────────────────────────────────────────────────────
  const merged = mergeFigureSources(...allSources);

  // ── Persist merged rows (transactional) ─────────────────────────────
  //
  // The entire reconcile — upserts, label-drift renames, stale-row
  // demotion — runs in a single transaction. If any write fails the
  // whole batch rolls back, preventing partial mutation of the DB.
  let persistErrors = 0;
  try {
    await prisma.$transaction(async (tx) => {
      const leaseToken = await acquirePaperWorkLease(
        tx,
        paperId,
        "extract-all-figures",
      );

      try {
        const extractionRunId = await persistExtractionEvidence(
          tx,
          paperId,
          capabilitySnapshot.capabilitySnapshotId,
          sourceBatches,
          {
          coverageClass: capabilitySnapshot.coverageClass,
          mergedCount: merged.length,
          sourceReport: report.sources,
          skipPdf: opts?.skipPdf ?? false,
          maxPages: opts?.maxPages || 50,
          },
        );
        const identityResolutionId = await createIdentityResolutionSnapshot(tx, {
          paperId,
          provenanceKind: "extraction",
          extractionRunId,
        });
        const projectionRunId = await createProjectionRunSnapshot(tx, paperId, identityResolutionId);
        await publishProjectionRun(tx, paperId, identityResolutionId, projectionRunId, merged, leaseToken);
      } finally {
        await releasePaperWorkLease(tx, paperId, leaseToken);
      }
    });
  } catch (err) {
    // Transaction rolled back — DB unchanged from pre-merge state.
    // Use Math.max(1, ...) so a failure during stale-row reconciliation
    // with zero merged figures still reports as a persist error.
    persistErrors = Math.max(1, merged.length);
    console.error(`[extract-all] Persist transaction failed, rolled back:`, (err as Error).message);
  }

  report.persistErrors = persistErrors;

  // ── Post-pass: render HTML table previews (best-effort, non-transactional) ──
  if (persistErrors === 0) {
    try {
      const { renderTablePreviews } = await import("./html-table-preview-renderer");
      const previewResult = await renderTablePreviews(paperId);
      if (previewResult.rendered > 0) {
        console.log(`[extract-all] Rendered ${previewResult.rendered} table previews for ${paperId}`);
      }
    } catch (err) {
      console.warn(`[extract-all] Table preview rendering skipped: ${(err as Error).message}`);
    }
  }

  // ── Compute report from actual DB state ──────────────────────────────
  // Accounts for preserved previews from prior runs and newly rendered ones,
  // not just what the merge output thought would happen.
  if (persistErrors === 0) {
    const dbCanonical = await prisma.paperFigure.findMany({
      where: { paperId, isPrimaryExtraction: true },
      select: { imagePath: true },
    });
    report.totalFigures = dbCanonical.length;
    report.figuresWithImages = dbCanonical.filter(f => f.imagePath).length;
    report.gapPlaceholders = dbCanonical.filter(f => !f.imagePath).length;
  } else {
    const canonical = merged.filter(f => f.isPrimaryExtraction);
    report.totalFigures = canonical.length;
    report.figuresWithImages = canonical.filter(f => f.imagePath).length;
    report.gapPlaceholders = canonical.filter(f => !f.imagePath).length;
  }

  const summary =
    `[extract-all] ${paper.title}: ${report.totalFigures} figures ` +
    `(${report.figuresWithImages} with images, ${report.gapPlaceholders} gaps` +
    `${persistErrors > 0 ? `, ${persistErrors} persist errors` : ""})` +
    ` from ${report.sources.filter(s => s.attempted && s.figuresFound > 0).map(s => s.method).join(", ") || "none"}`;
  if (persistErrors > 0) {
    console.warn(summary);
  } else {
    console.log(summary);
  }

  return report;
}

// ── Publisher HTML helper ────────────────────────────────────────────

interface PublisherFigureRecord {
  figureLabel: string;
  captionText: string | null;
  captionSource: string;
  sourceMethod: string;
  sourceUrl: string;
  confidence: string;
  imagePath: string;
  assetHash: string;
  type: string;
}

async function tryPublisherFigures(
  paperId: string,
  doi: string,
): Promise<{ downloaded: number; figures: PublisherFigureRecord[] }> {
  const empty = { downloaded: 0, figures: [] as PublisherFigureRecord[] };

  const doiUrl = `https://doi.org/${doi}`;
  const res = await fetch(doiUrl, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return empty;

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("html")) return empty;

  const html = await res.text();
  if (html.includes("Just a moment...") || html.includes("cf-browser-verification")) {
    return empty;
  }

  const pubResult = extractWithPublisherParser(html, res.url);
  if (!pubResult || pubResult.figures.length === 0) return empty;

  const figDir = path.join(process.cwd(), "uploads", "figures", paperId);
  await mkdir(figDir, { recursive: true });

  const written: PublisherFigureRecord[] = [];
  for (let i = 0; i < pubResult.figures.length; i++) {
    const fig = pubResult.figures[i];
    try {
      const imgRes = await fetch(fig.imgUrl, {
        headers: { ...BROWSER_HEADERS, Accept: "image/*,*/*" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!imgRes.ok) continue;

      const ct = imgRes.headers.get("content-type") || "";
      if (!ct.startsWith("image/") && !ct.includes("svg")) continue;

      const buffer = Buffer.from(await imgRes.arrayBuffer());
      if (buffer.length < 500 || buffer.length > 15_000_000) continue;

      const assetHash = createHash("sha256").update(buffer).digest("hex");
      const ext = ct.includes("png") ? "png"
        : ct.includes("svg") ? "svg"
        : ct.includes("gif") ? "gif"
        : ct.includes("webp") ? "webp"
        : "jpg";
      const filename = `pub-${i}.${ext}`;
      await writeFile(path.join(figDir, filename), buffer);

      const imagePath = `uploads/figures/${paperId}/${filename}`;
      const figureLabel = fig.figureLabel || `pub-fig-${i}`;

      // No DB write — the orchestrator's transaction handles all persistence.
      written.push({
        figureLabel,
        captionText: fig.caption || null,
        captionSource: fig.caption ? "html_figcaption" : "none",
        sourceMethod: "publisher_html",
        sourceUrl: fig.imgUrl,
        confidence: "medium",
        imagePath,
        assetHash,
        type: fig.type,
      });
    } catch {
      // Skip individual figure failures
    }
  }

  return { downloaded: written.length, figures: written };
}
