import { readFile } from "fs/promises";
import path from "path";

import { JSDOM } from "jsdom";

import type { CitationMentionInput } from "../../citations/citation-mention-service";
import {
  runPdfPreflight,
  type PreflightConfig,
  type PreflightOutput,
} from "../pdf-preflight";
import type { ExtractionStatus } from "../types";
import { GrobidClient } from "./client";

export interface GrobidCitationMentionResult {
  mentions: CitationMentionInput[];
  status: ExtractionStatus;
  errorSummary?: string;
  preflight?: PreflightOutput;
}

export interface GrobidCitationMentionExtractorOptions {
  client?: GrobidClient;
  preflightConfig?: PreflightConfig;
  priority?: "interactive" | "backfill";
}

export class GrobidCitationMentionExtractor {
  private readonly client: GrobidClient;
  private readonly preflightConfig?: PreflightConfig;
  private readonly priority: "interactive" | "backfill";

  constructor(options: GrobidCitationMentionExtractorOptions = {}) {
    this.client = options.client ?? new GrobidClient();
    this.preflightConfig = options.preflightConfig;
    this.priority = options.priority ?? "interactive";
  }

  async extract(pdfPath: string): Promise<GrobidCitationMentionResult> {
    const preflight = await runPdfPreflight(pdfPath, this.preflightConfig);
    if (preflight.result !== "text_layer_ok") {
      return {
        mentions: [],
        status: "failed",
        errorSummary: preflight.reason ?? preflight.result,
        preflight,
      };
    }

    try {
      const absolutePath = path.resolve(process.cwd(), pdfPath);
      const pdfBuffer = await readFile(absolutePath);
      const response = await this.client.processFulltextDocument({
        pdfBuffer,
        priority: this.priority,
        pageCount: preflight.pageCount,
        includeRawCitations: true,
        consolidateCitations: false,
      });
      const mentions = parseGrobidTeiCitationMentions(response.teiXml);

      if (mentions.length === 0) {
        return {
          mentions: [],
          status: "partial",
          errorSummary: "GROBID returned TEI but no citation mentions were parsed",
          preflight,
        };
      }

      return {
        mentions,
        status: "succeeded",
        preflight,
      };
    } catch (error) {
      return {
        mentions: [],
        status: "failed",
        errorSummary:
          error instanceof Error
            ? error.message
            : `GROBID fulltext extraction failed: ${String(error)}`,
        preflight,
      };
    }
  }
}

export function parseGrobidTeiCitationMentions(
  teiXml: string,
): CitationMentionInput[] {
  const dom = new JSDOM(teiXml, { contentType: "text/xml" });
  const doc = dom.window.document;
  const body = doc.getElementsByTagName("body")[0];
  if (!body) return [];

  const referenceIndexByXmlId = buildReferenceIndexByXmlId(doc);
  const mentions: CitationMentionInput[] = [];
  walkBody(body, null, referenceIndexByXmlId, mentions);
  return dedupeMentions(mentions);
}

function buildReferenceIndexByXmlId(doc: Document): Map<string, number> {
  const indexByXmlId = new Map<string, number>();
  const listBibl = doc.getElementsByTagName("listBibl")[0];
  if (!listBibl) return indexByXmlId;

  const biblStructs = listBibl.getElementsByTagName("biblStruct");
  for (let index = 0; index < biblStructs.length; index += 1) {
    const xmlId =
      biblStructs[index].getAttribute("xml:id") ??
      biblStructs[index].getAttribute("id");
    if (!xmlId) continue;
    indexByXmlId.set(normalizeXmlTarget(xmlId), index + 1);
  }

  return indexByXmlId;
}

function walkBody(
  node: Element,
  currentSection: string | null,
  referenceIndexByXmlId: Map<string, number>,
  mentions: CitationMentionInput[],
): void {
  let section = currentSection;

  for (const child of Array.from(node.children)) {
    const tagName = child.localName;
    if (tagName === "head") {
      section = extractSectionLabel(child) ?? section;
      continue;
    }

    if (tagName === "p") {
      mentions.push(
        ...extractParagraphMentions(child, section, referenceIndexByXmlId),
      );
      continue;
    }

    walkBody(child, section, referenceIndexByXmlId, mentions);
  }
}

