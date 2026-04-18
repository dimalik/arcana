import { XMLParser } from "fast-xml-parser";

import { normalizeLabel } from "./label-utils";
import type { MergeableFigure } from "./source-merger";

const DEFAULT_GROBID_TIMEOUT_MS = 60_000;
const GROBID_SOURCE_METHOD = "grobid_tei";
const FIGURE_LABEL_PATTERN = /^(?:Figure|Fig\.?|Table)\s+\d+[a-z]?\b/i;

const teiParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
});

interface ParsedGrobidFigure {
  figureLabel: string | null;
  captionText: string | null;
  pdfPage: number | null;
  bbox: string | null;
  type: "figure" | "table";
}

export interface GrobidExtractorOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

function extractText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return cleanText(value.map((entry) => extractText(entry)).filter(Boolean).join(" "));
  }
  if (typeof value !== "object") return null;

  const parts: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("@_")) continue;
    const text = extractText(entry);
    if (text) parts.push(text);
  }

  return cleanText(parts.join(" "));
}

function collectFigureNodes(value: unknown, sink: Record<string, unknown>[]) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectFigureNodes(entry, sink);
    return;
  }
  if (typeof value !== "object") return;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "figure") {
      for (const node of asArray(entry as Record<string, unknown> | Record<string, unknown>[])) {
        if (node && typeof node === "object") {
          sink.push(node as Record<string, unknown>);
        }
      }
    }
    collectFigureNodes(entry, sink);
  }
}

function buildCaptionText(
  label: string | null,
  head: string | null,
  figDesc: string | null,
): string | null {
  const preferred = figDesc ?? head ?? label;
  if (!preferred) return null;
  if (!label || preferred.toLowerCase().startsWith(label.toLowerCase())) {
    return preferred;
  }
  return `${label}: ${preferred}`;
}

function inferTypeHint(
  typeAttr: string | null,
  label: string | null,
  head: string | null,
  captionText: string | null,
): "figure" | "table" | null {
  if (typeAttr === "table") return "table";
  if (typeAttr === "figure") return "figure";

  const combined = [label, head, captionText].filter(Boolean).join(" ").toLowerCase();
  if (combined.startsWith("table ")) return "table";
  if (combined.startsWith("figure ") || combined.startsWith("fig. ")) return "figure";
  return null;
}

function normalizeExplicitLabel(
  label: string | null,
  typeHint: "figure" | "table" | null,
): string | null {
  const cleaned = cleanText(label);
  if (!cleaned) return null;
  if (FIGURE_LABEL_PATTERN.test(cleaned)) {
    return cleaned;
  }
  if (/^\d+[a-z]?$/i.test(cleaned) && typeHint) {
    return `${typeHint === "table" ? "Table" : "Figure"} ${cleaned}`;
  }
  return cleaned;
}

function inferLabel(label: string | null, head: string | null, captionText: string | null): string | null {
  if (label) return label;
  const headMatch = cleanText(head)?.match(FIGURE_LABEL_PATTERN)?.[0] ?? null;
  if (headMatch) return headMatch;
  const captionMatch = cleanText(captionText)?.match(FIGURE_LABEL_PATTERN)?.[0] ?? null;
  return captionMatch ? cleanText(captionMatch) : null;
}

function parseCoords(coords: string | null | undefined): { pdfPage: number | null; bbox: string | null } {
  const coordValue = cleanText(coords ?? null);
  if (!coordValue) {
    return { pdfPage: null, bbox: null };
  }

  for (const segment of coordValue.split(";")) {
    const parts = segment
      .split(",")
      .map((part) => Number.parseFloat(part))
      .filter((value) => Number.isFinite(value));

    if (parts.length < 5) continue;

    const [page, x0, y0, wOrX1, hOrY1] = parts;
    const x1 = wOrX1 > x0 ? wOrX1 : x0 + wOrX1;
    const y1 = hOrY1 > y0 ? hOrY1 : y0 + hOrY1;

    return {
      pdfPage: Number.isFinite(page) ? Math.max(1, Math.round(page)) : null,
      bbox: [x0, y0, x1, y1].map((value) => value.toFixed(2)).join(","),
    };
  }

  return { pdfPage: null, bbox: null };
}

