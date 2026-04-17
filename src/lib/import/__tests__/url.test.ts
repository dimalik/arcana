import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithRetryMock } = vi.hoisted(() => ({
  fetchWithRetryMock: vi.fn(),
}));

vi.mock("../semantic-scholar", () => ({
  fetchWithRetry: fetchWithRetryMock,
}));

import { fetchDoiMetadata } from "../url";

describe("fetchDoiMetadata", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    global.fetch = originalFetch;
  });

  it("falls back to DOI landing-page meta tags when provider DOI lookups have blank titles", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "https://openalex.org/W2963341956",
            doi: "https://doi.org/10.18653/v1/n19-1423",
            title: "",
            display_name: "",
            publication_year: 2019,
            authorships: [],
            primary_location: null,
            open_access: null,
            abstract_inverted_index: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: {
              title: [""],
              issued: { "date-parts": [[2019]] },
              "container-title": [
                "Proceedings of the 2019 Conference of the North American Chapter of the Association for Computational Linguistics",
              ],
              author: [{ given: "Jacob", family: "Devlin" }],
            },
          }),
          { status: 200 },
        ),
      );

    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        `
        <html>
          <head>
            <meta name="citation_title" content="BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding" />
            <meta name="citation_author" content="Jacob Devlin" />
            <meta name="citation_author" content="Ming-Wei Chang" />
            <meta name="citation_publication_date" content="2019/06/01" />
            <meta name="citation_journal_title" content="Proceedings of NAACL-HLT 2019" />
            <meta name="citation_doi" content="10.18653/v1/N19-1423" />
            <meta name="citation_pdf_url" content="https://aclanthology.org/N19-1423.pdf" />
            <meta name="citation_abstract" content="BERT abstract" />
          </head>
          <body></body>
        </html>
        `,
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      ),
    );

    const result = await fetchDoiMetadata("10.18653/v1/N19-1423");

    expect(result).toEqual({
      title:
        "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
      abstract: "BERT abstract",
      authors: ["Jacob Devlin", "Ming-Wei Chang"],
      year: 2019,
      venue: "Proceedings of NAACL-HLT 2019",
      doi: "10.18653/v1/N19-1423",
      openAccessPdfUrl: "https://aclanthology.org/N19-1423.pdf",
    });
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://doi.org/10.18653/v1/N19-1423",
      expect.objectContaining({
        headers: expect.any(Object),
        redirect: "follow",
      }),
    );
  });
});
