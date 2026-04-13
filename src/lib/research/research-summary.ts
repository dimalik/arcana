/**
 * Generates a grounded research summary directly from the claim/lineage graph.
 *
 * The summary compiler is deterministic: the control plane decides which claims
 * qualify as findings, limitations, and open questions. The rendered markdown
 * is therefore an auditable projection of project state rather than free-form
 * agent prose.
 */

import { prisma } from "@/lib/prisma";
import { rename, rm, writeFile } from "fs/promises";
import path from "path";
import { CLAIM_FINDING_TYPES } from "./claim-ledger";
import { getProjectLineage } from "./lineage-audit";

type LineageData = Awaited<ReturnType<typeof getProjectLineage>>;
type LineageTrack = LineageData["tracks"][number];
type LineageClaim = LineageTrack["claims"][number];
type QueueItem = LineageTrack["queue"][number];

export interface GroundedSummaryEvidenceRef {
  kind: string;
  label: string;
  supports: boolean;
  strength: string;
}

export interface GroundedSummaryFinding {
  claimId: string;
  statement: string;
  summary: string | null;
  type: string;
  status: string;
  confidence: string;
  updatedAt: string;
  supportCount: number;
  rebuttalCount: number;
  hasReview: boolean;
  linkedHypothesis: string | null;
  linkedResult: string | null;
  evidence: GroundedSummaryEvidenceRef[];
}

export interface GroundedSummaryLimitation {
  kind: "contested_claim" | "risk_claim" | "coordinator_obligation" | "track_gap";
  text: string;
  blocking: boolean;
  claimId?: string;
  stepId?: string;
}

export interface GroundedResearchSummary {
  generatedAt: string;
  project: {
    id: string;
    title: string;
    question: string | null;
    methodology: string | null;
    currentPhase: string;
  };
  stats: {
    papers: number;
    hypotheses: number;
    rootApproaches: number;
    experimentRuns: number;
    experimentResults: number;
    findings: number;
    contestedClaims: number;
    reproducedClaims: number;
    blockingObligations: number;
  };
  tldr: string;
  introduction: string;
  methods: string;
  currentStatus: string;
  keyFindings: GroundedSummaryFinding[];
  limitations: GroundedSummaryLimitation[];
  openQuestions: string[];
}

export interface ResearchSummaryData {
  short: string;
  full: string;
  structured: GroundedResearchSummary;
}

function parseBriefQuestion(brief: string): string | null {
  try {
    const parsed = JSON.parse(brief) as { question?: string };
    return parsed.question?.trim() || null;
  } catch {
    const trimmed = brief.trim();
    return trimmed || null;
  }
}

