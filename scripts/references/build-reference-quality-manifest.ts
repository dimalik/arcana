import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

import { prisma } from "../../src/lib/prisma";
import { searchByTitle, type S2Result, type SearchSource } from "../../src/lib/import/semantic-scholar";
import { titleSimilarity } from "../../src/lib/references/match";
import { collectReferenceQualityAudit } from "../../src/lib/references/reference-quality-audit";
import { candidateAuthorsPassTrustCheck } from "../../src/lib/references/reference-quality";
import {
  buildManifestRowId,
  decisionToJsonl,
  type CitationContextDecision,
  type ReferenceMetadataDecision,
  type ReferenceMetadataFieldActions,
} from "../../src/lib/references/reference-quality-manifest";

function parseArgs(argv: string[]): {
  outPath: string;
  offline: boolean;
} {
  let outPath: string | null = null;
  let offline = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      outPath = argv[index + 1] ? resolve(process.cwd(), argv[index + 1]) : null;
      index += 1;
      continue;
    }
    if (arg === "--offline") {
      offline = true;
    }
  }

  if (!outPath) {
    throw new Error(
      "Usage: node --import tsx scripts/references/build-reference-quality-manifest.ts --out <path> [--offline]",
    );
  }

  return { outPath, offline };
}

function inferCandidateSource(
  candidate: (Omit<S2Result, "source"> & { source?: SearchSource | "arxiv" }) | null,
): SearchSource | "arxiv" | "none" {
  if (!candidate) return "none";
  if (candidate.source) return candidate.source;
  if (candidate.semanticScholarId.startsWith("https://openalex.org/")) return "openalex";
  if (candidate.semanticScholarId.startsWith("s2:")) return "s2";
  if (candidate.semanticScholarId.startsWith("crossref:")) return "crossref";
  return "none";
}

async function resolveCandidate(
  title: string,
  year: number | null | undefined,
  offline: boolean,
): Promise<(Omit<S2Result, "source"> & { source?: SearchSource | "arxiv" }) | null> {
  if (offline || !title) return null;
  return searchByTitle(title, year ?? null);
}

function normalizedContextNeedsReview(
  beforeValue: string | null,
  normalizedValue: string | null,
): boolean {
  const before = (beforeValue ?? "").trim();
  const normalized = (normalizedValue ?? "").trim();
  if (!before || !normalized) return false;

  return (
    /^\[[^\]]+\]\s+(demonstrates?|shows?|explores?|describes?|introduces?|presents?)/i.test(before)
    || /\bas explored by \[[^\]]+\]/i.test(before)
    || /^(Similarly|For example|Indeed|Building on this foundation|Emphasizing|The arms race|A significant breakthrough)[^.;]*\b(demonstrates?|shows?|explores?|describes?|introduces?|presents?)\b/i.test(normalized)
    || /\bas explored by\.$/i.test(normalized)
    || /\bby\.$/i.test(normalized)
  );
}

function buildFieldActions(params: {
  pollutedFields: Array<{ field: "title" | "authors" | "venue"; beforeValue: string | null }>;
  candidate: (Omit<S2Result, "source"> & { source?: SearchSource | "arxiv" }) | null;
  queryTitle: string;
  rawCitation: string;
}): {
  fieldActions: ReferenceMetadataFieldActions;
  confidenceScore: number | null;
  confidenceReason: string;
  actionReason: string;
} {
  const fieldActions: ReferenceMetadataFieldActions = {};
  const confidenceScore = params.candidate
    ? titleSimilarity(params.queryTitle, params.candidate.title)
    : null;
  const confidenceReason = params.candidate
    ? `title_similarity:${confidenceScore?.toFixed(3) ?? "0.000"}`
    : "no_candidate";

  for (const pollutedField of params.pollutedFields) {
    switch (pollutedField.field) {
      case "title":
        fieldActions.title =
          params.candidate && (confidenceScore ?? 0) >= 0.7 && params.candidate.title
            ? "replace"
            : "leave";
        break;
      case "authors":
        fieldActions.authors =
          params.candidate
          && (confidenceScore ?? 0) >= 0.7
          && candidateAuthorsPassTrustCheck({
            rawCitation: params.rawCitation,
            title: params.candidate.title || params.queryTitle,
            candidateAuthors: params.candidate.authors,
          })
            ? "replace"
            : "leave";
        break;
      case "venue":
        fieldActions.venue =
          params.candidate && params.candidate.venue
            ? "replace"
            : "suppress";
        break;
    }
  }

  const actionReason = params.candidate
    ? `candidate:${inferCandidateSource(params.candidate)}:${confidenceReason}`
    : "offline_or_unresolved";

  return {
    fieldActions,
    confidenceScore,
    confidenceReason,
    actionReason,
  };
}

