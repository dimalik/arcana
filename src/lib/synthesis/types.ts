export type SynthesisDepth = "quick" | "balanced" | "deep";

export interface DepthConfig {
  maxThemes: number;
  sectionTypes: string[];
  tokensPerSection: number;
  lengthGuidance: string;
  composeGuidance: string;
}

export const DEPTH_CONFIGS: Record<SynthesisDepth, DepthConfig> = {
  quick: {
    maxThemes: 3,
    sectionTypes: ["thematic", "findings", "conclusion"],
    tokensPerSection: 2000,
    lengthGuidance:
      "Write 150-250 words. Be direct — key points only, no exhaustive enumeration.",
    composeGuidance:
      "Write a 2-3 sentence introduction and a 2-3 sentence conclusion. Keep it concise.",
  },
  balanced: {
    maxThemes: 4,
    sectionTypes: ["thematic", "methodology", "findings", "gaps"],
    tokensPerSection: 4000,
    lengthGuidance:
      "Write 400-600 words. Cover main points with supporting evidence.",
    composeGuidance:
      "Write a focused introduction (1-2 paragraphs) and conclusion (1-2 paragraphs).",
  },
  deep: {
    maxThemes: 8,
    sectionTypes: [
      "thematic",
      "methodology",
      "findings",
      "contradictions",
      "gaps",
      "timeline",
      "meta",
    ],
    tokensPerSection: 8000,
    lengthGuidance: "",
    composeGuidance: "",
  },
};

export interface SynthesisPlan {
  themes: { id: string; label: string; description: string }[];
  structure: { sectionType: string; focus: string; themes?: string[] }[];
  paperClusters: Record<string, string[]>; // themeId -> paperIds
}

export interface PaperDigest {
  paperId: string;
  coreContribution: string;
  methodology: string;
  keyFindings: string[];
  themes: string[];
  metrics: Record<string, string>;
  limitations: string;
}

export interface SectionDraft {
  sectionType: string;
  title: string;
  content: string;
  citations: { paperId: string; claim: string }[];
}

export interface FigureSpec {
  chartType: "bar" | "line" | "scatter" | "grouped_bar";
  title: string;
  caption: string;
  xAxis: { label: string; key: string };
  yAxis: { label: string; key: string };
  data: Record<string, string | number>[];
  series?: { key: string; label: string; color?: string }[];
}

export interface CitationGraphNode {
  id: string;              // corpus: paper DB ID, external: "ext:doi:..." or "ext:arxiv:..."
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  abstract: string | null;
  citationCount: number | null;
  externalUrl: string | null;
  isCorpus: boolean;
  corpusConnectionCount: number;
}

export interface CitationGraph {
  nodes: CitationGraphNode[];
  edges: { source: string; target: string }[];
}

export interface ThinDigest extends PaperDigest {
  isThin: true;
  externalId: string;
}

export interface Guidance {
  synthesisType?: string | null;
  focusAreas?: string[];
  additionalThemes?: { id: string; label: string; description: string }[];
  removedThemes?: string[];
  sectionOverrides?: { sectionType: string; focus: string; themes?: string[] }[] | null;
  methodologyEmphasis?: "high" | "medium" | "low";
  additionalNotes?: string;
}

export interface VizData {
  timeline: { year: number; count: number; papers: { id: string; title: string }[] }[];
  themes: { theme: string; count: number; color: string }[];
  methodologyMatrix: {
    papers: { id: string; title: string; approach: string; datasets: string[]; metrics: string[] }[];
  };
  citationNetwork: {
    nodes: { id: string; label: string; isCorpus?: boolean; corpusConnections?: number }[];
    edges: { source: string; target: string }[];
  };
  figures?: FigureSpec[];
}
