/**
 * Figure & table extraction from PDFs.
 *
 * Strategy:
 * 1. Render each PDF page to an image using pdfjs-dist + node-canvas
 * 2. Send each page image to a vision LLM to identify figures/tables
 * 3. Store identified figures with LLM-generated descriptions
 *
 * The LLM acts as the "figure detector" — it's more robust than
 * heuristic-based approaches and can also describe what it sees.
 */

import { prisma } from "@/lib/prisma";
import { getModel } from "@/lib/llm/provider";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { setLlmContext } from "@/lib/llm/provider";
import { generateText } from "ai";

// ── Types ─────────────────────────────────────────────────────

interface ExtractedFigure {
  page: number;
  figureIndex: number;
  type: "figure" | "table" | "diagram" | "equation";
  caption: string | null;
  description: string;
  imagePath: string;
  width: number;
  height: number;
}

// ── Page rendering ────────────────────────────────────────────

async function renderPdfPageToImage(
  pdfPath: string,
  pageNum: number,
  outputPath: string,
  scale: number = 2.0,
): Promise<{ width: number; height: number } | null> {
  // Dynamic imports to avoid bundling issues
  const fs = await import("fs/promises");
  const path = await import("path");
  const { createCanvas } = await import("canvas");

  // pdfjs-dist needs special handling in Node.js
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const absolutePath = path.resolve(process.cwd(), pdfPath);
  const data = new Uint8Array(await fs.readFile(absolutePath));

  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

  if (pageNum > doc.numPages || pageNum < 1) {
    doc.destroy();
    return null;
  }

  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");

  // pdfjs render expects a CanvasRenderingContext2D-compatible object — types don't match node-canvas
  /* eslint-disable @typescript-eslint/no-explicit-any */
  await page.render({
    canvasContext: ctx as any,
    viewport,
    canvas: null as any,
  } as any).promise;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Save as PNG
  const buffer = canvas.toBuffer("image/png");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);

  page.cleanup();
  doc.destroy();

  return { width: Math.round(viewport.width), height: Math.round(viewport.height) };
}

// ── Vision LLM analysis ──────────────────────────────────────

interface PageAnalysis {
  hasFigures: boolean;
  figures: {
    type: "figure" | "table" | "diagram" | "equation";
    caption: string | null;
    description: string;
  }[];
}

