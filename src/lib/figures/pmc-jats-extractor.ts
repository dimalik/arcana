/**
 * Extract figures from PMC Open Access tar.gz packages.
 *
 * PMC OA packages contain:
 *   - JATS XML with <fig> elements referencing <graphic> files
 *   - Actual image files (TIFF, JPEG, PNG) alongside the XML
 *
 * This is the highest-quality journal figure source — structured,
 * author-verified, with explicit captions in XML.
 *
 * sourceMethod: "pmc_jats", confidence: "high"
 */

import { fetchWithRetry } from "@/lib/import/semantic-scholar";
import { writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import path from "path";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

export interface JatsFigure {
  figureLabel: string;
  captionText: string;
  type: "figure" | "table";
  imageFilename: string;
  imageData: Buffer;
  assetHash: string;
}

export interface PmcExtractionResult {
  figures: JatsFigure[];
  pmcid: string | null;
  sourceUrl: string | null;
}

/**
 * Resolve a DOI to a PMCID via Europe PMC.
 */
async function resolvePmcId(doi: string): Promise<string | null> {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:${encodeURIComponent(doi)}&format=json&pageSize=1`;
  const res = await fetchWithRetry(url, "europepmc", 200);
  if (!res) return null;
  const data = await res.json();
  return data.resultList?.result?.[0]?.pmcid || null;
}

/**
 * Get the OA package tar.gz URL from PMC.
 */
async function getOaPackageUrl(pmcid: string): Promise<string | null> {
  const oaUrl = `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=${pmcid}`;
  const res = await fetch(oaUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;

  const xml = await res.text();
  const ftpMatch = xml.match(/href="(ftp:\/\/[^"]+\.tar\.gz)"/);
  if (!ftpMatch) return null;

  return ftpMatch[1].replace("ftp://ftp.ncbi.nlm.nih.gov", "https://ftp.ncbi.nlm.nih.gov");
}

/**
 * Parse a tar archive (uncompressed) and return entries.
 */
function parseTarEntries(tarData: Buffer): { name: string; data: Buffer }[] {
  const entries: { name: string; data: Buffer }[] = [];
  let offset = 0;

  while (offset < tarData.length - 512) {
    const header = tarData.subarray(offset, offset + 512);
    const nameEnd = header.indexOf(0);
    const name = header.subarray(0, Math.min(nameEnd, 100)).toString("utf-8");
    if (!name) break;

    const sizeStr = header.subarray(124, 136).toString("utf-8").trim();
    const size = parseInt(sizeStr, 8) || 0;
    offset += 512;

    if (size > 0) {
      entries.push({ name, data: Buffer.from(tarData.subarray(offset, offset + size)) });
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}

/**
 * Parse JATS XML to extract figure metadata.
 * Returns: { label, caption, graphicHref, type }[]
 */
function parseJatsXml(xml: string): { label: string; caption: string; graphicHref: string; type: "figure" | "table" }[] {
  const results: { label: string; caption: string; graphicHref: string; type: "figure" | "table" }[] = [];

  // Extract <fig> elements (figures)
  const figRegex = /<fig\b[^>]*>([\s\S]*?)<\/fig>/gi;
  let match: RegExpExecArray | null;
  while ((match = figRegex.exec(xml)) !== null) {
    const block = match[1];
    const label = block.match(/<label>([\s\S]*?)<\/label>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
    const caption = block.match(/<caption>([\s\S]*?)<\/caption>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
    // <graphic> can use xlink:href or href
    const graphicHref = block.match(/<graphic[^>]+(?:xlink:href|href)=["']([^"']+)["']/i)?.[1] || "";

    if (graphicHref) {
      results.push({
        label: label || "Figure",
        caption: caption ? `${label}: ${caption}` : label,
        graphicHref,
        type: "figure",
      });
    }
  }

  // Extract <table-wrap> elements (tables with images)
  const tableRegex = /<table-wrap\b[^>]*>([\s\S]*?)<\/table-wrap>/gi;
  while ((match = tableRegex.exec(xml)) !== null) {
    const block = match[1];
    const label = block.match(/<label>([\s\S]*?)<\/label>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
    const caption = block.match(/<caption>([\s\S]*?)<\/caption>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
    const graphicHref = block.match(/<graphic[^>]+(?:xlink:href|href)=["']([^"']+)["']/i)?.[1] || "";

    if (graphicHref) {
      results.push({
        label: label || "Table",
        caption: caption ? `${label}: ${caption}` : label,
        graphicHref,
        type: "table",
      });
    }
  }

  return results;
}

/**
 * Match JATS graphic references to actual files in the tar archive.
 * JATS <graphic> href is typically just the stem (no extension).
 */
function findImageFile(
  graphicHref: string,
  entries: { name: string; data: Buffer }[],
): { name: string; data: Buffer } | null {
  const stem = graphicHref.replace(/^.*\//, ""); // strip path prefix
  const imageExts = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".gif"];

  // Try exact match first
  for (const entry of entries) {
    const entryBase = entry.name.replace(/^.*\//, "");
    if (entryBase === stem) return entry;
    // Try with each extension
    for (const ext of imageExts) {
      if (entryBase === stem + ext) return entry;
      if (entryBase === stem.replace(/\.[^.]+$/, "") + ext) return entry;
    }
  }

  // Fuzzy: check if stem is contained in any filename
  for (const entry of entries) {
    const entryBase = entry.name.replace(/^.*\//, "").toLowerCase();
    if (entryBase.includes(stem.toLowerCase()) && imageExts.some(e => entryBase.endsWith(e))) {
      return entry;
    }
  }

  return null;
}

/**
 * Convert TIFF data to PNG using Python PIL (if the file is TIFF).
 */
async function convertToPngIfNeeded(data: Buffer, filename: string): Promise<Buffer> {
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".tif") && !lower.endsWith(".tiff")) return data;

  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { writeFile: wf, readFile: rf, unlink } = await import("fs/promises");
  const execFileAsync = promisify(execFile);
  const os = await import("os");

  const tmpIn = path.join(os.tmpdir(), `pmc-tiff-${Date.now()}.tiff`);
  const tmpOut = path.join(os.tmpdir(), `pmc-tiff-${Date.now()}.png`);

  try {
    await wf(tmpIn, data);
    await execFileAsync("python3", [
      "-c",
      `from PIL import Image; Image.open("${tmpIn}").convert("RGB").save("${tmpOut}", "PNG")`,
    ], { timeout: 15000 });
    const pngData = await rf(tmpOut);
    return pngData;
  } finally {
    await unlink(tmpIn).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}

/**
 * Extract figures from a PMC OA package for a given DOI.
 * Returns structured figure data with image buffers.
 */
export async function extractPmcFigures(doi: string): Promise<PmcExtractionResult> {
  const empty: PmcExtractionResult = { figures: [], pmcid: null, sourceUrl: null };

  // Step 1: Resolve DOI → PMCID
  const pmcid = await resolvePmcId(doi);
  if (!pmcid) return empty;

  // Step 2: Get OA package URL
  const tarUrl = await getOaPackageUrl(pmcid);
  if (!tarUrl) return { ...empty, pmcid };

  // Step 3: Download and decompress tar.gz
  let tarData: Buffer;
  try {
    const res = await fetch(tarUrl, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return { ...empty, pmcid };

    const compressed = Buffer.from(await res.arrayBuffer());
    const { gunzipSync } = await import("zlib");
    tarData = gunzipSync(compressed);
  } catch (err) {
    console.warn(`[pmc-jats] Failed to download OA package for ${pmcid}:`, (err as Error).message);
    return { ...empty, pmcid };
  }

  // Step 4: Parse tar entries
  const entries = parseTarEntries(tarData);

  // Step 5: Find JATS XML
  const jatsEntry = entries.find(e =>
    e.name.endsWith(".nxml") || e.name.endsWith(".xml"),
  );
  if (!jatsEntry) {
    console.warn(`[pmc-jats] No JATS XML found in OA package for ${pmcid}`);
    return { ...empty, pmcid, sourceUrl: tarUrl };
  }

  // Step 6: Parse JATS XML for figures
  const jatsXml = jatsEntry.data.toString("utf-8");
  const jatsFigures = parseJatsXml(jatsXml);

  // Step 7: Match graphic references to image files and build results
  const figures: JatsFigure[] = [];
  for (const jf of jatsFigures) {
    const imageEntry = findImageFile(jf.graphicHref, entries);
    if (!imageEntry) {
      console.warn(`[pmc-jats] Image not found for ${jf.label}: ${jf.graphicHref}`);
      continue;
    }

    let imageData: Buffer;
    try {
      imageData = await convertToPngIfNeeded(imageEntry.data, imageEntry.name);
    } catch {
      imageData = imageEntry.data; // Use original if conversion fails
    }

    const assetHash = createHash("sha256").update(imageData).digest("hex");
    const ext = imageEntry.name.toLowerCase().endsWith(".tif") || imageEntry.name.toLowerCase().endsWith(".tiff")
      ? "png" // Converted
      : imageEntry.name.split(".").pop() || "jpg";

    figures.push({
      figureLabel: jf.label,
      captionText: jf.caption,
      type: jf.type,
      imageFilename: `pmc-${jf.label.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}.${ext}`,
      imageData,
      assetHash,
    });
  }

  console.log(`[pmc-jats] Extracted ${figures.length} figures from ${pmcid} JATS XML`);
  return { figures, pmcid, sourceUrl: tarUrl };
}

export interface PmcFigureRecord {
  figureLabel: string;
  captionText: string;
  captionSource: string;
  sourceMethod: string;
  sourceUrl: string | null;
  confidence: string;
  imagePath: string;
  assetHash: string;
  type: "figure" | "table";
}

/**
 * Extract PMC/JATS figures: download OA package, save images to disk.
 * Does NOT write to PaperFigure — the orchestrator's transaction handles all DB writes.
 */
export async function downloadPmcFigures(
  paperId: string,
  doi: string,
): Promise<{ downloaded: number; pmcid: string | null; figures: PmcFigureRecord[] }> {
  const result = await extractPmcFigures(doi);
  if (result.figures.length === 0) return { downloaded: 0, pmcid: result.pmcid, figures: [] };

  const figDir = path.join(process.cwd(), "uploads", "figures", paperId);
  await mkdir(figDir, { recursive: true });

  const written: PmcFigureRecord[] = [];

  for (let i = 0; i < result.figures.length; i++) {
    const fig = result.figures[i];
    try {
      const fullPath = path.join(figDir, fig.imageFilename);
      await writeFile(fullPath, fig.imageData);

      const imagePath = `uploads/figures/${paperId}/${fig.imageFilename}`;

      written.push({
        figureLabel: fig.figureLabel,
        captionText: fig.captionText,
        captionSource: "jats",
        sourceMethod: "pmc_jats",
        sourceUrl: result.sourceUrl,
        confidence: "high",
        imagePath,
        assetHash: fig.assetHash,
        type: fig.type,
      });
    } catch (err) {
      console.warn(`[pmc-jats] Failed to save ${fig.figureLabel}:`, (err as Error).message);
    }
  }

  return { downloaded: written.length, pmcid: result.pmcid, figures: written };
}
