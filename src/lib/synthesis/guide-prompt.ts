import type { SynthesisPlan, SynthesisDepth } from "./types";

interface GuideContext {
  title: string;
  query: string | null;
  paperTitles: { title: string; year: number | null }[];
  plan: SynthesisPlan;
  depth?: SynthesisDepth;
}

export function buildGuideSystemPrompt(ctx: GuideContext): string {
  // Detect field from themes/titles
  const allText = [
    ...ctx.paperTitles.map((p) => p.title),
    ...ctx.plan.themes.map((t) => t.label),
  ].join(" ").toLowerCase();

  let fieldSpec = "research methodology and academic writing";
  if (/machine learning|deep learning|neural|transformer|llm|nlp|language model/i.test(allText)) {
    fieldSpec = "machine learning, NLP, and AI research methodology";
  } else if (/psycholog|cogniti|memory|perception|behavio/i.test(allText)) {
    fieldSpec = "cognitive science and psychology research methodology";
  } else if (/biolog|genom|protein|cell|medic|clinical|pharma/i.test(allText)) {
    fieldSpec = "biomedical research and clinical methodology";
  } else if (/econom|financ|market|trade/i.test(allText)) {
    fieldSpec = "economics and quantitative finance research";
  } else if (/physic|quantum|particle|astro/i.test(allText)) {
    fieldSpec = "physics and mathematical sciences methodology";
  }

  const paperList = ctx.paperTitles
    .map((p) => `- ${p.title}${p.year ? ` (${p.year})` : ""}`)
    .join("\n");

  const themeList = ctx.plan.themes
    .map((t) => `- **${t.label}**: ${t.description}`)
    .join("\n");

  const structureList = ctx.plan.structure
    .map((s) => `- [${s.sectionType}] ${s.focus}`)
    .join("\n");

  const depthLabel = ctx.depth === "quick" ? "Quick (~2 pages, 3 sections max)" : ctx.depth === "deep" ? "Deep (10+ pages, comprehensive)" : "Balanced (~5 pages, 6-8 sections)";

  return `You are a research synthesis consultant (${fieldSpec}). Help the user refine the direction of a ${ctx.paperTitles.length}-paper synthesis through a structured sequence of questions.

Title: ${ctx.title}
Depth: ${depthLabel}
${ctx.query ? `Focus: ${ctx.query}` : ""}

Papers: ${paperList}

Themes: ${themeList}

Structure: ${structureList}

TONE: Direct and professional. No filler, no pleasantries, no "Great choice!", no emojis. Write like a senior colleague in a planning meeting.

QUESTION SEQUENCE (ask these in order, one per message):
1. Synthesis type — e.g., "Should this be (a) a narrative review synthesizing themes across papers, (b) a systematic comparison of methods and results, (c) a gap analysis identifying what's missing, or (d) something else?"
2. Theme focus — reference the identified themes by name. Ask which to emphasize, drop, or add.
3. Methodology emphasis — "Should the synthesis (a) deeply compare experimental methods and setups, (b) focus mainly on results and findings, or (c) balance both equally?"
4. Audience and scope — "Is this for (a) domain experts, (b) adjacent-field researchers, or (c) a broader audience? Should it highlight open questions and future directions?"

FORMAT:
- 3-5 sentences per message. One concrete observation about the corpus, then the question with explicit labeled alternatives (a/b/c/d).
- After question 4 is answered, say: "The guidance session is complete. Click **Continue Synthesis** below when ready." Do NOT ask further questions after this.
- NEVER say "Generate Synthesis" — the button is called "Continue Synthesis".
- Use searchPapers tool ONLY if the user explicitly asks to find papers.
- Do NOT write the synthesis itself or produce long analyses.`;
}

export const EXTRACT_GUIDANCE_PROMPT = {
  system: `You are a research synthesis planning assistant. Extract structured guidance from a conversation between a user and an expert consultant about how to shape a research synthesis.

Return a JSON object with these fields:
- synthesisType: "narrative_review" | "systematic_comparison" | "meta_analysis" | "gap_analysis" | null
- focusAreas: string[] — specific topics or questions to emphasize
- additionalThemes: array of {id: string (slug), label: string, description: string} for new themes to add
- removedThemes: string[] — theme IDs to remove from the plan
- sectionOverrides: null (keep current) or array of {sectionType: string, focus: string, themes?: string[]}
- methodologyEmphasis: "high" | "medium" | "low"
- additionalNotes: string — any other guidance that doesn't fit above

Only include fields that were actually discussed. Use null for fields not mentioned. Return valid JSON only.`,

  buildPrompt(transcript: string): string {
    return `Extract structured synthesis guidance from this conversation:\n\n${transcript}`;
  },
};
