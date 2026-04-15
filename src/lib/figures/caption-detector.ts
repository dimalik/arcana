export interface DetectedCaption {
  label: string;
  type: "figure" | "table";
  captionText: string;
  page: number;
  lineIndex: number;
  /** Y position on the page (0=top, 1=bottom). Set by pipeline from PDF layout data. */
  yRatio: number;
}

const CAPTION_PATTERN = /(?:^|\n)\s*((?:Figure|Fig\.|Table)\s+\d+[a-z]?)\s*[:.—–\-]\s*(.+?)(?=\n|$)/gi;

export function detectCaptions(pageText: string, page: number): DetectedCaption[] {
  const captions: DetectedCaption[] = [];
  let match: RegExpExecArray | null;
  CAPTION_PATTERN.lastIndex = 0;

  while ((match = CAPTION_PATTERN.exec(pageText)) !== null) {
    const label = match[1].trim();
    const restOfCaption = match[2].trim();
    const type = /^(?:Table)/i.test(label) ? "table" as const : "figure" as const;

    captions.push({
      label,
      type,
      captionText: `${label}: ${restOfCaption}`,
      page,
      lineIndex: match.index,
      yRatio: 0, // Set by pipeline from PDF layout data
    });
  }

  return captions;
}
