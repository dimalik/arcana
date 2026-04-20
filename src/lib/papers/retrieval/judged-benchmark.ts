import { z } from "zod";

export const judgedTaskSchema = z.enum([
  "claims",
  "related-papers",
  "search",
  "recommendations",
]);

export const judgedSplitSchema = z.enum(["dev", "holdout"]);

export const paperLocatorSchema = z.object({
  title: z.string().min(1),
  doi: z.string().min(1).optional(),
  arxivId: z.string().min(1).optional(),
  semanticScholarId: z.string().min(1).optional(),
});

export const judgedLabelSchema = z.object({
  title: z.string().min(1),
  doi: z.string().min(1).optional(),
  arxivId: z.string().min(1).optional(),
  relevance: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  subtopics: z.array(z.string()).default([]),
  novelty: z.number().min(0).max(1).optional(),
  notes: z.string().optional(),
});

export const claimsJudgmentSchema = z.object({
  claimId: z.string().min(1),
  text: z.string().min(1),
  rhetoricalRole: z.string().min(1),
  facet: z.string().min(1),
  polarity: z.string().min(1),
  evaluationContext: z
    .object({
      task: z.string().min(1).optional(),
      dataset: z.string().min(1).optional(),
      metric: z.string().min(1).optional(),
      comparator: z.string().min(1).optional(),
      setting: z.string().min(1).optional(),
      split: z.string().min(1).optional(),
    })
    .optional(),
  sourceSpan: z
    .object({
      charStart: z.number().int().nonnegative(),
      charEnd: z.number().int().nonnegative(),
    })
    .optional(),
});

export const claimsJudgedSetSchema = z.object({
  task: z.literal("claims"),
  split: judgedSplitSchema,
  status: z.enum(["draft", "ready"]),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      domain: z.string().min(1),
      paper: paperLocatorSchema,
      judgments: z.array(claimsJudgmentSchema),
      notes: z.string().optional(),
    }),
  ),
});

export const relatedJudgedSetSchema = z.object({
  task: z.literal("related-papers"),
  split: judgedSplitSchema,
  status: z.enum(["draft", "ready"]),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      caseClass: z.enum([
        "hub",
        "niche",
        "ambiguous-title",
        "cross-community",
      ]),
      seed: paperLocatorSchema,
      judgments: z.array(judgedLabelSchema),
      notes: z.string().optional(),
    }),
  ),
});

export const searchJudgedSetSchema = z.object({
  task: z.literal("search"),
  split: judgedSplitSchema,
  status: z.enum(["draft", "ready"]),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      query: z.string().min(1),
      queryClass: z.enum([
        "doi-exact",
        "arxiv-exact",
        "full-title",
        "partial-title",
        "author",
        "concept",
      ]),
      judgments: z.array(judgedLabelSchema),
      notes: z.string().optional(),
    }),
  ),
});

export const recommendationsJudgedSetSchema = z.object({
  task: z.literal("recommendations"),
  split: judgedSplitSchema,
  status: z.enum(["draft", "ready"]),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      caseClass: z.enum([
        "single-interest",
        "multi-interest",
        "hub-heavy",
        "new-to-field",
      ]),
      profileDescription: z.string().min(1),
      seedPapers: z.array(paperLocatorSchema).min(1),
      judgments: z.array(judgedLabelSchema),
      notes: z.string().optional(),
    }),
  ),
});

export const agreementArtifactSchema = z.object({
  task: judgedTaskSchema,
  split: judgedSplitSchema,
  status: z.enum(["draft", "ready"]),
  agreementMetric: z.enum(["cohen_kappa", "percent_agreement"]),
  agreementValue: z.number().min(0).max(1).nullable(),
  annotatorsPerCase: z.number().int().min(2),
  adjudicatedCaseCount: z.number().int().nonnegative(),
});

export const devAgreementArtifactSchema = agreementArtifactSchema.extend({
  split: z.literal("dev"),
});

export const benchmarkBudgetsSchema = z.object({
  search: z.object({
    apiP95Ms: z.number().positive(),
    rerankerP95Ms: z.number().positive(),
    candidateCap: z.number().int().positive(),
    costP95Usd: z.number().positive(),
    degradedPath: z.string().min(1),
  }),
  related: z.object({
    cacheP95Ms: z.number().positive(),
    candidateCap: z.number().int().positive(),
    costP95UsdAmortized: z.number().positive(),
    cacheTtlDays: z.number().int().positive(),
    degradedPath: z.string().min(1),
  }),
  recommendations: z.object({
    freshnessSlaHours: z.number().int().positive(),
    readP95Ms: z.number().positive(),
    costP95UsdPerUserDay: z.number().positive(),
    degradedPath: z.string().min(1),
  }),
});

const floorMetricSchema = z.record(z.string(), z.number().nullable());

export const benchmarkFloorsSchema = z.object({
  status: z.enum(["draft", "ready"]),
  tasks: z.object({
    claims: z.object({
      dev: floorMetricSchema,
      holdout: floorMetricSchema,
    }),
    relatedPapers: z.object({
      dev: floorMetricSchema,
      holdout: floorMetricSchema,
    }),
    search: z.object({
      dev: floorMetricSchema,
      holdout: floorMetricSchema,
    }),
    recommendations: z.object({
      dev: floorMetricSchema,
      holdout: floorMetricSchema,
    }),
  }),
});

export const judgedSetSchemas = {
  claims: claimsJudgedSetSchema,
  "related-papers": relatedJudgedSetSchema,
  search: searchJudgedSetSchema,
  recommendations: recommendationsJudgedSetSchema,
} as const;

export type JudgedTask = z.infer<typeof judgedTaskSchema>;
