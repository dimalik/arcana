// src/lib/figures/pdf-crop-renderer.ts
//
// Renders a PDF page and crops the region around a figure/table.
// Uses PyMuPDF layout analysis to find actual content regions around a
// detected caption, without assuming a fixed caption-above/caption-below
// orientation for tables.

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
  regionKind?: "graphics" | "text" | "fallback";
  error?: string;
}

interface LayoutTextBlock {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
}

interface LayoutRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface PageLayout {
  width: number;
  height: number;
  textBlocks: LayoutTextBlock[];
  imageRects: LayoutRect[];
  drawingRects: LayoutRect[];
}

interface ColumnBounds {
  leftRatio: number;
  rightRatio: number;
}

interface CropRegion {
  top: number;
  bottom: number;
  left: number;
  right: number;
  kind: "graphics" | "text" | "fallback";
}

interface ContentCandidate extends LayoutRect {
  kind: "text" | "graphics";
  text?: string;
}

interface TableRegionCandidate extends LayoutRect {
  kind: "graphics" | "text";
  score: number;
}

interface GraphicCluster extends LayoutRect {
  members: LayoutRect[];
}

const CAPTION_BLOCK_RE = /^(?:Figure|Fig\.?|Table)\s+\d+[a-z]?\s*[:.—–-]/i;
const SECTION_HEADING_RE = /^\d+\.?\s+[A-Z]/;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeLooseText(text: string): string {
  return text.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

function centerX(rect: LayoutRect): number {
  return (rect.x0 + rect.x1) / 2;
}

function isCaptionBlock(text: string): boolean {
  return CAPTION_BLOCK_RE.test(text.trim());
}

function isSectionHeading(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 100 && SECTION_HEADING_RE.test(trimmed);
}

function isWithinColumn(rect: LayoutRect, column: ColumnBounds, pageWidth: number): boolean {
  const leftPx = column.leftRatio * pageWidth;
  const rightPx = column.rightRatio * pageWidth;
  const cx = centerX(rect);
  if (cx < leftPx || cx > rightPx) {
    return false;
  }

  const isSingleColumn = (column.rightRatio - column.leftRatio) < 0.8;
  if (!isSingleColumn) {
    return true;
  }

  const rectWidth = rect.x1 - rect.x0;
  const overlapWidth = Math.max(0, Math.min(rect.x1, rightPx) - Math.max(rect.x0, leftPx));
  return overlapWidth >= rectWidth * 0.65;
}

function getColumnBounds(captionBlock: LayoutTextBlock, pageWidth: number): ColumnBounds {
  const midX = pageWidth * 0.5;
  const captionCenterX = (captionBlock.x0 + captionBlock.x1) / 2;
  if (captionBlock.x1 < pageWidth * 0.55 && captionCenterX < midX) {
    return { leftRatio: 0.0, rightRatio: 0.52 };
  }
  if (captionBlock.x0 > pageWidth * 0.45 && captionCenterX > midX) {
    return { leftRatio: 0.48, rightRatio: 1.0 };
  }
  return { leftRatio: 0.0, rightRatio: 1.0 };
}

function matchCaptionBlock(
  layout: PageLayout,
  label: string,
  captionYRatio: number,
): LayoutTextBlock | null {
  const normalizedLabel = normalizeLooseText(label);
  const labelMatches = layout.textBlocks.filter((block) => {
    const normalizedText = normalizeLooseText(block.text);
    return normalizedText.includes(normalizedLabel);
  });

  const captionMatches = labelMatches.filter((block) => isCaptionBlock(block.text));
  if (captionMatches.length > 0) {
    return captionMatches.sort((a, b) => a.y0 - b.y0)[0];
  }

  if (labelMatches.length > 0) {
    return labelMatches.sort((a, b) => {
      const aDistance = Math.abs(a.y0 - (captionYRatio * layout.height));
      const bDistance = Math.abs(b.y0 - (captionYRatio * layout.height));
      return aDistance - bDistance;
    })[0];
  }

  const targetY = captionYRatio * layout.height;
  let best: LayoutTextBlock | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const block of layout.textBlocks) {
    if (!isCaptionBlock(block.text)) {
      continue;
    }
    const distance = Math.abs(block.y0 - targetY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = block;
    }
  }
  return best;
}

