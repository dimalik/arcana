export interface ReferenceMetadataInput {
  title: string;
  authors: string | null;
  venue: string | null;
  rawCitation: string;
}

export interface SanitizedReferenceMetadata {
  title: string;
  authors: string | null;
  venue: string | null;
  rawCitation: string;
}

export interface PollutedMetadataField {
  field: "title" | "authors" | "venue";
  beforeValue: string | null;
}

const LEADING_CITATION_MARKER_RE = /^[A-Z][A-Z0-9]{1,12}\s*\+\s*\d+\]\s*/;
const VENUE_CITATION_MARKER_RE = /^[A-Z][A-Z0-9]{1,12}\s*\+\s*\d{2,4}$/;
const STANDALONE_YEAR_RE = /^\(?\d{4}[a-z]?\)?$/i;
const TRAILING_YEAR_RE = /[\s,.;:()-]*\b\d{4}[a-z]?\)?\.?$/i;
const PERSON_NAME_RE = "[A-Z][A-Za-z'`.-]+(?:\\s+(?:[A-Z]\\.|[A-Z][A-Za-z'`.-]+)){0,3}";
const LEADING_AUTHOR_BLOB_RE = new RegExp(
  `^${PERSON_NAME_RE},\\s+${PERSON_NAME_RE}\\.\\s+.+(?:,\\s*\\d{4}[a-z]?\\.?)?$`,
);

export function cleanReferenceText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/([a-z]{2,})-\s*\n\s*([a-z]{2,})/g, "$1$2")
    .replace(LEADING_CITATION_MARKER_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitCitationSentences(rawCitation: string): string[] {
  return cleanReferenceText(rawCitation)
    .split(/\.\s+/)
    .map((part) => part.trim().replace(/\.+$/, ""))
    .filter(Boolean);
}

export function looksLikePollutedTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  if (LEADING_CITATION_MARKER_RE.test(title)) return true;
  const cleanedTitle = cleanReferenceText(title);
  if (!cleanedTitle) return false;
  return (
    /\bet al\b/i.test(cleanedTitle)
    || LEADING_AUTHOR_BLOB_RE.test(cleanedTitle)
  );
}

function cleanDerivedTitle(title: string): string {
  return cleanReferenceText(title)
    .replace(TRAILING_YEAR_RE, "")
    .trim()
    .replace(/[.,;:]+$/, "")
    .trim();
}

export function deriveTitleFromRawCitation(rawCitation: string): string | null {
  const cleaned = cleanReferenceText(rawCitation);
  const authorRemainder =
    cleaned.match(/\band\s+[^.]+?\.\s+(.+)$/i)?.[1]
    ?? cleaned.match(/\bet al\.\s+(.+)$/i)?.[1]
    ?? null;

  const remainder = authorRemainder
    ? authorRemainder.replace(/^\(?\d{4}[a-z]?\)?\.\s+/i, "").trim()
    : null;

  if (remainder) {
    const dotted = remainder.match(/^([^.;]+?)\.\s+/)?.[1];
    const commaYear = remainder.match(/^([^.;]+?),\s*\d{4}[a-z]?\.?$/i)?.[1];
    const derived = cleanDerivedTitle(dotted ?? commaYear ?? remainder);
    if (derived) return derived;
  }

  const parts = splitCitationSentences(rawCitation);
  if (parts.length >= 3 && STANDALONE_YEAR_RE.test(parts[1] ?? "")) {
    return cleanDerivedTitle(parts[2] ?? "") || null;
  }
  if (parts.length >= 2) {
    return cleanDerivedTitle(parts[1] ?? "") || null;
  }
  return null;
}

