import { prisma } from "@/lib/prisma";
import { processQuery, scoreText, scoreWeighted } from "./search-utils";

export type SkillQueryMode = "exploit" | "balanced" | "explore";

export interface SkillCard {
  insightId: string;
  roomName: string;
  paperId: string;
  paperTitle: string;
  paperYear: number | null;
  learning: string;
  trigger: string;
  mechanism: string;
  implementationHint: string;
  riskNote: string;
  confidence: number; // 0-1
  novelty: number; // 0-1
  relevance: number;
  score: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function firstSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const match = cleaned.match(/^(.+?[.!?])(?:\s|$)/);
  return (match?.[1] || cleaned).trim();
}

function parseStructuredApplications(applications: string | null): {
  trigger?: string;
  mechanism?: string;
  implementationHint?: string;
  riskNote?: string;
} {
  if (!applications) return {};
  const trimmed = applications.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const out: {
        trigger?: string;
        mechanism?: string;
        implementationHint?: string;
        riskNote?: string;
      } = {};
      if (typeof parsed.trigger === "string") out.trigger = parsed.trigger;
      if (typeof parsed.mechanism === "string") out.mechanism = parsed.mechanism;
      if (typeof parsed.implementationHint === "string") out.implementationHint = parsed.implementationHint;
      if (typeof parsed.riskNote === "string") out.riskNote = parsed.riskNote;
      return out;
    }
  } catch {
    // Fallback to free-text parsing below.
  }

  const extract = (label: string): string | undefined => {
    const regex = new RegExp(`${label}\\s*:\\s*([^\\n]+)`, "i");
    const match = trimmed.match(regex);
    return match?.[1]?.trim();
  };

  return {
    trigger: extract("trigger"),
    mechanism: extract("mechanism"),
    implementationHint: extract("implementation"),
    riskNote: extract("risk"),
  };
}

function defaultRisk(significance: string, applications: string | null): string {
  const merged = `${significance} ${applications || ""}`.toLowerCase();
  if (/(fail|fails|fragile|unstable|sensitive|limitation|tradeoff|trade-off|cost)/.test(merged)) {
    return firstSentence(`${significance} ${applications || ""}`) || "Validate with a PoC before scaling.";
  }
  return "Validate with a PoC before scaling.";
}

function scoreByMode(
  mode: SkillQueryMode,
  relevance: number,
  confidence: number,
  novelty: number,
  projectBonus: number,
): number {
  switch (mode) {
    case "exploit":
      return relevance * 1.5 + confidence * 2.0 + projectBonus;
    case "explore":
      return relevance * 1.0 + novelty * 4.0 + confidence * 0.5 + projectBonus * 0.6;
    case "balanced":
    default:
      return relevance * 1.25 + confidence * 1.2 + novelty * 2.0 + projectBonus;
  }
}

function selectDiverse(cards: SkillCard[], maxResults: number, mode: SkillQueryMode): SkillCard[] {
  if (mode === "exploit") return cards.slice(0, maxResults);

  const byRoom = new Map<string, SkillCard[]>();
  for (const card of cards) {
    const roomCards = byRoom.get(card.roomName) || [];
    roomCards.push(card);
    byRoom.set(card.roomName, roomCards);
  }

  const rooms = Array.from(byRoom.keys()).sort((a, b) => {
    const topA = byRoom.get(a)?.[0]?.score ?? 0;
    const topB = byRoom.get(b)?.[0]?.score ?? 0;
    return topB - topA;
  });

  const out: SkillCard[] = [];
  const usedPaperIds = new Set<string>();
  while (out.length < maxResults) {
    let advanced = false;
    for (const room of rooms) {
      const queue = byRoom.get(room);
      if (!queue || queue.length === 0) continue;

      // Prefer not repeating the same paper unless necessary.
      let idx = queue.findIndex((card) => !usedPaperIds.has(card.paperId));
      if (idx < 0) idx = 0;
      const [picked] = queue.splice(idx, 1);
      if (!picked) continue;
      out.push(picked);
      usedPaperIds.add(picked.paperId);
      advanced = true;
      if (out.length >= maxResults) break;
    }
    if (!advanced) break;
  }

  return out.slice(0, maxResults);
}

