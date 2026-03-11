import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

// POST — Create demo research projects using existing papers
export async function POST() {
  try {
    const userId = await requireUserId();

    // Get some papers to use as seeds
    const papers = await prisma.paper.findMany({
      where: { userId },
      select: { id: true, title: true },
      take: 20,
    });

    if (papers.length < 4) {
      return NextResponse.json(
        { error: "Need at least 4 papers in your library to seed demos" },
        { status: 400 },
      );
    }

    const created: string[] = [];

    // ── Demo 1: Attention Mechanisms ─────────────────────────────
    {
      const attentionPapers = papers.filter((p) =>
        /attention|transformer|mla|gqa|multi.head/i.test(p.title)
      ).slice(0, 3);
      const seedPapers = attentionPapers.length >= 2 ? attentionPapers : papers.slice(0, 3);

      const collection = await prisma.collection.create({
        data: { name: "Research: Efficient Attention Mechanisms" },
      });

      for (const p of seedPapers) {
        await prisma.collectionPaper.create({
          data: { paperId: p.id, collectionId: collection.id },
        }).catch(() => {});
      }

      const project = await prisma.researchProject.create({
        data: {
          userId,
          title: "Efficient Attention Mechanisms for Long-Context LLMs",
          brief: JSON.stringify({
            question: "How can attention mechanisms be made more efficient for processing long sequences (>100K tokens) without significant quality degradation?",
            subQuestions: [
              "What are the computational bottlenecks in standard multi-head attention?",
              "How do linear attention variants compare to sparse attention methods?",
              "What is the quality-efficiency tradeoff for different context lengths?",
            ],
            domains: ["Machine Learning", "NLP"],
            keywords: ["attention", "transformer", "linear attention", "sparse attention", "long context", "KV cache", "multi-query attention"],
          }),
          methodology: "experimental",
          status: "ACTIVE",
          currentPhase: "literature",
          collectionId: collection.id,
          iterations: {
            create: {
              number: 1,
              goal: "Survey existing efficient attention methods and identify the most promising approaches",
            },
          },
          log: {
            create: [
              { type: "decision", content: "Project created: Efficient Attention Mechanisms for Long-Context LLMs" },
              { type: "observation", content: `Seeded with ${seedPapers.length} papers on attention mechanisms` },
            ],
          },
        },
      });

      created.push(project.id);
    }

    // ── Demo 2: LLM Hallucination ────────────────────────────────
    {
      const hallucinationPapers = papers.filter((p) =>
        /hallucin|factual|robust|rl|reinforcement/i.test(p.title)
      ).slice(0, 3);
      const seedPapers = hallucinationPapers.length >= 2 ? hallucinationPapers : papers.slice(3, 6);

      const collection = await prisma.collection.create({
        data: { name: "Research: Reducing LLM Hallucination" },
      });

      for (const p of seedPapers) {
        await prisma.collectionPaper.create({
          data: { paperId: p.id, collectionId: collection.id },
        }).catch(() => {});
      }

      const project = await prisma.researchProject.create({
        data: {
          userId,
          title: "Mitigating Factual Hallucination in Large Language Models",
          brief: JSON.stringify({
            question: "What training and inference-time techniques most effectively reduce factual hallucinations in LLMs, and how can we measure improvement reliably?",
            subQuestions: [
              "How do RLHF/RLVR approaches compare to retrieval augmentation for reducing hallucination?",
              "What evaluation benchmarks capture hallucination rates most accurately?",
              "Is there a fundamental tradeoff between creativity and factual accuracy?",
              "How does model scale affect hallucination rates?",
            ],
            domains: ["Machine Learning", "NLP"],
            keywords: ["hallucination", "factuality", "RLHF", "RLVR", "retrieval augmented generation", "grounding", "evaluation"],
          }),
          methodology: "analytical",
          status: "ACTIVE",
          currentPhase: "hypothesis",
          collectionId: collection.id,
          iterations: {
            create: {
              number: 1,
              goal: "Categorize hallucination mitigation approaches and form testable hypotheses",
            },
          },
          hypotheses: {
            create: [
              {
                statement: "RLVR-trained models show lower hallucination rates than RLHF-trained models on factual QA benchmarks",
                rationale: "RLVR directly optimizes for verifiable correctness rather than human preference, which may conflate fluency with accuracy",
                status: "PROPOSED",
              },
              {
                statement: "Retrieval augmentation reduces hallucination more effectively than training-time interventions for knowledge-intensive tasks",
                rationale: "Training can't memorize all facts, but retrieval provides access to up-to-date information at inference time",
                status: "PROPOSED",
              },
            ],
          },
          log: {
            create: [
              { type: "decision", content: "Project created: Mitigating Factual Hallucination in LLMs" },
              { type: "observation", content: `Seeded with ${seedPapers.length} papers on hallucination and robustness` },
              { type: "decision", content: "Phase changed: literature → hypothesis" },
              { type: "agent_suggestion", content: "Proposed 2 initial hypotheses based on literature review" },
            ],
          },
        },
      });

      created.push(project.id);
    }

    return NextResponse.json({ created, count: created.length });
  } catch (err) {
    console.error("[api/research/seed-demo] POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to seed demos" },
      { status: 500 },
    );
  }
}