function buildFallbackRegion(req: CropRequest): CropRegion {
  const margin = 0.04;
  if (req.type === "table") {
    const upRoom = req.captionYRatio - (req.neighborAboveYRatio ?? 0);
    const downRoom = (req.neighborBelowYRatio ?? 1) - req.captionYRatio;
    const preferAbove = upRoom > downRoom * 1.15;
    if (preferAbove) {
      return {
        top: clamp(req.captionYRatio - 0.40, 0, 1),
        bottom: clamp(req.captionYRatio - margin, 0, 1),
        left: 0.03,
        right: 0.97,
        kind: "fallback",
      };
    }
    return {
      top: clamp(req.captionYRatio + margin, 0, 1),
      bottom: clamp(req.captionYRatio + 0.40, 0, 1),
      left: 0.03,
      right: 0.97,
      kind: "fallback",
    };
  }

  return {
    top: clamp(req.captionYRatio - 0.40, 0, 1),
    bottom: clamp(req.captionYRatio - margin, 0, 1),
    left: 0.03,
    right: 0.97,
    kind: "fallback",
  };
}

function buildTableSideRegionCandidate(
  layout: PageLayout,
  captionBlock: LayoutTextBlock,
  column: ColumnBounds,
  direction: "up" | "down",
  neighborAboveYRatio?: number,
  neighborBelowYRatio?: number,
): TableRegionCandidate | null {
  const minY = (neighborAboveYRatio ?? 0) * layout.height;
  const maxY = (neighborBelowYRatio ?? 1) * layout.height;

  const textItems: ContentCandidate[] = layout.textBlocks
    .filter((block) => isWithinColumn(block, column, layout.width))
    .filter((block) => {
      if (direction === "up") {
        return block.y1 <= captionBlock.y0 - 2 && block.y1 >= minY;
      }
      return block.y0 >= captionBlock.y1 + 2 && block.y0 <= maxY;
    })
    .map((block) => ({
      ...block,
      kind: "text" as const,
      text: block.text,
    }));

  const graphicItems: ContentCandidate[] = [...layout.imageRects, ...layout.drawingRects]
    .filter((rect) => isWithinColumn(rect, column, layout.width))
    .filter((rect) => (rect.x1 - rect.x0) >= 20 && (rect.y1 - rect.y0) >= 20)
    .filter((rect) => {
      if (direction === "up") {
        return rect.y1 <= captionBlock.y0 - 2 && rect.y1 >= minY;
      }
      return rect.y0 >= captionBlock.y1 + 2 && rect.y0 <= maxY;
    })
    .map((rect) => ({
      ...rect,
      kind: "graphics" as const,
    }));

  const items = [...textItems, ...graphicItems].sort((a, b) => (
    direction === "up" ? b.y1 - a.y1 : a.y0 - b.y0
  ));

  let region: LayoutRect | null = null;
  let lastEdge = direction === "up" ? captionBlock.y0 : captionBlock.y1;
  let itemCount = 0;
  let graphicCount = 0;
  const maxInitialGap = 140;
  const maxContiguousGap = 28;

  for (const item of items) {
    if (item.kind === "text") {
      const text = item.text?.trim() ?? "";
      if (isCaptionBlock(text) || isSectionHeading(text)) {
        if (region) {
          break;
        }
        continue;
      }
    }

    const gap = direction === "up" ? lastEdge - item.y1 : item.y0 - lastEdge;
    if (!region && gap > maxInitialGap) {
      break;
    }
    if (region && gap > maxContiguousGap) {
      break;
    }

    region = region
      ? {
          x0: Math.min(region.x0, item.x0),
          y0: Math.min(region.y0, item.y0),
          x1: Math.max(region.x1, item.x1),
          y1: Math.max(region.y1, item.y1),
        }
      : {
          x0: item.x0,
          y0: item.y0,
          x1: item.x1,
          y1: item.y1,
        };

    itemCount += 1;
    if (item.kind === "graphics") {
      graphicCount += 1;
    }
    lastEdge = direction === "up" ? item.y0 : item.y1;
  }

  if (!region) {
    return null;
  }

  const gapToCaption = direction === "up"
    ? captionBlock.y0 - region.y1
    : region.y0 - captionBlock.y1;
  const height = region.y1 - region.y0;
  const width = region.x1 - region.x0;
  const score = height + (width * 0.2) + (itemCount * 14) + (graphicCount * 60) - (gapToCaption * 0.8);

  return {
    ...region,
    kind: graphicCount > 0 ? "graphics" : "text",
    score,
  };
}

