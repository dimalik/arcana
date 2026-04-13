import path from "path";

export const EXPERIMENT_PURPOSES = [
  "SMOKE",
  "SYNTHETIC_PROXY",
  "CALIBRATION",
  "BASELINE",
  "MAIN_EVAL",
  "TRAINING",
  "ANALYSIS",
] as const;

export const EXPERIMENT_GROUNDINGS = [
  "UNSPECIFIED",
  "SYNTHETIC",
  "LOCAL_ARTIFACT",
  "EXTERNAL_DATASET",
  "MODEL_INFERENCE",
  "HUMAN_EVAL",
  "MIXED",
] as const;

export const CLAIM_ELIGIBILITY_LEVELS = [
  "NONE",
  "EXPLORATORY",
  "SUPPORTING",
  "DECISIVE",
] as const;

export const CLAIM_PROMOTION_POLICIES = [
  "NO_CLAIMS",
  "PROVISIONAL_CLAIMS",
  "CLAIMS_ALLOWED",
  "MEMORY_ELIGIBLE",
] as const;

export const EXPERIMENT_EVIDENCE_CLASSES = [
  "NONE",
  "SYNTHETIC_PROXY",
  "EXPLORATORY",
  "SUPPORTING",
  "DECISIVE",
] as const;

export type ExperimentPurpose = (typeof EXPERIMENT_PURPOSES)[number];
export type ExperimentGrounding = (typeof EXPERIMENT_GROUNDINGS)[number];
export type ClaimEligibilityLevel = (typeof CLAIM_ELIGIBILITY_LEVELS)[number];
export type ClaimPromotionPolicy = (typeof CLAIM_PROMOTION_POLICIES)[number];
export type ExperimentEvidenceClass = (typeof EXPERIMENT_EVIDENCE_CLASSES)[number];

export interface PersistedExperimentContract {
  experimentPurpose: ExperimentPurpose;
  grounding: ExperimentGrounding;
  claimEligibility: ClaimEligibilityLevel;
  promotionPolicy: ClaimPromotionPolicy;
  evidenceClass: ExperimentEvidenceClass;
  source: "tool_input" | "script_directive" | "inferred";
}

export interface ExperimentContractInput {
  scriptName: string;
  command?: string | null;
  code?: string | null;
  experimentPurpose?: string | null;
  grounding?: string | null;
  claimEligibility?: string | null;
  promotionPolicy?: string | null;
  evidenceClass?: string | null;
}

type PartialContract = Partial<PersistedExperimentContract>;

const PURPOSE_SET = new Set<string>(EXPERIMENT_PURPOSES);
const GROUNDING_SET = new Set<string>(EXPERIMENT_GROUNDINGS);
const ELIGIBILITY_SET = new Set<string>(CLAIM_ELIGIBILITY_LEVELS);
const PROMOTION_SET = new Set<string>(CLAIM_PROMOTION_POLICIES);
const EVIDENCE_CLASS_SET = new Set<string>(EXPERIMENT_EVIDENCE_CLASSES);

function normalizeEnumValue<T extends string>(value: string | null | undefined, allowed: Set<string>): T | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return allowed.has(normalized) ? normalized as T : null;
}

function baseScriptName(scriptName: string) {
  return path.basename(scriptName).toLowerCase();
}

