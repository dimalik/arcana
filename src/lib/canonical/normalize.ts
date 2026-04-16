/**
 * Identifier normalization for canonical paper identity.
 */

export type IdentifierType =
  | "doi"
  | "arxiv"
  | "semantic_scholar"
  | "openalex"
  | "pmid"
  | "openreview";

const DOI_URL_PREFIXES = [
  "https://doi.org/",
  "http://doi.org/",
  "https://dx.doi.org/",
  "http://dx.doi.org/",
];

const ARXIV_URL_PREFIXES = [
  "https://arxiv.org/abs/",
  "http://arxiv.org/abs/",
  "https://arxiv.org/pdf/",
  "http://arxiv.org/pdf/",
];

const OPENALEX_URL_PREFIX = "https://openalex.org/";

export function normalizeIdentifier(type: IdentifierType, value: string): string {
  const trimmed = value.trim();

  switch (type) {
    case "doi":
      return normalizeDoi(trimmed);
    case "arxiv":
      return normalizeArxiv(trimmed);
    case "openalex":
      return normalizeOpenalex(trimmed);
    case "semantic_scholar":
    case "pmid":
    case "openreview":
      return trimmed;
    default:
      return trimmed;
  }
}

function normalizeDoi(raw: string): string {
  let doi = raw;
  for (const prefix of DOI_URL_PREFIXES) {
    if (doi.toLowerCase().startsWith(prefix)) {
      doi = doi.slice(prefix.length);
      break;
    }
  }
  return doi.toLowerCase();
}

function normalizeArxiv(raw: string): string {
  let id = raw;
  for (const prefix of ARXIV_URL_PREFIXES) {
    if (id.toLowerCase().startsWith(prefix.toLowerCase())) {
      id = id.slice(prefix.length);
      break;
    }
  }
  if (id.endsWith(".pdf")) {
    id = id.slice(0, -4);
  }
  return id.replace(/v\d+$/, "");
}

function normalizeOpenalex(raw: string): string {
  let id = raw;
  if (id.toLowerCase().startsWith(OPENALEX_URL_PREFIX.toLowerCase())) {
    id = id.slice(OPENALEX_URL_PREFIX.length);
  }
  if (/^w\d+$/i.test(id)) {
    return id.charAt(0).toUpperCase() + id.slice(1);
  }
  return id;
}

export function parseArxivId(raw: string): { baseId: string; version: number | null } {
  const versionMatch = raw.match(/^(.+?)v(\d+)$/);
  if (versionMatch) {
    return { baseId: versionMatch[1], version: parseInt(versionMatch[2], 10) };
  }
  return { baseId: raw, version: null };
}