function computeTableRegion(
  layout: PageLayout,
  captionBlock: LayoutTextBlock,
  column: ColumnBounds,
  neighborAboveYRatio?: number,
  neighborBelowYRatio?: number,
): CropRegion | null {
  const up = buildTableSideRegionCandidate(
    layout,
    captionBlock,
    column,
    "up",
    neighborAboveYRatio,
    neighborBelowYRatio,
  );
  const down = buildTableSideRegionCandidate(
    layout,
    captionBlock,
    column,
    "down",
    neighborAboveYRatio,
    neighborBelowYRatio,
  );

  const chosen = !up ? down : !down ? up : up.score >= down.score ? up : down;
  if (!chosen) {
    return null;
  }

  const verticalMargin = 8 / layout.height;
  const horizontalMargin = 8 / layout.width;

  return {
    top: clamp((chosen.y0 / layout.height) - verticalMargin, 0, 1),
    bottom: clamp((chosen.y1 / layout.height) + verticalMargin, 0, 1),
    left: clamp(Math.max(column.leftRatio, (chosen.x0 / layout.width) - horizontalMargin), 0, 1),
    right: clamp(Math.min(column.rightRatio, (chosen.x1 / layout.width) + horizontalMargin), 0, 1),
    kind: chosen.kind,
  };
}

