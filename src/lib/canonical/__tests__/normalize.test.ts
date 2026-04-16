import { describe, expect, it } from "vitest";
import { normalizeIdentifier, parseArxivId } from "../normalize";

describe("normalizeIdentifier", () => {
  it("normalizes DOI values", () => {
    expect(normalizeIdentifier("doi", "10.1234/ABC.DEF")).toBe("10.1234/abc.def");
    expect(normalizeIdentifier("doi", "https://doi.org/10.1234/abc")).toBe("10.1234/abc");
    expect(normalizeIdentifier("doi", "http://dx.doi.org/10.1234/abc")).toBe("10.1234/abc");
  });

  it("normalizes arXiv identifiers", () => {
    expect(normalizeIdentifier("arxiv", "2301.12345v2")).toBe("2301.12345");
    expect(normalizeIdentifier("arxiv", "https://arxiv.org/abs/2301.12345v1")).toBe("2301.12345");
    expect(normalizeIdentifier("arxiv", "hep-ph/0601001v3")).toBe("hep-ph/0601001");
  });

  it("normalizes OpenAlex identifiers", () => {
    expect(normalizeIdentifier("openalex", "w1234567")).toBe("W1234567");
    expect(normalizeIdentifier("openalex", "https://openalex.org/W1234567")).toBe("W1234567");
  });
});

describe("parseArxivId", () => {
  it("extracts base ID and version", () => {
    expect(parseArxivId("2301.12345v2")).toEqual({ baseId: "2301.12345", version: 2 });
  });

  it("returns null version when no version suffix", () => {
    expect(parseArxivId("2301.12345")).toEqual({ baseId: "2301.12345", version: null });
  });
});
