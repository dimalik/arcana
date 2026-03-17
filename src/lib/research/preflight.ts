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

  // ── Dataset trimming checks ─────────────────────────────────────
  checkDatasetTrimming(lines, violations);

  // ── Multi-GPU checks ────────────────────────────────────────────
  if (gpuCount > 1) {
    checkMultiGpu(lines, code, gpuCount, violations);
  }

  // ── Batch size checks ───────────────────────────────────────────
  checkBatchSizes(lines, gpuCount, violations);

  // ── Statistical rigor checks ────────────────────────────────────
  checkStatisticalRigor(lines, code, violations);

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

// ── Checks ────────────────────────────────────────────────────────

/** Detect dataset slicing to small sizes (the #1 problem). */
function checkDatasetTrimming(lines: string[], violations: PreflightViolation[]) {
  // Patterns that indicate dataset trimming:
  // 1. data[:N] where N < 1000 (on training-like variables)
  // 2. n_train=N, max_train=N, max_samples=N where N < 1000
  // 3. .head(N), .sample(N) where N < 1000

  const dataVarPattern = /\b(train|data|dataset|texts|examples|samples|corpus|sft|dpo|grpo|rl_data)\w*\s*(?:=.*)?(\[:\d+\])/i;
  const smallSlicePattern = /\[:(\d+)\]/g;
  const paramPattern = /\b(n_train|max_train|max_samples|num_train|train_size|max_examples|n_examples)\s*[=:]\s*(\d+)/i;
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
        violations.push({
          severity: "error",
          code: "SMALL_TRAIN_SIZE",
          message: `Training size limited to ${n} via '${paramMatch[1]}=${n}'. This produces unreliable results.`,
          line: lineNum,
          fix: `Remove the hard cap or increase to the full dataset size. Use streaming/lazy loading if memory is a concern.`,
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
  gpuCount: number,
  violations: PreflightViolation[],
) {
  const batchPattern = /\bper_device_train_batch_size\s*=\s*(\d+)/;
  const genericBatchPattern = /\bbatch_size\s*=\s*(\d+)/;

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

    // Check generic batch size (only for very small values)
    const genericMatch = genericBatchPattern.exec(lines[i]);
    if (genericMatch && !trainerMatch) {
      const bs = parseInt(genericMatch[1]);
      if (bs <= 2 && !lines[i].includes("micro") && !lines[i].includes("grad_accum")) {
        violations.push({
          severity: "warning",
          code: "TINY_BATCH",
          message: `batch_size=${bs} is very small. Consider increasing for better GPU utilization.`,
          line: i + 1,
          fix: `Increase batch size or use gradient accumulation. Small batches underutilize GPU memory and slow training.`,
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
