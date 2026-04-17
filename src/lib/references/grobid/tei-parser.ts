import { XMLParser } from "fast-xml-parser";
import type { ReferenceExtractionCandidate } from "../types";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
});

const VENUE_LEVELS = new Set(["j", "m", "s", "u"]);
const DOI_REGEX = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i;
const ARXIV_CONTEXT_REGEX =
  /\barxiv(?:\s+preprint)?\s*(?::)?\s*(?:abs\/)?((?:\d{4}\.\d{4,5}(?:v\d+)?)|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?))(?:\s*\[[^\]]*\]?)?/i;
const ARXIV_BARE_REGEX =
  /\b(?:abs\/)?((?:\d{4}\.\d{4,5}(?:v\d+)?)|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?))(?:\s*\[[^\]]*\]?)?\b/i;
const YEAR_REGEX = /\b(19|20)\d{2}[a-z]?\b/;
const YEAR_SCAN_REGEX = /\b(?:19|20)\d{2}[a-z]?\b/g;
const ARXIV_FROM_DOI_REGEX = /10\.48550\/arxiv\.(.+)$/i;
const TITLE_VENUE_SPLITS: Array<{ pattern: RegExp; keepChars: number }> = [
  {
    pattern:
      /\?\s+(?=(?:In\b|Proceedings\b|Proc\.\b|arXiv\b|Journal\b|Transactions\b|SIG|NeurIPS|ACL|NAACL|EMNLP|ICLR|ICML|AAAI|CVPR|ECCV|ICCV))/i,
    keepChars: 1,
  },
  {
    pattern:
      /\.\s+(?=(?:In\b|Proceedings\b|Proc\.\b|arXiv\b|Journal\b|Transactions\b|SIG|NeurIPS|ACL|NAACL|EMNLP|ICLR|ICML|AAAI|CVPR|ECCV|ICCV))/i,
    keepChars: 0,
  },
  {
    pattern: /,\s+(?=(?:Proceedings\b|arXiv\b))/i,
    keepChars: 0,
  },
  {
    pattern: /\.\s+/,
    keepChars: 0,
  },
];

export function parseGrobidTeiReferences(
  teiXml: string,
): ReferenceExtractionCandidate[] {
  const parsed = parser.parse(teiXml) as unknown;
  const biblStructs = findBiblStructs(parsed);

  return biblStructs
    .map((biblStruct, index) => parseBiblStruct(biblStruct, index))
    .filter(
      (
        candidate,
      ): candidate is ReferenceExtractionCandidate =>
        candidate !== null && Boolean(candidate.rawCitation.trim()),
    );
}

function parseBiblStruct(
  biblStruct: Record<string, unknown>,
  index: number,
): ReferenceExtractionCandidate | null {
  const analytic = asRecord(biblStruct.analytic);
  const monogr = asRecord(biblStruct.monogr);
  const rawCitation = extractRawCitation(biblStruct.note);
  const rawParsed = parseRawCitation(rawCitation);
  const authors = extractAuthors(analytic?.author);
  const fallbackAuthors =
    authors.length > 0 ? authors : extractAuthors(monogr?.author);

  const structuredTitle = analytic
    ? extractWorkTitle(analytic.title)
    : extractWorkTitle(monogr?.title);
  const structuredVenue = analytic ? extractVenueTitle(monogr?.title) : null;
  const year = extractYear(monogr?.imprint, rawCitation);
  const identifiers = extractIdentifiers(
    [analytic?.idno, monogr?.idno, biblStruct.idno],
    rawCitation,
  );

  const title = chooseBestTitle({
    structuredTitle,
    rawTitle: rawParsed.title,
    rawCitation,
    authors: fallbackAuthors,
    year,
    structuredVenue,
  });
  const venue = chooseBestVenue({
    structuredVenue,
    rawVenue: rawParsed.venue,
    title,
  });
  const resolvedRawCitation =
    rawCitation ??
    buildFallbackRawCitation({
      title,
      authors: fallbackAuthors,
      venue,
      year,
    });

  if (!title && !resolvedRawCitation) return null;

  return {
    referenceIndex: index + 1,
    rawCitation: resolvedRawCitation ?? title ?? `Reference ${index + 1}`,
    title: title ?? rawParsed.title ?? resolvedRawCitation ?? null,
    authors: fallbackAuthors.length > 0 ? fallbackAuthors : null,
    year,
    venue,
    doi: identifiers.doi,
    arxivId: identifiers.arxivId,
    extractionMethod: "grobid_tei",
    extractionConfidence: estimateConfidence({
      title,
      rawCitation: resolvedRawCitation,
      authors: fallbackAuthors,
      year,
      venue,
      doi: identifiers.doi,
      arxivId: identifiers.arxivId,
    }),
  };
}