export async function querySkillCards(params: {
  userId: string;
  query: string;
  projectId?: string;
  maxResults?: number;
  mode?: SkillQueryMode;
  trackUsage?: boolean;
}): Promise<{ cards: SkillCard[]; matchedInsightIds: string[] }> {
  const maxResults = clamp(params.maxResults ?? 8, 1, 20);
  const mode: SkillQueryMode = params.mode ?? "balanced";

  const [insights, queryTerms, projectPaperIds] = await Promise.all([
    prisma.insight.findMany({
      where: { paper: { userId: params.userId } },
      include: {
        paper: { select: { id: true, title: true, year: true } },
        room: { select: { name: true } },
      },
      orderBy: [{ usageCount: "desc" }, { updatedAt: "desc" }],
      take: 2000,
    }),
    processQuery(params.query),
    (async () => {
      if (!params.projectId) return new Set<string>();
      const project = await prisma.researchProject.findUnique({
        where: { id: params.projectId },
        select: { collectionId: true },
      });
      if (!project?.collectionId) return new Set<string>();
      const projectPapers = await prisma.collectionPaper.findMany({
        where: { collectionId: project.collectionId },
        select: { paperId: true },
      });
      return new Set(projectPapers.map((p) => p.paperId));
    })(),
  ]);

  if (insights.length === 0) return { cards: [], matchedInsightIds: [] };

  const scored: SkillCard[] = [];
  for (const insight of insights) {
    const app = parseStructuredApplications(insight.applications);
    const searchableSections = [
      { text: insight.learning, weight: 4 },
      { text: insight.significance, weight: 2 },
      { text: insight.applications || "", weight: 2 },
      { text: insight.paper.title, weight: 2 },
      { text: insight.room.name, weight: 1 },
      { text: app.trigger || "", weight: 2 },
      { text: app.mechanism || "", weight: 2 },
    ];

    const relevance = scoreWeighted(searchableSections, queryTerms);
    if (relevance <= 0) continue;

    const projectBonus = projectPaperIds.has(insight.paperId) ? 2 : 0;
    const sourceBoost = insight.source === "manual"
      ? 0.22
      : insight.source === "research"
        ? 0.16
        : 0.1;
    const usageBoost = Math.min(0.28, Math.log2(insight.usageCount + 1) * 0.06);
    const confidence = clamp(0.45 + sourceBoost + usageBoost, 0.15, 0.98);
    const novelty = clamp(1 / (1 + Math.sqrt(insight.usageCount + 1)), 0.05, 1);
    const score = scoreByMode(mode, relevance, confidence, novelty, projectBonus);

    const trigger = app.trigger
      || firstSentence(insight.applications || "")
      || firstSentence(insight.significance)
      || `When facing a ${insight.room.name.toLowerCase()} bottleneck.`;
    const mechanism = app.mechanism
      || firstSentence(insight.learning)
      || "Apply the core technique described in this insight.";
    const implementationHint = app.implementationHint
      || firstSentence(insight.applications || "")
      || "Start with a minimal PoC before full training.";
    const riskNote = app.riskNote || defaultRisk(insight.significance, insight.applications);

    scored.push({
      insightId: insight.id,
      roomName: insight.room.name,
      paperId: insight.paper.id,
      paperTitle: insight.paper.title,
      paperYear: insight.paper.year ?? null,
      learning: insight.learning,
      trigger,
      mechanism,
      implementationHint,
      riskNote,
      confidence: Number(confidence.toFixed(3)),
      novelty: Number(novelty.toFixed(3)),
      relevance,
      score: Number(score.toFixed(3)),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const selected = selectDiverse(scored, maxResults, mode);

  const matchedInsightIds = selected.map((c) => c.insightId);
  if ((params.trackUsage ?? true) && matchedInsightIds.length > 0) {
    prisma.insight.updateMany({
      where: { id: { in: matchedInsightIds } },
      data: { usageCount: { increment: 1 } },
    }).catch(() => {});
  }

  return { cards: selected, matchedInsightIds };
}

export async function queryAntiPatterns(params: {
  projectId: string;
  query: string;
  maxResults?: number;
}): Promise<string[]> {
  const maxResults = clamp(params.maxResults ?? 5, 1, 15);
  const [entries, queryTerms] = await Promise.all([
    prisma.researchLogEntry.findMany({
      where: {
        projectId: params.projectId,
        type: { in: ["dead_end", "help_request"] },
      },
      orderBy: { createdAt: "desc" },
      take: 120,
      select: { content: true },
    }),
    processQuery(params.query),
  ]);

  const ranked = entries
    .map((entry) => {
      const content = entry.content.replace(/\s+/g, " ").trim();
      return { content, score: scoreText(content, queryTerms) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of ranked) {
    const sentence = firstSentence(item.content).slice(0, 220);
    const key = sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!sentence || seen.has(key)) continue;
    seen.add(key);
    deduped.push(sentence);
    if (deduped.length >= maxResults) break;
  }

  return deduped;
}

export function formatSkillCards(cards: SkillCard[]): string {
  return cards.map((card, idx) => {
    return [
      `${idx + 1}. [${card.roomName}] ${card.paperTitle} (${card.paperYear || "?"})`,
      `   Trigger: ${card.trigger}`,
      `   Mechanism: ${card.mechanism}`,
      `   Implementation: ${card.implementationHint}`,
      `   Risk: ${card.riskNote}`,
      `   Confidence=${card.confidence.toFixed(2)} | Novelty=${card.novelty.toFixed(2)} | Score=${card.score.toFixed(2)}`,
    ].join("\n");
  }).join("\n\n");
}
