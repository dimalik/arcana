function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function canonicalizeAuthorName(rawName: string): string {
  return collapseWhitespace(rawName);
}

export function normalizeAuthorName(rawName: string): string {
  const canonical = canonicalizeAuthorName(rawName);
  if (!canonical) return "";

  return canonical
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parsePaperAuthorsJson(
  value: string | null | undefined,
): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map(canonicalizeAuthorName)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function normalizeAuthorList(
  authors: string[] | null | undefined,
): string[] {
  if (!authors) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawName of authors) {
    const canonical = canonicalizeAuthorName(rawName);
    const bucket = normalizeAuthorName(canonical);
    if (!canonical || !bucket || seen.has(bucket)) continue;
    seen.add(bucket);
    normalized.push(canonical);
  }
  return normalized;
}

export function serializePaperAuthors(
  authors: string[] | null | undefined,
): string | null {
  const normalized = normalizeAuthorList(authors);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

export function authorBucketKey(rawName: string): string {
  return normalizeAuthorName(rawName);
}