async function analyzePageForFigures(
  imagePath: string,
  pageNum: number,
  paperTitle: string,
): Promise<PageAnalysis> {
  const fs = await import("fs/promises");
  const imageBuffer = await fs.readFile(imagePath);
  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:image/png;base64,${base64}`;

  const { provider, modelId, proxyConfig } = await resolveModelConfig({});
  const model = await getModel(provider, modelId, proxyConfig);
  setLlmContext("figure-extraction", undefined, { paperTitle, page: pageNum });

  const result = await generateText({
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            image: dataUrl,
          },
          {
            type: "text",
            text: `You are analyzing page ${pageNum} of the paper "${paperTitle}".

Look at this page and identify ALL figures, tables, diagrams, and significant equations.

For each one found, provide:
- type: "figure", "table", "diagram", or "equation"
- caption: the caption text if visible (e.g., "Figure 3: Comparison of model architectures")
- description: a detailed explanation of what this figure/table shows, what the axes represent, what the key takeaways are, any notable data points or trends. Be specific and quantitative where possible.

Respond in JSON format ONLY:
{
  "figures": [
    {
      "type": "figure",
      "caption": "Figure 1: ...",
      "description": "This figure shows..."
    }
  ]
}

If there are NO figures, tables, diagrams, or significant equations on this page, respond:
{"figures": []}

Important: Only identify actual figures/tables/diagrams — not headers, footnotes, or regular text paragraphs. Equations count only if they are displayed prominently (not inline).`,
          },
        ],
      },
    ],
    maxOutputTokens: 1500,
    maxRetries: 1,
  });

  try {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = result.text.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    // Also try to find raw JSON
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0];

    const parsed = JSON.parse(jsonStr);
    const figures = (parsed.figures || []).map((f: { type?: string; caption?: string; description?: string }) => ({
      type: (f.type || "figure") as "figure" | "table" | "diagram" | "equation",
      caption: f.caption || null,
      description: f.description || "No description available",
    }));

    return { hasFigures: figures.length > 0, figures };
  } catch {
    console.warn(`[figure-extractor] Failed to parse LLM response for page ${pageNum}:`, result.text.slice(0, 200));
    return { hasFigures: false, figures: [] };
  }
}

// ── Main extraction pipeline ─────────────────────────────────

export async function extractFigures(
  paperId: string,
  options?: { maxPages?: number; scale?: number },
): Promise<ExtractedFigure[]> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const paper = await prisma.paper.findUnique({
    where: { id: paperId },
    select: { id: true, title: true, filePath: true },
  });

  if (!paper?.filePath) {
    console.warn(`[figure-extractor] Paper ${paperId} has no PDF file`);
    return [];
  }

  const absolutePath = path.resolve(process.cwd(), paper.filePath);
  const data = new Uint8Array(await fs.readFile(absolutePath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const totalPages = doc.numPages;
  doc.destroy();

  const maxPages = Math.min(options?.maxPages || 30, totalPages);
  const scale = options?.scale || 2.0;

  // Output directory for page images
  const figDir = path.join(process.cwd(), "uploads", "figures", paperId);
  await fs.mkdir(figDir, { recursive: true });

  const extracted: ExtractedFigure[] = [];
  console.log(`[figure-extractor] Processing ${maxPages} pages for "${paper.title}"`);

  for (let page = 1; page <= maxPages; page++) {
    const pageImagePath = path.join(figDir, `page-${page}.png`);

    // Render page to image
    const dims = await renderPdfPageToImage(paper.filePath, page, pageImagePath, scale);
    if (!dims) continue;

    // Analyze with vision LLM
    const analysis = await analyzePageForFigures(pageImagePath, page, paper.title);

    if (!analysis.hasFigures) {
      // Delete page image if no figures found (save disk space)
      await fs.unlink(pageImagePath).catch(() => {});
      continue;
    }

    // Store each figure
    for (let i = 0; i < analysis.figures.length; i++) {
      const fig = analysis.figures[i];

      // If multiple figures on one page, keep the full page image
      // (cropping would require bounding boxes which the LLM doesn't reliably provide)
      const imagePath = `uploads/figures/${paperId}/page-${page}.png`;

      const record: ExtractedFigure = {
        page,
        figureIndex: i,
        type: fig.type,
        caption: fig.caption,
        description: fig.description,
        imagePath,
        width: dims.width,
        height: dims.height,
      };

      // Upsert to DB
      await prisma.paperFigure.upsert({
        where: {
          paperId_page_figureIndex: { paperId, page, figureIndex: i },
        },
        create: {
          paperId,
          page,
          figureIndex: i,
          type: fig.type,
          caption: fig.caption,
          description: fig.description,
          imagePath,
          width: dims.width,
          height: dims.height,
        },
        update: {
          type: fig.type,
          caption: fig.caption,
          description: fig.description,
        },
      });

      extracted.push(record);
    }

    console.log(`[figure-extractor] Page ${page}: found ${analysis.figures.length} figure(s)`);
  }

  console.log(`[figure-extractor] Done: ${extracted.length} figures extracted from "${paper.title}"`);
  return extracted;
}

// ── Save figures to Mind Palace ──────────────────────────────

export async function saveFiguresToMindPalace(
  paperId: string,
  figures: ExtractedFigure[],
): Promise<number> {
  if (figures.length === 0) return 0;

  // Find or create a "Visual Insights" room
  let room = await prisma.mindPalaceRoom.findFirst({
    where: { name: "Visual Insights" },
  });
  if (!room) {
    room = await prisma.mindPalaceRoom.create({
      data: {
        name: "Visual Insights",
        description: "Figures, tables, and diagrams extracted from papers",
        color: "#8B5CF6",
        icon: "image",
        isAutoGenerated: true,
      },
    });
  }

  let created = 0;
  for (const fig of figures) {
    // Only create insights for figures with meaningful descriptions
    if (!fig.description || fig.description.length < 30) continue;

    const learning = fig.caption
      ? `${fig.caption}\n\n${fig.description}`
      : fig.description;

    const significance = fig.type === "table"
      ? "Key data table from the paper"
      : fig.type === "diagram"
        ? "Architecture or process diagram"
        : fig.type === "equation"
          ? "Important equation or formula"
          : "Visual finding from the paper";

    try {
      // Check if insight already exists for this figure
      const existing = await prisma.insight.findFirst({
        where: {
          paperId,
          roomId: room.id,
          learning: { contains: fig.description.slice(0, 50) },
        },
      });
      if (existing) continue;

      await prisma.insight.create({
        data: {
          roomId: room.id,
          paperId,
          learning: learning.slice(0, 2000),
          significance,
          applications: `See page ${fig.page} of the paper. Image: ${fig.imagePath}`,
          isAutoGenerated: true,
          source: "distill",
        },
      });
      created++;
    } catch (err) {
      console.warn(`[figure-extractor] Failed to create insight for figure:`, (err as Error).message);
    }
  }

  return created;
}
