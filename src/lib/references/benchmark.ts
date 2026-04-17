import { normalizeTitle } from "./match";

export interface ExpectedRef {
  title: string;
  year?: number | null;
  doi?: string | null;
}

export interface ExtractedRef {
  title: string | null;
  year?: number | null;
  doi?: string | null;
}

export interface ScoreResult {
  precision: number;
  recall: number;
  f1: number;
  matched: number;
  missed: number;
  extra: number;
}

export function scoreExtraction(
  expected: ExpectedRef[],
  extracted: ExtractedRef[],
): ScoreResult {
  const matchedExpected = new Set<number>();
  const matchedExtracted = new Set<number>();

  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    if (matchedExpected.has(expectedIndex)) continue;

    const expectedDoi = expected[expectedIndex].doi?.toLowerCase().trim();
    if (!expectedDoi) continue;

    for (
      let extractedIndex = 0;
      extractedIndex < extracted.length;
      extractedIndex += 1
    ) {
      if (matchedExtracted.has(extractedIndex)) continue;

      const extractedDoi = extracted[extractedIndex].doi?.toLowerCase().trim();
      if (extractedDoi === expectedDoi) {
        matchedExpected.add(expectedIndex);
        matchedExtracted.add(extractedIndex);
        break;
      }
    }
  }

  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    if (matchedExpected.has(expectedIndex)) continue;

    const normalizedExpectedTitle = normalizeTitle(expected[expectedIndex].title);
    for (
      let extractedIndex = 0;
      extractedIndex < extracted.length;
      extractedIndex += 1
    ) {
      if (matchedExtracted.has(extractedIndex)) continue;

      const extractedTitle = extracted[extractedIndex].title;
      if (!extractedTitle) continue;

      if (normalizeTitle(extractedTitle) === normalizedExpectedTitle) {
        matchedExpected.add(expectedIndex);
        matchedExtracted.add(extractedIndex);
        break;
      }
    }
  }

  const matched = matchedExpected.size;
  const missed = expected.length - matched;
  const extra = extracted.length - matchedExtracted.size;
  const precision = extracted.length > 0 ? matched / extracted.length : 0;
  const recall = expected.length > 0 ? matched / expected.length : 0;
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1, matched, missed, extra };
}
