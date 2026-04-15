// src/lib/figures/pdf-crop-renderer.ts
//
// Renders a PDF page and crops the region around a figure/table.
// Uses PyMuPDF text-block layout analysis to find actual content regions
// rather than guessing from caption Y position.

import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, mkdir, readdir, unlink } from "fs/promises";
import path from "path";
import { createHash } from "crypto";

const execFileAsync = promisify(execFile);

interface CropRequest {
  pdfPath: string;
  page: number;
  captionYRatio: number;
  outDir: string;
  label: string;
  type: "figure" | "table";
  neighborAboveYRatio?: number;
  neighborBelowYRatio?: number;
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

    // Step 1: Use PyMuPDF to find the actual content region for this caption
    const cropRegion = await findContentRegion(req);

    // Step 2: Render the page at 300 DPI
    const pageFile = path.join(req.outDir, `render-p${req.page}`);
    await execFileAsync("pdftoppm", [
      "-png", "-r", "300",
      "-f", String(req.page), "-l", String(req.page),
      req.pdfPath, pageFile,
    ]);

    const files = await readdir(req.outDir);
    const rendered = files.find(f => f.startsWith(`render-p${req.page}-`) && f.endsWith(".png"));
    if (!rendered) {
      return { success: false, error: "pdftoppm did not produce output" };
    }

    const renderedPath = path.join(req.outDir, rendered);

    // Step 3: Crop using the detected region
    const safeLabel = req.label.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    const outPath = path.join(req.outDir, `crop-p${req.page}-${safeLabel}.png`);

    const { stdout } = await execFileAsync("python3", [
      "-c",
      `import sys, json
from PIL import Image

img = Image.open(sys.argv[1])
w, h = img.size
region = json.loads(sys.argv[2])
out_path = sys.argv[3]

# Convert PDF-point ratios to pixel coords
top = max(0, int(region["top"] * h))
bottom = min(h, int(region["bottom"] * h))
left = max(0, int(region["left"] * w))
right = min(w, int(region["right"] * w))

# Ensure minimum size
if (bottom - top) < 50 or (right - left) < 100:
    json.dump({"ok": False, "error": f"region too small: {right-left}x{bottom-top}"}, sys.stdout)
else:
    cropped = img.crop((left, top, right, bottom))
    cropped.save(out_path, "PNG")
    cw, ch = cropped.size
    json.dump({"ok": True, "width": cw, "height": ch}, sys.stdout)
`,
      renderedPath,
      JSON.stringify(cropRegion),
      outPath,
    ], { timeout: 15000 });

    // Clean up full-page render
    try { await unlink(renderedPath); } catch { /* ignore */ }

    const result = JSON.parse(stdout) as { ok: boolean; width?: number; height?: number; error?: string };
    if (!result.ok) {
      return { success: false, error: result.error };
    }

    const croppedBuffer = await readFile(outPath);
    const assetHash = createHash("sha256").update(croppedBuffer).digest("hex");

    return {
      success: true,
      filepath: outPath,
      assetHash,
      width: result.width,
      height: result.height,
    };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }
}

/**
 * Use PyMuPDF to find the actual content region associated with a caption.
 *
 * Strategy:
 * - Find the caption's text block bbox
 * - For tables (caption above): scan text blocks below until hitting a
 *   paragraph, section heading, or another caption
 * - For figures (caption below): scan text blocks above until hitting a
 *   paragraph, section heading, or another caption
 * - Include a small margin around the detected region
 *
 * Returns normalized coordinates (0-1) for { top, bottom, left, right }.
 */
