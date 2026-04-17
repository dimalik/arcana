// src/lib/figures/pdf-figure-pipeline.ts
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir } from "fs/promises";
import path from "path";
import { detectCaptions, type DetectedCaption } from "./caption-detector";
import { renderAndCropFigure } from "./pdf-crop-renderer";

const execFileAsync = promisify(execFile);

export interface ExtractedFigure {
  figureLabel: string | null;
  captionText: string | null;
  captionSource: "pdf_ocr" | "none";
  sourceMethod: "pdf_embedded" | "pdf_render_crop" | "pdf_structural";
  confidence: "high" | "medium" | "low";
  imagePath: string | null;
  assetHash: string | null;
  pdfPage: number | null;
  bbox: string | null;
  type: "figure" | "table";
  width: number | null;
  height: number | null;
  /** Transient: what happened at crop time. Consumed by merger for gapReason, not persisted. */
  cropOutcome?: "success" | "rejected" | "failed" | null;
}

interface EmbeddedImage {
  page: number;
  imageIndex: number;
  width: number;
  height: number;
  bytes: number;
  assetHash: string;
  filename: string;
  filepath: string;
  yRatio: number;
}

interface PdfCropAcceptanceInput {
  type: "figure" | "table";
  width: number;
  height: number;
  regionKind: "graphics" | "text" | "fallback";
}

interface PdfCropAcceptanceResult {
  accepted: boolean;
  rejectionReason?: "crop_rejected";
}

function evaluatePdfCropAcceptance(input: PdfCropAcceptanceInput): PdfCropAcceptanceResult {
  const aspect = input.width / input.height;
  const minHeight = input.type === "figure" ? 120 : 80;
  const minWidth = input.type === "figure" ? 240 : 200;
  const isTooThin = input.height < minHeight;
  const isTooNarrow = input.width < minWidth;
  const isExtremeAspect = aspect > 20 || aspect < 0.1;

  if (input.type === "figure" && input.regionKind !== "graphics") {
    return { accepted: false, rejectionReason: "crop_rejected" };
  }
  if (isTooThin || isTooNarrow || isExtremeAspect) {
    return { accepted: false, rejectionReason: "crop_rejected" };
  }
  return { accepted: true };
}

