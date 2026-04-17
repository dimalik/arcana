import { createHash } from "crypto";
import { Prisma } from "@prisma/client";

export const FIGURE_SOURCE_CAPABILITY_EVALUATOR_VERSION = "figure-source-capability-evaluator-v1";
export const FIGURE_CAPABILITY_SNAPSHOT_VERSION = "figure-capability-snapshot-v1";

const STRUCTURED_FIGURE_SOURCES = ["pmc_jats", "arxiv_html", "publisher_html"] as const;

type FigureCapabilityTx = Prisma.TransactionClient;
type StructuredFigureSource = (typeof STRUCTURED_FIGURE_SOURCES)[number];

interface PaperCapabilityInput {
  id: string;
  doi: string | null;
  arxivId: string | null;
  sourceUrl: string | null;
}

interface EvaluatedSourceCapability {
  source: StructuredFigureSource;
  status: string;
  reasonCode: string;
  inputsHash: string;
}

interface PersistedSourceCapability extends EvaluatedSourceCapability {
  id: string;
}

export interface CapabilitySnapshotContext {
  capabilitySnapshotId: string;
  coverageClass: string;
  entries: Array<{
    source: StructuredFigureSource;
    status: string;
    reasonCode: string;
    sourceCapabilityEvaluationId: string;
  }>;
}

function buildCapabilityInputsHash(paper: PaperCapabilityInput): string {
  return createHash("sha1")
    .update(JSON.stringify({
      doi: paper.doi ?? null,
      arxivId: paper.arxivId ?? null,
      sourceUrl: paper.sourceUrl ?? null,
    }))
    .digest("hex");
}

function evaluateSourceCapability(
  source: StructuredFigureSource,
  paper: PaperCapabilityInput,
): EvaluatedSourceCapability {
  const inputsHash = buildCapabilityInputsHash(paper);

  if (source === "arxiv_html") {
    return {
      source,
      status: paper.arxivId ? "usable" : "unusable",
      reasonCode: paper.arxivId ? "arxiv_id_present" : "missing_arxiv_id",
      inputsHash,
    };
  }

  const hasDoi = !!paper.doi;
  return {
    source,
    status: hasDoi ? "usable" : "unusable",
    reasonCode: hasDoi ? "doi_present" : "missing_doi",
    inputsHash,
  };
}

function derivePaperCoverageClass(
  evaluations: Pick<EvaluatedSourceCapability, "source" | "status">[],
): string {
  const statusBySource = new Map(
    evaluations.map((evaluation) => [evaluation.source, evaluation.status]),
  );
  const pmcUsable = statusBySource.get("pmc_jats") === "usable";
  const arxivUsable = statusBySource.get("arxiv_html") === "usable";
  const publisherUsable = statusBySource.get("publisher_html") === "usable";

  if (pmcUsable && arxivUsable) return "both";
  if (pmcUsable) return "pmc_usable";
  if (arxivUsable) return "arxiv_usable";
  if (publisherUsable) return "publisher_html_usable";
  return "structured_none";
}

function buildSnapshotInputsHash(
  coverageClass: string,
  evaluations: PersistedSourceCapability[],
): string {
  return createHash("sha1")
    .update(JSON.stringify({
      coverageClass,
      evaluations: evaluations.map((evaluation) => ({
        id: evaluation.id,
        source: evaluation.source,
        status: evaluation.status,
        reasonCode: evaluation.reasonCode,
        inputsHash: evaluation.inputsHash,
      })),
    }))
    .digest("hex");
}

async function upsertCurrentSourceCapabilityEvaluation(
  tx: FigureCapabilityTx,
  paperId: string,
  evaluation: EvaluatedSourceCapability,
): Promise<PersistedSourceCapability> {
  const latest = await tx.sourceCapabilityEvaluation.findFirst({
    where: {
      paperId,
      source: evaluation.source,
    },
    orderBy: [{ checkedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      source: true,
      status: true,
      reasonCode: true,
      evaluatorVersion: true,
      inputsHash: true,
    },
  });

  if (
    latest
    && latest.status === evaluation.status
    && latest.reasonCode === evaluation.reasonCode
    && latest.evaluatorVersion === FIGURE_SOURCE_CAPABILITY_EVALUATOR_VERSION
    && latest.inputsHash === evaluation.inputsHash
  ) {
    return {
      id: latest.id,
      source: latest.source as StructuredFigureSource,
      status: latest.status,
      reasonCode: latest.reasonCode,
      inputsHash: latest.inputsHash,
    };
  }

  const created = await tx.sourceCapabilityEvaluation.create({
    data: {
      paperId,
      source: evaluation.source,
      status: evaluation.status,
      reasonCode: evaluation.reasonCode,
      checkedAt: new Date(),
      evaluatorVersion: FIGURE_SOURCE_CAPABILITY_EVALUATOR_VERSION,
      inputsHash: evaluation.inputsHash,
    },
    select: {
      id: true,
      source: true,
      status: true,
      reasonCode: true,
      inputsHash: true,
    },
  });

  return {
    id: created.id,
    source: created.source as StructuredFigureSource,
    status: created.status,
    reasonCode: created.reasonCode,
    inputsHash: created.inputsHash,
  };
}

async function refreshSourceCapabilities(
  tx: FigureCapabilityTx,
  paper: PaperCapabilityInput,
): Promise<{
  evaluations: PersistedSourceCapability[];
  coverageClass: string;
}> {
  const evaluated = STRUCTURED_FIGURE_SOURCES.map((source) => evaluateSourceCapability(source, paper));
  const persisted: PersistedSourceCapability[] = [];

  for (const evaluation of evaluated) {
    persisted.push(await upsertCurrentSourceCapabilityEvaluation(tx, paper.id, evaluation));
  }

  return {
    evaluations: persisted,
    coverageClass: derivePaperCoverageClass(persisted),
  };
}

async function createCapabilitySnapshot(
  tx: FigureCapabilityTx,
  paperId: string,
  evaluations: PersistedSourceCapability[],
  coverageClass: string,
): Promise<CapabilitySnapshotContext> {
  const snapshot = await tx.capabilitySnapshot.create({
    data: {
      paperId,
      snapshotVersion: FIGURE_CAPABILITY_SNAPSHOT_VERSION,
      coverageClass,
      inputsHash: buildSnapshotInputsHash(coverageClass, evaluations),
    },
    select: { id: true },
  });

  if (evaluations.length > 0) {
    await tx.capabilitySnapshotEntry.createMany({
      data: evaluations.map((evaluation) => ({
        capabilitySnapshotId: snapshot.id,
        source: evaluation.source,
        sourceCapabilityEvaluationId: evaluation.id,
        status: evaluation.status,
        reasonCode: evaluation.reasonCode,
      })),
    });
  }

  return {
    capabilitySnapshotId: snapshot.id,
    coverageClass,
    entries: evaluations.map((evaluation) => ({
      source: evaluation.source,
      status: evaluation.status,
      reasonCode: evaluation.reasonCode,
      sourceCapabilityEvaluationId: evaluation.id,
    })),
  };
}

export async function prepareCapabilitySnapshotForExtraction(
  tx: FigureCapabilityTx,
  paper: PaperCapabilityInput,
): Promise<CapabilitySnapshotContext> {
  const { evaluations, coverageClass } = await refreshSourceCapabilities(tx, paper);
  return createCapabilitySnapshot(tx, paper.id, evaluations, coverageClass);
}

export const capabilitySubstrateInternals = {
  buildCapabilityInputsHash,
  evaluateSourceCapability,
  derivePaperCoverageClass,
  buildSnapshotInputsHash,
};
