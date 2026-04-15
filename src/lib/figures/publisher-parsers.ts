/**
 * Publisher-specific HTML figure parsers.
 *
 * Each parser extracts <figure> elements with captions from a known DOM structure.
 * Publishers not on this allowlist fall through to the generic HTML parser
 * in figure-downloader.ts.
 *
 * sourceMethod: "publisher_html", confidence: "medium"
 */

export interface PublisherFigure {
  imgUrl: string;
  caption: string;
  figureLabel: string | null;
  type: "figure" | "table";
}

interface PublisherParser {
  name: string;
  /** Test if this parser applies to the given URL */
  matches: (url: string) => boolean;
  /** Extract figures from HTML. baseUrl is the resolved page URL for relative src resolution */
  parse: (html: string, baseUrl: string) => PublisherFigure[];
}

function resolveUrl(src: string, baseUrl: string): string | null {
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return null;
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

function parseFigureLabel(text: string): string | null {
  const m = text.match(/^((?:Figure|Fig\.?|Table)\s+\d+[a-z]?)/i);
  return m ? m[1] : null;
}

// ── PLoS ────────────────────────────────────────────────────────────

const plosParser: PublisherParser = {
  name: "PLoS",
  matches: (url) => /journals\.plos\.org/i.test(url),
  parse: (html, baseUrl) => {
    const figures: PublisherFigure[] = [];
    // PLoS uses <div class="figure-wrap"> or <figure> with <figcaption>
    const figRegex = /<figure[^>]*>([\s\S]*?)<\/figure>/gi;
    let m: RegExpExecArray | null;
    while ((m = figRegex.exec(html)) !== null) {
      const block = m[1];
      const imgSrc = block.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
      if (!imgSrc) continue;
      const resolved = resolveUrl(imgSrc, baseUrl);
      if (!resolved) continue;

      const caption = block.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1];
      const captionText = caption ? stripTags(caption).slice(0, 500) : "";
      const label = parseFigureLabel(captionText);
      const type = /^table\s/i.test(captionText) ? "table" as const : "figure" as const;

      figures.push({ imgUrl: resolved, caption: captionText, figureLabel: label, type });
    }
    return figures;
  },
};

// ── Nature ──────────────────────────────────────────────────────────

const natureParser: PublisherParser = {
  name: "Nature",
  matches: (url) => /nature\.com/i.test(url),
  parse: (html, baseUrl) => {
    const figures: PublisherFigure[] = [];
    // Nature uses <figure> with data-test="figure" or class containing "c-article-figure"
    const figRegex = /<figure[^>]*>([\s\S]*?)<\/figure>/gi;
    let m: RegExpExecArray | null;
    while ((m = figRegex.exec(html)) !== null) {
      const block = m[1];
      const imgSrc = block.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
      if (!imgSrc) continue;
      const resolved = resolveUrl(imgSrc, baseUrl);
      if (!resolved) continue;

      // Nature wraps caption in <figcaption> or <div class="c-article-figure-description">
      let captionText = "";
      const figcaption = block.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1];
      if (figcaption) {
        captionText = stripTags(figcaption).slice(0, 500);
      } else {
        const descDiv = block.match(/<div[^>]*class="[^"]*figure-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
        if (descDiv) captionText = stripTags(descDiv).slice(0, 500);
      }

      const label = parseFigureLabel(captionText);
      // Nature also uses <b> or <span> for "Fig. N" inside figcaption
      const type = /^table\s/i.test(captionText) ? "table" as const : "figure" as const;

      figures.push({ imgUrl: resolved, caption: captionText, figureLabel: label, type });
    }
    return figures;
  },
};

// ── MDPI ────────────────────────────────────────────────────────────

const mdpiParser: PublisherParser = {
  name: "MDPI",
  matches: (url) => /mdpi\.com/i.test(url),
  parse: (html, baseUrl) => {
    const figures: PublisherFigure[] = [];
    // MDPI uses <div class="html-fig_wrap"> or <figure class="html-fig">
    const figRegex = /<(?:figure|div)[^>]*class="[^"]*html-fig[^"]*"[^>]*>([\s\S]*?)<\/(?:figure|div)>/gi;
    let m: RegExpExecArray | null;
    while ((m = figRegex.exec(html)) !== null) {
      const block = m[1];
      const imgSrc = block.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
      if (!imgSrc) continue;
      const resolved = resolveUrl(imgSrc, baseUrl);
      if (!resolved) continue;

      // MDPI captions in <div class="html-fig_description"> or <figcaption>
      let captionText = "";
      const descDiv = block.match(/<div[^>]*class="[^"]*fig_description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
      if (descDiv) {
        captionText = stripTags(descDiv).slice(0, 500);
      } else {
        const figcaption = block.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1];
        if (figcaption) captionText = stripTags(figcaption).slice(0, 500);
      }

      const label = parseFigureLabel(captionText);
      const type = /^table\s/i.test(captionText) ? "table" as const : "figure" as const;

      figures.push({ imgUrl: resolved, caption: captionText, figureLabel: label, type });
    }
    return figures;
  },
};

// ── Science (AAAS) ──────────────────────────────────────────────────

const scienceParser: PublisherParser = {
  name: "Science",
  matches: (url) => /science\.org/i.test(url),
  parse: (html, baseUrl) => {
    const figures: PublisherFigure[] = [];
    // Science uses <figure class="fig"> or similar
    const figRegex = /<figure[^>]*class="[^"]*fig[^"]*"[^>]*>([\s\S]*?)<\/figure>/gi;
    let m: RegExpExecArray | null;
    while ((m = figRegex.exec(html)) !== null) {
      const block = m[1];
      const imgSrc = block.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
      if (!imgSrc) continue;
      const resolved = resolveUrl(imgSrc, baseUrl);
      if (!resolved) continue;

      const captionBlock = block.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] || "";
      const captionText = stripTags(captionBlock).slice(0, 500);
      const label = parseFigureLabel(captionText);
      const type = /^table\s/i.test(captionText) ? "table" as const : "figure" as const;

      figures.push({ imgUrl: resolved, caption: captionText, figureLabel: label, type });
    }
    return figures;
  },
};

// ── Registry ────────────────────────────────────────────────────────

const PUBLISHER_PARSERS: PublisherParser[] = [
  plosParser,
  natureParser,
  mdpiParser,
  scienceParser,
];

/**
 * Find a publisher-specific parser for the given URL.
 * Returns null if no parser matches (fall through to generic).
 */
export function findPublisherParser(url: string): PublisherParser | null {
  return PUBLISHER_PARSERS.find(p => p.matches(url)) || null;
}

/**
 * Extract figures using the appropriate publisher parser.
 * Returns null if no parser matches the URL.
 */
export function extractWithPublisherParser(
  html: string,
  pageUrl: string,
): { publisher: string; figures: PublisherFigure[] } | null {
  const parser = findPublisherParser(pageUrl);
  if (!parser) return null;

  const figures = parser.parse(html, pageUrl);
  return { publisher: parser.name, figures };
}
