import { cp, mkdir } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { saveEvaluationProtocolTx, getEvaluationProtocol } from "./evaluation-protocol";

interface CreateProjectSandboxOptions {
  sourceProjectId: string;
  userId: string;
  title?: string;
  phase?: string;
  copyWorkspace?: boolean;
}

interface SandboxSourceMeta {
  sandboxOf: {
    projectId: string;
    createdAt: string;
  };
}

export interface CreatedProjectSandbox {
  id: string;
  title: string;
  kind: string;
  currentPhase: string;
  outputFolder: string;
  sourceProjectId: string;
  workspaceCopied: boolean;
}

function slugifyProjectTitle(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "research-sandbox";
}

function buildSandboxTitle(title: string) {
  return title.includes("[Sandbox]") ? title : `${title} [Sandbox]`;
}

function normalizeSandboxPhase(input: string | undefined, fallback: string) {
  const defaultPhase = ["ANALYSIS", "DECISION"].includes(fallback) ? "EXECUTION" : fallback;
  const phase = (input || defaultPhase || "EXECUTION").trim().toUpperCase();
  if (["DISCOVERY", "HYPOTHESIS", "EXECUTION", "ANALYSIS", "DECISION"].includes(phase)) {
    return phase;
  }
  return fallback || "EXECUTION";
}

function normalizeHypothesisStatus(status: string) {
  if (status === "PROPOSED" || status === "REVISED") return "PROPOSED";
  return "TESTING";
}

function shouldCopyWorkspaceEntry(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized) return true;
  if (normalized === ".arcana" || normalized.startsWith(".arcana/")) return false;
  if (normalized === ".archive" || normalized.startsWith(".archive/")) return false;
  if (normalized === "results" || normalized.startsWith("results/")) return false;
  if (normalized === "stdout.log" || normalized === "stderr.log") return false;
  if (normalized === "RESEARCH_SUMMARY.json" || normalized === "RESEARCH_SUMMARY.md") return false;
  if (/^run_[^/]+/.test(normalized)) return false;
  if (/^\.run-.*\.log$/.test(path.basename(normalized))) return false;
  return true;
}

function buildSandboxBrief(brief: string, sourceProjectId: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(brief) as Record<string, unknown>;
  } catch {
    parsed = { question: brief };
  }

  const next: Record<string, unknown> = {
    ...parsed,
    sandboxOf: {
      projectId: sourceProjectId,
      createdAt: new Date().toISOString(),
    },
  };

  return JSON.stringify(next as Record<string, unknown> & SandboxSourceMeta);
}