function computeFigureRegion(
  layout: PageLayout,
  captionBlock: LayoutTextBlock,
  column: ColumnBounds,
  neighborAboveYRatio?: number,
): CropRegion {
  const minY = (neighborAboveYRatio ?? 0) * layout.height;
  const sortedBlocks = [...layout.textBlocks]
    .filter((block) => isWithinColumn(block, column, layout.width))
    .sort((a, b) => a.y0 - b.y0);

  let regionTop = captionBlock.y0 / layout.height;
  const regionBottom = captionBlock.y1 / layout.height;
  const regionLeft = column.leftRatio;
  const regionRight = column.rightRatio;

  for (const block of [...sortedBlocks].reverse()) {
    if (block.y1 > captionBlock.y0 - 2 || block.y1 < minY) {
      continue;
    }
    const text = block.text.trim();
    const gap = (regionTop * layout.height) - block.y1;
    const isBigGap = gap > 25 && regionTop < (captionBlock.y0 / layout.height) - 0.05;
    if (isCaptionBlock(text) || isSectionHeading(text) || isBigGap) {
      break;
    }
    regionTop = block.y0 / layout.height;
  }

  const rawGraphicRects = [...layout.imageRects, ...layout.drawingRects]
    .filter((rect) => isWithinColumn(rect, column, layout.width))
    .filter((rect) => rect.y1 <= captionBlock.y0 + 2 && rect.y1 >= minY)
    .filter((rect) => (rect.x1 - rect.x0) >= 20 && (rect.y1 - rect.y0) >= 20);

  const margin = 8 / layout.height;
  if (rawGraphicRects.length === 0) {
    return {
      top: clamp(regionTop - margin, 0, 1),
      bottom: clamp(regionBottom + margin, 0, 1),
      left: clamp(regionLeft, 0, 1),
      right: clamp(regionRight, 0, 1),
      kind: "text",
    };
  }

  const selectNearestGraphicCluster = (rects: LayoutRect[]): GraphicCluster => {
    const sorted = [...rects].sort((a, b) => a.y0 - b.y0);
    const clusters: GraphicCluster[] = [];

    for (const rect of sorted) {
      const last = clusters[clusters.length - 1];
      if (!last) {
        clusters.push({ ...rect, members: [rect] });
        continue;
      }

      const verticalGap = rect.y0 - last.y1;
      const nearby = verticalGap <= 28;

      if (nearby) {
        last.x0 = Math.min(last.x0, rect.x0);
        last.y0 = Math.min(last.y0, rect.y0);
        last.x1 = Math.max(last.x1, rect.x1);
        last.y1 = Math.max(last.y1, rect.y1);
        last.members.push(rect);
      } else {
        clusters.push({ ...rect, members: [rect] });
      }
    }

    return clusters.sort((a, b) => {
      const aGap = captionBlock.y0 - a.y1;
      const bGap = captionBlock.y0 - b.y1;
      if (aGap !== bGap) return aGap - bGap;
      return b.members.length - a.members.length;
    })[0];
  };

  const selectedCluster = selectNearestGraphicCluster(rawGraphicRects);
  let gx0 = selectedCluster.x0;
  let gy0 = selectedCluster.y0;
  let gx1 = selectedCluster.x1;
  let gy1 = selectedCluster.y1;

  const supportTextRects = sortedBlocks
    .filter((block) => block.y1 < captionBlock.y0 - 1)
    .filter((block) => block.y1 >= gy0 - 18 && block.y0 <= gy1 + 40)
    .filter((block) => block.x1 >= gx0 - 40 && block.x0 <= gx1 + 40)
    .filter((block) => {
      const text = block.text.trim();
      const blockWidth = block.x1 - block.x0;
      const blockHeight = block.y1 - block.y0;
      const clusterWidth = gx1 - gx0;
      return text.length <= 80
        && blockHeight <= 40
        && blockWidth <= Math.max(140, clusterWidth * 0.85);
    })
    .map((block) => ({ x0: block.x0, y0: block.y0, x1: block.x1, y1: block.y1 }));

  if (supportTextRects.length > 0) {
    gx0 = Math.min(gx0, ...supportTextRects.map((rect) => rect.x0));
    gy0 = Math.min(gy0, ...supportTextRects.map((rect) => rect.y0));
    gx1 = Math.max(gx1, ...supportTextRects.map((rect) => rect.x1));
    gy1 = Math.max(gy1, ...supportTextRects.map((rect) => rect.y1));
  }

  return {
    top: clamp((gy0 / layout.height) - margin, 0, 1),
    bottom: clamp(Math.min(captionBlock.y0 / layout.height, (gy1 / layout.height) + margin), 0, 1),
    left: clamp(Math.max(column.leftRatio, (gx0 / layout.width) - (10 / layout.width)), 0, 1),
    right: clamp(Math.min(column.rightRatio, (gx1 / layout.width) + (10 / layout.width)), 0, 1),
    kind: "graphics",
  };
}

function computeCropRegionFromLayout(req: CropRequest, layout: PageLayout): CropRegion {
  const captionBlock = matchCaptionBlock(layout, req.label, req.captionYRatio);
  if (!captionBlock) {
    return buildFallbackRegion(req);
  }

  const column = getColumnBounds(captionBlock, layout.width);
  if (req.type === "table") {
    const tableRegion = computeTableRegion(
      layout,
      captionBlock,
      column,
      req.neighborAboveYRatio,
      req.neighborBelowYRatio,
    );
    return tableRegion ?? buildFallbackRegion(req);
  }

  return computeFigureRegion(
    layout,
    captionBlock,
    column,
    req.neighborAboveYRatio,
  );
}

