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
  const response = await fetch(
    `https://export.arxiv.org/api/query?id_list=${arxivId}`
  );
  const xml = await response.text();

  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
  });
  const result = parser.parse(xml);

  const entry = result.feed?.entry;
  if (!entry) {
    throw new Error("Paper not found on arxiv");
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