export async function extractFiguresFromPdf(
  pdfPath: string,
  paperId: string,
  opts?: { maxPages?: number; coveredLabels?: Set<string> },
): Promise<ExtractedFigure[]> {
  const maxPages = opts?.maxPages || 50;
  const coveredLabels = opts?.coveredLabels || new Set<string>();
  const outDir = path.join(process.cwd(), "uploads", "figures", paperId);
  await mkdir(outDir, { recursive: true });

  const absolutePdfPath = path.resolve(process.cwd(), pdfPath);

  // Part 1: Detect captions from PDF text with Y positions
  const allCaptions: DetectedCaption[] = [];
  try {
    // Extract text blocks with their Y positions from PyMuPDF
    const { stdout } = await execFileAsync("python3", [
      "-c",
      `import fitz, json, sys, re
doc = fitz.open(sys.argv[1])
pages = []
caption_pat = re.compile(r'(?:Figure|Fig\.|Table)\s+\d+[a-z]?\s*[:.—–-]', re.IGNORECASE)
for i in range(min(len(doc), int(sys.argv[2]))):
    page = doc[i]
    ph = page.rect.height
    blocks = page.get_text("dict")["blocks"]
    text_lines = []
    for b in blocks:
        if b.get("type") == 0:  # text block
            for line in b.get("lines", []):
                txt = " ".join(s["text"] for s in line.get("spans", []))
                y = line["bbox"][1]  # top of the line
                text_lines.append({"text": txt, "y": y, "y_ratio": y / ph if ph > 0 else 0})
    # Also get full page text for caption detection
    full_text = page.get_text()
    # Find caption Y positions by matching caption text to text_lines
    caption_positions = {}
    for tl in text_lines:
        if caption_pat.search(tl["text"]):
            caption_positions[tl["text"][:40]] = tl["y_ratio"]
    pages.append({"page": i+1, "text": full_text, "caption_positions": caption_positions, "page_height": ph})
doc.close()
json.dump(pages, sys.stdout)`,
      absolutePdfPath,
      String(maxPages),
    ], { timeout: 30000 });
    const pages = JSON.parse(stdout) as { page: number; text: string; caption_positions: Record<string, number>; page_height: number }[];
    for (const p of pages) {
      const captions = detectCaptions(p.text, p.page);
      // Set Y positions from the PyMuPDF layout data
      for (const cap of captions) {
        // Match caption to a text line by label prefix
        for (const [lineText, yRatio] of Object.entries(p.caption_positions)) {
          if (lineText.includes(cap.label)) {
            cap.yRatio = yRatio;
            break;
          }
        }
        // Fallback: estimate from character offset
        if (cap.yRatio === 0 && p.text.length > 0) {
          cap.yRatio = cap.lineIndex / p.text.length;
        }
      }
      allCaptions.push(...captions);
    }
  } catch (err) {
    console.warn(`[pdf-pipeline] Text extraction failed: ${(err as Error).message}`);
  }

  // Part 2: Extract embedded images via PyMuPDF
  let embeddedImages: EmbeddedImage[] = [];
  try {
    const extractorPath = path.join(process.cwd(), "src/lib/figures/pdf-image-extractor.py");
    const { stdout } = await execFileAsync("python3", [
      extractorPath,
      absolutePdfPath,
      "--out-dir", outDir,
      "--max-pages", String(maxPages),
    ], { timeout: 60000 });
    embeddedImages = JSON.parse(stdout);
  } catch (err) {
    console.warn(`[pdf-pipeline] Image extraction failed: ${(err as Error).message}`);
  }

  // Match captions to images by page proximity
  const results: ExtractedFigure[] = [];
  const matchedImageHashes = new Set<string>();

  for (const caption of allCaptions) {
    // Find images on the same page that haven't been matched yet
    const pageImages = embeddedImages.filter(
      (img) => img.page === caption.page && !matchedImageHashes.has(img.assetHash),
    );

    if (pageImages.length > 0) {
      // Match by directional Y proximity:
      //   - For figures: caption is below → prefer images ABOVE the caption (yRatio < captionY)
      //   - For tables: caption is above → prefer images BELOW the caption (yRatio > captionY)
      // Within the correct direction, pick the closest image.
      // Fall back to absolute distance if no image is in the correct direction.
      const captionY = caption.yRatio;
      const isFigure = caption.type === "figure";

      pageImages.sort((a, b) => {
        const aCorrectSide = isFigure ? a.yRatio < captionY : a.yRatio > captionY;
        const bCorrectSide = isFigure ? b.yRatio < captionY : b.yRatio > captionY;

        // Prefer images on the correct side of the caption
        if (aCorrectSide && !bCorrectSide) return -1;
        if (!aCorrectSide && bCorrectSide) return 1;

        // Both on same side — pick closest by absolute distance
        return Math.abs(a.yRatio - captionY) - Math.abs(b.yRatio - captionY);
      });
      const img = pageImages[0];
      matchedImageHashes.add(img.assetHash);

      results.push({
        figureLabel: caption.label,
        captionText: caption.captionText,
        captionSource: "pdf_ocr",
        sourceMethod: "pdf_embedded",
        confidence: "medium",
        imagePath: `uploads/figures/${paperId}/${img.filename}`,
        assetHash: img.assetHash,
        pdfPage: caption.page,
        bbox: null,
        type: caption.type,
        width: img.width,
        height: img.height,
        cropOutcome: null,
      });
    } else {
      // No embedded image found — try render+crop for vector figures.
      // Skip render+crop if a high-confidence source already covers this label
      // (avoids generating bad preview crops when HTML extraction succeeded).
      const normalizedLabel = caption.label.toLowerCase().replace(/^fig\.?\s*/i, "figure ").trim();
      if (coveredLabels.has(normalizedLabel)) {
        // Emit a structural placeholder — the merge will use the HTML source
        results.push({
          figureLabel: caption.label,
          captionText: caption.captionText,
          captionSource: "pdf_ocr",
          sourceMethod: "pdf_structural",
          confidence: "low",
          imagePath: null,
          assetHash: null,
          pdfPage: caption.page,
          bbox: null,
          type: caption.type,
          width: null,
          height: null,
          cropOutcome: null, // Not a crop — covered by HTML
        });
        continue;
      }

      // Compute neighbor caption Y ratios for tighter crop bounds
      const samePage = allCaptions
        .filter((c) => c.page === caption.page && c !== caption)
        .map((c) => c.yRatio);
      const above = samePage.filter((y) => y < caption.yRatio);
      const below = samePage.filter((y) => y > caption.yRatio);
      const neighborAboveYRatio = above.length > 0 ? Math.max(...above) : undefined;
      const neighborBelowYRatio = below.length > 0 ? Math.min(...below) : undefined;

      const crop = await renderAndCropFigure({
        pdfPath: absolutePdfPath,
        page: caption.page,
        captionYRatio: caption.yRatio,
        outDir,
        label: caption.label,
        type: caption.type,
        neighborAboveYRatio,
        neighborBelowYRatio,
      });

      if (crop.success && crop.filepath && crop.width && crop.height) {
        const cropAcceptance = evaluatePdfCropAcceptance({
          type: caption.type,
          width: crop.width,
          height: crop.height,
          regionKind: crop.regionKind ?? "fallback",
        });

        if (!cropAcceptance.accepted) {
          results.push({
            figureLabel: caption.label,
            captionText: caption.captionText,
            captionSource: "pdf_ocr",
            sourceMethod: "pdf_structural",
            confidence: "low",
            imagePath: null,
            assetHash: null,
            pdfPage: caption.page,
            bbox: null,
            type: caption.type,
            width: null,
            height: null,
            cropOutcome: "rejected",
          });
        } else {
          results.push({
            figureLabel: caption.label,
            captionText: caption.captionText,
            captionSource: "pdf_ocr",
            sourceMethod: "pdf_render_crop",
            confidence: "low",
            imagePath: crop.filepath.startsWith(process.cwd())
              ? crop.filepath.slice(process.cwd().length + 1)
              : crop.filepath,
            assetHash: crop.assetHash || null,
            pdfPage: caption.page,
            bbox: null,
            type: caption.type,
            width: crop.width || null,
            height: crop.height || null,
            cropOutcome: "success",
          });
        }
      } else {
        // Gap placeholder — caption found but render+crop failed
        results.push({
          figureLabel: caption.label,
          captionText: caption.captionText,
          captionSource: "pdf_ocr",
          sourceMethod: "pdf_structural",
          confidence: "low",
          imagePath: null,
          assetHash: null,
          pdfPage: caption.page,
          bbox: null,
          type: caption.type,
          width: null,
          height: null,
          cropOutcome: "failed",
        });
      }
    }
  }

  // Add unmatched images (found in PDF but no caption detected)
  for (const img of embeddedImages) {
    if (!matchedImageHashes.has(img.assetHash)) {
      results.push({
        figureLabel: null,
        captionText: null,
        captionSource: "none",
        sourceMethod: "pdf_embedded",
        confidence: "low",
        imagePath: `uploads/figures/${paperId}/${img.filename}`,
        assetHash: img.assetHash,
        pdfPage: img.page,
        bbox: null,
        type: "figure",
        width: img.width,
        height: img.height,
        cropOutcome: null,
      });
    }
  }

  return results;
}

export const pdfFigurePipelineInternals = {
  evaluatePdfCropAcceptance,
};