async function loadPageLayout(req: CropRequest): Promise<PageLayout> {
  const { stdout } = await execFileAsync("python3", [
    "-c",
    `import fitz, json, sys

pdf_path = sys.argv[1]
page_num = int(sys.argv[2]) - 1

doc = fitz.open(pdf_path)
page = doc[page_num]
pw, ph = page.rect.width, page.rect.height

blocks = []
for block in page.get_text("blocks"):
    if len(block) < 7 or block[6] != 0:
        continue
    blocks.append({
        "x0": block[0],
        "y0": block[1],
        "x1": block[2],
        "y1": block[3],
        "text": (block[4] or "").strip(),
    })

image_rects = []
text_dict = page.get_text("dict")
for block in text_dict.get("blocks", []):
    if block.get("type") != 1:
        continue
    bbox = block.get("bbox")
    if not bbox:
        continue
    image_rects.append({
        "x0": bbox[0],
        "y0": bbox[1],
        "x1": bbox[2],
        "y1": bbox[3],
    })

for info in page.get_image_info():
    try:
        bbox = info["bbox"]
        image_rects.append({
            "x0": bbox[0],
            "y0": bbox[1],
            "x1": bbox[2],
            "y1": bbox[3],
        })
    except Exception:
        pass

drawing_rects = []
for drawing in page.get_drawings():
    try:
        rect = drawing.get("rect")
        if rect is None:
            continue
        drawing_rects.append({
            "x0": rect[0],
            "y0": rect[1],
            "x1": rect[2],
            "y1": rect[3],
        })
    except Exception:
        pass

json.dump({
    "width": pw,
    "height": ph,
    "textBlocks": blocks,
    "imageRects": image_rects,
    "drawingRects": drawing_rects,
}, sys.stdout)
doc.close()
`,
    req.pdfPath,
    String(req.page),
  ], { timeout: 15000 });

  return JSON.parse(stdout) as PageLayout;
}

export async function renderAndCropFigure(req: CropRequest): Promise<CropResult> {
  try {
    await mkdir(req.outDir, { recursive: true });

    const cropRegion = await findContentRegion(req);

    const pageFile = path.join(req.outDir, `render-p${req.page}`);
    await execFileAsync("pdftoppm", [
      "-png", "-r", "300",
      "-f", String(req.page), "-l", String(req.page),
      req.pdfPath, pageFile,
    ]);

    const files = await readdir(req.outDir);
    const rendered = files.find((file) => file.startsWith(`render-p${req.page}-`) && file.endsWith(".png"));
    if (!rendered) {
      return { success: false, error: "pdftoppm did not produce output" };
    }

    const renderedPath = path.join(req.outDir, rendered);
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

top = max(0, int(region["top"] * h))
bottom = min(h, int(region["bottom"] * h))
left = max(0, int(region["left"] * w))
right = min(w, int(region["right"] * w))

if (bottom - top) < 50 or (right - left) < 100:
    json.dump({"ok": False, "error": f"region too small: {right-left}x{bottom-top}"}, sys.stdout)
else:
    cropped = img.crop((left, top, right, bottom))
    cropped.save(out_path, "PNG")
    cw, ch = cropped.size
    json.dump({"ok": True, "width": cw, "height": ch, "regionKind": region.get("kind", "fallback")}, sys.stdout)
`,
      renderedPath,
      JSON.stringify(cropRegion),
      outPath,
    ], { timeout: 15000 });

    try {
      await unlink(renderedPath);
    } catch {
      // ignore cleanup failure
    }

    const result = JSON.parse(stdout) as {
      ok: boolean;
      width?: number;
      height?: number;
      regionKind?: "graphics" | "text" | "fallback";
      error?: string;
    };

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
      regionKind: result.regionKind ?? "fallback",
    };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }
}

async function findContentRegion(req: CropRequest): Promise<CropRegion> {
  try {
    const layout = await loadPageLayout(req);
    return computeCropRegionFromLayout(req, layout);
  } catch {
    return buildFallbackRegion(req);
  }
}

export const pdfCropRendererInternals = {
  buildFallbackRegion,
  computeCropRegionFromLayout,
};