function truncate(text: string, max = 180) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function sentence(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function countLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function confidenceRank(value: string) {
  if (value === "STRONG") return 3;
  if (value === "MODERATE") return 2;
  return 1;
}

function statusRank(value: string) {
  if (value === "REPRODUCED") return 3;
  if (value === "SUPPORTED") return 2;
  if (value === "CONTESTED") return 1;
  return 0;
}

function evidenceLabel(claim: LineageClaim, evidence: LineageClaim["evidence"][number]): string {
  if (evidence.result?.scriptName) {
    const verdict = claim.result?.verdict ? ` (${claim.result.verdict})` : "";
    return `Result: ${evidence.result.scriptName}${verdict}`;
  }
  if (evidence.paper?.title) return `Paper: ${evidence.paper.title}`;
  if (evidence.artifact?.filename) return `Artifact: ${evidence.artifact.filename}`;
  if (evidence.task?.role) return `Task: ${evidence.task.role} (${evidence.task.status.toLowerCase()})`;
  if (evidence.remoteJob?.command) return `Job: ${truncate(evidence.remoteJob.command, 72)}`;
  if (evidence.logEntry?.content) return `Log: ${truncate(evidence.logEntry.content, 72)}`;
  if (evidence.hypothesisId && claim.hypothesis?.statement) return `Hypothesis: ${truncate(claim.hypothesis.statement, 72)}`;
  return evidence.kind;
}

function summarizeEvidenceRefs(claim: LineageClaim): GroundedSummaryEvidenceRef[] {
  return claim.evidence
    .slice()
    .sort((left, right) => {
      if (left.supports !== right.supports) return left.supports ? -1 : 1;
      return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    })
    .slice(0, 5)
    .map((evidence) => ({
      kind: evidence.kind,
      label: evidenceLabel(claim, evidence),
      supports: evidence.supports,
      strength: evidence.strength,
    }));
}

function isFindingClaim(claim: LineageClaim) {
  return ["SUPPORTED", "REPRODUCED"].includes(claim.status)
    && CLAIM_FINDING_TYPES.includes(claim.type as typeof CLAIM_FINDING_TYPES[number]);
}

function findingScore(claim: LineageClaim) {
  const supportCount = claim.evidence.filter((evidence) => evidence.supports).length;
  const rebuttalCount = claim.evidence.filter((evidence) => !evidence.supports).length;
  const directExperimentSupport = claim.evidence.some((evidence) =>
    evidence.kind === "experiment_result" && evidence.supports,
  ) ? 1 : 0;
  return (
    statusRank(claim.status) * 100
    + confidenceRank(claim.confidence) * 20
    + supportCount * 4
    + directExperimentSupport * 8
    + (claim.hasReview ? 3 : 0)
    - rebuttalCount * 5
  );
}

function uniqueClaims(tracks: LineageTrack[]): LineageClaim[] {
  const byId = new Map<string, LineageClaim>();
  for (const track of tracks) {
    for (const claim of track.claims) {
      if (!byId.has(claim.id)) byId.set(claim.id, claim);
    }
  }
  return Array.from(byId.values());
}

function uniqueQueue(tracks: LineageTrack[]): QueueItem[] {
  const byId = new Map<string, QueueItem>();
  for (const track of tracks) {
    for (const item of track.queue) {
      if (!byId.has(item.stepId)) byId.set(item.stepId, item);
    }
  }
  return Array.from(byId.values());
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value.trim());
  }
  return result;
}

function buildIntroduction(params: {
  title: string;
  question: string | null;
  methodology: string | null;
  stats: GroundedResearchSummary["stats"];
  samplePapers: string[];
}) {
  const { title, question, methodology, stats, samplePapers } = params;
  const first = question
    ? `This project investigates: ${question}`
    : `${title} is being tracked as a ${methodology || "research"} project.`;
  const second = [
    methodology ? `Methodology: ${methodology}` : null,
    countLabel(stats.papers, "paper"),
    countLabel(stats.hypotheses, "hypothesis"),
    countLabel(stats.experimentResults, "experiment result"),
  ].filter(Boolean).join(", ");

  const paperSentence = samplePapers.length > 0
    ? `Representative source set: ${samplePapers.map((paper) => truncate(paper, 72)).join("; ")}.`
    : "";

  return [sentence(first), sentence(second), paperSentence].filter(Boolean).join(" ");
}

function buildMethods(stats: GroundedResearchSummary["stats"], approachNames: string[]) {
  const parts = [
    `The current audit graph covers ${countLabel(stats.experimentRuns, "experiment run")} and ${countLabel(stats.experimentResults, "imported result")}.`,
    `Research structure includes ${countLabel(stats.hypotheses, "hypothesis")} across ${countLabel(stats.rootApproaches, "top-level approach")}.`,
  ];
  if (approachNames.length > 0) {
    parts.push(`Tracked approaches: ${approachNames.map((name) => truncate(name, 56)).join("; ")}.`);
  }
  parts.push("Final findings are compiled only from SUPPORTED or REPRODUCED claims, while contested and risk material is kept in limitations/open questions.");
  return parts.join(" ");
}