export function parseExperimentContractDirective(code: string | null | undefined): PartialContract {
  if (!code) return {};

  const directive: PartialContract = {};
  const lines = code.split("\n");
  for (const line of lines) {
    const match = line.match(/^\s*#\s*ARCANA:\s*(.+)$/i);
    if (!match) continue;

    const body = match[1];
    const tokens = body.split(/[,\s]+/).map((token) => token.trim()).filter(Boolean);
    for (const token of tokens) {
      if (!token.includes("=")) continue;
      const [rawKey, rawValue] = token.split("=", 2);
      const key = rawKey.trim().toLowerCase();
      const value = rawValue.trim();

      if (key === "purpose") {
        directive.experimentPurpose = normalizeEnumValue<ExperimentPurpose>(value, PURPOSE_SET) || undefined;
      } else if (key === "grounding") {
        directive.grounding = normalizeEnumValue<ExperimentGrounding>(value, GROUNDING_SET) || undefined;
      } else if (key === "claim_eligibility") {
        directive.claimEligibility = normalizeEnumValue<ClaimEligibilityLevel>(value, ELIGIBILITY_SET) || undefined;
      } else if (key === "promotion_policy") {
        directive.promotionPolicy = normalizeEnumValue<ClaimPromotionPolicy>(value, PROMOTION_SET) || undefined;
      } else if (key === "evidence_class") {
        directive.evidenceClass = normalizeEnumValue<ExperimentEvidenceClass>(value, EVIDENCE_CLASS_SET) || undefined;
      }
    }
  }

  return directive;
}

export function isSyntheticProxyBenchmark(code: string | null | undefined) {
  if (!code) return false;

  const syntheticCorpusSignals = [
    /\bdef\s+(?:make_human|human_text)\s*\(/i,
    /\bdef\s+(?:make_raw_ai|raw_ai_text)\s*\(/i,
    /\bhumans?\s*=\s*\[(?:make_human|human_text)\(/i,
    /\braws?\s*=\s*\[(?:make_raw_ai|raw_ai_text)\(/i,
    /\btemplates\s*=\s*\[/i,
  ];
  const heuristicDetectorSignals = [
    /\bdef\s+(?:primary_detector_score|holdout_detector_score)\s*\(/i,
    /\bdef\s+.*detector_score\s*\(/i,
    /\blexical_diversity\s*\(/i,
    /\bbigram_repeat_rate\s*\(/i,
    /\bcomma_rate\s*\(/i,
    /\bcontent_overlap\s*\(/i,
  ];
  const externalDataSignals = [
    /\bload_dataset\s*\(/i,
    /\bfrom_pretrained\s*\(/i,
    /\bread_csv\s*\(/i,
    /\bjson\.load\s*\(/i,
    /\bpickle\.load\s*\(/i,
    /\bnp\.load\s*\(/i,
    /\bparquet\b/i,
    /\bDataLoader\s*\(/i,
    /\bopen\(\s*[^,]+,\s*["']r/i,
  ];

  const syntheticSignalCount = syntheticCorpusSignals.filter((pattern) => pattern.test(code)).length;
  const detectorSignalCount = heuristicDetectorSignals.filter((pattern) => pattern.test(code)).length;
  const hasExternalDataSource = externalDataSignals.some((pattern) => pattern.test(code));

  return syntheticSignalCount >= 3 && detectorSignalCount >= 2 && !hasExternalDataSource;
}

function inferPurpose(scriptName: string, command: string | null | undefined, code: string | null | undefined) {
  const base = baseScriptName(scriptName);
  if (isSyntheticProxyBenchmark(code)) return "SYNTHETIC_PROXY";
  if (/^analysis_\d+_/i.test(base)) return "ANALYSIS";
  if (/(^|_)(smoke|connection|probe|check|test)(_|\.|$)/i.test(base)) return "SMOKE";
  if (/^poc_\d+_/i.test(base)) return "CALIBRATION";
  if (/^exp_\d+_/.test(base) && /baseline/i.test(base)) return "BASELINE";
  if (/^exp_\d+_/.test(base) && /(train|trainer|grpo|dpo|ppo|sft|lora|finetune)/i.test(base)) return "TRAINING";
  if (/^exp_\d+_/.test(base)) return "MAIN_EVAL";
  if (command && /\bpython3?\s+analysis_/i.test(command)) return "ANALYSIS";
  return "MAIN_EVAL";
}

function inferGrounding(code: string | null | undefined, purpose: ExperimentPurpose): ExperimentGrounding {
  if (isSyntheticProxyBenchmark(code)) return "SYNTHETIC";
  if (!code) {
    return purpose === "ANALYSIS" ? "LOCAL_ARTIFACT" : "UNSPECIFIED";
  }

  const hasExternalDataset =
    /\bload_dataset\s*\(/i.test(code)
    || /\btorchvision\.datasets\b/i.test(code)
    || /\bdatasets\.[A-Za-z_]+\(/i.test(code);
  const hasLocalArtifact =
    /\bread_csv\s*\(/i.test(code)
    || /\bjson\.load\s*\(/i.test(code)
    || /\bpickle\.load\s*\(/i.test(code)
    || /\bnp\.load\s*\(/i.test(code)
    || /\bparquet\b/i.test(code)
    || /\bopen\(\s*[^,]+,\s*["']r/i.test(code);
  const hasModelInference =
    /\bfrom_pretrained\s*\(/i.test(code)
    || /\bpipeline\s*\(/i.test(code)
    || /\bgenerate\s*\(/i.test(code);
  const hasHumanEval =
    /\bhuman[_ -]?eval\b/i.test(code)
    || /\bannotator\b/i.test(code)
    || /\bmturk\b/i.test(code)
    || /\blabel\s+studio\b/i.test(code);

  const activeSignals = [
    hasExternalDataset,
    hasLocalArtifact,
    hasModelInference,
    hasHumanEval,
  ].filter(Boolean).length;

  if (activeSignals >= 2) return "MIXED";
  if (hasHumanEval) return "HUMAN_EVAL";
  if (hasExternalDataset) return "EXTERNAL_DATASET";
  if (hasLocalArtifact) return "LOCAL_ARTIFACT";
  if (hasModelInference) return "MODEL_INFERENCE";
  if (purpose === "ANALYSIS") return "LOCAL_ARTIFACT";
  return "UNSPECIFIED";
}

function deriveClaimEligibility(purpose: ExperimentPurpose, grounding: ExperimentGrounding): ClaimEligibilityLevel {
  if (purpose === "ANALYSIS" || purpose === "SMOKE") return "NONE";
  if (purpose === "SYNTHETIC_PROXY" || purpose === "CALIBRATION") return "EXPLORATORY";
  if (grounding === "SYNTHETIC") return "EXPLORATORY";
  if (purpose === "BASELINE" || purpose === "TRAINING") return "SUPPORTING";
  return "DECISIVE";
}

function derivePromotionPolicy(eligibility: ClaimEligibilityLevel): ClaimPromotionPolicy {
  if (eligibility === "NONE") return "NO_CLAIMS";
  if (eligibility === "EXPLORATORY") return "PROVISIONAL_CLAIMS";
  if (eligibility === "SUPPORTING") return "CLAIMS_ALLOWED";
  return "MEMORY_ELIGIBLE";
}

function deriveEvidenceClass(
  purpose: ExperimentPurpose,
  grounding: ExperimentGrounding,
  eligibility: ClaimEligibilityLevel,
): ExperimentEvidenceClass {
  if (eligibility === "NONE" || purpose === "ANALYSIS" || purpose === "SMOKE") return "NONE";
  if (grounding === "SYNTHETIC" || purpose === "SYNTHETIC_PROXY") return "SYNTHETIC_PROXY";
  if (eligibility === "EXPLORATORY") return "EXPLORATORY";
  if (eligibility === "SUPPORTING") return "SUPPORTING";
  return "DECISIVE";
}

export function resolveExperimentContract(input: ExperimentContractInput): PersistedExperimentContract {
  const explicitPurpose = normalizeEnumValue<ExperimentPurpose>(input.experimentPurpose, PURPOSE_SET);
  const explicitGrounding = normalizeEnumValue<ExperimentGrounding>(input.grounding, GROUNDING_SET);
  const explicitEligibility = normalizeEnumValue<ClaimEligibilityLevel>(input.claimEligibility, ELIGIBILITY_SET);
  const explicitPromotion = normalizeEnumValue<ClaimPromotionPolicy>(input.promotionPolicy, PROMOTION_SET);
  const explicitEvidenceClass = normalizeEnumValue<ExperimentEvidenceClass>(input.evidenceClass, EVIDENCE_CLASS_SET);
  const directives = parseExperimentContractDirective(input.code);

  const experimentPurpose =
    explicitPurpose
    || directives.experimentPurpose
    || inferPurpose(input.scriptName, input.command, input.code);
  const grounding =
    explicitGrounding
    || directives.grounding
    || inferGrounding(input.code, experimentPurpose);
  const claimEligibility =
    explicitEligibility
    || directives.claimEligibility
    || deriveClaimEligibility(experimentPurpose, grounding);
  const promotionPolicy =
    explicitPromotion
    || directives.promotionPolicy
    || derivePromotionPolicy(claimEligibility);
  const evidenceClass =
    explicitEvidenceClass
    || directives.evidenceClass
    || deriveEvidenceClass(experimentPurpose, grounding, claimEligibility);

  const source =
    explicitPurpose || explicitGrounding || explicitEligibility || explicitPromotion || explicitEvidenceClass
      ? "tool_input"
      : Object.keys(directives).length > 0
        ? "script_directive"
        : "inferred";

  return {
    experimentPurpose,
    grounding,
    claimEligibility,
    promotionPolicy,
    evidenceClass,
    source,
  };
}

export function allowsSyntheticProxyExecution(
  contract: Pick<PersistedExperimentContract, "experimentPurpose" | "grounding" | "source">,
) {
  return contract.source !== "inferred"
    && (contract.experimentPurpose === "SYNTHETIC_PROXY" || contract.grounding === "SYNTHETIC");
}

export function isClaimBearingExperiment(contract: Pick<PersistedExperimentContract, "claimEligibility">) {
  return contract.claimEligibility === "SUPPORTING" || contract.claimEligibility === "DECISIVE";
}

export function claimEvidenceStrengthForExperiment(
  contract: Pick<PersistedExperimentContract, "evidenceClass">,
  supports: boolean,
): "DIRECT" | "INDIRECT" | "CONTEXT" | "REBUTTAL" {
  if (!supports) return "REBUTTAL";
  if (contract.evidenceClass === "DECISIVE" || contract.evidenceClass === "SUPPORTING") return "DIRECT";
  if (contract.evidenceClass === "EXPLORATORY") return "INDIRECT";
  return "CONTEXT";
}
