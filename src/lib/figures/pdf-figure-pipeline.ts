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
}

export async function extractFiguresFromPdf(
  pdfPath: string,
  paperId: string,
  opts?: { maxPages?: number },
): Promise<ExtractedFigure[]> {
  const maxPages = opts?.maxPages || 50;
  const outDir = path.join(process.cwd(), "uploads", "figures", paperId);
  await mkdir(outDir, { recursive: true });

  const absolutePdfPath = path.resolve(process.cwd(), pdfPath);

  // Part 1: Detect captions from PDF text
  const allCaptions: DetectedCaption[] = [];
  try {
    const { stdout } = await execFileAsync("python3", [
      "-c",
      `import fitz, json, sys
doc = fitz.open(sys.argv[1])
pages = []
for i in range(min(len(doc), int(sys.argv[2]))):
    pages.append({"page": i+1, "text": doc[i].get_text()})
doc.close()
json.dump(pages, sys.stdout)`,
      absolutePdfPath,
      String(maxPages),
    ], { timeout: 30000 });
    const pages = JSON.parse(stdout) as { page: number; text: string }[];
    for (const p of pages) {
      allCaptions.push(...detectCaptions(p.text, p.page));
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
      });
    } else {
      // No embedded image found — try render+crop for vector figures
      const crop = await renderAndCropFigure({
        pdfPath: absolutePdfPath,
        page: caption.page,
        captionYRatio: caption.lineIndex / 3000,
        outDir,
        label: caption.label,
      });

      if (crop.success && crop.filepath) {
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
        });
      } else {
        // Gap placeholder — caption found but no figure recovered
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
      });
    }
  }

  return results;
}