function buildCurrentStatus(params: {
  phase: string;
  findings: number;
  contestedClaims: number;
  reproducedClaims: number;
  blockingObligations: number;
}) {
  const { phase, findings, contestedClaims, reproducedClaims, blockingObligations } = params;
  const clauses = [
    `Current phase: ${phase}.`,
    `${countLabel(findings, "grounded finding")} and ${countLabel(reproducedClaims, "reproduced claim")} are currently in the ledger.`,
  ];
  if (contestedClaims > 0) {
    clauses.push(`${countLabel(contestedClaims, "contested claim")} still require resolution.`);
  }
  if (blockingObligations > 0) {
    clauses.push(`${countLabel(blockingObligations, "blocking coordinator obligation")} remain open before the project can advance cleanly.`);
  } else {
    clauses.push("No blocking credibility obligations are currently open.");
  }
  return clauses.join(" ");
}

function buildTldr(question: string | null, topFinding: GroundedSummaryFinding | null, currentStatus: string) {
  if (!topFinding) {
    const prefix = question ? `${question} ` : "";
    return truncate(`${prefix}${currentStatus}`, 280);
  }
  const evidence = topFinding.evidence[0]?.label || `${topFinding.supportCount} supporting evidence row(s)`;
  return truncate(
    `${question ? `${question} ` : ""}Strongest grounded conclusion: ${topFinding.statement} (${topFinding.status.toLowerCase()}, ${topFinding.confidence.toLowerCase()}; evidence: ${evidence}).`,
    280,
  );
}

function formatMarkdown(summary: GroundedResearchSummary): string {
  const sections: string[] = [];

  sections.push("# Research Summary");
  sections.push(`\n> ${summary.tldr}`);
  sections.push(`\n## Introduction\n${summary.introduction}`);

  if (summary.keyFindings.length > 0) {
    const findings = summary.keyFindings.map((finding, index) => {
      const evidence = finding.evidence.map((item) =>
        `${item.supports ? "support" : "rebuttal"}: ${item.label}`,
      ).join("; ");
      const metadata = [
        `status: ${finding.status.toLowerCase()}`,
        `confidence: ${finding.confidence.toLowerCase()}`,
        finding.linkedResult ? `result: ${finding.linkedResult}` : null,
        finding.linkedHypothesis ? `hypothesis: ${truncate(finding.linkedHypothesis, 96)}` : null,
      ].filter(Boolean).join(" | ");
      const summaryLine = finding.summary ? `\n   Note: ${finding.summary}` : "";
      return `${index + 1}. **${finding.statement}**\n   ${metadata}\n   Evidence: ${evidence || "no attached evidence"}${summaryLine}`;
    });
    sections.push(`\n## Key Findings\n${findings.join("\n")}`);
  } else {
    sections.push("\n## Key Findings\nNo supported or reproduced findings have been promoted into the ledger yet.");
  }

  sections.push(`\n## Methods\n${summary.methods}`);

  if (summary.limitations.length > 0) {
    const limitations = summary.limitations.map((item) => {
      const prefix = item.kind === "coordinator_obligation"
        ? "blocking"
        : item.kind === "contested_claim"
          ? "contested"
          : item.kind === "risk_claim"
            ? "risk"
            : "gap";
      return `- [${prefix}] ${item.text}`;
    });
    sections.push(`\n## Limitations\n${limitations.join("\n")}`);
  }

  if (summary.openQuestions.length > 0) {
    const questions = summary.openQuestions.map((question) => `- ${question}`);
    sections.push(`\n## Open Questions\n${questions.join("\n")}`);
  }

  sections.push(`\n## Status\n${summary.currentStatus}`);
  sections.push(
    `\n---\n*Grounded from ${countLabel(summary.stats.experimentResults, "experiment result")}, ${countLabel(summary.stats.findings, "finding")}, and ${countLabel(summary.stats.blockingObligations, "blocking obligation")}. Generated ${summary.generatedAt.replace("T", " ").slice(0, 16)}.*`,
  );

  return sections.join("\n");
}

