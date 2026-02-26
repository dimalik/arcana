export interface CitationData {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
}

/**
 * Generate a BibTeX citation key from first author's last name + year.
 */
function bibtexKey(data: CitationData): string {
  const firstAuthor = data.authors[0] || "unknown";
  const lastName = firstAuthor.split(/\s+/).pop()?.toLowerCase() || "unknown";
  const year = data.year || "n.d.";
  return `${lastName}${year}`;
}

/**
 * Escape special BibTeX characters.
 */
function escapeBibtex(str: string): string {
  return str.replace(/[&%$#_{}~^\\]/g, (ch) => `\\${ch}`);
}

/**
 * Format a reference as BibTeX.
 */
export function formatBibtex(data: CitationData): string {
  // Use @inproceedings if venue looks like a conference, otherwise @article
  const venue = data.venue || "";
  const isConference =
    /conference|proceedings|workshop|symposium|icml|neurips|iclr|cvpr|acl|emnlp|aaai|ijcai/i.test(
      venue
    );
  const entryType = isConference ? "inproceedings" : "article";
  const key = bibtexKey(data);

  const lines: string[] = [`@${entryType}{${key},`];
  lines.push(`  title = {${escapeBibtex(data.title)}},`);

  if (data.authors.length > 0) {
    lines.push(
      `  author = {${data.authors.map(escapeBibtex).join(" and ")}},`
    );
  }
  if (data.year) {
    lines.push(`  year = {${data.year}},`);
  }
  if (venue) {
    const venueField = isConference ? "booktitle" : "journal";
    lines.push(`  ${venueField} = {${escapeBibtex(venue)}},`);
  }
  if (data.doi) {
    lines.push(`  doi = {${data.doi}},`);
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Format a reference in APA 7th edition style.
 */
export function formatAPA(data: CitationData): string {
  const parts: string[] = [];

  // Authors
  if (data.authors.length > 0) {
    const formatted = data.authors.map((name) => {
      const parts = name.trim().split(/\s+/);
      if (parts.length === 1) return parts[0];
      const lastName = parts.pop()!;
      const initials = parts.map((p) => `${p[0]}.`).join(" ");
      return `${lastName}, ${initials}`;
    });

    if (formatted.length === 1) {
      parts.push(formatted[0]);
    } else if (formatted.length <= 20) {
      const last = formatted.pop()!;
      parts.push(`${formatted.join(", ")}, & ${last}`);
    } else {
      parts.push(`${formatted.slice(0, 19).join(", ")}, ... ${formatted[formatted.length - 1]}`);
    }
  }

  // Year
  parts.push(`(${data.year || "n.d."})`);

  // Title
  parts.push(`${data.title}.`);

  // Venue
  if (data.venue) {
    parts.push(`*${data.venue}*.`);
  }

  // DOI
  if (data.doi) {
    parts.push(`https://doi.org/${data.doi}`);
  }

  return parts.join(" ");
}
