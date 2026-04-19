import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

import { prisma } from "../../src/lib/prisma";
import { applyReviewedReferenceMetadataDecision } from "../../src/lib/citations/reference-entry-service";
import {
  assertValidManifestDecision,
  parseManifestLine,
  type CitationContextDecision,
  type ReferenceMetadataDecision,
  type ReferenceQualityManifestDecision,
} from "../../src/lib/references/reference-quality-manifest";

function parseArgs(argv: string[]): {
  manifestPath: string;
  outPath?: string;
} {
  let manifestPath: string | null = null;
  let outPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      manifestPath = argv[index + 1] ? resolve(process.cwd(), argv[index + 1]) : null;
      index += 1;
      continue;
    }
    if (arg === "--out") {
      outPath = argv[index + 1] ? resolve(process.cwd(), argv[index + 1]) : undefined;
      index += 1;
    }
  }

  if (!manifestPath) {
    throw new Error(
      "Usage: node --import tsx scripts/references/apply-reference-quality-manifest.ts --manifest <path> [--out <path>]",
    );
  }

  return { manifestPath, outPath };
}

function readManifest(manifestPath: string): ReferenceQualityManifestDecision[] {
  return readFileSync(manifestPath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseManifestLine);
}

async function applyCitationContextDecision(
  decision: CitationContextDecision,
): Promise<"updated_legacy_context" | "verified_projection_only" | "skipped"> {
  if (decision.action === "leave") return "skipped";

  if (decision.scope === "legacy_reference_context") {
    if (!decision.legacyReferenceId || decision.normalizedValue == null) {
      return "skipped";
    }
    await prisma.reference.update({
      where: { id: decision.legacyReferenceId },
      data: { citationContext: decision.normalizedValue },
    });
    return "updated_legacy_context";
  }

  return "verified_projection_only";
}

async function main() {
  const { manifestPath, outPath } = parseArgs(process.argv.slice(2));
  const decisions = readManifest(manifestPath);
  for (const decision of decisions) {
    assertValidManifestDecision(decision);
  }

  const paperIds = [...new Set(decisions.map((decision) => decision.paperId))];
  const papers = await prisma.paper.findMany({
    where: { id: { in: paperIds } },
    select: { id: true, userId: true },
  });
  const userIdByPaperId = new Map(papers.map((paper) => [paper.id, paper.userId]));

  const summary = {
    generatedAt: new Date().toISOString(),
    manifestPath,
    totalDecisions: decisions.length,
    metadataApplied: 0,
    metadataSkipped: 0,
    legacyContextsUpdated: 0,
    mentionProjectionVerified: 0,
    logs: [] as Array<Record<string, unknown>>,
  };

  for (const decision of decisions) {
    if (decision.kind === "reference_metadata") {
      const metadataDecision = decision as ReferenceMetadataDecision;
      const hasMutation = Object.values(metadataDecision.fieldActions).some(
        (action) => action && action !== "leave",
      );
      if (!hasMutation) {
        summary.metadataSkipped += 1;
        summary.logs.push({
          manifestRowId: metadataDecision.manifestRowId,
          kind: metadataDecision.kind,
          outcome: "skipped",
        });
        continue;
      }

      const result = await applyReviewedReferenceMetadataDecision({
        paperId: metadataDecision.paperId,
        referenceId: metadataDecision.referenceEntryId,
        userId: userIdByPaperId.get(metadataDecision.paperId) ?? null,
        candidate: metadataDecision.candidate,
        fieldActions: metadataDecision.fieldActions,
        persistIdentifiers: metadataDecision.persistIdentifiers,
      });

      summary.metadataApplied += 1;
      summary.logs.push({
        manifestRowId: metadataDecision.manifestRowId,
        kind: metadataDecision.kind,
        outcome: result ? "applied" : "missing_reference",
        referenceEntryId: metadataDecision.referenceEntryId,
        linkedPaperId: result?.linkedPaperId ?? null,
        identifiersPersisted: result?.identifiersPersisted ?? false,
        resolutionUpdated: result?.resolutionUpdated ?? false,
      });
      continue;
    }

    const citationDecision = decision as CitationContextDecision;
    const outcome = await applyCitationContextDecision(citationDecision);
    if (outcome === "updated_legacy_context") {
      summary.legacyContextsUpdated += 1;
    } else if (outcome === "verified_projection_only") {
      summary.mentionProjectionVerified += 1;
    }
    summary.logs.push({
      manifestRowId: citationDecision.manifestRowId,
      kind: citationDecision.kind,
      scope: citationDecision.scope,
      outcome,
    });
  }

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
  }

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
