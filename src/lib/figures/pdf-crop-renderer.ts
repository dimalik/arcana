// src/lib/figures/pdf-crop-renderer.ts
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import path from "path";
import { createHash } from "crypto";

const execFileAsync = promisify(execFile);

interface CropRequest {
  pdfPath: string;
  page: number;
  captionYRatio: number;
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

    const pageFile = path.join(req.outDir, `render-p${req.page}`);
    await execFileAsync("pdftoppm", [
      "-png", "-r", "300",
      "-f", String(req.page), "-l", String(req.page),
      req.pdfPath, pageFile,
    ]);

    // Find the rendered file — pdftoppm uses variable zero-padding
    const files = await readdir(req.outDir);
    const rendered = files.find(f => f.startsWith(`render-p${req.page}-`) && f.endsWith(".png"));
    if (!rendered) {
      return { success: false, error: "pdftoppm did not produce output" };
    }

    const renderedPath = path.join(req.outDir, rendered);
    const imageBuffer = await readFile(renderedPath);

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
