import type { PreflightResult } from "./types";

export interface PreflightConfig {
  minCharsPerPage: number;
  maxReplacementCharRatio: number;
  maxPages: number;
}

export const DEFAULT_PREFLIGHT_CONFIG: PreflightConfig = {
  minCharsPerPage: 100,
  maxReplacementCharRatio: 0.15,
  maxPages: 500,
};

export interface PreflightOutput {
  result: PreflightResult;
  reason?: string;
  pageCount?: number;
  totalChars?: number;
  replacementCharRatio?: number;
}

export function countReplacementChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === "\uFFFD") count++;
  }
  return count;
}

/**
 * Inspect a real PDF file for text-layer quality before GROBID submission.
 *
 * Uses PDFParse directly because we need both the extracted text and metadata
 * such as page count. The existing parser helper only returns text.
 */
export async function runPdfPreflight(
  pdfPath: string,
  config: PreflightConfig = DEFAULT_PREFLIGHT_CONFIG,
): Promise<PreflightOutput> {
  let text: string;
  let pageCount: number;

  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const { PDFParse } = await import("pdf-parse");

    const absolutePath = path.resolve(process.cwd(), pdfPath);
    const buffer = await fs.readFile(absolutePath);
    const parser = new PDFParse({
      data: new Uint8Array(buffer),
    }) as unknown as {
      getText(): Promise<{ text: string }>;
      getInfo(
        params?: { parsePageInfo?: boolean },
      ): Promise<{ total?: number; pages?: Array<unknown> }>;
      destroy?(): Promise<void>;
    };

    try {
      // pdf-parse is not safe to call concurrently on the same parser instance.
      // Running getText() and getInfo() in parallel causes a DataCloneError in
      // the worker transport on real PDFs.
      const infoResult = await parser.getInfo();
      const textResult = await parser.getText();

      text = textResult.text;
      pageCount = infoResult.total ?? infoResult.pages?.length ?? 0;
    } finally {
      await parser.destroy?.().catch(() => undefined);
    }
  } catch (error) {
    return {
      result: "preflight_error",
      reason: `PDF parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (pageCount > config.maxPages) {
    return {
      result: "preflight_error",
      reason: `page count ${pageCount} exceeds limit ${config.maxPages}`,
      pageCount,
    };
  }

  const totalChars = text.length;
  if (totalChars === 0 || text.trim().length === 0) {
    return {
      result: "text_layer_missing",
      reason: "no recoverable text from PDF",
      pageCount,
      totalChars: 0,
    };
  }

  const charsPerPage = pageCount > 0 ? totalChars / pageCount : 0;
  if (pageCount > 0 && charsPerPage < config.minCharsPerPage) {
    return {
      result: "text_layer_missing",
      reason: `average ${Math.round(charsPerPage)} chars/page below threshold ${config.minCharsPerPage}`,
      pageCount,
      totalChars,
    };
  }

  const replacementCount = countReplacementChars(text);
  const replacementCharRatio = totalChars > 0 ? replacementCount / totalChars : 0;
  if (replacementCharRatio > config.maxReplacementCharRatio) {
    return {
      result: "text_layer_garbled",
      reason: `replacement char ratio ${(replacementCharRatio * 100).toFixed(1)}% exceeds ${(config.maxReplacementCharRatio * 100).toFixed(1)}% threshold`,
      pageCount,
      totalChars,
      replacementCharRatio,
    };
  }

  return {
    result: "text_layer_ok",
    pageCount,
    totalChars,
    replacementCharRatio,
  };
}