export function parseAuthorsJson(authors: string | null): string[] | null {
  if (!authors) return null;
  try {
    const parsed = JSON.parse(authors) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((value) => (typeof value === "string" ? cleanReferenceText(value) : ""))
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function looksLikePollutedAuthors(authors: string | null): boolean {
  const parsedAuthors = parseAuthorsJson(authors);
  if (!parsedAuthors || parsedAuthors.length === 0) return false;
  return parsedAuthors.some(
    (author) => author.includes("]") || /\s\+\s\d+\]/.test(author),
  );
}

export function deriveAuthorsFromRawCitation(
  rawCitation: string,
  title: string,
): string[] | null {
  const cleaned = cleanReferenceText(rawCitation);
  const titleIndex = title
    ? cleaned.toLowerCase().indexOf(title.toLowerCase())
    : -1;
  const authorBlock = titleIndex > 0
    ? cleaned.slice(0, titleIndex)
    : splitCitationSentences(rawCitation)[0] ?? cleaned;

  const normalized = authorBlock
    .replace(/\(?\d{4}[a-z]?\)?\.?\s*$/i, "")
    .replace(/[.;:\s]+$/g, "")
    .replace(/\bet al\b\.?/gi, "")
    .replace(/\band\b/gi, ",")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return normalized.length > 0 ? normalized : null;
}

export function candidateAuthorsPassTrustCheck(params: {
  rawCitation: string;
  title: string;
  candidateAuthors: string[];
}): boolean {
  const cleanedCandidateAuthors = params.candidateAuthors
    .map((author) => cleanReferenceText(author))
    .filter(Boolean);
  if (cleanedCandidateAuthors.length === 0) return false;

  const derivedAuthors = deriveAuthorsFromRawCitation(
    params.rawCitation,
    params.title,
  );
  if (!derivedAuthors || derivedAuthors.length === 0) return true;

  if (derivedAuthors.length >= 2 && cleanedCandidateAuthors.length === 1) {
    return false;
  }

  if (
    derivedAuthors.length >= 4
    && cleanedCandidateAuthors.length < Math.ceil(derivedAuthors.length * 0.8)
  ) {
    return false;
  }

  return true;
}

export function looksLikePollutedVenue(venue: string | null | undefined): boolean {
  const cleanedVenue = cleanReferenceText(venue);
  return cleanedVenue.length > 0 && VENUE_CITATION_MARKER_RE.test(cleanedVenue);
}

export function detectPollutedMetadataFields(
  input: Pick<ReferenceMetadataInput, "title" | "authors" | "venue">,
): PollutedMetadataField[] {
  const fields: PollutedMetadataField[] = [];

  if (looksLikePollutedTitle(input.title)) {
    fields.push({ field: "title", beforeValue: input.title });
  }

  if (looksLikePollutedAuthors(input.authors)) {
    fields.push({ field: "authors", beforeValue: input.authors });
  }

  if (looksLikePollutedVenue(input.venue)) {
    fields.push({ field: "venue", beforeValue: input.venue });
  }

  return fields;
}

export function referenceMetadataNeedsRepair(
  input: Pick<ReferenceMetadataInput, "title" | "authors" | "venue">,
): boolean {
  return detectPollutedMetadataFields(input).length > 0;
}

export function sanitizeReferenceMetadataForDisplay(
  input: ReferenceMetadataInput,
): SanitizedReferenceMetadata {
  const cleanedTitle = cleanReferenceText(input.title);
  const derivedTitle = deriveTitleFromRawCitation(input.rawCitation);
  const title = looksLikePollutedTitle(input.title)
    ? (derivedTitle ?? cleanedTitle)
    : cleanedTitle;

  const parsedAuthors = parseAuthorsJson(input.authors);
  const displayAuthors = !parsedAuthors || looksLikePollutedAuthors(input.authors)
    ? deriveAuthorsFromRawCitation(input.rawCitation, title || derivedTitle || "")
    : parsedAuthors;
  const cleanedVenue = cleanReferenceText(input.venue);
  const venue = looksLikePollutedVenue(input.venue) ? null : cleanedVenue || null;

  return {
    title: title || cleanedTitle || cleanReferenceText(input.rawCitation),
    authors: displayAuthors ? JSON.stringify(displayAuthors) : input.authors,
    venue,
    rawCitation: cleanReferenceText(input.rawCitation),
  };
}
