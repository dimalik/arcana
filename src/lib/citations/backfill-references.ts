/**
 * Backfill: migrate legacy Reference rows to ReferenceEntry rows with an explicit
 * dry-run/report mode for tranche cutover readiness.
 *
 * Usage:
 *   npx tsx src/lib/citations/backfill-references.ts --dry-run --out benchmark/references/readiness-report.pre-apply.json
 *   npx tsx src/lib/citations/backfill-references.ts --apply
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

import {
  hydratePaperEntityIfPossible,
  inspectPaperEntityHydration,
} from "../canonical/import-dedup";
import { normalizeIdentifier } from "../canonical/normalize";
import { prisma } from "../prisma";

const DEFAULT_WAIVERS_PATH = resolve(
  process.cwd(),
  "benchmark/references/waivers.json",
);

type CliMode = "dry-run" | "apply";

interface CliOptions {
  mode: CliMode;
  outPath?: string;
  waiversPath: string;
}

export interface OrphanWaiver {
  legacyReferenceId: string;
  reason: string;
  decided_by: string;
  decided_at: string;
}

interface WaiverFile {
  waivers: OrphanWaiver[];
}

interface LegacyReferenceRow {
  id: string;
  paperId: string;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  externalUrl: string | null;
  semanticScholarId: string | null;
  rawCitation: string;
  referenceIndex: number | null;
  matchedPaperId: string | null;
}

interface ReferenceEntryRow {
  id: string;
  paperId: string;
  legacyReferenceId: string | null;
  resolvedEntityId: string | null;
}

interface MatchedPaperRow {
  id: string;
  title: string;
  userId: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  abstract: string | null;
  doi: string | null;
  arxivId: string | null;
  entityId: string | null;
}

interface OrphanLegacyReferenceReportItem {
  legacyReferenceId: string;
  paperId: string;
  title: string;
  referenceIndex: number | null;
  fixStrategy: "create_reference_entry" | "waived";
  waiverReason: string | null;
}

interface UnlinkedReferenceEntryReportItem {
  referenceEntryId: string;
  paperId: string;
  legacyReferenceId: string | null;
}

interface TitleHintResidualReportItem {
  legacyReferenceId: string;
  referenceEntryId: string | null;
  matchedPaperId: string;
  matchedPaperTitle: string | null;
  matchedPaperEntityId: string | null;
  classification: "strong_identifier_promotable" | "audit_bucket";
  matchedBy: "doi" | "arxiv" | "none";
  reason: string;
}

interface TargetPaperHydrationReportItem {
  paperId: string;
  title: string;
  entityId: string | null;
  canHydrate: boolean;
  identifierTypes: string[];
}

export interface ReferenceBackfillReadinessReport {
  generatedAt: string;
  totals: {
    legacyReferenceCount: number;
    linkedLegacyReferenceCount: number;
    orphanLegacyReferenceCount: number;
    unlinkedReferenceEntryCount: number;
    strongIdentifierPromotableResidualCount: number;
    auditBucketResidualCount: number;
    targetPaperHydrationCount: number;
  };
  orphanLegacyReferences: OrphanLegacyReferenceReportItem[];
  unlinkedReferenceEntries: UnlinkedReferenceEntryReportItem[];
  titleHintResiduals: {
    strongIdentifierPromotable: TitleHintResidualReportItem[];
    auditBucketSample: TitleHintResidualReportItem[];
  };
  targetPaperHydrationSet: TargetPaperHydrationReportItem[];
}

const AUDIT_BUCKET_SAMPLE_LIMIT = 100;

interface ApplySummary {
  hydratedTargetPapers: number;
  createdReferenceEntries: number;
  recheckedReferenceEntries: number;
  resolvedReferenceEntries: number;
  promotedResiduals: number;
}

interface ResidualClassificationInput {
  legacyReference: LegacyReferenceRow;
  referenceEntry: ReferenceEntryRow | null;
  matchedPaper: MatchedPaperRow | null;
}

function parseArgs(argv: string[]): CliOptions {
  let mode: CliMode | null = null;
  let outPath: string | undefined;
  let waiversPath = DEFAULT_WAIVERS_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      mode = "dry-run";
      continue;
    }
    if (arg === "--apply") {
      mode = "apply";
      continue;
    }
    if (arg === "--out") {
      outPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--waivers") {
      waiversPath = argv[index + 1] ? resolve(process.cwd(), argv[index + 1]) : waiversPath;
      index += 1;
      continue;
    }
  }

  if (!mode) {
    throw new Error("Pass exactly one mode: --dry-run or --apply");
  }

  if (mode === "dry-run" && !outPath) {
    throw new Error("--dry-run requires --out <path>");
  }

  return {
    mode,
    outPath: outPath ? resolve(process.cwd(), outPath) : undefined,
    waiversPath,
  };
}

function loadWaivers(filePath: string): Map<string, OrphanWaiver> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as WaiverFile;
    return new Map((parsed.waivers ?? []).map((waiver) => [waiver.legacyReferenceId, waiver]));
  } catch {
    return new Map();
  }
}

function writeJson(filePath: string, payload: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n");
}

function sameNormalizedIdentifier(
  type: "doi" | "arxiv",
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return normalizeIdentifier(type, left) === normalizeIdentifier(type, right);
}

export function classifyTitleHintResidual(
  input: ResidualClassificationInput,
): TitleHintResidualReportItem | null {
  const { legacyReference, referenceEntry, matchedPaper } = input;
  if (!legacyReference.matchedPaperId || !matchedPaper) {
    return null;
  }

  const canonicalLocalLinkExists =
    Boolean(referenceEntry?.resolvedEntityId) &&
    Boolean(matchedPaper.entityId) &&
    referenceEntry?.resolvedEntityId === matchedPaper.entityId;

  if (canonicalLocalLinkExists) {
    return null;
  }

  if (sameNormalizedIdentifier("doi", legacyReference.doi, matchedPaper.doi)) {
    return {
      legacyReferenceId: legacyReference.id,
      referenceEntryId: referenceEntry?.id ?? null,
      matchedPaperId: matchedPaper.id,
      matchedPaperTitle: matchedPaper.title,
      matchedPaperEntityId: matchedPaper.entityId,
      classification: "strong_identifier_promotable",
      matchedBy: "doi",
      reason: "legacy reference DOI matches matched paper DOI",
    };
  }

  if (sameNormalizedIdentifier("arxiv", legacyReference.arxivId, matchedPaper.arxivId)) {
    return {
      legacyReferenceId: legacyReference.id,
      referenceEntryId: referenceEntry?.id ?? null,
      matchedPaperId: matchedPaper.id,
      matchedPaperTitle: matchedPaper.title,
      matchedPaperEntityId: matchedPaper.entityId,
      classification: "strong_identifier_promotable",
      matchedBy: "arxiv",
      reason: "legacy reference arXiv ID matches matched paper arXiv ID",
    };
  }

  return {
    legacyReferenceId: legacyReference.id,
    referenceEntryId: referenceEntry?.id ?? null,
    matchedPaperId: matchedPaper.id,
    matchedPaperTitle: matchedPaper.title,
    matchedPaperEntityId: matchedPaper.entityId,
    classification: "audit_bucket",
    matchedBy: "none",
    reason: matchedPaper.entityId
      ? "legacy title hint is not independently corroborated by DOI/arXiv"
      : "matched paper lacks entityId and strong identifier corroboration",
  };
}

async function loadBackfillState() {
  const [legacyReferences, referenceEntries] = await Promise.all([
    prisma.reference.findMany({
      select: {
        id: true,
        paperId: true,
        title: true,
        authors: true,
        year: true,
        venue: true,
        doi: true,
        arxivId: true,
        externalUrl: true,
        semanticScholarId: true,
        rawCitation: true,
        referenceIndex: true,
        matchedPaperId: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.referenceEntry.findMany({
      select: {
        id: true,
        paperId: true,
        legacyReferenceId: true,
        resolvedEntityId: true,
      },
    }),
  ]);

  const matchedPaperIds = Array.from(
    new Set(
      legacyReferences
        .map((reference) => reference.matchedPaperId)
        .filter((paperId): paperId is string => Boolean(paperId)),
    ),
  );

  const matchedPapers = matchedPaperIds.length
    ? await prisma.paper.findMany({
        where: { id: { in: matchedPaperIds } },
        select: {
          id: true,
          title: true,
          userId: true,
          authors: true,
          year: true,
          venue: true,
          abstract: true,
          doi: true,
          arxivId: true,
          entityId: true,
        },
      })
    : [];

  return {
    legacyReferences: legacyReferences as LegacyReferenceRow[],
    referenceEntries: referenceEntries as ReferenceEntryRow[],
    matchedPapers: matchedPapers as MatchedPaperRow[],
  };
}

async function buildReadinessReport(
  waivers: Map<string, OrphanWaiver>,
): Promise<ReferenceBackfillReadinessReport> {
  const { legacyReferences, referenceEntries, matchedPapers } = await loadBackfillState();
  const referenceEntryByLegacyId = new Map<string, ReferenceEntryRow>();
  const legacyReferenceIds = new Set(legacyReferences.map((reference) => reference.id));
  const matchedPaperById = new Map(matchedPapers.map((paper) => [paper.id, paper]));

  for (const entry of referenceEntries) {
    if (entry.legacyReferenceId) {
      referenceEntryByLegacyId.set(entry.legacyReferenceId, entry);
    }
  }

  const orphanLegacyReferences: OrphanLegacyReferenceReportItem[] = [];
  const strongIdentifierPromotable: TitleHintResidualReportItem[] = [];
  const auditBucket: TitleHintResidualReportItem[] = [];
  const targetPaperHydrationSet: TargetPaperHydrationReportItem[] = [];
  const targetPaperHydrationIds = new Set<string>();

  for (const legacyReference of legacyReferences) {
    const referenceEntry = referenceEntryByLegacyId.get(legacyReference.id) ?? null;
    if (!referenceEntry) {
      const waiver = waivers.get(legacyReference.id);
      orphanLegacyReferences.push({
        legacyReferenceId: legacyReference.id,
        paperId: legacyReference.paperId,
        title: legacyReference.title,
        referenceIndex: legacyReference.referenceIndex,
        fixStrategy: waiver ? "waived" : "create_reference_entry",
        waiverReason: waiver?.reason ?? null,
      });
    }

    const matchedPaper = legacyReference.matchedPaperId
      ? matchedPaperById.get(legacyReference.matchedPaperId) ?? null
      : null;
    const residual = classifyTitleHintResidual({
      legacyReference,
      referenceEntry,
      matchedPaper,
    });
    if (!residual) continue;

    if (!matchedPaper?.entityId && matchedPaper && !targetPaperHydrationIds.has(matchedPaper.id)) {
      targetPaperHydrationIds.add(matchedPaper.id);
      const inspection = await inspectPaperEntityHydration(matchedPaper.id);
      if (inspection) {
        targetPaperHydrationSet.push({
          paperId: inspection.paperId,
          title: inspection.title,
          entityId: inspection.entityId,
          canHydrate: inspection.canHydrate,
          identifierTypes: inspection.identifierTypes,
        });
      }
    }

    if (residual.classification === "strong_identifier_promotable") {
      strongIdentifierPromotable.push(residual);
    } else {
      auditBucket.push(residual);
    }
  }

  const unlinkedReferenceEntries = referenceEntries
    .filter(
      (entry) => !entry.legacyReferenceId || !legacyReferenceIds.has(entry.legacyReferenceId),
    )
    .map<UnlinkedReferenceEntryReportItem>((entry) => ({
      referenceEntryId: entry.id,
      paperId: entry.paperId,
      legacyReferenceId: entry.legacyReferenceId,
    }));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      legacyReferenceCount: legacyReferences.length,
      linkedLegacyReferenceCount: legacyReferences.filter((reference) => reference.matchedPaperId)
        .length,
      orphanLegacyReferenceCount: orphanLegacyReferences.length,
      unlinkedReferenceEntryCount: unlinkedReferenceEntries.length,
      strongIdentifierPromotableResidualCount: strongIdentifierPromotable.length,
      auditBucketResidualCount: auditBucket.length,
      targetPaperHydrationCount: targetPaperHydrationSet.length,
    },
    orphanLegacyReferences,
    unlinkedReferenceEntries,
    titleHintResiduals: {
      strongIdentifierPromotable,
      auditBucketSample: auditBucket.slice(0, AUDIT_BUCKET_SAMPLE_LIMIT),
    },
    targetPaperHydrationSet,
  };
}

function validateWaivers(report: ReferenceBackfillReadinessReport): void {
  const unresolvedOrphans = report.orphanLegacyReferences.filter(
    (orphan) => orphan.fixStrategy !== "create_reference_entry" && !orphan.waiverReason,
  );

  if (unresolvedOrphans.length > 0) {
    throw new Error(
      `Found orphan legacy references without a fix strategy or waiver: ${unresolvedOrphans
        .map((orphan) => orphan.legacyReferenceId)
        .join(", ")}`,
    );
  }
}

async function applyBackfill(
  report: ReferenceBackfillReadinessReport,
): Promise<ApplySummary> {
  const { createReferenceEntry, resolveReferenceEntity } = await import(
    "./reference-entry-service"
  );
  const legacyReferences = await prisma.reference.findMany({
    where: { id: { in: report.orphanLegacyReferences.map((reference) => reference.legacyReferenceId) } },
    select: {
      id: true,
      paperId: true,
      title: true,
      authors: true,
      year: true,
      venue: true,
      doi: true,
      arxivId: true,
      externalUrl: true,
      semanticScholarId: true,
      rawCitation: true,
      referenceIndex: true,
    },
  });
  const legacyReferenceById = new Map(legacyReferences.map((reference) => [reference.id, reference]));

  let hydratedTargetPapers = 0;
  let createdReferenceEntries = 0;
  let recheckedReferenceEntries = 0;
  let resolvedReferenceEntries = 0;
  let promotedResiduals = 0;

  for (const targetPaper of report.targetPaperHydrationSet) {
    const result = await hydratePaperEntityIfPossible(targetPaper.paperId);
    if (result?.status === "hydrated") {
      hydratedTargetPapers += 1;
    }
  }

  for (const orphan of report.orphanLegacyReferences) {
    if (orphan.fixStrategy !== "create_reference_entry") continue;
    const reference = legacyReferenceById.get(orphan.legacyReferenceId);
    if (!reference) continue;

    const entry = await createReferenceEntry({
      paperId: reference.paperId,
      title: reference.title,
      rawCitation: reference.rawCitation,
      authors: reference.authors,
      year: reference.year,
      venue: reference.venue,
      doi: reference.doi,
      arxivId: reference.arxivId,
      externalUrl: reference.externalUrl,
      semanticScholarId: reference.semanticScholarId,
      referenceIndex: reference.referenceIndex,
      provenance: "llm_extraction",
      extractorVersion: "backfill_v2",
      legacyReferenceId: reference.id,
    });
    createdReferenceEntries += 1;

    const resolution = await resolveReferenceEntity(entry.id, {
      doi: reference.doi,
      arxivId: reference.arxivId,
      title: reference.title,
      authors: reference.authors,
      year: reference.year,
      venue: reference.venue,
      rawCitation: reference.rawCitation,
    });
    if (resolution.resolvedEntityId) {
      resolvedReferenceEntries += 1;
    }
  }

  const { legacyReferences: refreshedLegacyReferences, referenceEntries } = await loadBackfillState();
  const referenceEntryByLegacyId = new Map<string, ReferenceEntryRow>();
  for (const entry of referenceEntries) {
    if (entry.legacyReferenceId) {
      referenceEntryByLegacyId.set(entry.legacyReferenceId, entry);
    }
  }

  const matchedPaperIds = Array.from(
    new Set(
      refreshedLegacyReferences
        .map((reference) => reference.matchedPaperId)
        .filter((paperId): paperId is string => Boolean(paperId)),
    ),
  );
  const matchedPapers = matchedPaperIds.length
    ? await prisma.paper.findMany({
        where: { id: { in: matchedPaperIds } },
        select: {
          id: true,
          title: true,
          userId: true,
          authors: true,
          year: true,
          venue: true,
          abstract: true,
          doi: true,
          arxivId: true,
          entityId: true,
        },
      })
    : [];
  const matchedPaperById = new Map(matchedPapers.map((paper) => [paper.id, paper as MatchedPaperRow]));

  for (const legacyReference of refreshedLegacyReferences) {
    const referenceEntry = referenceEntryByLegacyId.get(legacyReference.id) ?? null;
    if (!referenceEntry) continue;
    recheckedReferenceEntries += 1;

    const matchedPaper = legacyReference.matchedPaperId
      ? matchedPaperById.get(legacyReference.matchedPaperId) ?? null
      : null;
    const residual = classifyTitleHintResidual({
      legacyReference: legacyReference as LegacyReferenceRow,
      referenceEntry,
      matchedPaper,
    });

    if (
      residual?.classification === "strong_identifier_promotable" &&
      matchedPaper?.entityId &&
      !referenceEntry.resolvedEntityId
    ) {
      await prisma.referenceEntry.update({
        where: { id: referenceEntry.id },
        data: {
          resolvedEntityId: matchedPaper.entityId,
          resolveConfidence: 1,
          resolveSource: "identifier_exact",
        },
      });
      promotedResiduals += 1;
      resolvedReferenceEntries += 1;
    }
  }

  return {
    hydratedTargetPapers,
    createdReferenceEntries,
    recheckedReferenceEntries,
    resolvedReferenceEntries,
    promotedResiduals,
  };
}

export async function runReferenceBackfill(options: CliOptions): Promise<void> {
  const waivers = loadWaivers(options.waiversPath);
  const report = await buildReadinessReport(waivers);
  validateWaivers(report);

  if (options.mode === "dry-run") {
    if (!options.outPath) {
      throw new Error("Dry-run requires --out");
    }
    writeJson(options.outPath, report);
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          outPath: options.outPath,
          totals: report.totals,
        },
        null,
        2,
      ),
    );
    return;
  }

  const summary = await applyBackfill(report);
  console.log(JSON.stringify({ mode: "apply", ...summary }, null, 2));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runReferenceBackfill(options);
}

const isDirectInvocation = Boolean(process.argv[1]?.endsWith("backfill-references.ts"));

if (isDirectInvocation) {
  main()
    .catch((error) => {
      console.error("[backfill] Fatal:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
