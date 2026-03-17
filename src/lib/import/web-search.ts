/**
 * DuckDuckGo web search utility — no API key required.
 * Uses POST to html.duckduckgo.com to avoid CAPTCHAs.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchDuckDuckGo(
  query: string,
  maxResults = 8
): Promise<WebSearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://duckduckgo.com/",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];

  const html = await res.text();

  const linkRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex =
    /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const links: RegExpExecArray[] = [];
  const snippets: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) links.push(m);
  while ((m = snippetRegex.exec(html)) !== null) snippets.push(m);

  const results: WebSearchResult[] = [];
  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const rawUrl = links[i][1];
    let actualUrl = rawUrl;
    const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
    if (uddgMatch) actualUrl = decodeURIComponent(uddgMatch[1]);

    const title = links[i][2].replace(/<[^>]+>/g, "").trim();
    const snippet = snippets[i]?.[1]?.replace(/<[^>]+>/g, "").trim() || "";

    if (title && actualUrl) {
      results.push({ title, url: actualUrl, snippet });
    }
  }

  return results;
}