async function main() {
  const { outPath, offline } = parseArgs(process.argv.slice(2));
  const audit = await collectReferenceQualityAudit(prisma);
  const metadataRows = audit.metadataRows.filter((row) => row.pollutedFields.length > 0);
  const decisions: Array<ReferenceMetadataDecision | CitationContextDecision> = [];

  for (const row of metadataRows) {
    const referenceEntry = await prisma.referenceEntry.findUnique({
      where: { id: row.referenceEntryId },
      select: { year: true },
    });
    const candidate = await resolveCandidate(
      row.searchQueryTitle,
      referenceEntry?.year ?? null,
      offline,
    );
    const { fieldActions, confidenceScore, confidenceReason, actionReason } = buildFieldActions({
      pollutedFields: row.pollutedFields,
      candidate,
      queryTitle: row.searchQueryTitle,
      rawCitation: row.rawCitation,
    });
    const persistIdentifiers = Object.values(fieldActions).includes("replace");

    decisions.push({
      manifestRowId: buildManifestRowId("reference_metadata", [
        row.paperId,
        row.referenceEntryId,
        "reference_metadata",
      ]),
      kind: "reference_metadata",
      referenceEntryId: row.referenceEntryId,
      legacyReferenceId: row.legacyReferenceId,
      paperId: row.paperId,
      pollutedFields: row.pollutedFields,
      candidate,
      candidateSource: inferCandidateSource(candidate),
      candidateIdentifiers: {
        doi: candidate?.doi ?? null,
        arxivId: candidate?.arxivId ?? null,
        semanticScholarId: candidate?.semanticScholarId ?? null,
        externalUrl: candidate?.externalUrl ?? null,
      },
      confidence: {
        score: confidenceScore,
        reason: confidenceReason,
      },
      fieldActions,
      persistIdentifiers,
      actionReason,
    });
  }

  for (const row of audit.citationContextRows) {
    const degraded = normalizedContextNeedsReview(
      row.beforeValue,
      row.normalizedValue,
    );
    decisions.push({
      manifestRowId: buildManifestRowId("citation_context", [
        row.paperId,
        row.referenceEntryId,
        row.scope,
        row.mentionId ?? row.legacyReferenceId ?? "",
      ]),
      kind: "citation_context",
      referenceEntryId: row.referenceEntryId,
      legacyReferenceId: row.legacyReferenceId,
      paperId: row.paperId,
      scope: row.scope,
      mentionId: row.mentionId,
      beforeValue: row.beforeValue,
      normalizedValue: row.normalizedValue,
      action: row.normalizedValue && !degraded ? "replace_normalized" : "leave",
      actionReason: row.normalizedValue
        ? degraded
          ? "normalized_projection_diff_review_required"
          : "normalized_projection_diff"
        : "no_normalized_projection",
    });
  }

  const jsonl = decisions
    .sort((left, right) => left.manifestRowId.localeCompare(right.manifestRowId))
    .map(decisionToJsonl)
    .join("\n");

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${jsonl}\n`);

  console.log(
    JSON.stringify(
      {
        outPath,
        offline,
        referenceMetadataDecisions: decisions.filter((decision) => decision.kind === "reference_metadata").length,
        citationContextDecisions: decisions.filter((decision) => decision.kind === "citation_context").length,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
