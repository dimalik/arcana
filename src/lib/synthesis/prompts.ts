/**
 * Synthesis-specific LLM prompt templates.
 * Each prompt asks for structured JSON output.
 */

import type { SynthesisDepth } from "./types";

export const PLAN_PROMPT = {
  system: `You are a senior research scientist designing a systematic literature review. Given a list of papers (titles, abstracts, summaries), identify recurring themes, plan a logical structure for a synthesis document, and cluster papers by theme.

Return a JSON object:
{
  "themes": [
    { "id": "theme-slug", "label": "Theme Name", "description": "1-2 sentence description" }
  ],
  "structure": [
    { "sectionType": "thematic", "focus": "Description of what this section covers", "themes": ["theme-slug"] },
    { "sectionType": "methodology", "focus": "Compare methods across papers" },
    { "sectionType": "findings", "focus": "Synthesize key findings" },
    { "sectionType": "contradictions", "focus": "Highlight conflicting claims" },
    { "sectionType": "gaps", "focus": "Identify research gaps" },
    { "sectionType": "timeline", "focus": "Chronological evolution of ideas" },
    { "sectionType": "meta", "focus": "Meta-analysis of quantitative patterns" }
  ],
  "paperClusters": {
    "theme-slug": ["paperId1", "paperId2"]
  }
}

Rules:
- Identify 3-8 themes depending on paper diversity.
- Every paper must appear in at least one theme cluster.
- Structure should include thematic sections for each major theme, plus methodology/findings/contradictions/gaps/timeline/meta sections.
- Return ONLY valid JSON. No markdown fences, no extra text.`,

  buildPrompt(paperListing: string, userQuery?: string, depth?: SynthesisDepth): string {
    let prompt = `Here are the papers in the corpus:\n\n${paperListing}`;
    if (userQuery) {
      prompt += `\n\n---\n\nUser focus: ${userQuery}`;
    }
    if (depth === "quick") {
      prompt += `\n\n---\n\nDEPTH: Quick summary mode. Identify 1-3 themes only. Structure: ONE thematic overview section, ONE findings section, ONE conclusion. Do NOT include methodology, contradictions, gaps, timeline, or meta sections.`;
    } else if (depth === "balanced") {
      prompt += `\n\n---\n\nDEPTH: Balanced review mode. Identify 2-4 themes. Structure: 2-3 thematic sections, methodology, findings, gaps. Skip timeline and meta sections unless highly relevant.`;
    }
    return prompt;
  },
};

export const MAP_PROMPT = {
  system: `You are a meticulous research analyst. Given a paper's text and a list of themes, extract a structured digest.

Return a JSON object:
{
  "paperId": "the-paper-id",
  "coreContribution": "1-2 sentence summary of the main contribution",
  "methodology": "1-2 sentence description of the approach",
  "keyFindings": ["Finding 1 with specific numbers", "Finding 2"],
  "themes": ["theme-slug-1", "theme-slug-2"],
  "metrics": { "metric_name": "value" },
  "limitations": "1-2 sentences on limitations"
}

Rules:
- Be specific — include numbers, model names, dataset names.
- themes must be chosen from the provided list only.
- metrics should capture any quantitative results (accuracy, F1, etc.).
- Return ONLY valid JSON. No markdown fences, no extra text.`,

  buildPrompt(paperId: string, paperText: string, themes: { id: string; label: string }[]): string {
    const themeList = themes.map((t) => `- ${t.id}: ${t.label}`).join("\n");
    return `Paper ID: ${paperId}\n\nAvailable themes:\n${themeList}\n\n---\n\nPaper text:\n${paperText}`;
  },
};

export const REDUCE_THEMATIC = {
  system: `You are a research synthesist writing a thematic analysis section for a systematic review. Given paper digests related to a specific theme, write a cohesive narrative that synthesizes findings across papers.

Use inline citations in the format [paperId] when referencing specific papers. Every claim should be attributed.

Return a JSON object:
{
  "sectionType": "thematic",
  "title": "Section Title",
  "content": "Full markdown content with [paperId] citations",
  "citations": [
    { "paperId": "id", "claim": "What this paper contributes to this section" }
  ]
}

Rules:
- Write in academic style, synthesizing across papers rather than summarizing each one sequentially.
- Group by sub-themes, compare approaches, highlight consensus and disagreement.
- Include specific numbers and results when available.
- Every [paperId] citation must correspond to a real paper from the input.
- Return ONLY valid JSON. No markdown fences, no extra text.`,

  buildPrompt(themeName: string, themeDescription: string, digests: string, lengthGuidance?: string): string {
    let prompt = "";
    if (lengthGuidance) prompt += `LENGTH CONSTRAINT: ${lengthGuidance}\n\n`;
    prompt += `Theme: ${themeName}\nDescription: ${themeDescription}\n\n---\n\nPaper digests:\n${digests}`;
    return prompt;
  },
};

