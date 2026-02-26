import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

interface UrlContent {
  title: string;
  content: string;
  excerpt: string;
  siteName: string | null;
}

export async function extractUrlContent(url: string): Promise<UrlContent> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; Arcana/1.0; +http://localhost)",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    throw new Error("Could not extract content from URL");
  }

  return {
    title: article.title || "Untitled",
    content: article.textContent || "",
    excerpt: article.excerpt || "",
    siteName: article.siteName || null,
  };
}