export async function compileResearchSummary(projectId: string): Promise<ResearchSummaryData> {
  const [project, lineage] = await Promise.all([
    prisma.researchProject.findUnique({
      where: { id: projectId },
      include: {
        hypotheses: { select: { id: true } },
        approaches: {
          where: { parentId: null },
          select: { id: true, name: true },
          orderBy: { createdAt: "asc" },
        },
        collection: {
          include: {
            papers: {
              take: 5,
              select: { paper: { select: { title: true } } },
            },
          },
        },
      },
    }),
    getProjectLineage(projectId),
  ]);

  if (!project) {
    const structured: GroundedResearchSummary = {
      generatedAt: new Date().toISOString(),
      project: {
        id: projectId,
        title: "Unknown project",
        question: null,
        methodology: null,
        currentPhase: "unknown",
      },
      stats: {
        papers: 0,
        hypotheses: 0,
        rootApproaches: 0,
        experimentRuns: 0,
        experimentResults: 0,
        findings: 0,
        contestedClaims: 0,
        reproducedClaims: 0,
        blockingObligations: 0,
      },
      tldr: "Project not found.",
      introduction: "Project not found.",
      methods: "Project not found.",
      currentStatus: "Project not found.",
      keyFindings: [],
      limitations: [],
      openQuestions: [],
    };
    return { short: structured.tldr, full: "# Research Summary\n\nProject not found.\n", structured };
  }

  const paperCount = project.collectionId
    ? await prisma.collectionPaper.count({ where: { collectionId: project.collectionId } })
    : 0;

  const question = parseBriefQuestion(project.brief);
  const claims = uniqueClaims(lineage.tracks);
  const queue = uniqueQueue(lineage.tracks);
  const allFindingClaims = claims
    .filter(isFindingClaim)
    .sort((left, right) => {
      const scoreDiff = findingScore(right) - findingScore(left);
      if (scoreDiff !== 0) return scoreDiff;
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    });
  const findingClaims = allFindingClaims.slice(0, 7);

  const groundedFindings: GroundedSummaryFinding[] = findingClaims.map((claim) => ({
    claimId: claim.id,
    statement: claim.statement,
    summary: claim.summary || null,
    type: claim.type,
    status: claim.status,
    confidence: claim.confidence,
    updatedAt: new Date(claim.updatedAt).toISOString(),
    supportCount: claim.evidence.filter((evidence) => evidence.supports).length,
    rebuttalCount: claim.evidence.filter((evidence) => !evidence.supports).length,
    hasReview: claim.hasReview,
    linkedHypothesis: claim.hypothesis?.statement || null,
    linkedResult: claim.result?.scriptName || null,
    evidence: summarizeEvidenceRefs(claim),
  }));

  const contestedClaims = claims
    .filter((claim) => claim.status === "CONTESTED")
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const riskClaims = claims
    .filter((claim) => claim.type === "risk" && claim.status !== "RETRACTED")
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());

  const limitations: GroundedSummaryLimitation[] = [
    ...contestedClaims.slice(0, 6).map((claim) => ({
      kind: "contested_claim" as const,
      text: claim.statement,
      blocking: false,
      claimId: claim.id,
    })),
    ...riskClaims.slice(0, 4).map((claim) => ({
      kind: "risk_claim" as const,
      text: claim.statement,
      blocking: false,
      claimId: claim.id,
    })),
    ...queue
      .filter((item) => item.blocking)
      .slice(0, 6)
      .map((item) => ({
        kind: "coordinator_obligation" as const,
        text: item.claimStatement
          ? `${item.title} (${item.claimStatement})`
          : item.title,
        blocking: true,
        claimId: item.claimId || undefined,
        stepId: item.stepId,
      })),
    ...lineage.tracks
      .flatMap((track) => track.gaps.slice(0, 2))
      .slice(0, 6)
      .map((gap) => ({
        kind: "track_gap" as const,
        text: gap,
        blocking: false,
      })),
  ];

  const openQuestions = uniqueStrings([
    ...contestedClaims.slice(0, 4).map((claim) => `What evidence would resolve: ${claim.statement}`),
    ...queue
      .filter((item) => item.blocking)
      .slice(0, 4)
      .map((item) => item.description || item.title),
    ...lineage.tracks
      .filter((track) => track.stats.results > 0 && track.stats.claims === 0)
      .slice(0, 3)
      .map((track) => `Translate the results for "${track.label}" into a reviewed claim.`),
  ]).slice(0, 7);

  const stats: GroundedResearchSummary["stats"] = {
    papers: paperCount,
    hypotheses: project.hypotheses.length,
    rootApproaches: project.approaches.length,
    experimentRuns: lineage.overview.runs,
    experimentResults: lineage.overview.results,
    findings: allFindingClaims.length,
    contestedClaims: contestedClaims.length,
    reproducedClaims: claims.filter((claim) => claim.status === "REPRODUCED").length,
    blockingObligations: queue.filter((item) => item.blocking).length,
  };

  const currentStatus = buildCurrentStatus({
    phase: project.currentPhase,
    findings: stats.findings,
    contestedClaims: stats.contestedClaims,
    reproducedClaims: stats.reproducedClaims,
    blockingObligations: stats.blockingObligations,
  });

  const structured: GroundedResearchSummary = {
    generatedAt: new Date().toISOString(),
    project: {
      id: project.id,
      title: project.title,
      question,
      methodology: project.methodology,
      currentPhase: project.currentPhase,
    },
    stats,
    tldr: "",
    introduction: buildIntroduction({
      title: project.title,
      question,
      methodology: project.methodology,
      stats,
      samplePapers: project.collection?.papers.map((entry: { paper: { title: string } }) => entry.paper.title) || [],
    }),
    methods: buildMethods(stats, project.approaches.map((approach: { name: string }) => approach.name).slice(0, 5)),
    currentStatus,
    keyFindings: groundedFindings,
    limitations: limitations.slice(0, 10),
    openQuestions,
  };

  structured.tldr = buildTldr(question, groundedFindings[0] || null, currentStatus);
  const full = formatMarkdown(structured);

  return {
    short: structured.tldr,
    full,
    structured,
  };
}

