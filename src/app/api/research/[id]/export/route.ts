import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import { compileResearchSummary } from "@/lib/research/research-summary";
import { getProjectLineage } from "@/lib/research/lineage-audit";
import { ensureProjectMaintenance } from "@/lib/research/project-maintenance";
import { getProjectTraceAudit } from "@/lib/research/trace-audit";

type Params = { params: Promise<{ id: string }> };

// GET /api/research/[id]/export?artifacts=true
// Exports the full research project as JSON, optionally including file artifacts as base64.
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const includeResearch = searchParams.get("noResearch") !== "true";
    const includePapers = searchParams.get("noPapers") !== "true";
    const includeFullText = searchParams.get("fullText") === "true";
    const includeCode = searchParams.get("code") === "true";
    const includeArtifacts = searchParams.get("artifacts") === "true";
    const includeTrace = searchParams.get("noTrace") !== "true";
    const traceLimitParam = Number(searchParams.get("traceLimit") || "200");
    const traceLimit = Number.isFinite(traceLimitParam) ? traceLimitParam : 200;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      include: {
        iterations: {
          orderBy: { number: "asc" },
          include: {
            steps: { orderBy: { sortOrder: "asc" } },
          },
        },
        hypotheses: {
          orderBy: { createdAt: "asc" },
          include: {
            parent: { select: { id: true, statement: true } },
            children: { select: { id: true, statement: true, status: true } },
          },
        },
        log: {
          orderBy: { createdAt: "asc" },
        },
        claims: {
          include: {
            evidence: true,
            assessments: {
              orderBy: { createdAt: "desc" },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        collection: {
          include: {
            papers: {
              include: {
                paper: {
                  select: {
                    id: true,
                    title: true,
                    authors: true,
                    year: true,
                    venue: true,
                    abstract: true,
                    summary: true,
                    sourceType: true,
                    sourceUrl: true,
                    doi: true,
                    fullText: true,
                    tags: { include: { tag: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    await ensureProjectMaintenance(id);

    // Load agent memories for this user (project-scoped + global)
    const [memories, groundedSummary, lineage, traceAudit] = await Promise.all([
      prisma.agentMemory.findMany({
        where: {
          userId,
          OR: [{ projectId: id }, { projectId: null }],
        },
        select: {
          category: true,
          lesson: true,
          context: true,
          projectId: true,
          usageCount: true,
          sourceClaimId: true,
          status: true,
          confidence: true,
        },
      }),
      includeResearch ? compileResearchSummary(id) : Promise.resolve(null),
      includeResearch ? getProjectLineage(id) : Promise.resolve(null),
      includeResearch && includeTrace ? getProjectTraceAudit({ projectId: id, limit: traceLimit }) : Promise.resolve(null),
    ]);

    // Build export object
    const exportData: Record<string, unknown> = {
      _format: "arcana-research-export",
      _version: 1,
      _exportedAt: new Date().toISOString(),
      project: {
        title: project.title,
        brief: project.brief,
        status: project.status,
        methodology: project.methodology,
        currentPhase: project.currentPhase,
        outputFolder: project.outputFolder,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      papers: includePapers ? (project.collection?.papers.map((cp) => ({
        title: cp.paper.title,
        authors: cp.paper.authors,
        year: cp.paper.year,
        venue: cp.paper.venue,
        abstract: cp.paper.abstract,
        summary: cp.paper.summary,
        sourceType: cp.paper.sourceType,
        sourceUrl: cp.paper.sourceUrl,
        doi: cp.paper.doi,
        fullText: includeFullText ? cp.paper.fullText : null,
        tags: cp.paper.tags.map((t) => t.tag.name),
      })) || []) : [],
      ...(includeResearch ? {
        hypotheses: project.hypotheses.map((h) => ({
          id: h.id,
          statement: h.statement,
          rationale: h.rationale,
          status: h.status,
          evidence: h.evidence,
          parentId: h.parentId,
        })),
        iterations: project.iterations.map((iter) => ({
          number: iter.number,
          goal: iter.goal,
          status: iter.status,
          reflection: iter.reflection,
          nextActions: iter.nextActions,
          startedAt: iter.startedAt,
          completedAt: iter.completedAt,
          steps: iter.steps.map((s) => ({
            type: s.type,
            status: s.status,
            title: s.title,
            description: s.description,
            input: s.input,
            output: s.output,
            sortOrder: s.sortOrder,
            createdAt: s.createdAt,
            completedAt: s.completedAt,
          })),
        })),
        log: project.log.map((l) => ({
          id: l.id,
          type: l.type,
          content: l.content,
          metadata: l.metadata,
          createdAt: l.createdAt,
        })),
        claims: project.claims.map((claim) => ({
          id: claim.id,
          statement: claim.statement,
          summary: claim.summary,
          type: claim.type,
          status: claim.status,
          confidence: claim.confidence,
          createdBy: claim.createdBy,
          createdFrom: claim.createdFrom,
          notes: claim.notes,
          hypothesisId: claim.hypothesisId,
          resultId: claim.resultId,
          taskId: claim.taskId,
          createdAt: claim.createdAt,
          updatedAt: claim.updatedAt,
          assessments: claim.assessments.map((assessment) => ({
            id: assessment.id,
            actorRole: assessment.actorRole,
            verdict: assessment.verdict,
            confidence: assessment.confidence,
            notes: assessment.notes,
            metadata: assessment.metadata,
            taskId: assessment.taskId,
            createdAt: assessment.createdAt,
          })),
          evidence: claim.evidence.map((e) => ({
            id: e.id,
            kind: e.kind,
            supports: e.supports,
            strength: e.strength,
            rationale: e.rationale,
            excerpt: e.excerpt,
            locator: e.locator,
            paperId: e.paperId,
            hypothesisId: e.hypothesisId,
            resultId: e.resultId,
            artifactId: e.artifactId,
            logEntryId: e.logEntryId,
            taskId: e.taskId,
            remoteJobId: e.remoteJobId,
          })),
        })),
        memories: memories.map((m) => ({
          category: m.category,
          lesson: m.lesson,
          context: m.context,
          scope: m.projectId ? "project" : "global",
          usageCount: m.usageCount,
          sourceClaimId: m.sourceClaimId,
          status: m.status,
          confidence: m.confidence,
        })),
        summary: groundedSummary ? {
          short: groundedSummary.short,
          full: groundedSummary.full,
          structured: groundedSummary.structured,
        } : null,
        lineage: lineage ? {
          project: lineage.project,
          overview: lineage.overview,
          tracks: lineage.tracks,
        } : null,
        trace: includeTrace ? {
          total: traceAudit?.total || 0,
          returned: traceAudit?.returned || 0,
          overview: traceAudit?.overview || null,
          sessions: traceAudit?.sessions || [],
          postmortems: traceAudit?.postmortems || [],
          events: traceAudit?.events || [],
        } : null,
      } : {}),
    };

    // Optionally include code and/or artifacts from the output folder
    if ((includeCode || includeArtifacts) && project.outputFolder) {
      const CODE_EXTS = new Set([".py", ".sh", ".txt", ".yaml", ".yml", ".json", ".toml", ".cfg", ".ini", ".md"]);
      const codeFiles: { filename: string; content: string; sizeBytes: number }[] = [];
      const artifactFiles: { filename: string; content: string; sizeBytes: number }[] = [];
      try {
        const files = await readdir(project.outputFolder);
        for (const f of files) {
          const fp = path.join(project.outputFolder, f);
          const s = await stat(fp);
          if (!s.isFile() || s.size > 5 * 1024 * 1024) continue;
          const ext = path.extname(f).toLowerCase();
          const isCode = CODE_EXTS.has(ext);

          if ((isCode && includeCode) || (!isCode && includeArtifacts)) {
            try {
              const content = await readFile(fp, "utf-8");
              const entry = { filename: f, content, sizeBytes: s.size };
              if (isCode) codeFiles.push(entry);
              else artifactFiles.push(entry);
            } catch {
              const buf = await readFile(fp);
              const entry = { filename: f, content: buf.toString("base64"), sizeBytes: s.size };
              if (isCode) codeFiles.push(entry);
              else artifactFiles.push(entry);
            }
          }
        }
      } catch {
        // Output folder might not exist
      }
      if (codeFiles.length > 0) exportData.code = codeFiles;
      if (artifactFiles.length > 0) exportData.artifacts = artifactFiles;
    }

    const json = JSON.stringify(exportData, null, 2);
    const filename = `${project.title.replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/\s+/g, "_").toLowerCase()}_export.json`;

    return new NextResponse(json, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("[api/research/[id]/export] GET error:", err);
    return NextResponse.json({ error: "Failed to export project" }, { status: 500 });
  }
}