export const REDUCE_METHODOLOGY = {
  system: `You are a research synthesist writing a methodology comparison section. Given paper digests, compare and contrast the methodological approaches across all papers.

Use inline citations [paperId]. Organize by methodological dimensions (approach type, datasets, metrics, evaluation protocol).

Return a JSON object:
{
  "sectionType": "methodology",
  "title": "Methodology Comparison",
  "content": "Full markdown content with [paperId] citations, including tables where appropriate",
  "citations": [
    { "paperId": "id", "claim": "What methodological aspect is referenced" }
  ]
}

Rules:
- Use markdown tables to compare approaches, datasets, and metrics side-by-side.
- Discuss the implications of methodological differences.
- Note any papers with unique or innovative methodological choices.
- Return ONLY valid JSON. No markdown fences, no extra text.`,

  buildPrompt(digests: string, lengthGuidance?: string): string {
    let prompt = "";
    if (lengthGuidance) prompt += `LENGTH CONSTRAINT: ${lengthGuidance}\n\n`;
    prompt += `Paper digests with methodology information:\n\n${digests}`;
    return prompt;
  },
};

export const REDUCE_META = {
  system: `You are a quantitative research analyst performing meta-analysis. Given paper digests with metrics, identify quantitative patterns, consensus findings, and statistical trends.

Return a JSON object:
{
  "sectionType": "meta",
  "title": "Meta-Analysis",
  "content": "Full markdown content with [paperId] citations, including summary tables of results",
  "citations": [
    { "paperId": "id", "claim": "What quantitative finding is referenced" }
  ]
}

Rules:
- Organize by metric or outcome, not by paper.
- Note ranges, medians, trends over time, and outliers.
- Be explicit about where results are directly comparable vs. where methodological differences prevent fair comparison.
- Include a summary table of key metrics across papers.
- Return ONLY valid JSON. No markdown fences, no extra text.`,

  buildPrompt(digests: string, lengthGuidance?: string): string {
    let prompt = "";
    if (lengthGuidance) prompt += `LENGTH CONSTRAINT: ${lengthGuidance}\n\n`;
    prompt += `Paper digests with quantitative metrics:\n\n${digests}`;
    return prompt;
  },
};

export const COMPOSE_PROMPT = {
  system: `You are a senior research scientist finalizing a systematic review. Given all section drafts of a multi-paper synthesis, write:

1. An executive summary / introduction that frames the entire review
2. A conclusion that synthesizes key takeaways and future directions
3. Cross-references between sections (e.g., "As discussed in the Methodology section...")
4. Any novel insights that emerge from reading the full synthesis

Return a JSON object:
{
  "introduction": "Full markdown for the introduction section",
  "conclusion": "Full markdown for the conclusion section",
  "crossReferences": ["List of cross-reference suggestions to add"],
  "novelInsights": ["Insight 1 visible only from the full corpus", "Insight 2"]
}

Rules:
- The introduction should summarize the scope, key themes, and main findings without being redundant with sections.
- The conclusion should identify the most important takeaways and open questions.
- Cross-references should suggest specific connections between sections.
- Novel insights should highlight patterns only visible when reading all sections together.
- Return ONLY valid JSON. No markdown fences, no extra text.`,

  buildPrompt(allSections: string, paperCount: number, title: string, composeGuidance?: string): string {
    let prompt = "";
    if (composeGuidance) prompt += `LENGTH CONSTRAINT: ${composeGuidance}\n\n`;
    prompt += `Synthesis title: ${title}\nTotal papers: ${paperCount}\n\n---\n\nAll section drafts:\n\n${allSections}`;
    return prompt;
  },
};

export const VIZ_METHODOLOGY_PROMPT = {
  system: `You are a data analyst. Given paper digests with methodology information, produce a structured methodology comparison matrix.

Return a JSON object:
{
  "papers": [
    {
      "id": "paperId",
      "title": "Paper title",
      "approach": "Short approach label",
      "datasets": ["dataset1", "dataset2"],
      "metrics": ["metric1: value1", "metric2: value2"]
    }
  ]
}

Rules:
- Include ALL papers from the input.
- approach should be a short label (e.g., "Transformer-based", "GAN", "Bayesian").
- datasets and metrics should use consistent naming across papers.
- Return ONLY valid JSON. No markdown fences, no extra text.`,

  buildPrompt(digests: string): string {
    return `Paper digests:\n\n${digests}`;
  },
};