async function copyProjectWorkspace(sourceDir: string | null, destDir: string) {
  if (!sourceDir) return false;

  await mkdir(path.dirname(destDir), { recursive: true });
  try {
    await cp(sourceDir, destDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (src) => {
        if (src === sourceDir) return true;
        const relative = path.relative(sourceDir, src);
        return shouldCopyWorkspaceEntry(relative);
      },
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function createProjectSandbox(options: CreateProjectSandboxOptions): Promise<CreatedProjectSandbox> {
  const source = await prisma.researchProject.findFirst({
    where: { id: options.sourceProjectId, userId: options.userId },
    include: {
      collection: {
        include: {
          papers: {
            select: { paperId: true },
          },
        },
      },
      hypotheses: {
        orderBy: { createdAt: "asc" },
      },
      approaches: {
        orderBy: { createdAt: "asc" },
      },
      resourceRules: {
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      },
      iterations: {
        orderBy: { number: "desc" },
        take: 1,
        select: { goal: true, number: true },
      },
    },
  });

  if (!source) {
    throw new Error("Source project not found");
  }

  const sandboxId = randomUUID();
  const collectionId = randomUUID();
  const sandboxTitle = buildSandboxTitle(options.title?.trim() || source.title);
  const sandboxPhase = normalizeSandboxPhase(options.phase, source.currentPhase);
  const baseOutputDir = source.outputFolder
    ? path.dirname(source.outputFolder)
    : path.join(process.cwd(), "output", "research");
  const sandboxOutputFolder = path.join(baseOutputDir, `${slugifyProjectTitle(sandboxTitle)}-${sandboxId.slice(0, 8)}`);
  const latestIterationGoal = source.iterations[0]?.goal || `Sandbox cloned from ${source.id.slice(0, 8)}`;
  const evaluationProtocol = await getEvaluationProtocol(source.id);

  await prisma.$transaction(async (tx) => {
    await tx.collection.create({
      data: {
        id: collectionId,
        name: `Research Sandbox: ${sandboxTitle}`,
      },
    });

    await tx.researchProject.create({
      data: {
        id: sandboxId,
        userId: options.userId,
        kind: "SANDBOX",
        title: sandboxTitle,
        brief: buildSandboxBrief(source.brief, source.id),
        status: "PAUSED",
        methodology: source.methodology,
        currentPhase: sandboxPhase,
        metricSchema: source.metricSchema,
        collectionId,
        outputFolder: sandboxOutputFolder,
        iterations: {
          create: {
            number: 1,
            goal: latestIterationGoal,
          },
        },
        log: {
          create: {
            type: "decision",
            content: `Sandbox cloned from project ${source.id.slice(0, 8)} at phase ${source.currentPhase}.`,
            metadata: JSON.stringify({
              sandbox: true,
              sourceProjectId: source.id,
              sourcePhase: source.currentPhase,
            }),
          },
        },
      },
    });

    for (const entry of source.collection?.papers || []) {
      await tx.collectionPaper.create({
        data: {
          collectionId,
          paperId: entry.paperId,
        },
      }).catch(() => {});
    }

    const hypothesisIdMap = new Map<string, string>();
    for (const hypothesis of source.hypotheses) {
      hypothesisIdMap.set(hypothesis.id, randomUUID());
    }
    for (const hypothesis of source.hypotheses) {
      const nextId = hypothesisIdMap.get(hypothesis.id)!;
      await tx.researchHypothesis.create({
        data: {
          id: nextId,
          projectId: sandboxId,
          statement: hypothesis.statement,
          rationale: hypothesis.rationale,
          status: normalizeHypothesisStatus(hypothesis.status),
          evidence: null,
          theme: hypothesis.theme,
          parentId: hypothesis.parentId ? hypothesisIdMap.get(hypothesis.parentId) || null : null,
        },
      });
    }

    const approachIdMap = new Map<string, string>();
    for (const approach of source.approaches) {
      approachIdMap.set(approach.id, randomUUID());
    }
    for (const approach of source.approaches) {
      const nextId = approachIdMap.get(approach.id)!;
      await tx.approachBranch.create({
        data: {
          id: nextId,
          projectId: sandboxId,
          parentId: approach.parentId ? approachIdMap.get(approach.parentId) || null : null,
          name: approach.name,
          description: approach.description,
          status: approach.status,
        },
      });
    }

    for (const rule of source.resourceRules) {
      await tx.resourceRule.create({
        data: {
          projectId: sandboxId,
          pattern: rule.pattern,
          runtime: rule.runtime,
          needs: rule.needs,
          reason: rule.reason,
          priority: rule.priority,
        },
      });
    }

    if (evaluationProtocol) {
      await saveEvaluationProtocolTx(sandboxId, evaluationProtocol.protocol, tx);
    }
  });

  const workspaceCopied = options.copyWorkspace === false
    ? false
    : await copyProjectWorkspace(source.outputFolder, sandboxOutputFolder).catch(async (err) => {
      await prisma.researchLogEntry.create({
        data: {
          projectId: sandboxId,
          type: "decision",
          content: `Sandbox workspace copy failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      }).catch(() => {});
      return false;
    });

  return {
    id: sandboxId,
    title: sandboxTitle,
    kind: "SANDBOX",
    currentPhase: sandboxPhase,
    outputFolder: sandboxOutputFolder,
    sourceProjectId: source.id,
    workspaceCopied,
  };
}
