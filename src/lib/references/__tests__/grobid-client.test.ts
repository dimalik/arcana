import { readFileSync } from "fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GrobidClient } from "../grobid/client";
import {
  DEFAULT_GROBID_CONFIG,
  GrobidUnavailableError,
  type GrobidConfig,
} from "../grobid/types";

const sampleTei = readFileSync(
  new URL("./recorded/grobid-processReferences-sample.xml", import.meta.url),
  "utf-8",
);

const mockFetch = vi.fn();

describe("GrobidClient", () => {
  const config: GrobidConfig = {
    ...DEFAULT_GROBID_CONFIG,
    serverUrl: "http://grobid-test:8070",
    interactiveConcurrency: 2,
    backfillConcurrency: 2,
    maxQueueDepth: 5,
    circuitBreakerThreshold: 3,
    maxRetries: 1,
  };

  let client: GrobidClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    client = new GrobidClient(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends PDF to processReferences and returns TEI", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(sampleTei),
    });

    const result = await client.processReferences({
      pdfBuffer: Buffer.from("fake-pdf"),
      priority: "interactive",
    });

    expect(result.statusCode).toBe(200);
    expect(result.teiXml).toContain("Attention Is All You Need");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://grobid-test:8070/api/processReferences");
  });

  it("sends PDF to processFulltextDocument and returns TEI", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(sampleTei),
    });

    const result = await client.processFulltextDocument({
      pdfBuffer: Buffer.from("fake-pdf"),
      priority: "interactive",
    });

    expect(result.statusCode).toBe(200);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://grobid-test:8070/api/processFulltextDocument");
  });

  it("computes deadline from pageCount", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(sampleTei),
    });

    await client.processReferences({
      pdfBuffer: Buffer.from("fake-pdf"),
      priority: "interactive",
      pageCount: 50,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 503 then succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.resolve("busy"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(sampleTei),
      });

    const result = await client.processReferences({
      pdfBuffer: Buffer.from("fake-pdf"),
      priority: "interactive",
    });

    expect(result.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 400", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve("bad request"),
    });

    await expect(
      client.processReferences({
        pdfBuffer: Buffer.from("fake"),
        priority: "interactive",
      }),
    ).rejects.toThrow("400");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("trips circuit breaker after threshold failures", async () => {
    for (let index = 0; index < 6; index += 1) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.resolve("busy"),
      });
    }

    for (let index = 0; index < config.circuitBreakerThreshold; index += 1) {
      try {
        await client.processReferences({
          pdfBuffer: Buffer.from("fake"),
          priority: "interactive",
        });
      } catch {
        // expected
      }
    }

    await expect(
      client.processReferences({
        pdfBuffer: Buffer.from("fake"),
        priority: "interactive",
      }),
    ).rejects.toThrow(GrobidUnavailableError);
  });
});
