export type PromptResultStorageKind = "text" | "json_object" | "json_array";

export interface PromptResultSchemaManifestEntry {
  storage: PromptResultStorageKind;
  description: string;
  consumers: readonly string[];
  requiredKeys?: readonly string[];
  optionalKeys?: readonly string[];
  itemRequiredKeys?: readonly string[];
  itemOptionalKeys?: readonly string[];
}

const promptResultSchemaManifest = {
  extract: {
    storage: "json_object",
    description:
      "Metadata extraction payload. Keys are optional, but renamed keys are a breaking change.",
    consumers: ["src/app/api/papers/[id]/history/restore/route.ts"],
    optionalKeys: [
      "title",
      "authors",
      "year",
      "venue",
      "doi",
      "arxivId",
      "abstract",
      "keyFindings",
      "methodology",
      "contributions",
      "limitations",
    ],
  },
  summarize: {
    storage: "text",
    description: "Markdown/text summary written directly to Paper.summary.",
    consumers: [
      "src/app/api/papers/[id]/history/restore/route.ts",
      "src/app/papers/[id]/page.tsx",
    ],
  },
  categorize: {
    storage: "json_object",
    description: "Tag assignment payload used to restore auto-generated tags.",
    consumers: ["src/app/api/papers/[id]/history/restore/route.ts"],
    requiredKeys: ["tags"],
  },
  detectContradictions: {
    storage: "json_object",
    description: "Cross-paper contradiction analysis.",
    consumers: ["src/components/analysis/cross-paper-insights.tsx"],
    requiredKeys: ["contradictions", "summary"],
    itemRequiredKeys: [
      "newPaperClaim",
      "conflictingPaperId",
      "conflictingPaperClaim",
      "severity",
      "explanation",
    ],
  },
  extractReferences: {
    storage: "json_array",
    description:
      "Structured reference-extraction payload persisted for audit/debug and compatibility history views.",
    consumers: ["src/app/papers/[id]/page.tsx"],
    itemRequiredKeys: ["title", "rawCitation"],
    itemOptionalKeys: ["index", "authors", "year", "venue", "doi"],
  },
  distill: {
    storage: "json_object",
    description: "Mind-palace insight extraction payload.",
    consumers: ["src/lib/llm/auto-process.ts", "src/app/api/papers/[id]/distill/route.ts"],
    requiredKeys: ["insights"],
    itemRequiredKeys: ["learning", "significance"],
    itemOptionalKeys: ["applications", "roomSuggestion"],
  },
  findGaps: {
    storage: "json_object",
    description: "Research-gap analysis across related papers.",
    consumers: ["src/components/analysis/cross-paper-insights.tsx"],
    requiredKeys: ["gaps", "overallAssessment"],
    itemRequiredKeys: [
      "title",
      "description",
      "relevantPaperIds",
      "type",
      "confidence",
    ],
  },
  buildTimeline: {
    storage: "json_object",
    description: "Idea-timeline analysis across related papers.",
    consumers: ["src/components/analysis/cross-paper-insights.tsx"],
    requiredKeys: ["timeline", "narrative", "openQuestions"],
    itemRequiredKeys: [
      "paperId",
      "year",
      "role",
      "contribution",
      "buildsOn",
      "keyAdvance",
    ],
  },
  compareMethodologies: {
    storage: "json_object",
    description: "Methodology comparison payload for the comparator view.",
    consumers: ["src/components/analysis/methodology-comparator.tsx"],
    requiredKeys: ["comparison", "methodologicalDifferences", "verdict"],
  },
  concepts: {
    storage: "json_array",
    description: "Concept hierarchy seed payload.",
    consumers: ["src/app/api/papers/[id]/concepts/route.ts"],
    itemRequiredKeys: ["name", "explanation"],
    itemOptionalKeys: ["prerequisites"],
  },
  code: {
    storage: "text",
    description: "Freeform code-generation response.",
    consumers: ["src/app/api/papers/[id]/llm/code/route.ts"],
  },
  "rewrite-section": {
    storage: "text",
    description: "Rewritten review/methodology/results section.",
    consumers: [
      "src/app/api/papers/[id]/llm/rewrite-section/route.ts",
      "src/app/papers/[id]/page.tsx",
    ],
  },
  custom: {
    storage: "text",
    description: "Freeform custom LLM response.",
    consumers: ["src/app/api/papers/[id]/llm/custom/route.ts"],
  },
} as const satisfies Record<string, PromptResultSchemaManifestEntry>;

export const PROMPT_RESULT_SCHEMA_MANIFEST = promptResultSchemaManifest;
export default promptResultSchemaManifest;

export const PROMPT_RESULT_SCHEMA_TYPES = Object.freeze(
  Object.keys(promptResultSchemaManifest).sort(),
);
