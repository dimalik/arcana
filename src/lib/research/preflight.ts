/**
 * Pre-flight experiment code validator.
 *
 * Scans Python scripts before remote submission and catches antipatterns
 * that waste GPU time: dataset trimming, disabled multi-GPU, tiny batches.
 *
 * Returns violations that BLOCK submission — the agent must fix them first.
 */

import { readFile } from "fs/promises";
import path from "path";
import {
  allowsSyntheticProxyExecution,
  isSyntheticProxyBenchmark,
  resolveExperimentContract,
  type ExperimentGrounding,
  type ExperimentPurpose,
} from "./experiment-contracts";

export interface PreflightViolation {
  severity: "error" | "warning";
  code: string;
  message: string;
  line: number;
  fix: string;
}

export interface PreflightResult {
  ok: boolean;
  violations: PreflightViolation[];
  summary: string;
}

type ScriptValidationProfile = {
  kind: "poc" | "experiment" | "analysis" | "python";
  enforceResearchScaleChecks: boolean;
};

const STRICT_SEMANTIC_IMPORT_PATTERN = /\b(?:from|import)\s+(torch|transformers|trl|accelerate|deepspeed|peft|bitsandbytes|datasets|sentence_transformers|sklearn)\b/i;
const STRICT_SEMANTIC_USAGE_PATTERN = /\b(torch\.cuda|CUDA_VISIBLE_DEVICES|AutoModel|AutoTokenizer|Trainer\s*\(|GRPOTrainer\s*\(|DPOTrainer\s*\(|PPOTrainer\s*\(|SFTTrainer\s*\(|device_map\s*=|deepspeed|accelerate)\b/i;

/**
 * Validate an experiment script before submission.
 * @param workDir - The experiment directory (synced to remote)
 * @param command - The command being run (e.g., "python3 exp_030.py")
 * @param gpuCount - Number of GPUs available on the target host
 */
export async function validateExperiment(
  workDir: string,
  command: string,
  gpuCount: number,
  contractOverride?: {
    experimentPurpose?: ExperimentPurpose | null;
    grounding?: ExperimentGrounding | null;
  },
): Promise<PreflightResult> {
  // Extract script filename from command
  const scriptMatch = command.match(/python3?\s+(\S+\.py)/);
  if (!scriptMatch) {
    return { ok: true, violations: [], summary: "Non-Python command, skipping validation." };
  }

  const scriptName = scriptMatch[1];
  const scriptPath = path.join(workDir, scriptName);

  let code: string;
  try {
    code = await readFile(scriptPath, "utf-8");
  } catch {
    return { ok: true, violations: [], summary: `Could not read ${scriptName}, skipping validation.` };
  }

  const lines = code.split("\n");
  const violations: PreflightViolation[] = [];
  const profile = getScriptValidationProfile(scriptName);
  const contract = resolveExperimentContract({
    scriptName,
    command,
    code,
    experimentPurpose: contractOverride?.experimentPurpose,
    grounding: contractOverride?.grounding,
  });

  // ── Python syntax check — catches SyntaxError before burning GPU time ──
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("python3", ["-c", `import ast; ast.parse(open(${JSON.stringify(scriptPath)}).read())`], { timeout: 5000 });
  } catch (syntaxErr) {
    const msg = syntaxErr instanceof Error ? (syntaxErr as { stderr?: string }).stderr || syntaxErr.message : "Unknown syntax error";
    violations.push({
      severity: "error",
      code: "SYNTAX_ERROR",
      message: `Python syntax error: ${msg.split("\n").filter(Boolean).slice(-2).join(" ")}`,
      line: 1,
      fix: "Fix the syntax error in the script before submitting.",
    });
    // Return immediately — no point checking other things if syntax is broken
    return { ok: false, violations, summary: violations.map(v => `[${v.code}] ${v.message}\n  Fix: ${v.fix}`).join("\n") };
  }

  // ── Resolve top-level constants to their numeric values ────────
  const constants = resolveConstants(lines);

  // ── Semantic/API safety checks (always enforced) ────────────────
  checkSemanticApiContracts(lines, code, gpuCount, violations);

  // ── Infrastructure management detection (always enforced) ───────
  checkPathManagement(lines, violations);

  if (profile.enforceResearchScaleChecks) {
    // ── Dataset trimming checks ───────────────────────────────────
    checkDatasetTrimming(lines, constants, violations);

    // ── Multi-GPU checks ──────────────────────────────────────────
    if (gpuCount > 1) {
      checkMultiGpu(lines, code, gpuCount, violations);
    }

    // ── Batch size checks ─────────────────────────────────────────
    checkBatchSizes(lines, constants, gpuCount, violations);

    // ── Manual GPU pinning checks ───────────────────────────────
    if (gpuCount > 1) {
      checkManualGpuPinning(lines, code, gpuCount, violations);
    }

    // ── Statistical rigor checks ──────────────────────────────────
    checkStatisticalRigor(lines, code, violations);

    // ── Script substance quality gate ─────────────────────────────
    checkScriptSubstance(lines, code, violations);

    // ── Synthetic proxy benchmark detection ──────────────────────
    checkSyntheticProxyBenchmarks(lines, code, violations, contract);
  }

  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");

  if (errors.length === 0 && warnings.length === 0) {
    return { ok: true, violations: [], summary: "Pre-flight checks passed." };
  }

  const parts: string[] = [];
  if (errors.length > 0) {
    parts.push(`${errors.length} ERROR(s) — MUST FIX before running:`);
    for (const e of errors) {
      parts.push(`  [${e.code}] Line ${e.line}: ${e.message}`);
      parts.push(`    Fix: ${e.fix}`);
    }
  }
  if (warnings.length > 0) {
    parts.push(`${warnings.length} WARNING(s):`);
    for (const w of warnings) {
      parts.push(`  [${w.code}] Line ${w.line}: ${w.message}`);
      parts.push(`    Fix: ${w.fix}`);
    }
  }

  return {
    ok: errors.length === 0,
    violations,
    summary: parts.join("\n"),
  };
}

/**
 * Reject experiment scripts that fabricate both sides of the benchmark in code
 * and score them with hand-written detector heuristics. Those are useful for
 * toy debugging, but they are not acceptable as main experiment evidence
 * unless the project explicitly opts into synthetic-benchmark methodology.
 */
function checkSyntheticProxyBenchmarks(
  lines: string[],
  code: string,
  violations: PreflightViolation[],
  contract: {
    experimentPurpose: ExperimentPurpose;
    grounding: ExperimentGrounding;
    source: "tool_input" | "script_directive" | "inferred";
  },
) {
  const hasExplicitSyntheticOptIn = /ARCANA_ALLOW_SYNTHETIC_BENCHMARK\s*=\s*True/.test(code)
    || /#\s*ARCANA:\s*allow-synthetic-benchmark/i.test(code);

  if (hasExplicitSyntheticOptIn || allowsSyntheticProxyExecution(contract)) return;

  if (isSyntheticProxyBenchmark(code)) {
    const firstLine = lines.findIndex((line) =>
      /\bdef\s+(?:make_human|human_text|make_raw_ai|raw_ai_text|primary_detector_score|holdout_detector_score)\s*\(/i.test(line),
    );
    violations.push({
      severity: "error",
      code: "SYNTHETIC_PROXY_BENCHMARK",
      message: "Script appears to fabricate both the benchmark texts and the detector scoring logic in-process. This is a synthetic proxy benchmark, not a real experiment.",
      line: firstLine >= 0 ? firstLine + 1 : 1,
      fix: "Use an external benchmark/data source and an externally grounded detector or model pipeline. If this is intentionally synthetic/proxy work, declare it explicitly with '# ARCANA: purpose=synthetic_proxy grounding=synthetic' (or ARCANA_ALLOW_SYNTHETIC_BENCHMARK=True) so it stays exploratory instead of entering the main experiment track.",
    });
  }
}

function getScriptValidationProfile(scriptName: string): ScriptValidationProfile {
  const normalized = scriptName.replace(/\\/g, "/").split("/").pop() ?? scriptName;
  if (/^poc_\d+_/i.test(normalized)) {
    return { kind: "poc", enforceResearchScaleChecks: false };
  }
  if (/^exp_\d+_/i.test(normalized)) {
    return { kind: "experiment", enforceResearchScaleChecks: true };
  }
  if (/^analysis_\d+_/i.test(normalized)) {
    return { kind: "analysis", enforceResearchScaleChecks: true };
  }
  return { kind: "python", enforceResearchScaleChecks: true };
}

export function requiresBlockingSemanticAnalysis(scriptName: string, code: string): boolean {
  if (!scriptName.endsWith(".py")) return false;
  return STRICT_SEMANTIC_IMPORT_PATTERN.test(code) || STRICT_SEMANTIC_USAGE_PATTERN.test(code);
}

// ── Constant Resolution ──────────────────────────────────────────

/**
 * Scan for top-level constant assignments like `N_TRAIN = 120` or `BATCH_SIZE = 4`.
 * Returns a map from constant name → { value, line }.
 * This lets later checks resolve `[:N_TRAIN]` → `[:120]`.
 */
function resolveConstants(lines: string[]): Map<string, { value: number; line: number }> {
  const constants = new Map<string, { value: number; line: number }>();
  // Match: `SOME_VAR = 123` or `some_var = 123` at the start of a line (no leading spaces = top-level)
  // Also match with type hints: `SOME_VAR: int = 123`
  const constPattern = /^([A-Za-z_]\w*)\s*(?::\s*\w+\s*)?=\s*(\d+)\s*(?:#.*)?$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("#")) continue;
    // Only match top-level (no indentation) or minimal indentation
    if (line.startsWith("  ") || line.startsWith("\t")) continue;

    const m = constPattern.exec(line);
    if (m) {
      constants.set(m[1], { value: parseInt(m[2]), line: i + 1 });
    }
  }
  return constants;
}

// ── Checks ────────────────────────────────────────────────────────

/** Detect dataset slicing to small sizes (the #1 problem). */
function checkDatasetTrimming(lines: string[], constants: Map<string, { value: number; line: number }>, violations: PreflightViolation[]) {
  // Patterns that indicate dataset trimming:
  // 1. data[:N] where N < 1000 (on training-like variables)
  // 2. n_train=N, max_train=N, max_samples=N where N < 1000
  // 3. .head(N), .sample(N) where N < 1000

  const dataVarPattern = /\b(train|data|dataset|texts|examples|samples|corpus|sft|dpo|grpo|rl_data)\w*\s*(?:=.*)?(\[:\d+\])/i;
  const smallSlicePattern = /\[:(\d+)\]/g;
  const paramPattern = /\b(n_train|max_train|max_samples|num_train|train_size|max_examples|n_examples|n_test|n_eval|n_calib|num_test|num_eval|test_size|eval_size|num_calib|max_eval|max_test)\s*[=:]\s*(\d+)/i;
  const argparseDefaultPattern = /add_argument\(\s*["']--(n_train|max_train|max_samples|num_train|train_size|max_examples|n_examples|n_test|n_eval|n_calib|num_test|num_eval|test_size|eval_size|num_calib|max_eval|max_test)["'][^)]*?\bdefault\s*=\s*(\d+)/i;
  const headSamplePattern = /\.(head|sample)\((\d+)\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments
    if (line.trim().startsWith("#")) continue;

    // Check small slice on data variables
    const dataMatch = dataVarPattern.exec(line);
    if (dataMatch) {
      const sliceMatch = /\[:(\d+)\]/.exec(line);
      if (sliceMatch) {
        const n = parseInt(sliceMatch[1]);
        if (n < 1000) {
          violations.push({
            severity: "error",
            code: "SMALL_DATASET",
            message: `Dataset sliced to ${n} samples. This is too small for meaningful results.`,
            line: lineNum,
            fix: `Use the FULL dataset or at minimum 1000+ samples. If memory is an issue, use streaming: load_dataset(..., streaming=True). If you need a subset for debugging, name the script with 'debug' prefix and run the full version as the real experiment.`,
          });
        }
      }
    }

    // Check parameter-based limits
    const paramMatch = paramPattern.exec(line);
    if (paramMatch) {
      const n = parseInt(paramMatch[2]);
      if (n < 1000) {
        const paramName = paramMatch[1];
        const isEval = /test|eval|calib|val/i.test(paramName);
        violations.push({
          severity: "error",
          code: isEval ? "SMALL_EVAL_SIZE" : "SMALL_TRAIN_SIZE",
          message: `${isEval ? "Evaluation" : "Training"} size limited to ${n} via '${paramName}=${n}'. This produces unreliable results.`,
          line: lineNum,
          fix: isEval
            ? `Increase to at least 500+ for evaluation. Small eval sets produce unreliable metrics.`
            : `Remove the hard cap or increase to the full dataset size. Use streaming/lazy loading if memory is a concern.`,
        });
      }
    }

    const argparseMatch = argparseDefaultPattern.exec(line);
    if (argparseMatch) {
      const paramName = argparseMatch[1];
      const n = parseInt(argparseMatch[2]);
      if (n < 1000) {
        const isEval = /test|eval|calib|val/i.test(paramName);
        violations.push({
          severity: "error",
          code: isEval ? "SMALL_EVAL_SIZE" : "SMALL_TRAIN_SIZE",
          message: `${isEval ? "Evaluation" : "Training"} CLI default '${paramName}' is ${n}. This bakes an undersized run into the experiment script.`,
          line: lineNum,
          fix: isEval
            ? `Raise the default ${paramName} to at least 500+ for evaluation, or remove the cap entirely.`
            : `Raise the default ${paramName} to the full dataset scale (1000+ minimum), or remove the cap entirely.`,
        });
      }
    }

    // Check .head() / .sample() with small N
    const hsMatch = headSamplePattern.exec(line);
    if (hsMatch) {
      const n = parseInt(hsMatch[2]);
      if (n < 1000 && !line.includes("display") && !line.includes("print") && !line.includes("log")) {
        violations.push({
          severity: "warning",
          code: "SMALL_SUBSET",
          message: `.${hsMatch[1]}(${n}) limits data to ${n} samples.`,
          line: lineNum,
          fix: `Use the full dataset. .head()/.sample() are for exploration, not experiments.`,
        });
      }
    }
  }

  // Check constants whose names suggest dataset sizes
  const dataSizeConstNames = /^(n_train|n_test|n_eval|n_calib|n_val|num_train|num_test|num_eval|num_val|num_calib|train_size|test_size|eval_size|val_size|max_train|max_test|max_eval|max_samples|max_examples|n_examples|n_samples)$/i;
  constants.forEach(({ value, line }, name) => {
    if (dataSizeConstNames.test(name) && value < 1000) {
      const isTest = /test|eval|calib|val/i.test(name);
      if (!violations.some((v) => v.line === line)) {
        violations.push({
          severity: "error",
          code: isTest ? "SMALL_EVAL_SIZE" : "SMALL_TRAIN_SIZE",
          message: `${name}=${value} limits ${isTest ? "evaluation" : "training"} to only ${value} samples.`,
          line,
          fix: isTest
            ? `Increase ${name} to at least 500+ for evaluation. Small eval sets produce unreliable metrics.`
            : `Increase ${name} to use the full dataset (1000+ minimum). Use streaming if memory is a concern.`,
        });
      }
    }
  });

  // Check for variable-based slicing: `data[:N_TRAIN]` where N_TRAIN is a resolved constant
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    if (line.trim().startsWith("#")) continue;
    if (violations.some((v) => v.line === lineNum)) continue;

    // Match `something[:VARIABLE_NAME]`
    const varSlicePattern = /(\w+)\[:([A-Za-z_]\w*)\]/g;
    let vsMatch;
    while ((vsMatch = varSlicePattern.exec(line)) !== null) {
      const constName = vsMatch[2];
      const resolved = constants.get(constName);
      if (resolved && resolved.value < 1000) {
        violations.push({
          severity: "error",
          code: "SMALL_DATASET_VIA_CONST",
          message: `Dataset sliced via '${constName}=${resolved.value}' (defined at line ${resolved.line}). Only ${resolved.value} samples.`,
          line: lineNum,
          fix: `Increase ${constName} to use the full dataset (1000+ minimum). The constant is defined at line ${resolved.line}.`,
        });
        break; // One violation per line is enough
      }
    }
  }

  // Also check for generic small slice patterns that don't match data variables
  // but are clearly data-related from context
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    if (line.trim().startsWith("#")) continue;

    // Pattern: variable[:N] where N < 500 and context suggests data
    const contextSlice = /(\w+)\[:(\d+)\]/.exec(line);
    if (contextSlice && !line.includes("text[") && !line.includes("string[") && !line.includes("prompt[")) {
      const varName = contextSlice[1].toLowerCase();
      const n = parseInt(contextSlice[2]);
      // Only flag if the variable name suggests data AND it's very small
      if (n <= 200 && (varName.includes("ai") || varName.includes("human") || varName.includes("eval") || varName.includes("test") || varName.includes("calib"))) {
        // Check we haven't already flagged this line
        if (!violations.some((v) => v.line === lineNum)) {
          violations.push({
            severity: "error",
            code: "SMALL_EVAL_SET",
            message: `Evaluation/test data limited to ${n} samples via '${contextSlice[1]}[:${n}]'.`,
            line: lineNum,
            fix: `Use at least 500+ samples for evaluation. Small eval sets produce unreliable metrics with wide confidence intervals.`,
          });
        }
      }
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineNumberAtOffset(code: string, offset: number): number {
  return code.slice(0, offset).split("\n").length;
}

function findAutoDeviceMapModels(code: string): Array<{ name: string; line: number }> {
  const models = new Map<string, number>();
  const pattern = /([A-Za-z_]\w*)\s*=\s*[A-Za-z0-9_\.]+\.from_pretrained\(([\s\S]{0,1200}?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const [, name, args] = match;
    if (!/device_map\s*=\s*["']auto["']/i.test(args)) continue;
    if (!models.has(name)) {
      models.set(name, lineNumberAtOffset(code, match.index));
    }
  }
  return Array.from(models.entries()).map(([name, line]) => ({ name, line }));
}

function findSingleCudaAliases(lines: string[]): Set<string> {
  const aliases = new Set<string>();
  const aliasPattern = /^\s*([A-Za-z_]\w*)\s*=\s*["']cuda:\d+["']\s*(?:#.*)?$/;
  for (const line of lines) {
    const match = aliasPattern.exec(line);
    if (match) aliases.add(match[1]);
  }
  return aliases;
}

function checkSemanticApiContracts(
  lines: string[],
  code: string,
  gpuCount: number,
  violations: PreflightViolation[],
) {
  const apiRules: Array<{
    code: string;
    pattern: RegExp;
    message: string;
    fix: string;
  }> = [
    {
      code: "INVALID_TORCH_CUDA_PROPERTY",
      pattern: /\b(?:torch\.)?cuda\.get_device_properties\([^)]*\)\.total_mem\b/,
      message: "PyTorch CUDA device properties expose 'total_memory', not 'total_mem'.",
      fix: "Replace '.total_mem' with '.total_memory' before submitting the script.",
    },
  ];
  const autoDeviceMapModels = findAutoDeviceMapModels(code);
  const singleCudaAliases = findSingleCudaAliases(lines);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    for (const rule of apiRules) {
      if (rule.pattern.test(line)) {
        violations.push({
          severity: "error",
          code: rule.code,
          message: rule.message,
          line: i + 1,
          fix: rule.fix,
        });
        break;
      }
    }

    if (autoDeviceMapModels.length > 0) {
      for (const model of autoDeviceMapModels) {
        const escapedName = escapeRegExp(model.name);
        if (
          new RegExp(String.raw`\.to\(\s*${escapedName}\.device\s*\)`).test(line)
          || new RegExp(String.raw`to\(\s*next\(\s*${escapedName}\.parameters\(\)\s*\)\.device\s*\)`).test(line)
        ) {
          violations.push({
            severity: "error",
            code: "SHARDED_MODEL_SINGLE_DEVICE_INPUTS",
            message: `Model '${model.name}' uses device_map="auto", but this line moves tensors to a single device via ${model.name}.device.`,
            line: i + 1,
            fix: `Do not use .to(${model.name}.device) with device_map="auto". For sharded models, keep tokenizer outputs on CPU or move them to ${model.name}.get_input_embeddings().weight.device via a helper. If the model fits on one GPU, remove device_map="auto" and load it on a single device instead.`,
          });
          break;
        }
      }

      if (
        !violations.some((violation) => violation.line === i + 1 && violation.code === "SHARDED_MODEL_SINGLE_DEVICE_INPUTS")
        && /(?:return_tensors\s*=\s*["']pt["']|input_ids|attention_mask|labels|encodings?|inputs?|batch)\b/i.test(line)
      ) {
        for (const alias of Array.from(singleCudaAliases)) {
          if (new RegExp(String.raw`\.to\(\s*${escapeRegExp(alias)}\s*\)`).test(line)) {
            violations.push({
              severity: "error",
              code: "SHARDED_MODEL_SINGLE_DEVICE_INPUTS",
              message: `Script uses device_map="auto" but moves model inputs to single-device alias '${alias}'. That breaks sharded models across multiple GPUs.`,
              line: i + 1,
              fix: `Do not move tokenized inputs to ${alias} when any model is loaded with device_map="auto". Keep inputs on CPU or move them to the embedding/input device from model.get_input_embeddings().weight.device. If the model is small enough, drop device_map="auto" and run it on one GPU.`,
            });
            break;
          }
        }
      }
    }

    if (
      gpuCount > 1
      && /os\.environ\[\s*["']CUDA_VISIBLE_DEVICES["']\s*\]\s*=/.test(line)
      && !violations.some((violation) => violation.line === i + 1 && violation.code === "MANUAL_GPU_PINNING")
    ) {
      violations.push({
        severity: "error",
        code: "MANUAL_GPU_PINNING",
        message: `Script hard-codes CUDA_VISIBLE_DEVICES while ${gpuCount} GPUs are available. Device visibility is an execution-policy concern, not experiment code.`,
        line: i + 1,
        fix: "Remove CUDA_VISIBLE_DEVICES assignments from the script and let the scheduler/runtime choose device placement.",
      });
    }
  }
}

/** Detect missing or disabled multi-GPU usage. */
function checkMultiGpu(
  lines: string[],
  code: string,
  gpuCount: number,
  violations: PreflightViolation[],
) {
  // Check for explicitly disabled distributed training
  const disablePatterns = [
    { pattern: /ACCELERATE_USE_DEEPSPEED.*(?:false|0|no)/i, desc: "DeepSpeed explicitly disabled" },
    { pattern: /ACCELERATE_NO_DEEPSPEED/i, desc: "DeepSpeed explicitly disabled" },
    { pattern: /deepspeed\s*=\s*None/i, desc: "DeepSpeed set to None in training args" },
    { pattern: /no_cuda\s*=\s*True/i, desc: "CUDA explicitly disabled" },
  ];

  for (const dp of disablePatterns) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("#")) continue;
      if (dp.pattern.test(lines[i])) {
        violations.push({
          severity: "error",
          code: "DISABLED_MULTI_GPU",
          message: `${dp.desc} (line ${i + 1}).`,
          line: i + 1,
          fix: `Remove this line. Use accelerate + DeepSpeed for distributed training across all ${gpuCount} GPUs.`,
        });
      }
    }
  }

  // Check if there's ANY multi-GPU strategy
  const hasAccelerate = /accelerate\s+launch|from\s+accelerate\s+import|Accelerator\(\)/i.test(code);
  const hasDeepSpeed = /deepspeed|DeepSpeedPlugin/i.test(code) && !/deepspeed\s*=\s*None/i.test(code);
  const hasDataParallel = /DataParallel|DistributedDataParallel/i.test(code);
  const hasFSDP = /FullyShardedDataParallel|FSDP/i.test(code);
  const hasDeviceMapAuto = /device_map\s*=\s*["']auto["']/i.test(code);
  const hasTrainer = /\bTrainer\s*\(|\bGRPOTrainer\s*\(|\bSFTTrainer\s*\(|\bDPOTrainer\s*\(|\bPPOTrainer\s*\(/i.test(code);

  // If using HF Trainer, it handles multi-GPU automatically — but only with accelerate launch
  const hasMultiGpuStrategy = hasAccelerate || hasDeepSpeed || hasDataParallel || hasFSDP;

  if (!hasMultiGpuStrategy && !hasDeviceMapAuto) {
    // Check if it's an inference-only script (no training loop)
    const hasTrainingLoop = hasTrainer || /\.backward\(\)|optimizer\.step\(\)|\.train\(\)/i.test(code);

    if (hasTrainingLoop) {
      violations.push({
        severity: "error",
        code: "NO_MULTI_GPU",
        message: `Training script uses no multi-GPU strategy. You have ${gpuCount} GPUs but only one is being used for training.`,
        line: 1,
        fix: `Use accelerate + DeepSpeed: add 'accelerate' and 'deepspeed' to requirements.txt, configure TrainingArguments with deepspeed="ds_config.json", or wrap with accelerate launch. For HF Trainer, set per_device_train_batch_size and let Trainer handle distribution.`,
      });
    } else if (!hasDeviceMapAuto) {
      violations.push({
        severity: "warning",
        code: "SINGLE_GPU_INFERENCE",
        message: `Inference script doesn't use device_map="auto". Could use all ${gpuCount} GPUs for faster throughput.`,
        line: 1,
        fix: `Use model = AutoModel.from_pretrained(..., device_map="auto") to shard across GPUs, or use DataParallel for batch inference.`,
      });
    }
  }
}

/** Check for unreasonably small batch sizes. */
function checkBatchSizes(
  lines: string[],
  constants: Map<string, { value: number; line: number }>,
  gpuCount: number,
  violations: PreflightViolation[],
) {
  const batchPattern = /\bper_device_train_batch_size\s*=\s*(\d+)/i;
  const genericBatchPattern = /\bbatch_size\s*=\s*(\d+)/i;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("#")) continue;

    // Check HF Trainer batch size
    const trainerMatch = batchPattern.exec(lines[i]);
    if (trainerMatch) {
      const bs = parseInt(trainerMatch[1]);
      const effectiveBatch = bs * gpuCount;
      if (effectiveBatch < 8 && gpuCount > 1) {
        violations.push({
          severity: "warning",
          code: "TINY_BATCH",
          message: `per_device_train_batch_size=${bs} × ${gpuCount} GPUs = ${effectiveBatch} effective batch. Consider increasing.`,
          line: i + 1,
          fix: `Increase per_device_train_batch_size or use gradient_accumulation_steps. Effective batch < 16 often hurts training stability.`,
        });
      }
    }

    // Check generic batch size (literal or via constant)
    const genericMatch = genericBatchPattern.exec(lines[i]);
    if (genericMatch && !trainerMatch) {
      const bs = parseInt(genericMatch[1]);
      if (bs <= 4 && !lines[i].includes("micro") && !lines[i].includes("grad_accum")) {
        violations.push({
          severity: "warning",
          code: "TINY_BATCH",
          message: `batch_size=${bs} is very small for ${gpuCount} GPU(s). Consider increasing for better utilization.`,
          line: i + 1,
          fix: `Increase batch size or use gradient accumulation. Small batches underutilize GPU memory and slow training.`,
        });
      }
    }
  }

  // Also check constants that look like batch sizes
  constants.forEach(({ value, line }, name) => {
    const lower = name.toLowerCase();
    if ((lower.includes("batch") && lower.includes("size")) || lower === "bs" || lower === "bsz") {
      if (value <= 4) {
        if (!violations.some((v) => v.line === line && v.code === "TINY_BATCH")) {
          violations.push({
            severity: "warning",
            code: "TINY_BATCH",
            message: `${name}=${value} is very small for ${gpuCount} GPU(s). A100s can handle much larger batches.`,
            line,
            fix: `Increase ${name}. With ${gpuCount}× A100 GPUs, batch sizes of 16-64+ are typical depending on model size.`,
          });
        }
      }
    }
  });
}

/** Detect manual GPU pinning that wastes GPUs (e.g., 2 models on 2 GPUs but 6 GPUs idle). */
function checkManualGpuPinning(
  lines: string[],
  code: string,
  gpuCount: number,
  violations: PreflightViolation[],
) {
  // Count explicit cuda:N device assignments
  const deviceAssignments = new Set<string>();
  const devicePattern = /["']cuda:(\d+)["']/g;
  let dm;
  while ((dm = devicePattern.exec(code)) !== null) {
    deviceAssignments.add(dm[1]);
  }

  // If the script manually pins to specific GPUs but uses fewer than half available
  if (deviceAssignments.size >= 1 && deviceAssignments.size < gpuCount / 2) {
    // Don't flag if there's already a multi-GPU strategy
    const hasMultiGpuStrategy = /accelerate|DataParallel|DistributedDataParallel|FSDP|device_map\s*=\s*["']auto["']/i.test(code);
    if (!hasMultiGpuStrategy) {
      // Check if there's a training loop — manual pinning for inference is less concerning
      const hasTraining = /\.backward\(\)|optimizer\.step\(\)|\.train\(\)|Trainer\s*\(/i.test(code);
      if (hasTraining) {
        violations.push({
          severity: "error",
          code: "MANUAL_GPU_PINNING",
          message: `Training script manually pins to ${deviceAssignments.size} GPU(s) via cuda:N but ${gpuCount} are available. ${gpuCount - deviceAssignments.size} GPU(s) are idle.`,
          line: 1,
          fix: `Use accelerate + DeepSpeed or FSDP to distribute training across all ${gpuCount} GPUs instead of manually assigning models to specific devices. Manual device pinning doesn't parallelize training.`,
        });
      }
    }
  }
}

/** Check for basic statistical rigor. */
function checkStatisticalRigor(
  lines: string[],
  code: string,
  violations: PreflightViolation[],
) {
  // Check if there's any mention of confidence intervals, seeds, or statistical testing
  const hasSeeds = /random_seed|seed\s*=|np\.random\.seed|torch\.manual_seed|set_seed/i.test(code);
  const hasMultipleSeeds = /for.*seed\s+in|seeds\s*=\s*\[/i.test(code);
  const hasCI = /confidence|bootstrap|ci_lower|ci_upper|scipy\.stats|t_test|wilcoxon|mannwhitney/i.test(code);
  const hasStdDev = /std\(|\.std\b|stderr|standard_error|sem\b/i.test(code);

  if (!hasSeeds && !hasMultipleSeeds) {
    violations.push({
      severity: "warning",
      code: "NO_SEED",
      message: "No random seed set. Results will not be reproducible.",
      line: 1,
      fix: "Set random seeds at the start: torch.manual_seed(42), np.random.seed(42), random.seed(42).",
    });
  }

  if (!hasCI && !hasStdDev && !hasMultipleSeeds) {
    // Only flag for scripts that produce metrics
    const producesMetrics = /accuracy|f1_score|auroc|bleu|rouge|perplexity|loss.*=.*\d/i.test(code);
    if (producesMetrics) {
      violations.push({
        severity: "warning",
        code: "NO_UNCERTAINTY",
        message: "No confidence intervals, standard deviations, or multiple seeds. Single-run results are unreliable.",
        line: 1,
        fix: "Run with multiple seeds (at least 3) and report mean ± std. Use bootstrap CIs for final metrics.",
      });
    }
  }
}

/** Count lines that represent meaningful code (not empty, comments, imports, or placeholders). */
function countMeaningfulLines(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;
    if ((trimmed.startsWith("import ") || trimmed.startsWith("from ")) && !trimmed.includes("=")) continue;
    if (trimmed === "pass" || trimmed === "...") continue;
    count++;
  }
  return count;
}

/** Reject scripts that try to manage their own execution infrastructure. */
function checkPathManagement(
  lines: string[],
  violations: PreflightViolation[],
) {
  const infraPatterns: { pattern: RegExp; message: string; fix: string }[] = [
    {
      pattern: /shutil\.copy.*(__file__|\.py)/,
      message: "Script copies itself to another location. The infrastructure handles file layout.",
      fix: "Remove shutil.copy of the script. Your script runs in the workspace root — just save outputs to relative paths.",
    },
    {
      pattern: /os\.makedirs.*run_|os\.mkdir.*run_/,
      message: "Script creates run_* directories. The infrastructure manages run directories automatically.",
      fix: "Remove os.makedirs for run directories. Save outputs to relative paths (e.g., 'results.json') — they go to the right place.",
    },
    {
      pattern: /Path\(\s*f?["']run_|(?:output|results?)_dir\s*=\s*Path\(\s*f?["']run_/i,
      message: "Script hard-codes a run_* output directory. The infrastructure already chooses the run directory.",
      fix: "Use relative output paths inside the current working directory (for example 'results.json' or Path('results') / 'metrics.json'). Do not embed run_* directories in the script.",
    },
    {
      pattern: /ARCANA_OUTPUT_DIR|\.arcana/,
      message: "Script references internal infrastructure paths (ARCANA_OUTPUT_DIR or .arcana/).",
      fix: "Remove references to ARCANA_OUTPUT_DIR and .arcana/. Save outputs to relative paths in the current directory.",
    },
    {
      pattern: /os\.chdir|os\.getcwd.*run_/,
      message: "Script changes or inspects the working directory for run management.",
      fix: "Remove os.chdir calls. The script runs in the workspace root — write outputs to relative paths.",
    },
    {
      pattern: /subprocess.*nvidia-smi|subprocess.*ps\s+aux|subprocess.*gpu/i,
      message: "Script runs infrastructure inspection commands (nvidia-smi, ps). Use built-in tools for this.",
      fix: "Remove subprocess calls for GPU/process inspection. Use check_job and get_workspace tools instead.",
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#")) continue;
    for (const { pattern, message, fix } of infraPatterns) {
      if (pattern.test(line)) {
        violations.push({
          severity: "error",
          code: "INFRA_MANAGEMENT",
          message,
          line: i + 1,
          fix,
        });
      }
    }
  }
}

/** Quality gate: reject trivial, diagnostic-only, or content-free scripts. */
function checkScriptSubstance(
  lines: string[],
  _code: string,
  violations: PreflightViolation[],
) {
  // ── Check A: Minimum substance (>= 15 meaningful lines) ──────
  const meaningfulCount = countMeaningfulLines(lines);
  if (meaningfulCount < 15) {
    violations.push({
      severity: "error",
      code: "TRIVIAL_SCRIPT",
      message: `Script has only ${meaningfulCount} meaningful lines of code (minimum 15 required). This is too simple to be a real experiment.`,
      line: 1,
      fix: "Write a substantive experiment script that loads data, runs a model or analysis, and saves results. A real experiment needs data loading, processing, model execution, evaluation, and result persistence.",
    });
  }

  // ── Check B: Research content required (at least one pattern group) ──
  const researchPatterns = {
    training: [
      /\.backward\(\)/,
      /optimizer\.step/,
      /Trainer\(/,
      /\.train\(\)/,
      /\.fit\(/,
      /for\s+.*\b(epoch|batch)\b/,
    ],
    dataLoading: [
      /load_dataset/,
      /DataLoader/,
      /read_csv/,
      /from_pretrained/,
      /\.load\(/,
    ],
    modelOps: [
      /nn\.Module/,
      /nn\.Linear/,
      /model\(/,
      /\.forward\(/,
      /AutoModel/,
      /\.generate\(/,
      /\.eval\(\)/,
    ],
    statistics: [
      /np\.mean/,
      /scipy\.stats/,
      /sklearn\./,
      /accuracy_score/,
      /f1_score/,
      /torch\.mean/,
      /bootstrap/,
    ],
  };

  let hasAnyGroup = false;
  for (const groupPatterns of Object.values(researchPatterns)) {
    for (const line of lines) {
      if (hasAnyGroup) break;
      for (const pattern of groupPatterns) {
        if (pattern.test(line)) {
          hasAnyGroup = true;
          break;
        }
      }
    }
    if (hasAnyGroup) break;
  }

  if (!hasAnyGroup) {
    violations.push({
      severity: "error",
      code: "NO_RESEARCH_CONTENT",
      message: "Script contains no recognizable research operations — no training loops, data loading, model operations, or statistical analysis.",
      line: 1,
      fix: "A research experiment script must include at least one of: training (optimizer.step, .backward(), Trainer), data loading (load_dataset, DataLoader, read_csv), model operations (nn.Module, AutoModel, .generate()), or statistical analysis (sklearn, scipy.stats, accuracy_score).",
    });
  }

  // ── Check C: Must persist results ─────────────────────────────
  const savePatterns = [
    /json\.dump/,
    /\.to_csv/,
    /\.to_json/,
    /torch\.save/,
    /open\(.*['"]w/,
    /save_pretrained/,
    /pickle\.dump/,
    /np\.save/,
    /\.savefig/,
  ];

  let hasResultSave = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    for (const pattern of savePatterns) {
      if (pattern.test(line)) {
        hasResultSave = true;
        break;
      }
    }
    if (hasResultSave) break;
  }

  if (!hasResultSave) {
    violations.push({
      severity: "error",
      code: "NO_RESULT_SAVE",
      message: "Script never persists results to disk. Experiment outputs will be lost when the process exits.",
      line: 1,
      fix: "Save results using json.dump(), .to_csv(), torch.save(), np.save(), or write to a file with open(..., 'w'). Every experiment must persist its metrics, predictions, or model checkpoints.",
    });
  }

  // ── Check D: Diagnostic-only (mostly print statements) ────────
  let printCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    if (trimmed.includes("print(")) {
      printCount++;
    }
  }

  if (meaningfulCount > 5 && printCount > meaningfulCount * 0.6) {
    violations.push({
      severity: "error",
      code: "DIAGNOSTIC_ONLY",
      message: `Script is ${Math.round((printCount / meaningfulCount) * 100)}% print statements (${printCount}/${meaningfulCount} meaningful lines). This looks like a diagnostic script, not an experiment.`,
      line: 1,
      fix: "Replace print-heavy debugging with a real experiment that processes data, runs a model, computes metrics, and saves structured results (JSON/CSV). Use logging instead of print for status messages.",
    });
  }
}
