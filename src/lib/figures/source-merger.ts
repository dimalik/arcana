/**
 * Source merge pipeline for figure extraction.
 *
 * After multiple extraction sources run independently, this module
 * merges results by figure identity (figureLabel + assetHash).
 *
 * The canonical row for each identity group is a FIELD-LEVEL merge:
 *   - captionText/captionSource from the highest-priority source that has a caption
 *   - imagePath/assetHash/width/height from the highest-priority source that has an image
 *   - confidence from the highest-priority source overall
 *   - sourceMethod from the source that contributed the image (since that's what the user sees)
 *   - pdfPage from whichever source provides it
 *
 * Non-canonical rows (alternates) are returned with isPrimaryExtraction=false,
 * preserving the raw extraction for audit/debug.
 */

import { normalizeLabel } from "./label-utils";

/** Source priority (lower number = higher priority) */
const SOURCE_PRIORITY: Record<string, number> = {
  pmc_jats: 1,
  arxiv_html: 2,
  publisher_html: 3,
  pdf_embedded: 4,
  pdf_render_crop: 5,
  pdf_structural: 6,
  vision_llm: 7,
  html_download: 8, // legacy
};

export interface MergeableFigure {
  figureLabel: string | null;
  captionText: string | null;
  captionSource: string;
  sourceMethod: string;
  sourceUrl?: string | null;
  confidence: string;
  imagePath: string | null;
  assetHash: string | null;
  pdfPage: number | null;
  bbox: string | null;
  type: string;
  width: number | null;
  height: number | null;
  /** For HTML tables: structured table markup. Stored in PaperFigure.description. */
  description?: string | null;
}

export interface MergedFigure extends MergeableFigure {
  isPrimaryExtraction: boolean;
}

export function getPriority(sourceMethod: string): number {
  return SOURCE_PRIORITY[sourceMethod] ?? 99;
}

interface AnnotatedFigure extends MergeableFigure {
  priority: number;
  normalizedLabel: string | null;
}

interface IdentityGroup {
  /** All member figures, sorted by priority (highest first = lowest number) */
  members: AnnotatedFigure[];
}

/**
 * Merge figures from multiple sources.
 *
 * Returns ALL figures with isPrimaryExtraction set:
 *   - One canonical row per identity group (field-level merge, isPrimaryExtraction=true)
 *   - All alternate source rows (isPrimaryExtraction=false)
 */
export function mergeFigureSources(
  ...sources: MergeableFigure[][]
): MergedFigure[] {
  const all: AnnotatedFigure[] = sources.flat().map(f => ({
    ...f,
    priority: getPriority(f.sourceMethod),
    normalizedLabel: normalizeLabel(f.figureLabel),
  }));

  // Sort by priority (highest priority = lowest number first)
  all.sort((a, b) => a.priority - b.priority);

  // Group by figure identity
  const groups = new Map<string, IdentityGroup>();
  const byHash = new Map<string, string>(); // assetHash → group key

  for (const fig of all) {
    let matchKey: string | null = null;

    if (fig.normalizedLabel && groups.has(fig.normalizedLabel)) {
      matchKey = fig.normalizedLabel;
    }

    if (!matchKey && fig.assetHash && byHash.has(fig.assetHash)) {
      matchKey = byHash.get(fig.assetHash)!;
    }

    if (matchKey) {
      groups.get(matchKey)!.members.push(fig);
      // Register this member's assetHash so later rows with the same
      // image but a different/missing label still dedup into this group.
      if (fig.assetHash && !byHash.has(fig.assetHash)) {
        byHash.set(fig.assetHash, matchKey);
      }
    } else {
      const key = fig.normalizedLabel || fig.assetHash || `unnamed_${groups.size}`;
      groups.set(key, { members: [fig] });
      if (fig.assetHash) {
        byHash.set(fig.assetHash, key);
      }
    }
  }

  // Build output. For each group:
  //   - Pick one raw member as canonical (isPrimaryExtraction=true).
  //   - For FIGURES: prefer member with image > highest priority overall.
  //   - For TABLES: prefer member with structured content (description) >
  //     member with image > highest priority. This ensures the structured
  //     HTML table row wins over a crop screenshot.
  //   - The canonical row keeps its OWN (sourceMethod, figureLabel) as DB key.
  //   - All other members are alternates (isPrimaryExtraction=false, raw fields).
  const output: MergedFigure[] = [];

  groups.forEach((group) => {
    const members = group.members; // sorted by priority (highest first)
    const isTable = members.some(m => m.type === "table");

    // Pick canonical based on type:
    let canonicalMember: AnnotatedFigure;
    if (isTable) {
      // Tables: structured content wins, then image, then highest priority
      canonicalMember =
        members.find(m => m.description && m.description.length > 100) ||
        members.find(m => m.imagePath) ||
        members[0];
    } else {
      // Figures: image wins, then highest priority
      canonicalMember = members.find(m => m.imagePath) || members[0];
    }

    // Best caption: from the highest-priority member that has one
    const bestCaptionMember = members.find(m => m.captionText);

    // For tables whose canonical is a structured-content row (no image),
    // graft the best available image from alternates as a preview.
    const bestImageMember = canonicalMember.imagePath
      ? canonicalMember
      : members.find(m => m.imagePath) || null;

    output.push({
      // Identity + source from canonical member
      sourceMethod: canonicalMember.sourceMethod,
      figureLabel: canonicalMember.figureLabel,
      sourceUrl: canonicalMember.sourceUrl,
      confidence: canonicalMember.confidence,
      bbox: canonicalMember.bbox,
      type: canonicalMember.type,
      pdfPage: canonicalMember.pdfPage ?? members.find(m => m.pdfPage != null)?.pdfPage ?? null,
      // Image: from canonical if it has one, otherwise from best alternate
      imagePath: bestImageMember?.imagePath ?? null,
      assetHash: bestImageMember?.assetHash ?? null,
      width: bestImageMember?.width ?? null,
      height: bestImageMember?.height ?? null,
      // Caption: from highest-priority member that has one
      captionText: bestCaptionMember?.captionText ?? null,
      captionSource: bestCaptionMember?.captionSource ?? canonicalMember.captionSource,
      // Structured content: from canonical or best available
      description: canonicalMember.description ?? members.find(m => m.description)?.description ?? null,
      isPrimaryExtraction: true,
    });

    // Alternates: every other member, raw fields, non-primary
    for (const member of members) {
      if (member === canonicalMember) continue;
      output.push({
        figureLabel: member.figureLabel,
        captionText: member.captionText,
        captionSource: member.captionSource,
        sourceMethod: member.sourceMethod,
        sourceUrl: member.sourceUrl,
        confidence: member.confidence,
        imagePath: member.imagePath,
        assetHash: member.assetHash,
        pdfPage: member.pdfPage,
        bbox: member.bbox,
        type: member.type,
        width: member.width,
        height: member.height,
        description: member.description,
        isPrimaryExtraction: false,
      });
    }
  });

  return output;
}