function findBiblStructs(node: unknown): Array<Record<string, unknown>> {
  if (!node || typeof node !== "object") return [];

  if (Array.isArray(node)) {
    return node.flatMap((value) => findBiblStructs(value));
  }

  const record = node as Record<string, unknown>;
  const results: Array<Record<string, unknown>> = [];

  if (record.biblStruct) {
    results.push(
      ...toArray(record.biblStruct).flatMap((value) => {
        const biblStruct = asRecord(value);
        return biblStruct ? [biblStruct] : [];
      }),
    );
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      results.push(...findBiblStructs(value));
    }
  }

  return results;
}

function extractWorkTitle(titleNode: unknown): string | null {
  return normalizeTitle(
    pickTitleByLevels(titleNode, ["a"]) ?? pickTitleByLevels(titleNode),
  );
}

function extractVenueTitle(titleNode: unknown): string | null {
  return normalizeVenue(
    pickTitleByLevels(titleNode, ["j", "m", "s", "u"]) ??
      pickTitleByLevels(titleNode),
  );
}

function pickTitleByLevels(
  titleNode: unknown,
  preferredLevels?: string[],
): string | null {
  const titles = toArray(titleNode);
  if (titles.length === 0) return null;

  if (preferredLevels && preferredLevels.length > 0) {
    for (const preferredLevel of preferredLevels) {
      for (const value of titles) {
        const titleRecord = asRecord(value);
        if (!titleRecord) continue;
        const level = (titleRecord.level ?? "").toString().toLowerCase();
        if (level !== preferredLevel) continue;
        const text = textValue(titleRecord);
        if (text) return text;
      }
    }
  }

  for (const value of titles) {
    const titleRecord = asRecord(value);
    if (titleRecord) {
      const level = (titleRecord.level ?? "").toString().toLowerCase();
      if (level && preferredLevels && preferredLevels.length > 0) continue;
    }
    const text = textValue(value);
    if (text) return text;
  }

  for (const value of titles) {
    const text = textValue(value);
    if (text) return text;
  }

  return null;
}

function extractAuthors(authorNode: unknown): string[] {
  const authors: string[] = [];

  for (const value of toArray(authorNode)) {
    const authorRecord = asRecord(value);
    const persName = asRecord(authorRecord?.persName);
    if (persName) {
      const surname = textValue(persName.surname);
      const forenames = toArray(persName.forename)
        .map((forename) => textValue(forename))
        .filter((forename): forename is string => Boolean(forename));
      const fullName = [...forenames, surname]
        .filter((part): part is string => Boolean(part))
        .join(" ")
        .trim();
      if (fullName) {
        authors.push(fullName);
        continue;
      }
    }

    const fallback = textValue(authorRecord ?? value);
    if (fallback) authors.push(fallback);
  }

  return dedupeStrings(authors);
}

function extractYear(imprintNode: unknown, rawCitation: string | null): number | null {
  const imprint = asRecord(imprintNode);

  if (imprint) {
    for (const dateNode of toArray(imprint.date)) {
      const dateRecord = asRecord(dateNode);
      const raw =
        textValue(dateRecord ?? dateNode) ??
        (dateRecord?.when ? dateRecord.when.toString() : null);
      const year = extractYearFromText(raw);
      if (year) return year;
    }
  }

  return extractYearFromText(rawCitation);
}

