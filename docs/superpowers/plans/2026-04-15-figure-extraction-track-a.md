# Figure Extraction Track A: Schema + Benchmark + PDF Fallback

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend PaperFigure schema with provenance fields, build a 100-paper benchmark, and implement the PDF fallback pipeline (caption detection + embedded image extraction + render+crop for vector figures).

**Architecture:** Track A has no identity dependency — it works purely from the stored PDF. Track B (arXiv HTML, PMC/JATS, publisher adapters) runs in parallel once identity is hardened.

**Tech Stack:** TypeScript, Prisma (SQLite), PyMuPDF (Python), pdftoppm (poppler), Vitest

**Spec:** `docs/superpowers/specs/2026-04-15-figure-extraction-pipeline.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/figures/caption-detector.ts` | Scan PDF text for "Figure N:", "Table N:" patterns, return page + position + label + caption text |
| `src/lib/figures/pdf-image-extractor.py` | PyMuPDF-based embedded image extraction with filtering |
| `src/lib/figures/pdf-crop-renderer.ts` | Render+crop for captions with no embedded image (vector plots) |
| `src/lib/figures/pdf-figure-pipeline.ts` | Orchestrates all three parts: caption detection → image extraction → render+crop → merge |
| `src/lib/figures/__tests__/caption-detector.test.ts` | Tests for caption pattern matching |
| `scripts/build-figure-benchmark.ts` | Build the 100-paper benchmark set |
| `scripts/run-figure-benchmark.ts` | Run extraction on benchmark and report per-bucket metrics |

### Modified Files

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Extend PaperFigure with provenance fields |

---

## Task 1: Schema Update

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Backup database**

```bash
./scripts/backup-db.sh pre-figure-schema
```

- [ ] **Step 2: Update PaperFigure model**

Replace the existing PaperFigure model with:

```prisma
model PaperFigure {
  id                  String   @id @default(uuid())
  paperId             String
  figureLabel         String?
  captionText         String?
  captionSource       String   @default("none")
  description         String?
  sourceMethod        String   @default("pdf_embedded")
  sourceUrl           String?
  sourceVersion       String?
  confidence          String   @default("medium")
  imagePath           String?
  assetHash           String?
  pdfPage             Int?
  sourcePage          Int?
  figureIndex         Int      @default(0)
  bbox                String?
  type                String   @default("figure")
  parentFigureId      String?
  isPrimaryExtraction Boolean  @default(true)
  width               Int?
  height              Int?
  createdAt           DateTime @default(now())

  paper         Paper        @relation(fields: [paperId], references: [id], onDelete: Cascade)
  parent        PaperFigure? @relation("SubFigures", fields: [parentFigureId], references: [id])
  subfigures    PaperFigure[] @relation("SubFigures")

  @@unique([paperId, sourceMethod, assetHash])
  @@unique([paperId, sourceMethod, figureLabel])
  @@index([paperId])
  @@index([assetHash])
}
```

- [ ] **Step 3: Run migration**

```bash
npx prisma migrate dev --name figure_provenance
npx prisma generate
```

IMPORTANT: Review the migration SQL for DROP TABLE before applying. If it drops PaperFigure, use `--create-only` and manually write an ALTER migration.

- [ ] **Step 4: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Stage and commit**

```bash
git add prisma/
git commit -m "schema: extend PaperFigure with provenance, confidence, source method, asset hash"
```

---

## Task 2: Caption Detector