export async function generateResearchSummary(
  projectId: string,
  workDir: string,
): Promise<ResearchSummaryData> {
  const summary = await compileResearchSummary(projectId);
  await safeWriteSummaryFiles(workDir, summary);
  return summary;
}

export async function getResearchSummaryForDisplay(
  projectId: string,
  workDir: string,
): Promise<ResearchSummaryData | null> {
  try {
    return await generateResearchSummary(projectId, workDir);
  } catch {
    return null;
  }
}

async function safeWriteSummaryFiles(workDir: string, summary: ResearchSummaryData) {
  const jsonPath = path.join(workDir, "RESEARCH_SUMMARY.json");
  const markdownPath = path.join(workDir, "RESEARCH_SUMMARY.md");
  const tmpSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const jsonTmpPath = `${jsonPath}.${tmpSuffix}`;
  const markdownTmpPath = `${markdownPath}.${tmpSuffix}`;

  try {
    await writeFile(jsonTmpPath, JSON.stringify(summary, null, 2), "utf-8");
    await writeFile(markdownTmpPath, summary.full, "utf-8");
    await rename(markdownTmpPath, markdownPath);
    await rename(jsonTmpPath, jsonPath);
  } catch {
    await Promise.allSettled([
      rm(jsonTmpPath, { force: true }),
      rm(markdownTmpPath, { force: true }),
    ]);
  }
}