export function parseGrobidTeiFigures(teiXml: string): ParsedGrobidFigure[] {
  const parsed = teiParser.parse(teiXml) as Record<string, unknown>;
  const nodes: Record<string, unknown>[] = [];
  collectFigureNodes(parsed, nodes);

  const results: ParsedGrobidFigure[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    const typeAttr = cleanText(typeof node["@_type"] === "string" ? node["@_type"] : null)?.toLowerCase();
    const rawExplicitLabel = cleanText(extractText(node.label));
    const head = cleanText(extractText(node.head));
    const figDesc = cleanText(extractText(node.figDesc));
    const typeHint = inferTypeHint(
      typeAttr === "table" || typeAttr === "figure" ? typeAttr : null,
      rawExplicitLabel,
      head,
      figDesc,
    );
    const explicitLabel = normalizeExplicitLabel(rawExplicitLabel, typeHint);
    const provisionalCaption = buildCaptionText(explicitLabel, head, figDesc);
    const label = inferLabel(explicitLabel, head, provisionalCaption);
    const captionText = buildCaptionText(label, head, figDesc);
    const { pdfPage, bbox } = parseCoords(typeof node["@_coords"] === "string" ? node["@_coords"] : null);

    const inferredType = typeAttr === "table"
      || (label?.toLowerCase().startsWith("table ") ?? false)
      || (captionText?.toLowerCase().startsWith("table ") ?? false)
      ? "table"
      : "figure";

    if (!label && !captionText && !bbox) {
      continue;
    }

    const dedupeKey = [
      inferredType,
      normalizeLabel(label) ?? cleanText(label) ?? "nolabel",
      pdfPage ?? "nopage",
      bbox ?? "nobbox",
      captionText ?? "nocaption",
    ].join("|");

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    results.push({
      figureLabel: label,
      captionText,
      pdfPage,
      bbox,
      type: inferredType,
    });
  }

  return results;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function parseTimeoutMs(value: string | null | undefined): number | null {
  const trimmed = cleanText(value ?? null);
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function getConfiguredGrobidUrl(): string | null {
  const baseUrl = cleanText(process.env.GROBID_URL ?? null);
  return baseUrl ? normalizeBaseUrl(baseUrl) : null;
}

export function getConfiguredGrobidTimeoutMs(): number {
  return parseTimeoutMs(process.env.GROBID_TIMEOUT_MS) ?? DEFAULT_GROBID_TIMEOUT_MS;
}

export function isGrobidConfigured(): boolean {
  return getConfiguredGrobidUrl() != null;
}

export async function extractFiguresWithGrobid(
  pdfPath: string,
  opts?: GrobidExtractorOptions,
): Promise<MergeableFigure[]> {
  const baseUrl = opts?.baseUrl ? normalizeBaseUrl(opts.baseUrl) : getConfiguredGrobidUrl();
  if (!baseUrl) {
    return [];
  }

  // Dynamic imports avoid Turbopack TP1004 path-analysis warnings for fs access.
  const fs = await import("fs/promises");
  const path = await import("path");
  const absolutePdfPath = path.resolve(process.cwd(), pdfPath);
  const pdfBuffer = await fs.readFile(absolutePdfPath);
  const form = new FormData();
  form.set("input", new Blob([pdfBuffer], { type: "application/pdf" }), "paper.pdf");
  form.set("teiCoordinates", "figure");
  form.set("consolidateHeader", "0");
  form.set("consolidateCitations", "0");
  form.set("segmentSentences", "0");

  const res = await fetch(`${baseUrl}/api/processFulltextDocument`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(opts?.timeoutMs ?? getConfiguredGrobidTimeoutMs()),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GROBID request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const teiXml = await res.text();
  return parseGrobidTeiFigures(teiXml).map((figure) => ({
    figureLabel: figure.figureLabel,
    captionText: figure.captionText,
    captionSource: GROBID_SOURCE_METHOD,
    sourceMethod: GROBID_SOURCE_METHOD,
    sourceUrl: null,
    confidence: "medium",
    imagePath: null,
    assetHash: null,
    pdfPage: figure.pdfPage,
    bbox: figure.bbox,
    type: figure.type,
    width: null,
    height: null,
    description: null,
    cropOutcome: null,
    gapReason: null,
    imageSourceMethod: null,
  }));
}

export const grobidExtractorInternals = {
  parseCoords,
  parseGrobidTeiFigures,
  buildCaptionText,
  inferTypeHint,
  normalizeExplicitLabel,
  parseTimeoutMs,
};