function extractIdentifiers(
  idNodes: unknown[],
  rawCitation: string | null,
): { doi: string | null; arxivId: string | null } {
  let doi: string | null = null;
  let arxivId: string | null = null;

  for (const node of idNodes) {
    for (const value of toArray(node)) {
      const idRecord = asRecord(value);
      const type = (idRecord?.type ?? "").toString().toLowerCase();
      const text = textValue(idRecord ?? value);
      if (!text) continue;

      if (!doi && (type === "doi" || DOI_REGEX.test(text))) {
        doi = normalizeDoi(text);
      }
      if (
        !arxivId &&
        (type === "arxiv" || type === "arxiv_id" || type === "arxivid")
      ) {
        arxivId = normalizeArxivId(text, true);
      } else if (!arxivId && /\barxiv\b/i.test(text)) {
        arxivId = normalizeArxivId(text, false);
      }
    }
  }

  if (!doi && rawCitation) {
    doi = normalizeDoi(rawCitation);
  }
  if (!arxivId && rawCitation && /\barxiv\b/i.test(rawCitation)) {
    arxivId = normalizeArxivId(rawCitation, false);
  }
  if (!arxivId && doi) {
    arxivId = extractArxivIdFromDoi(doi);
  }

  return { doi, arxivId };
}

function extractRawCitation(noteNode: unknown): string | null {
  for (const value of toArray(noteNode)) {
    const noteRecord = asRecord(value);
    if (!noteRecord) continue;
    if ((noteRecord.type ?? "").toString().toLowerCase() !== "raw_reference") {
      continue;
    }
    const text = normalizeWhitespace(textValue(noteRecord));
    if (text) return text;
  }

  return null;
}

function parseRawCitation(rawCitation: string | null): {
  title: string | null;
  venue: string | null;
} {
  if (!rawCitation) {
    return { title: null, venue: null };
  }

  const normalized = dehyphenateLineBreaks(normalizeWhitespace(rawCitation));
  if (!normalized) {
    return { title: null, venue: null };
  }

  const yearMatch = normalized.match(YEAR_REGEX);
  const remainder = normalizeWhitespace(
    yearMatch
      ? normalized
          .slice((yearMatch.index ?? 0) + yearMatch[0].length)
          .replace(/^[)\].,:;\s-]+/, "")
      : normalized,
  );

  if (!remainder) {
    return { title: null, venue: null };
  }

  for (const split of TITLE_VENUE_SPLITS) {
    const match = remainder.match(split.pattern);
    if (!match || match.index === undefined) continue;

    const title = normalizeTitle(
      remainder.slice(0, match.index + split.keepChars),
    );
    const venue = normalizeVenue(
      remainder.slice(match.index + match[0].length),
    );
    return { title, venue };
  }

  return {
    title: normalizeTitle(remainder),
    venue: null,
  };
}

function chooseBestTitle(input: {
  structuredTitle: string | null;
  rawTitle: string | null;
  rawCitation: string | null;
  authors: string[];
  year: number | null;
  structuredVenue: string | null;
}): string | null {
  const structuredTitle = normalizeTitle(input.structuredTitle);
  const rawTitle = normalizeTitle(input.rawTitle);
  const structuredSuspicious = isSuspiciousTitle(structuredTitle, {
    venue: input.structuredVenue,
    authors: input.authors,
  });
  const rawSuspicious = isSuspiciousTitle(rawTitle, {
    venue: input.structuredVenue,
    authors: input.authors,
  });

  if (structuredTitle && !structuredSuspicious) {
    if (rawTitle && !rawSuspicious && normalizedKey(structuredTitle) !== normalizedKey(rawTitle)) {
      if (looksLikeYearPrefixedTitle(structuredTitle)) return rawTitle;
      if (looksLikeAuthorList(structuredTitle)) return rawTitle;
      if (
        input.structuredVenue &&
        normalizedKey(structuredTitle) === normalizedKey(input.structuredVenue)
      ) {
        return rawTitle;
      }
    }
    return structuredTitle;
  }

  if (rawTitle && !rawSuspicious) return rawTitle;
  return structuredTitle ?? rawTitle ?? null;
}

function chooseBestVenue(input: {
  structuredVenue: string | null;
  rawVenue: string | null;
  title: string | null;
}): string | null {
  const candidates = [normalizeVenue(input.structuredVenue), normalizeVenue(input.rawVenue)];

  for (const venue of candidates) {
    if (!venue) continue;
    if (input.title && normalizedKey(venue) === normalizedKey(input.title)) {
      continue;
    }
    if (venue.length < 3) continue;
    return venue;
  }

  return null;
}