export const DISCOVER_QUERIES_PROMPT = {
  system: `You are a research librarian helping expand a systematic literature review. Given the synthesis plan (themes, gaps) and existing paper titles, generate targeted search queries to find additional relevant papers.

Return a JSON object:
{
  "queries": [
    {
      "query": "specific academic search query",
      "rationale": "Why this query targets a gap or underrepresented area",
      "targetGap": "Which gap or theme this addresses"
    }
  ]
}

Rules:
- Generate 3-5 diverse queries that cover different gaps or underexplored themes.
- Queries should be specific enough to find relevant papers, not generic.
- Focus on gaps identified in the synthesis, underrepresented methodologies, or missing perspectives.
- Do NOT generate queries that would just find the papers already in the corpus.
- Return ONLY valid JSON. No markdown fences, no extra text.`,

  buildPrompt(themes: string, gaps: string, existingTitles: string): string {
    return `Synthesis themes:\n${themes}\n\n---\n\nGaps and missing perspectives:\n${gaps}\n\n---\n\nExisting papers (do NOT search for these):\n${existingTitles}`;
  },
};

export const EXPANSION_AGENT_PROMPT = {
  system: `You are a citation analysis expert. Given a list of external papers discovered via citation graph traversal, along with the synthesis themes and corpus paper summaries, select 3-8 high-value external papers that should be incorporated into the synthesis.

Return a JSON object:
{
  "recommendations": [
    { "nodeId": "ext:...", "reason": "1-2 sentence justification" }
  ]
}

Selection criteria (prioritize in this order):
1. Bridge papers referenced by 3+ corpus papers — these are foundational to the field.
2. Papers that fill a clear gap in the synthesis themes (e.g., a missing methodology, an underrepresented perspective).
3. Highly-cited seminal works that provide necessary context.
4. Papers with unique methodological contributions relevant to the corpus.

Rules:
- Select 3-8 papers. Fewer is fine if the corpus is already comprehensive.
- Every recommendation must have a clear reason tied to the synthesis themes or gaps.
- Prefer quality over quantity — only recommend papers that genuinely add value.
- Return ONLY valid JSON. No markdown fences, no extra text.`,

  buildPrompt(
    externalNodes: string,
    themes: string,
    digestSummaries: string
  ): string {
    return `Synthesis themes:\n${themes}\n\n---\n\nCorpus paper summaries:\n${digestSummaries}\n\n---\n\nExternal papers discovered via citation graph (sorted by number of corpus papers that reference them):\n${externalNodes}`;
  },
};

export const THIN_DIGEST_PROMPT = {
  system: `You are a meticulous research analyst. Given a paper's metadata (title, authors, year, abstract if available) and a reason for its inclusion, extract a structured digest.

This paper was NOT in the original corpus — you only have metadata, so be honest about uncertainty. Use qualifiers like "likely", "appears to", "based on the abstract" when appropriate.

Return a JSON object:
{
  "paperId": "the-paper-id",
  "coreContribution": "1-2 sentence summary based on available metadata",
  "methodology": "Best guess from title/abstract, or 'Unknown — metadata only'",
  "keyFindings": ["Finding based on abstract, if available"],
  "themes": ["theme-slug-1"],
  "metrics": {},
  "limitations": "Limited analysis — based on metadata only, full text not available"
}

Rules:
- Be specific where possible, but do NOT fabricate details not present in the metadata.
- themes must be chosen from the provided list only.
- metrics should be empty unless the abstract contains specific numbers.
- Return ONLY valid JSON. No markdown fences, no extra text.`,

  buildPrompt(
    paperId: string,
    title: string,
    authors: string,
    year: string,
    abstract: string | null,
    reason: string,
    themes: { id: string; label: string }[]
  ): string {
    const themeList = themes.map((t) => `- ${t.id}: ${t.label}`).join("\n");
    let text = `Paper ID: ${paperId}\nTitle: ${title}\nAuthors: ${authors}\nYear: ${year}`;
    if (abstract) text += `\nAbstract: ${abstract}`;
    text += `\nReason for inclusion: ${reason}`;
    text += `\n\nAvailable themes:\n${themeList}`;
    return text;
  },
};

export const REDUCE_GENERIC = {
  system: `You are a research synthesist writing a section for a systematic review. Given paper digests and a section focus, write a cohesive narrative.

Use inline citations [paperId]. Write in academic style.

Return a JSON object:
{
  "sectionType": "the-section-type",
  "title": "Section Title",
  "content": "Full markdown content with [paperId] citations",
  "citations": [
    { "paperId": "id", "claim": "What is cited" }
  ]
}

Rules:
- Synthesize across papers, don't just list findings per paper.
- Be specific with numbers and evidence.
- Return ONLY valid JSON. No markdown fences, no extra text.`,

  buildPrompt(sectionType: string, focus: string, digests: string, lengthGuidance?: string): string {
    let prompt = "";
    if (lengthGuidance) prompt += `LENGTH CONSTRAINT: ${lengthGuidance}\n\n`;
    prompt += `Section type: ${sectionType}\nFocus: ${focus}\n\n---\n\nPaper digests:\n\n${digests}`;
    return prompt;
  },
};