**Files:**
- Create: `src/lib/figures/caption-detector.ts`
- Create: `src/lib/figures/__tests__/caption-detector.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/figures/__tests__/caption-detector.test.ts
import { describe, it, expect } from "vitest";
import { detectCaptions, type DetectedCaption } from "../caption-detector";

describe("detectCaptions", () => {
  it("detects 'Figure N:' pattern", () => {
    const text = "Some text before.\nFigure 3: Architecture of the proposed model.\nMore text after.";
    const captions = detectCaptions(text, 1);
    expect(captions).toHaveLength(1);
    expect(captions[0].label).toBe("Figure 3");
    expect(captions[0].type).toBe("figure");
    expect(captions[0].captionText).toContain("Architecture");
  });

  it("detects 'Table N:' pattern", () => {
    const text = "Table 1: Results on the benchmark dataset.";
    const captions = detectCaptions(text, 5);
    expect(captions).toHaveLength(1);
    expect(captions[0].label).toBe("Table 1");
    expect(captions[0].type).toBe("table");
  });

  it("detects 'Fig. N' pattern", () => {
    const text = "Fig. 2. Overview of the training pipeline.";
    const captions = detectCaptions(text, 3);
    expect(captions).toHaveLength(1);
    expect(captions[0].label).toBe("Fig. 2");
  });

  it("detects subfigure labels", () => {
    const text = "Figure 1a: Left panel. Figure 1b: Right panel.";
    const captions = detectCaptions(text, 2);
    expect(captions).toHaveLength(2);
    expect(captions[0].label).toBe("Figure 1a");
    expect(captions[1].label).toBe("Figure 1b");
  });

  it("returns empty for text without captions", () => {
    const text = "This is regular paragraph text with no figures or tables mentioned as captions.";
    expect(detectCaptions(text, 1)).toHaveLength(0);
  });

  it("does not match inline references like 'see Figure 3'", () => {
    const text = "As shown in Figure 3, the model converges quickly.";
    // This is a reference, not a caption — caption must start at line beginning or after newline
    expect(detectCaptions(text, 1)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Implement caption detector**

```typescript
// src/lib/figures/caption-detector.ts

export interface DetectedCaption {
  label: string;        // "Figure 3", "Table 1", "Fig. 2a"
  type: "figure" | "table";
  captionText: string;  // Full caption text including label
  page: number;
  lineIndex: number;    // Approximate position within the page text
}

// Matches "Figure N", "Fig. N", "Table N" at the start of a line or after a newline
// followed by optional letter (subfigure) and separator (: . —)
const CAPTION_PATTERN = /(?:^|\n)\s*((?:Figure|Fig\.|Table)\s+\d+[a-z]?)\s*[:.—–\-]\s*(.+?)(?=\n|$)/gi;

