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
  grobid_tei: 4,
  pdf_embedded: 5,
  pdf_render_crop: 6,
  pdf_structural: 7,
  vision_llm: 8,
  html_download: 9, // legacy
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
  /** Transient: what happened at crop time. Consumed by merger, not persisted. */
  cropOutcome?: "success" | "rejected" | "failed" | null;
  /** Product-facing: why canonical row has no image. Set by merger only. */
  gapReason?: string | null;
  /** Provenance of imagePath. Null iff imagePath is null. Set by merger. */
  imageSourceMethod?: string | null;
}

export interface MergedFigure extends MergeableFigure {
  isPrimaryExtraction: boolean;
}

export interface IdentityMergeResult {
  canonical: MergedFigure | null;
  alternates: MergedFigure[];
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

function selectCanonicalMember(members: AnnotatedFigure[], isTable: boolean): AnnotatedFigure {
  if (isTable) {
    return members.find((member) => member.description && member.description.length > 100)
      || members.find((member) => member.normalizedLabel || member.captionText)
      || members.find((member) => member.imagePath)
      || members[0];
  }

  return members.find((member) => member.normalizedLabel || member.captionText)
    || members.find((member) => member.imagePath)
    || members[0];
}

function buildAlternate(member: AnnotatedFigure): MergedFigure {
  return {
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
    gapReason: null,
    imageSourceMethod: member.imagePath ? member.sourceMethod : null,
    isPrimaryExtraction: false,
  };
}

export function mergeIdentityMembers(membersInput: MergeableFigure[]): IdentityMergeResult {
  const members: AnnotatedFigure[] = membersInput
    .map((member) => ({
      ...member,
      priority: getPriority(member.sourceMethod),
      normalizedLabel: normalizeLabel(member.figureLabel),
    }))
    .sort((a, b) => a.priority - b.priority);

  if (members.length === 0) {
    return { canonical: null, alternates: [] };
  }

  const isTable = members.some(m => m.type === "table");
  const isUnlabeledPdfOnlyGroup = members.every(
    (m) => !m.normalizedLabel
      && (m.sourceMethod === "pdf_embedded"
        || m.sourceMethod === "grobid_tei"
        || m.sourceMethod === "pdf_render_crop"
        || m.sourceMethod === "pdf_structural"),
  );

  if (isUnlabeledPdfOnlyGroup) {
    return {
      canonical: null,
      alternates: members.map(buildAlternate),
    };
  }

  const canonicalMember = selectCanonicalMember(members, isTable);

  const bestCaptionMember = members.find(m => m.captionText);
  const finalDescription = canonicalMember.description ?? members.find(m => m.description)?.description ?? null;
  const isStructuredTable = isTable
    && finalDescription != null
    && finalDescription.length > 100;

  let bestImageMember: AnnotatedFigure | null = null;
  if (canonicalMember.imagePath) {
    bestImageMember = canonicalMember;
  } else if (!isStructuredTable) {
    bestImageMember = members.find(m => m.imagePath) || null;
  } else {
    const unsafeSources = new Set(["grobid_tei", "pdf_embedded", "pdf_render_crop", "pdf_structural"]);
    bestImageMember = members.find(m => m.imagePath && !unsafeSources.has(m.sourceMethod)) || null;
  }

  const finalImagePath = bestImageMember?.imagePath ?? null;
  const imageSourceMethod = finalImagePath
    ? (bestImageMember === canonicalMember
      ? canonicalMember.sourceMethod
      : bestImageMember!.sourceMethod)
    : null;

  let gapReason: string | null = null;
  if (!finalImagePath) {
    if (isStructuredTable) {
      gapReason = "structured_content_no_preview";
    } else {
      const cropMember = members.find(m => m.cropOutcome === "failed" || m.cropOutcome === "rejected");
      if (cropMember?.cropOutcome === "failed") {
        gapReason = "crop_failed";
      } else if (cropMember?.cropOutcome === "rejected") {
        gapReason = "crop_rejected";
      } else {
        gapReason = "no_image_candidate";
      }
    }
  }

  const canonical: MergedFigure = {
    sourceMethod: canonicalMember.sourceMethod,
    figureLabel: canonicalMember.figureLabel,
    sourceUrl: canonicalMember.sourceUrl,
    confidence: canonicalMember.confidence,
    bbox: canonicalMember.bbox,
    type: canonicalMember.type,
    pdfPage: canonicalMember.pdfPage ?? members.find(m => m.pdfPage != null)?.pdfPage ?? null,
    imagePath: finalImagePath,
    assetHash: bestImageMember?.assetHash ?? null,
    width: bestImageMember?.width ?? null,
    height: bestImageMember?.height ?? null,
    captionText: bestCaptionMember?.captionText ?? null,
    captionSource: bestCaptionMember?.captionSource ?? canonicalMember.captionSource,
    description: finalDescription,
    gapReason,
    imageSourceMethod,
    isPrimaryExtraction: true,
  };

  return {
    canonical,
    alternates: members
      .filter((member) => member !== canonicalMember)
      .map(buildAlternate),
  };
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
    const result = mergeIdentityMembers(group.members);
    if (result.canonical) {
      output.push(result.canonical);
    }
    output.push(...result.alternates);
  });

  return output;
}
