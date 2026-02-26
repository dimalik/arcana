import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

interface OpenReviewMetadata {
  title: string;
  abstract: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  forumId: string;
  pdfUrl: string;
}

/**
 * Extract OpenReview forum ID from a URL or bare ID.
 */
export function parseOpenReviewId(input: string): string | null {
  // Handle full URLs: https://openreview.net/forum?id=XXXXX or /pdf?id=XXXXX
  try {
    const url = new URL(input);
    if (url.hostname === "openreview.net") {
      const id = url.searchParams.get("id");
      if (id) return id;
    }
  } catch {
    // Not a URL, try as bare ID
  }

  // Bare ID (alphanumeric + hyphens + underscores, typically 10+ chars)
  const idMatch = input.match(/^[A-Za-z0-9_-]{6,}$/);
  if (idMatch) return idMatch[0];

  return null;
}

/**
 * Fetch paper metadata from the OpenReview API v2.
 */
export async function fetchOpenReviewMetadata(
  forumId: string
): Promise<OpenReviewMetadata> {
  const response = await fetch(
    `https://api2.openreview.net/notes?id=${encodeURIComponent(forumId)}`
  );

  if (!response.ok) {
    throw new Error(`OpenReview API error: ${response.status}`);
  }

  const data = await response.json();
  const notes = data.notes;

  if (!notes || notes.length === 0) {
    throw new Error("Paper not found on OpenReview");
  }

  const note = notes[0];
  const content = note.content || {};

  // Title
  const title = content.title?.value || note.content?.title || "Untitled";

  // Abstract
  const abstract = content.abstract?.value || content.abstract || "";

  // Authors — could be in content.authors.value or content.authorids.value
  let authors: string[] = [];
  if (content.authors?.value && Array.isArray(content.authors.value)) {
    authors = content.authors.value;
  }

  // Venue
  const venue = content.venue?.value || note.venue || null;

  // Year from invitation or creation date
  let year: number | null = null;
  if (note.cdate) {
    year = new Date(note.cdate).getFullYear();
  }
  // Try to extract year from venue string (e.g., "ICLR 2024")
  if (venue) {
    const yearMatch = venue.match(/\b(20\d{2})\b/);
    if (yearMatch) year = parseInt(yearMatch[1], 10);
  }

  return {
    title: typeof title === "string" ? title.trim() : String(title),
    abstract: typeof abstract === "string" ? abstract.trim() : "",
    authors,
    year,
    venue: typeof venue === "string" ? venue : null,
    forumId,
    pdfUrl: `https://openreview.net/pdf?id=${forumId}`,
  };
}

/**
 * Download a PDF from OpenReview and save to uploads/.
 */
export async function downloadOpenReviewPdf(
  forumId: string
): Promise<string> {
  const uploadDir = path.join(process.cwd(), "uploads");
  await mkdir(uploadDir, { recursive: true });

  const pdfUrl = `https://openreview.net/pdf?id=${encodeURIComponent(forumId)}`;
  const response = await fetch(pdfUrl);

  if (!response.ok) {
    throw new Error(`Failed to download PDF: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const filename = `openreview-${forumId.replace(/[^A-Za-z0-9_-]/g, "_")}-${uuidv4().slice(0, 8)}.pdf`;
  const filePath = path.join(uploadDir, filename);
  await writeFile(filePath, buffer);

  return `uploads/${filename}`;
}