async function findContentRegion(req: CropRequest): Promise<{
  top: number; bottom: number; left: number; right: number;
}> {
  try {
    const { stdout } = await execFileAsync("python3", [
      "-c",
      `import fitz, json, sys, re

pdf_path = sys.argv[1]
page_num = int(sys.argv[2]) - 1  # 0-indexed
caption_y_ratio = float(sys.argv[3])
fig_type = sys.argv[4]
label = sys.argv[5]

doc = fitz.open(pdf_path)
page = doc[page_num]
pw, ph = page.rect.width, page.rect.height

blocks = page.get_text("blocks")
# blocks: (x0, y0, x1, y1, text, block_no, type)

caption_pat = re.compile(r"^(?:Figure|Fig\\.?|Table)\\s+\\d+[a-z]?\\s*[:.—–-]", re.IGNORECASE)

# Find our caption block by matching label text
caption_block = None
for b in blocks:
    if b[6] != 0: continue
    text = b[4].strip()
    if label.lower().replace(".", "") in text.lower().replace(".", "")[:30]:
        caption_block = b
        break

# Fallback: find by Y position
if not caption_block:
    target_y = caption_y_ratio * ph
    best = None
    best_dist = 999
    for b in blocks:
        if b[6] != 0: continue
        if caption_pat.match(b[4].strip()):
            dist = abs(b[1] - target_y)
            if dist < best_dist:
                best_dist = dist
                best = b
    caption_block = best

if not caption_block:
    # Absolute fallback: use caption Y ratio with generous margin
    margin = 0.04
    if fig_type == "table":
        json.dump({"top": max(0, caption_y_ratio - margin), "bottom": min(1, caption_y_ratio + 0.40), "left": 0.03, "right": 0.97}, sys.stdout)
    else:
        json.dump({"top": max(0, caption_y_ratio - 0.40), "bottom": min(1, caption_y_ratio + margin), "left": 0.03, "right": 0.97}, sys.stdout)
    doc.close()
    sys.exit(0)

cap_y0, cap_y1 = caption_block[1], caption_block[3]
cap_x0, cap_x1 = caption_block[0], caption_block[2]

# Column detection: determine if caption is in left col, right col, or full-width
# Heuristic: if caption right edge < 55% of page width → left column
#            if caption left edge > 45% of page width → right column
#            otherwise → full-width (spans both columns)
mid_x = pw * 0.5
cap_center_x = (cap_x0 + cap_x1) / 2
if cap_x1 < pw * 0.55 and cap_center_x < mid_x:
    col_left = 0.0
    col_right = 0.52  # left column with small margin
elif cap_x0 > pw * 0.45 and cap_center_x > mid_x:
    col_left = 0.48  # right column with small margin
    col_right = 1.0
else:
    col_left = 0.0
    col_right = 1.0  # full-width

# Sort blocks by vertical position
sorted_blocks = sorted([b for b in blocks if b[6] == 0], key=lambda b: b[1])

if fig_type == "table":
    # Table caption is above: scan downward to find table extent
    region_top = cap_y0 / ph
    region_bottom = cap_y1 / ph
    region_left = cap_x0
    region_right = cap_x1

    for b in sorted_blocks:
        if b[1] < cap_y1 + 2: continue  # skip blocks at/above caption
        text = b[4].strip()
        # Stop at: another caption, section heading, or clear paragraph break
        is_caption = caption_pat.match(text)
        is_section = re.match(r"^\\d+\\.?\\s+[A-Z]", text) and len(text) < 100
        # Check for significant vertical gap (> 20pt gap = end of table)
        gap_to_prev = b[1] - region_bottom * ph
        is_big_gap = gap_to_prev > 25 and region_bottom > cap_y1 / ph + 0.05

        if is_caption or is_section or is_big_gap:
            break
        region_bottom = b[3] / ph
        region_left = min(region_left, b[0])
        region_right = max(region_right, b[2])

    # Add margin, constrain to detected column
    margin = 8 / ph
    content_left = max(col_left, (region_left - 5) / pw)
    content_right = min(col_right, (region_right + 5) / pw)
    result = {
        "top": max(0, region_top - margin),
        "bottom": min(1, region_bottom + margin),
        "left": max(0, content_left),
        "right": min(1, content_right),
    }
else:
    # Figure caption is below: scan upward to find figure extent
    region_top = cap_y0 / ph
    region_bottom = cap_y1 / ph
    region_left = col_left
    region_right = col_right

    for b in reversed(sorted_blocks):
        if b[3] > cap_y0 - 2: continue  # skip blocks at/below caption
        text = b[4].strip()
        is_caption = caption_pat.match(text)
        is_section = re.match(r"^\\d+\\.?\\s+[A-Z]", text) and len(text) < 100
        # Check gap
        gap = region_top * ph - b[3]
        is_big_gap = gap > 25 and region_top < cap_y0 / ph - 0.05

        if is_caption or is_section or is_big_gap:
            break
        region_top = b[1] / ph

    # Also check for images/drawings above the caption
    for img in page.get_images(full=True):
        try:
            rects = page.get_image_rects(img[0])
            if rects:
                r = rects[0]
                if r.y1 < cap_y0 and r.y0 / ph >= region_top - 0.02:
                    region_top = min(region_top, r.y0 / ph)
        except: pass

    margin = 8 / ph
    result = {
        "top": max(0, region_top - margin),
        "bottom": min(1, region_bottom + margin),
        "left": max(0, region_left),
        "right": min(1, region_right),
    }

json.dump(result, sys.stdout)
doc.close()
`,
      req.pdfPath,
      String(req.page),
      String(req.captionYRatio),
      req.type,
      req.label,
    ], { timeout: 15000 });

    return JSON.parse(stdout);
  } catch {
    // Fallback to simple ratio-based crop
    const margin = 0.04;
    if (req.type === "table") {
      return {
        top: Math.max(0, req.captionYRatio - margin),
        bottom: Math.min(1, req.captionYRatio + 0.40),
        left: 0.03,
        right: 0.97,
      };
    }
    return {
      top: Math.max(0, req.captionYRatio - 0.40),
      bottom: Math.min(1, req.captionYRatio + margin),
      left: 0.03,
      right: 0.97,
    };
  }
}