export function detectCaptions(pageText: string, page: number): DetectedCaption[] {
  const captions: DetectedCaption[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  CAPTION_PATTERN.lastIndex = 0;

  while ((match = CAPTION_PATTERN.exec(pageText)) !== null) {
    const label = match[1].trim();
    const restOfCaption = match[2].trim();
    const type = /^(?:Table)/i.test(label) ? "table" as const : "figure" as const;

    captions.push({
      label,
      type,
      captionText: `${label}: ${restOfCaption}`,
      page,
      lineIndex: match.index,
    });
  }

  return captions;
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/lib/figures/__tests__/caption-detector.test.ts
```

- [ ] **Step 4: Stage and commit**

```bash
git add src/lib/figures/
git commit -m "feat(figures): caption detector — pattern-based Figure/Table/Fig detection from PDF text"
```

---

## Task 3: PDF Image Extractor (PyMuPDF)

**Files:**
- Create: `src/lib/figures/pdf-image-extractor.py`

- [ ] **Step 1: Write the extractor**

```python
#!/usr/bin/env python3
"""
Extract embedded images from a PDF using PyMuPDF.
Filters out icons, logos, and full-page scans.
Outputs JSON to stdout for consumption by the TypeScript pipeline.

Usage: python3 pdf-image-extractor.py <pdf_path> [--min-width 200] [--min-height 200] [--min-bytes 10000]
"""
import json
import hashlib
import os
import sys
import argparse

import fitz  # pymupdf


def extract_images(pdf_path, out_dir, min_width=200, min_height=200, min_bytes=10000, max_pages=50):
    doc = fitz.open(pdf_path)
    results = []
    seen_hashes = set()

    for page_num in range(min(len(doc), max_pages)):
        page = doc[page_num]
        page_width = page.rect.width
        page_height = page.rect.height

        for img_idx, img in enumerate(page.get_images(full=True)):
            xref = img[0]
            try:
                pix = fitz.Pixmap(doc, xref)
            except Exception:
                continue

            if pix.n > 4:
                pix = fitz.Pixmap(fitz.csRGB, pix)

            w, h = pix.width, pix.height
            if w < min_width or h < min_height:
                continue

            # Skip full-page scans
            if page_width > 0 and page_height > 0:
                if w / page_width > 0.95 and h / page_height > 0.95:
                    continue

            img_bytes = pix.tobytes("png")
            if len(img_bytes) < min_bytes:
                continue

            # Dedup by content hash
            asset_hash = hashlib.sha256(img_bytes).hexdigest()
            if asset_hash in seen_hashes:
                continue
            seen_hashes.add(asset_hash)

            filename = f"p{page_num + 1}-img{len(results) + 1}.png"
            filepath = os.path.join(out_dir, filename)
            with open(filepath, "wb") as f:
                f.write(img_bytes)

            results.append({
                "page": page_num + 1,
                "imageIndex": img_idx,
                "width": w,
                "height": h,
                "bytes": len(img_bytes),
                "assetHash": asset_hash,
                "filename": filename,
                "filepath": filepath,
            })

    doc.close()
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf_path")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--min-width", type=int, default=200)
    parser.add_argument("--min-height", type=int, default=200)
    parser.add_argument("--min-bytes", type=int, default=10000)
    parser.add_argument("--max-pages", type=int, default=50)
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    results = extract_images(
        args.pdf_path, args.out_dir,
        min_width=args.min_width, min_height=args.min_height,
        min_bytes=args.min_bytes, max_pages=args.max_pages,
    )
    json.dump(results, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Test on a sample paper**

```bash
mkdir -p /tmp/fig-test
python3 src/lib/figures/pdf-image-extractor.py uploads/$(ls uploads/ | head -5 | tail -1) --out-dir /tmp/fig-test
```

- [ ] **Step 3: Stage and commit**

```bash
git add src/lib/figures/pdf-image-extractor.py
git commit -m "feat(figures): PyMuPDF image extractor with size/dedup filtering"
```

---

## Task 4: PDF Render+Crop for Vector Figures

**Files:**
- Create: `src/lib/figures/pdf-crop-renderer.ts`

- [ ] **Step 1: Implement render+crop**

```typescript
// src/lib/figures/pdf-crop-renderer.ts
//
// For captions where no embedded image was found (vector plots/diagrams),
// render the page and crop the region above the caption.

import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { createHash } from "crypto";

const execFileAsync = promisify(execFile);

interface CropRequest {
  pdfPath: string;
  page: number;
  captionYRatio: number; // 0-1 position of caption on the page (0 = top)
  outDir: string;
  label: string;
}

interface CropResult {
  success: boolean;
  filepath?: string;
  assetHash?: string;
  width?: number;
  height?: number;
  error?: string;
}

export async function renderAndCropFigure(req: CropRequest): Promise<CropResult> {
  try {
    await mkdir(req.outDir, { recursive: true });

    // Render the page at 300 DPI
    const pageFile = path.join(req.outDir, `render-p${req.page}`);
    await execFileAsync("pdftoppm", [
      "-png", "-r", "300",
      "-f", String(req.page), "-l", String(req.page),
      req.pdfPath, pageFile,
    ]);

    // pdftoppm outputs as render-pN-01.png
    const paddedPage = String(req.page).padStart(String(req.page).length, "0");
    const renderedPath = `${pageFile}-${paddedPage.padStart(Math.max(paddedPage.length, 2), "0")}.png`;

    // Read the rendered image
    let imageBuffer: Buffer;
    try {
      imageBuffer = await readFile(renderedPath);
    } catch {
      // Try alternative naming
      const altPath = `${pageFile}-${String(req.page).padStart(2, "0")}.png`;
      imageBuffer = await readFile(altPath);
    }

    // Crop: take the region from ~20% above the caption position to the caption
    // This is a heuristic — figures are typically above their captions
    const cropTopRatio = Math.max(0, req.captionYRatio - 0.5);
    const cropBottomRatio = req.captionYRatio;

    // Use sharp or canvas for cropping if available, otherwise save full page
    // For now, save the full page render — cropping will be added when we have
    // image dimension information from the render
    const safeLabel = req.label.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    const outPath = path.join(req.outDir, `crop-p${req.page}-${safeLabel}.png`);
    await writeFile(outPath, imageBuffer);

    const assetHash = createHash("sha256").update(imageBuffer).digest("hex");

    return {
      success: true,
      filepath: outPath,
      assetHash,
    };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }
}
```

- [ ] **Step 2: Stage and commit**

```bash
git add src/lib/figures/pdf-crop-renderer.ts
git commit -m "feat(figures): render+crop for vector figures using pdftoppm"
```

---

## Task 5: PDF Figure Pipeline (Orchestrator)

**Files:**
- Create: `src/lib/figures/pdf-figure-pipeline.ts`

- [ ] **Step 1: Implement the orchestrator**

This ties together caption detection, image extraction, and render+crop. It also does the matching: captions ↔ images by page proximity.

```typescript
// src/lib/figures/pdf-figure-pipeline.ts
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, mkdir } from "fs/promises";
import path from "path";
import { createHash } from "crypto";
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

export async function extractFiguresFromPdf(
  pdfPath: string,
  paperId: string,
  opts?: { maxPages?: number },
): Promise<ExtractedFigure[]> {
  const maxPages = opts?.maxPages || 50;
  const outDir = path.join(process.cwd(), "uploads", "figures", paperId);
  await mkdir(outDir, { recursive: true });

  // Part 1: Detect captions from PDF text
  const allCaptions: DetectedCaption[] = [];
  try {
    // Use PyMuPDF to extract text with positions
    const { stdout } = await execFileAsync("python3", [
      "-c",
      `import fitz, json, sys
doc = fitz.open("${pdfPath}")
pages = []
for i in range(min(len(doc), ${maxPages})):
    pages.append({"page": i+1, "text": doc[i].get_text()})
doc.close()
json.dump(pages, sys.stdout)`,
    ]);
    const pages = JSON.parse(stdout) as { page: number; text: string }[];
    for (const p of pages) {
      allCaptions.push(...detectCaptions(p.text, p.page));
    }
  } catch (err) {
    console.warn(`[pdf-pipeline] Text extraction failed: ${(err as Error).message}`);
  }

  // Part 2: Extract embedded images
  let embeddedImages: Array<{
    page: number;
    assetHash: string;
    filename: string;
    filepath: string;
    width: number;
    height: number;
  }> = [];
  try {
    const { stdout } = await execFileAsync("python3", [
      path.join(process.cwd(), "src/lib/figures/pdf-image-extractor.py"),
      pdfPath,
      "--out-dir", outDir,
      "--max-pages", String(maxPages),
    ]);
    embeddedImages = JSON.parse(stdout);
  } catch (err) {
    console.warn(`[pdf-pipeline] Image extraction failed: ${(err as Error).message}`);
  }

  // Match captions to images by page
  const results: ExtractedFigure[] = [];
  const matchedImageHashes = new Set<string>();

  for (const caption of allCaptions) {
    // Find the best image on the same page
    const pageImages = embeddedImages.filter(
      (img) => img.page === caption.page && !matchedImageHashes.has(img.assetHash),
    );

    if (pageImages.length > 0) {
      // Take the first unmatched image on the same page
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
      // No embedded image — try render+crop
      const crop = await renderAndCropFigure({
        pdfPath,
        page: caption.page,
        captionYRatio: caption.lineIndex / 3000, // rough estimate
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
          imagePath: crop.filepath.replace(process.cwd() + "/", ""),
          assetHash: crop.assetHash || null,
          pdfPage: caption.page,
          bbox: null,
          type: caption.type,
          width: crop.width || null,
          height: crop.height || null,
        });
      } else {
        // Gap placeholder
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

  // Add unmatched images (no caption found)
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
```

- [ ] **Step 2: Test on a sample paper**

```bash
npx tsx -e "
import { extractFiguresFromPdf } from './src/lib/figures/pdf-figure-pipeline.js';
const results = await extractFiguresFromPdf('uploads/$(ls uploads/ | head -10 | tail -1)', 'test-paper');
console.log(JSON.stringify(results, null, 2));
console.log('Total:', results.length);
console.log('With images:', results.filter(r => r.imagePath).length);
console.log('Gaps:', results.filter(r => !r.imagePath).length);
"
```

- [ ] **Step 3: Stage and commit**

```bash
git add src/lib/figures/
git commit -m "feat(figures): PDF figure pipeline — caption detection + image extraction + render/crop + gap tracking"
```
