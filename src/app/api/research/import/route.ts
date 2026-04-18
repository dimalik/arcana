import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { buildInitialReferenceState } from "@/lib/references/reference-state";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

// POST /api/research/import
// Imports a research project from an export JSON.
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const data = await request.json();

    if (data._format !== "arcana-research-export") {
      return NextResponse.json({ error: "Invalid export format" }, { status: 400 });
    }

    const { project: proj, papers, hypotheses, iterations, log, memories, artifacts } = data;

    if (!proj?.title || !proj?.brief) {
      return NextResponse.json({ error: "Missing project title or brief" }, { status: 400 });
    }

    // 1. Create collection
    const collection = await prisma.collection.create({
      data: { name: `Research: ${proj.title} (imported)` },
    });

    // 2. Import papers — create or find by DOI/title
    const paperIdMap = new Map<number, string>(); // index → new paper ID
    if (Array.isArray(papers)) {
      for (let i = 0; i < papers.length; i++) {
        const p = papers[i];
        // Try to find existing paper by DOI or title
        let existing = p.doi
          ? await prisma.paper.findFirst({ where: { doi: p.doi, userId } })
          : null;
        if (!existing) {
          existing = await prisma.paper.findFirst({
            where: { title: p.title, userId },
          });
        }

        let paperId: string;
        if (existing) {
          paperId = existing.id;
        } else {
          const created = await prisma.paper.create({
            data: {
              userId,
              title: p.title,
              authors: p.authors,
              year: p.year,
              venue: p.venue,
              abstract: p.abstract,
              summary: p.summary,
              sourceType: p.sourceType || "MANUAL",
              sourceUrl: p.sourceUrl,
              doi: p.doi,
              fullText: p.fullText,
              processingStatus: p.fullText ? "COMPLETED" : "PENDING",
              referenceState: buildInitialReferenceState({
                fullText: p.fullText,
                processingStatus: p.fullText ? "COMPLETED" : "PENDING",
              }),
            },
          });
          paperId = created.id;

          // Create tags
          if (Array.isArray(p.tags)) {
            for (const tagName of p.tags) {
              const tag = await prisma.tag.upsert({
                where: { name: tagName },
                create: { name: tagName },
                update: {},
              });
              await prisma.paperTag.create({
                data: { paperId, tagId: tag.id },
              }).catch(() => {}); // ignore duplicates
            }
          }
        }

        paperIdMap.set(i, paperId);
        await prisma.collectionPaper.create({
          data: { paperId, collectionId: collection.id },
        }).catch(() => {}); // ignore duplicates
      }
    }

    // 3. Set up output folder
    const slug = slugify(proj.title);
    const outputFolder = path.join(process.cwd(), "output", "research", slug + "-imported");
    await mkdir(outputFolder, { recursive: true });

    // 4. Create project
    const project = await prisma.researchProject.create({
      data: {
        userId,
        title: proj.title,
        brief: proj.brief,
        status: "PAUSED", // Import as paused so user can review
        methodology: proj.methodology,
        currentPhase: proj.currentPhase || "literature",
        collectionId: collection.id,
        outputFolder,
      },
    });

    // 5. Import hypotheses (preserving parent-child relationships)
    const hypothesisIdMap = new Map<string, string>(); // old ID → new ID
    if (Array.isArray(hypotheses)) {
      // First pass: create all without parents
      for (const h of hypotheses) {
        const created = await prisma.researchHypothesis.create({
          data: {
            projectId: project.id,
            statement: h.statement,
            rationale: h.rationale,
            status: h.status || "PROPOSED",
            evidence: h.evidence,
          },
        });
        if (h.id) hypothesisIdMap.set(h.id, created.id);
      }
      // Second pass: link parents
      for (const h of hypotheses) {
        if (h.parentId && hypothesisIdMap.has(h.parentId) && hypothesisIdMap.has(h.id)) {
          await prisma.researchHypothesis.update({
            where: { id: hypothesisIdMap.get(h.id)! },
            data: { parentId: hypothesisIdMap.get(h.parentId)! },
          }).catch(() => {});
        }
      }
    }

    // 6. Import iterations and steps
    if (Array.isArray(iterations)) {
      for (const iter of iterations) {
        const normalizedSteps = Array.isArray(iter.steps)
          ? [...iter.steps]
              .sort((a, b) => {
                const aOrder = typeof a.sortOrder === "number" ? a.sortOrder : Number.MAX_SAFE_INTEGER;
                const bOrder = typeof b.sortOrder === "number" ? b.sortOrder : Number.MAX_SAFE_INTEGER;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return 0;
              })
              .map((step, index) => ({ ...step, sortOrder: index }))
          : [];
        const createdIter = await prisma.researchIteration.create({
          data: {
            projectId: project.id,
            number: iter.number,
            goal: iter.goal,
            status: iter.status || "COMPLETED",
            reflection: iter.reflection,
            nextActions: iter.nextActions,
            nextStepSortOrder: normalizedSteps.length,
          },
        });
        if (normalizedSteps.length > 0) {
          for (const s of normalizedSteps) {
            await prisma.researchStep.create({
              data: {
                iterationId: createdIter.id,
                type: s.type,
                status: s.status,
                title: s.title,
                description: s.description,
                input: s.input,
                output: s.output,
                sortOrder: s.sortOrder,
              },
            });
          }
        }
      }
    }

    // 7. Import log entries
    if (Array.isArray(log)) {
      for (const l of log) {
        await prisma.researchLogEntry.create({
          data: {
            projectId: project.id,
            type: l.type,
            content: l.content,
            metadata: l.metadata,
          },
        });
      }
    }

    // 8. Import memories (project-scoped ones only)
    if (Array.isArray(memories)) {
      for (const m of memories) {
        if (m.scope !== "project") continue;
        // Check for duplicates by lesson similarity
        const existing = await prisma.agentMemory.findFirst({
          where: { userId, lesson: m.lesson },
        });
        if (!existing) {
          await prisma.agentMemory.create({
            data: {
              userId,
              category: m.category,
              lesson: m.lesson,
              context: m.context,
              projectId: project.id,
            },
          });
        }
      }
    }

    // 9. Restore file artifacts
    if (Array.isArray(artifacts)) {
      for (const a of artifacts) {
        const safeName = path.basename(a.filename);
        const filePath = path.join(outputFolder, safeName);
        await writeFile(filePath, a.content, "utf-8");
      }
    }

    return NextResponse.json({
      id: project.id,
      title: project.title,
      papersImported: paperIdMap.size,
      hypothesesImported: hypothesisIdMap.size,
      iterationsImported: iterations?.length || 0,
      artifactsRestored: artifacts?.length || 0,
    }, { status: 201 });
  } catch (err) {
    console.error("[api/research/import] POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to import project" },
      { status: 500 },
    );
  }
}