function extractParagraphMentions(
  paragraph: Element,
  sectionLabel: string | null,
  referenceIndexByXmlId: Map<string, number>,
): CitationMentionInput[] {
  const refs = Array.from(paragraph.getElementsByTagName("ref")).filter(
    (ref) => (ref.getAttribute("type") ?? "").toLowerCase() === "bibr",
  );
  if (refs.length === 0) return [];

  const paragraphText = normalizeWhitespace(paragraph.textContent ?? "");
  if (!paragraphText) return [];

  const mentions: CitationMentionInput[] = [];
  let searchStart = 0;

  for (const ref of refs) {
    const citationText = normalizeWhitespace(ref.textContent ?? "");
    if (!citationText) continue;

    const range = locateCitationRange(paragraphText, citationText, searchStart);
    if (range) {
      searchStart = range.end;
    }

    const excerpt = extractExcerpt(
      paragraphText,
      range?.start ?? null,
      range?.end ?? null,
    );
    const referenceIndices = resolveReferenceIndices(
      ref.getAttribute("target"),
      referenceIndexByXmlId,
    );

    if (referenceIndices.length === 0) {
      mentions.push({
        citationText,
        excerpt,
        sectionLabel,
      });
      continue;
    }

    for (const referenceIndex of referenceIndices) {
      mentions.push({
        citationText,
        excerpt,
        sectionLabel,
        referenceIndex,
      });
    }
  }

  return mentions;
}

function extractSectionLabel(head: Element): string | null {
  const label = normalizeWhitespace(head.textContent ?? "");
  if (!label) return null;

  const sectionNumber = normalizeWhitespace(head.getAttribute("n") ?? "");
  if (!sectionNumber || label.startsWith(sectionNumber)) {
    return label;
  }

  return `${sectionNumber} ${label}`;
}

function locateCitationRange(
  paragraphText: string,
  citationText: string,
  searchStart: number,
): { start: number; end: number } | null {
  const exactIndex = paragraphText.indexOf(citationText, searchStart);
  if (exactIndex >= 0) {
    return {
      start: exactIndex,
      end: exactIndex + citationText.length,
    };
  }

  const fallbackIndex = paragraphText.indexOf(citationText);
  if (fallbackIndex >= 0) {
    return {
      start: fallbackIndex,
      end: fallbackIndex + citationText.length,
    };
  }

  return null;
}

function extractExcerpt(
  paragraphText: string,
  start: number | null,
  end: number | null,
): string {
  if (start == null || end == null) {
    return paragraphText;
  }

  const sentenceStart = findSentenceBoundary(paragraphText, start, "backward");
  const sentenceEnd = findSentenceBoundary(paragraphText, end, "forward");
  const excerpt = normalizeWhitespace(
    paragraphText.slice(sentenceStart, sentenceEnd),
  );
  return excerpt || paragraphText;
}

function findSentenceBoundary(
  text: string,
  pivot: number,
  direction: "backward" | "forward",
): number {
  const punctuation = /[.!?](?=\s+[A-Z0-9]|$)/g;

  if (direction === "backward") {
    let boundary = 0;
    let match: RegExpExecArray | null;
    while ((match = punctuation.exec(text)) !== null) {
      if (match.index >= pivot) break;
      boundary = match.index + 1;
      while (boundary < text.length && /\s/.test(text[boundary])) {
        boundary += 1;
      }
    }
    punctuation.lastIndex = 0;
    return boundary;
  }

  punctuation.lastIndex = pivot;
  const match = punctuation.exec(text);
  punctuation.lastIndex = 0;
  return match ? match.index + 1 : text.length;
}

function resolveReferenceIndices(
  target: string | null,
  referenceIndexByXmlId: Map<string, number>,
): number[] {
  if (!target) return [];

  return Array.from(
    new Set(
      target
        .split(/[\s,;]+/)
        .map((value) => normalizeXmlTarget(value))
        .map((value) => referenceIndexByXmlId.get(value))
        .filter((value): value is number => value != null),
    ),
  );
}

function normalizeXmlTarget(value: string): string {
  return value.trim().replace(/^#/, "");
}

function dedupeMentions(
  mentions: CitationMentionInput[],
): CitationMentionInput[] {
  const seen = new Set<string>();
  const deduped: CitationMentionInput[] = [];

  for (const mention of mentions) {
    const key = JSON.stringify({
      citationText: mention.citationText,
      excerpt: mention.excerpt,
      sectionLabel: mention.sectionLabel ?? null,
      referenceIndex: mention.referenceIndex ?? null,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(mention);
  }

  return deduped;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