function estimateConfidence(input: {
  title: string | null;
  rawCitation: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
}): number {
  let score = 0.2;
  if (input.title) score += 0.25;
  if (input.rawCitation) score += 0.2;
  if (input.authors.length > 0) score += 0.15;
  if (input.year) score += 0.05;
  if (input.venue) score += 0.05;
  if (input.doi || input.arxivId) score += 0.15;

  if (isSuspiciousTitle(input.title, { venue: input.venue, authors: input.authors })) {
    score -= 0.25;
  }
  if (input.title && input.venue && normalizedKey(input.title) === normalizedKey(input.venue)) {
    score -= 0.15;
  }
  if (!input.year) score -= 0.05;

  return Math.max(0.1, Math.min(0.95, Number(score.toFixed(2))));
}

function buildFallbackRawCitation(input: {
  title: string | null;
  authors: string[];
  venue: string | null;
  year: number | null;
}): string | null {
  const parts = [
    input.authors.length > 0 ? input.authors.join(", ") : null,
    input.year ? `(${input.year})` : null,
    input.title,
    input.venue ? `In ${input.venue}` : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(". ") : null;
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") {
    return normalizeWhitespace(value);
  }

  if (!value) return null;

  if (Array.isArray(value)) {
    return normalizeWhitespace(
      value
        .map((entry) => textValue(entry))
        .filter((entry): entry is string => Boolean(entry))
        .join(" "),
    );
  }

  if (typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const parts: string[] = [];

  if (typeof record["#text"] === "string") {
    parts.push(record["#text"]);
  }

  for (const [key, nested] of Object.entries(record)) {
    if (key === "#text" || isTextValueAttribute(key)) continue;
    const nestedText = textValue(nested);
    if (nestedText) parts.push(nestedText);
  }

  return normalizeWhitespace(parts.join(" "));
}

function normalizeTitle(value: string | null): string | null {
  if (!value) return null;

  let normalized = dehyphenateLineBreaks(normalizeWhitespace(value));
  if (!normalized) return null;
  normalized = normalized.replace(/^[("'\[]+/, "");
  normalized = normalized.replace(/[)"'\]]+$/, "");
  normalized = normalized.replace(/^\(?\d{4}[a-z]?\)?[.:]\s*/i, "");
  normalized = normalized.replace(/\s+\((?:preprint|poster)\)$/i, "");
  normalized = normalized.replace(/\s+/g, " ").trim();
  normalized = stripAuthorLeadFromTitle(normalized);

  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1).trim();
  }

  return normalized.length > 0 ? normalized : null;
}

function normalizeVenue(value: string | null): string | null {
  if (!value) return null;

  let normalized = dehyphenateLineBreaks(normalizeWhitespace(value));
  if (!normalized) return null;
  normalized = normalized.replace(/^In\s+/i, "");
  normalized = normalized.replace(/\barXiv(?::| preprint).*$/i, "");
  normalized = normalized.replace(/,\s*(?:volume|vol\.?|pages?)\b.*$/i, "");
  normalized = normalized.replace(/\s+/g, " ").trim();

  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1).trim();
  }

  return normalized.length > 0 ? normalized : null;
}

function normalizeDoi(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(DOI_REGEX);
  if (!match) return null;
  return match[0].replace(/[).,;]+$/, "");
}

function normalizeArxivId(
  value: string | null,
  allowBareId: boolean,
): string | null {
  if (!value) return null;

  const cleaned = value
    .replace(/^arxiv:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const match = cleaned.match(ARXIV_CONTEXT_REGEX);
  if (match?.[1]) {
    return match[1];
  }

  if (allowBareId) {
    const bareMatch = cleaned.match(ARXIV_BARE_REGEX);
    if (bareMatch?.[1]) {
      return bareMatch[1];
    }
  }

  return null;
}

function extractArxivIdFromDoi(doi: string | null): string | null {
  if (!doi) return null;
  const match = doi.match(ARXIV_FROM_DOI_REGEX);
  return match?.[1] ?? null;
}

function extractYearFromText(value: string | null): number | null {
  if (!value) return null;
  const matches = Array.from(value.matchAll(YEAR_SCAN_REGEX));
  if (matches.length === 0) return null;

  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const offset = match.index ?? -1;
    if (offset < 0) continue;
    if (looksLikePageRangeYear(value, offset, match[0].length)) continue;
    return Number.parseInt(match[0].slice(0, 4), 10);
  }

  return Number.parseInt(matches[matches.length - 1][0].slice(0, 4), 10);
}

