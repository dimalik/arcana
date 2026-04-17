import { readFile } from "fs/promises";
import path from "path";
import {
  runPdfPreflight,
  type PreflightConfig,
  type PreflightOutput,
} from "../pdf-preflight";
import { GrobidClient } from "../grobid/client";
import { parseGrobidTeiReferences } from "../grobid/tei-parser";
import type {
  ExtractionStatus,
  ReferenceExtractionCandidate,
  ReferenceExtractor,
} from "../types";

export interface GrobidExtractorResult {
  candidates: ReferenceExtractionCandidate[];
  status: ExtractionStatus;
  errorSummary?: string;
  preflight?: PreflightOutput;
}

export interface GrobidReferenceExtractorOptions {
  client?: GrobidClient;
  preflightConfig?: PreflightConfig;
  priority?: "interactive" | "backfill";
}

export class GrobidReferenceExtractor implements ReferenceExtractor {
  readonly method = "grobid_tei" as const;
  private readonly client: GrobidClient;
  private readonly preflightConfig?: PreflightConfig;
  private readonly priority: "interactive" | "backfill";

  constructor(options: GrobidReferenceExtractorOptions = {}) {
    this.client = options.client ?? new GrobidClient();
    this.preflightConfig = options.preflightConfig;
    this.priority = options.priority ?? "interactive";
  }

  async extract(paperId: string, pdfPath: string): Promise<GrobidExtractorResult> {
    void paperId;

    const preflight = await runPdfPreflight(pdfPath, this.preflightConfig);
    if (preflight.result !== "text_layer_ok") {
      return {
        candidates: [],
        status: "failed",
        errorSummary: preflight.reason ?? preflight.result,
        preflight,
      };
    }

    try {
      const absolutePath = path.resolve(process.cwd(), pdfPath);
      const pdfBuffer = await readFile(absolutePath);
      const response = await this.client.processReferences({
        pdfBuffer,
        priority: this.priority,
        pageCount: preflight.pageCount,
        includeRawCitations: true,
        consolidateCitations: false,
      });

      const candidates = parseGrobidTeiReferences(response.teiXml);
      if (candidates.length === 0) {
        return {
          candidates: [],
          status: "partial",
          errorSummary: "GROBID returned TEI but no bibliography entries were parsed",
          preflight,
        };
      }

      return {
        candidates,
        status: "succeeded",
        preflight,
      };
    } catch (error) {
      return {
        candidates: [],
        status: "failed",
        errorSummary:
          error instanceof Error ? error.message : `GROBID extraction failed: ${String(error)}`,
        preflight,
      };
    }
  }
}
