import { XMLParser } from "fast-xml-parser";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

interface ArxivMetadata {
  title: string;
  abstract: string;
  authors: string[];
  year: number;
  arxivId: string;
  categories: string[];
  pdfUrl: string;
}

export type ArxivSearchResult = ArxivMetadata;

export function parseArxivId(input: string): string | null {
  // Handle full URLs: https://arxiv.org/abs/2301.12345 or https://arxiv.org/pdf/2301.12345
  const urlMatch = input.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
  if (urlMatch) return urlMatch[1];

  // Handle bare IDs: 2301.12345 or 2301.12345v1
  const idMatch = input.match(/^(\d{4}\.\d{4,5}(?:v\d+)?)$/);
  if (idMatch) return idMatch[1];

  return null;
}

export async function fetchArxivMetadata(
  arxivId: string
): Promise<ArxivMetadata> {
  // Retry with backoff — arxiv rate-limits aggressively
  let xml = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 3000 * attempt));
    const response = await fetch(
      `https://export.arxiv.org/api/query?id_list=${arxivId}`,
      { headers: { "User-Agent": "Arcana-Paper-Finder/1.0" } },
    );
    xml = await response.text();
    if (!xml.includes("Rate exceeded")) break;
  }

  if (xml.includes("Rate exceeded")) {
    throw new Error("arxiv API rate limit — try again in a few seconds");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
  });
  const result = parser.parse(xml);

  const entry = result.feed?.entry;
  if (!entry) {
    throw new Error(`Paper ${arxivId} not found on arxiv`);
  }

  const authors = Array.isArray(entry.author)
    ? entry.author.map((a: { name: string }) => a.name)
    : [entry.author?.name].filter(Boolean);

  const published = entry.published || "";
  const year = published ? new Date(published).getFullYear() : new Date().getFullYear();

  const categories = Array.isArray(entry.category)
    ? entry.category.map((c: { "@_term": string }) => c["@_term"])
    : entry.category
      ? [entry.category["@_term"]]
      : [];

  return {
    title: (entry.title || "").replace(/\s+/g, " ").trim(),
    abstract: (entry.summary || "").replace(/\s+/g, " ").trim(),
    authors,
    year,
    arxivId,
    categories,
    pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
  };
}

export async function searchArxivByTitle(
  title: string,
  maxResults = 5,
): Promise<ArxivSearchResult[]> {
  const query = `ti:"${title.replace(/"/g, '\\"')}"`;
  const response = await fetch(
    `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`,
    { headers: { "User-Agent": "Arcana-Paper-Finder/1.0" } },
  );

  const xml = await response.text();
  if (xml.includes("Rate exceeded")) {
    throw new Error("arxiv API rate limit — try again in a few seconds");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
  });
  const result = parser.parse(xml);
  const entries = Array.isArray(result.feed?.entry)
    ? result.feed.entry
    : result.feed?.entry
      ? [result.feed.entry]
      : [];

  return entries
    .map((entry: Record<string, unknown>) => parseArxivEntry(entry))
    .filter(
      (entry: ArxivSearchResult | null): entry is ArxivSearchResult =>
        Boolean(entry),
    );
}

export async function downloadArxivPdf(arxivId: string): Promise<string> {
  const uploadDir = path.join(process.cwd(), "uploads");
  await mkdir(uploadDir, { recursive: true });

  const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
  const response = await fetch(pdfUrl);

  if (!response.ok) {
    throw new Error(`Failed to download PDF: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const filename = `arxiv-${arxivId.replace(/[/.]/g, "-")}-${uuidv4().slice(0, 8)}.pdf`;
  const filePath = path.join(uploadDir, filename);
  await writeFile(filePath, buffer);

  return `uploads/${filename}`;
}

function parseArxivEntry(entry: Record<string, unknown> | null | undefined): ArxivSearchResult | null {
  if (!entry) return null;

  const idValue = typeof entry.id === "string" ? entry.id : "";
  const arxivId = parseArxivId(idValue);
  if (!arxivId) return null;

  const authors = Array.isArray(entry.author)
    ? entry.author
        .map((author) =>
          author && typeof author === "object" && typeof (author as { name?: unknown }).name === "string"
            ? (author as { name: string }).name
            : null,
        )
        .filter((author): author is string => Boolean(author))
    : entry.author &&
        typeof entry.author === "object" &&
        typeof (entry.author as { name?: unknown }).name === "string"
      ? [(entry.author as { name: string }).name]
      : [];

  const published = typeof entry.published === "string" ? entry.published : "";
  const year = published ? new Date(published).getFullYear() : new Date().getFullYear();
  const categories = Array.isArray(entry.category)
    ? entry.category
        .map((category) =>
          category &&
          typeof category === "object" &&
          typeof (category as { "@_term"?: unknown })["@_term"] === "string"
            ? (category as { "@_term": string })["@_term"]
            : null,
        )
        .filter((category): category is string => Boolean(category))
    : entry.category &&
        typeof entry.category === "object" &&
        typeof (entry.category as { "@_term"?: unknown })["@_term"] === "string"
      ? [(entry.category as { "@_term": string })["@_term"]]
      : [];

  return {
    title:
      typeof entry.title === "string"
        ? entry.title.replace(/\s+/g, " ").trim()
        : "",
    abstract:
      typeof entry.summary === "string"
        ? entry.summary.replace(/\s+/g, " ").trim()
        : "",
    authors,
    year,
    arxivId,
    categories,
    pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
  };
}