function looksLikePageRangeYear(
  value: string,
  offset: number,
  length: number,
): boolean {
  const previous = previousNonSpaceChar(value, offset - 1);
  const next = nextNonSpaceChar(value, offset + length);
  return (
    previous !== null &&
    next !== null &&
    /[-–—:]/.test(previous) &&
    /[-–—:,\])]/.test(next)
  );
}

function isSuspiciousTitle(
  title: string | null,
  context: { venue: string | null; authors: string[] },
): boolean {
  if (!title) return false;
  if (looksLikeYearPrefixedTitle(title)) return true;
  if (context.venue && normalizedKey(title) === normalizedKey(context.venue)) return true;
  if (title.length > 240) return true;
  if (wordCount(title) > 40) return true;
  if (looksLikeAuthorList(title)) return true;
  if (/\b(?:Proceedings of|Proc\.\b|arXiv preprint|Symposium on|Conference on)\b/i.test(title)) {
    return true;
  }
  if (/[.?]\s+(?:In\b|Proceedings of|arXiv\b)/i.test(title)) {
    return true;
  }
  if (
    context.authors.length === 0 &&
    title.split(",").length > 6 &&
    !/[.?!:]/.test(title.slice(0, 80))
  ) {
    return true;
  }
  return false;
}

function looksLikeYearPrefixedTitle(title: string): boolean {
  return /^\(?\d{4}[a-z]?\)?[.:]\s+/i.test(title);
}

function looksLikeAuthorList(title: string): boolean {
  const commaCount = (title.match(/,/g) ?? []).length;
  if (commaCount < 6) return false;
  if (title.length < 80) return false;
  return /(?:\bet al\b| and )/i.test(title) || wordCount(title) > 35;
}

function stripAuthorLeadFromTitle(title: string): string {
  const segments = title
    .split(/\.\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) return title;

  const [lead, ...rest] = segments;
  if (!looksLikeAuthorLead(lead)) return title;

  const remainder = rest.join(". ").trim();
  return remainder.length > 8 ? remainder : title;
}

function looksLikeAuthorLead(value: string): boolean {
  const commaCount = (value.match(/,/g) ?? []).length;
  if (commaCount < 2 && !/\bet al\b/i.test(value) && !/\sand\s/i.test(value)) {
    return false;
  }

  const tokens = value
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z]+|[^A-Za-z.'-]+$/g, ""))
    .filter(Boolean);
  if (tokens.length < 4) return false;

  const uppercaseWordRatio =
    tokens.filter((token) => /^[A-Z][A-Za-z.'-]*$/.test(token)).length /
    Math.max(tokens.length, 1);
  return uppercaseWordRatio >= 0.45;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function normalizedKey(text: string | null): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeWhitespace(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function dehyphenateLineBreaks(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/([A-Za-z])-\s+([a-z])/g, "$1$2");
}

function previousNonSpaceChar(value: string, index: number): string | null {
  for (let current = index; current >= 0; current -= 1) {
    const char = value[current];
    if (!/\s/.test(char)) return char;
  }
  return null;
}

function nextNonSpaceChar(value: string, index: number): string | null {
  for (let current = index; current < value.length; current += 1) {
    const char = value[current];
    if (!/\s/.test(char)) return char;
  }
  return null;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const key = normalizedKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }

  return output;
}

function isTextValueAttribute(key: string): boolean {
  return (
    key === "type" ||
    key === "level" ||
    key === "when" ||
    key === "coords" ||
    key === "key" ||
    key === "target" ||
    key === "xml:id" ||
    key === "n" ||
    key === "unit" ||
    key === "from" ||
    key === "to" ||
    key === "cert" ||
    key === "subtype"
  );
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
