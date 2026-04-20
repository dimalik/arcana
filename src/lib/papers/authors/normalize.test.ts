import { describe, expect, it } from "vitest";

import {
  canonicalizeAuthorName,
  normalizeAuthorList,
  normalizeAuthorName,
  parsePaperAuthorsJson,
  serializePaperAuthors,
} from "./normalize";

describe("paper author normalization", () => {
  it("normalizes names into stable lexical buckets", () => {
    expect(normalizeAuthorName("  Geoffrey   Hínton ")).toBe("geoffrey hinton");
    expect(normalizeAuthorName("Geoffrey-Hinton")).toBe("geoffrey hinton");
  });

  it("parses and serializes author arrays deterministically", () => {
    expect(parsePaperAuthorsJson('[" Geoffrey Hinton ","Yann LeCun"]')).toEqual([
      "Geoffrey Hinton",
      "Yann LeCun",
    ]);
    expect(
      serializePaperAuthors([" Geoffrey Hinton ", "Geoffrey-Hinton", "Yann LeCun"]),
    ).toBe('["Geoffrey Hinton","Yann LeCun"]');
  });

  it("drops empty or malformed author inputs", () => {
    expect(parsePaperAuthorsJson("not-json")).toEqual([]);
    expect(normalizeAuthorList(["", "   ", "Jürgen Schmidhuber"])).toEqual([
      "Jürgen Schmidhuber",
    ]);
    expect(canonicalizeAuthorName("  Fei-Fei   Li  ")).toBe("Fei-Fei Li");
  });
});
