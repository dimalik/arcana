/**
 * Auto-fix layer for experiment code errors.
 *
 * Sits between job completion and failure recording. Classifies errors into:
 * - CODE_ERROR: fixable bugs (typos, wrong API, OOM from batch size) → auto-edit + resubmit
 * - RESEARCH_FAILURE: hypothesis disproven, method doesn't work → record as real failure
 * - RESOURCE_ERROR: missing package, access denied → help request, don't count as failure
 *
 * This is infrastructure — invisible to the research agent.
 */

import { prisma } from "@/lib/prisma";
import { generateObject } from "ai";
import { z } from "zod";
import { readFile, writeFile } from "fs/promises";
import path from "path";

export type ErrorClass = "CODE_ERROR" | "RESEARCH_FAILURE" | "RESOURCE_ERROR";

interface ClassificationResult {
  errorClass: ErrorClass;
  reason: string;
  fixDescription?: string;
}

interface AutoFixResult {
  fixed: boolean;
  errorClass: ErrorClass;
  reason: string;
  resubmitJobId?: string;
}

const MAX_FIX_ATTEMPTS = 2;

function classifyErrorHeuristically(
  errorContext: string,
  exitCode: number | null,
): ClassificationResult | null {
  const lower = errorContext.toLowerCase();
  const hasTraceback = /traceback \(most recent call last\):/i.test(errorContext);
  const hasPythonException = /\b(nameerror|typeerror|valueerror|runtimeerror|attributeerror|keyerror|indexerror|zerodivisionerror|syntaxerror|modulenotfounderror|importerror)\b/i.test(errorContext);
  const hasOomSignal = /cuda out of memory|outofmemoryerror|oom killed|oom_killed|exit 137|sigkill/i.test(lower) || exitCode === 137;

  if (hasOomSignal) {
    return {
      errorClass: "CODE_ERROR",
      reason: "OOM detected",
      fixDescription: "Reduce memory usage (smaller batch size, gradient checkpointing, or mixed precision).",
    };
  }

  // Avoid dangerous auto-edits when the output contains warnings only and no traceback.
  const hasOnlyKnownWarnings =
    !hasTraceback &&
    !hasPythonException &&
    /(generation flags are not valid and may be ignored|torch_dtype is deprecated|load report|unexpected:\s*can be ignored|loss_type=none)/i.test(lower);

  if (hasOnlyKnownWarnings) {
    return {
      errorClass: "RESEARCH_FAILURE",
      reason: "No actionable traceback detected (warning-only stderr). Skipping auto-fix to avoid unnecessary code rewrites.",
    };
  }

  return null;
}

/**
 * Classify an experiment error and attempt auto-fix if it's a code error.
 * Returns whether the error was fixed (and a new job submitted) or should be
 * recorded as a real failure.
 */
export async function classifyAndFix(
  jobId: string,
  exitCode: number | null,
  stderr: string,
  stdout: string,
  localDir: string,
  command: string,
): Promise<AutoFixResult> {
  const job = await prisma.remoteJob.findUnique({
    where: { id: jobId },
    select: {
      fixAttempts: true,
      hostId: true,
      projectId: true,
      scriptHash: true,
      hypothesisId: true,
      experimentPurpose: true,
      grounding: true,
      claimEligibility: true,
      promotionPolicy: true,
      evidenceClass: true,
    },
  });
  if (!job) return { fixed: false, errorClass: "RESEARCH_FAILURE", reason: "Job not found" };

  // Don't attempt fix if we've already tried too many times
  if (job.fixAttempts >= MAX_FIX_ATTEMPTS) {
    return { fixed: false, errorClass: "RESEARCH_FAILURE", reason: `Auto-fix exhausted (${job.fixAttempts} attempts). Treating as research failure.` };
  }

  // Extract script name from command
  const scriptMatch = command.match(/python3?\s+(\S+\.py)/);
  if (!scriptMatch) return { fixed: false, errorClass: "RESEARCH_FAILURE", reason: "Could not identify script" };
  const scriptName = scriptMatch[1];

  // Read the script content
  let scriptContent: string;
  try {
    scriptContent = await readFile(path.join(localDir, scriptName), "utf-8");
  } catch {
    return { fixed: false, errorClass: "RESEARCH_FAILURE", reason: "Could not read script file" };
  }

  // Build error context (truncated for LLM)
  const errorContext = [
    stderr ? `STDERR (last 6000 chars):\n${stderr.slice(-6000)}` : "",
    stdout ? `STDOUT (last 3000 chars):\n${stdout.slice(-3000)}` : "",
  ].filter(Boolean).join("\n\n");

  // Fast path for high-confidence patterns.
  const heuristic = classifyErrorHeuristically(errorContext, exitCode);
  if (heuristic) {
    if (heuristic.errorClass === "CODE_ERROR") {
      // Continue to fix generation path below.
    } else {
      return { fixed: false, errorClass: heuristic.errorClass, reason: heuristic.reason };
    }
  }

  // Step 1: Classify the error
  const classification = heuristic && heuristic.errorClass === "CODE_ERROR"
    ? heuristic
    : await classifyError(errorContext, scriptContent, exitCode);

  if (classification.errorClass === "RESOURCE_ERROR") {
    return { fixed: false, errorClass: "RESOURCE_ERROR", reason: classification.reason };
  }

  if (classification.errorClass === "RESEARCH_FAILURE") {
    return { fixed: false, errorClass: "RESEARCH_FAILURE", reason: classification.reason };
  }

  // Step 2: CODE_ERROR — attempt auto-fix
  console.log(`[auto-fix] Attempting fix #${job.fixAttempts + 1} for ${scriptName}: ${classification.reason}`);

  const fixResult = await generateFix(scriptContent, errorContext, scriptName, classification.fixDescription || classification.reason);
  if (!fixResult) {
    return { fixed: false, errorClass: "CODE_ERROR", reason: `Auto-fix failed to generate a fix: ${classification.reason}` };
  }

  // Step 3: Write the fixed script
  try {
    await writeFile(path.join(localDir, scriptName), fixResult.fixedCode, "utf-8");
  } catch {
    return { fixed: false, errorClass: "CODE_ERROR", reason: "Failed to write fixed script" };
  }

  // Step 4: Increment fix attempts on the original job
  await prisma.remoteJob.update({
    where: { id: jobId },
    data: { fixAttempts: job.fixAttempts + 1 },
  });

  // Step 5: Resubmit the job
  try {
    const { submitRemoteJob } = await import("./remote-executor");
    const result = await submitRemoteJob({
      hostId: job.hostId,
      localDir,
      command,
      projectId: job.projectId || undefined,
      scriptHash: job.scriptHash || undefined,
      hypothesisId: job.hypothesisId || undefined,
      experimentPurpose: job.experimentPurpose || undefined,
      grounding: job.grounding || undefined,
      claimEligibility: job.claimEligibility || undefined,
      promotionPolicy: job.promotionPolicy || undefined,
      evidenceClass: job.evidenceClass || undefined,
      ignoreActiveWorkspaceLock: true,
    });

    // Mark the new job with the fix attempt count
    await prisma.remoteJob.update({
      where: { id: result.jobId },
      data: { fixAttempts: job.fixAttempts + 1 },
    });

    // Log the auto-fix
    if (job.projectId) {
      await prisma.researchLogEntry.create({
        data: {
          projectId: job.projectId,
          type: "observation",
          content: `Auto-fixed \`${scriptName}\` (attempt ${job.fixAttempts + 1}): ${fixResult.description}\nFix: ${fixResult.changeDescription}`,
          metadata: JSON.stringify({ autoFix: true, originalJobId: jobId, newJobId: result.jobId }),
        },
      });
    }

    console.log(`[auto-fix] Fixed ${scriptName} and resubmitted as job ${result.jobId.slice(0, 8)}`);
    return { fixed: true, errorClass: "CODE_ERROR", reason: fixResult.description, resubmitJobId: result.jobId };
  } catch (submitErr) {
    console.error("[auto-fix] Resubmit failed:", submitErr);
    return { fixed: false, errorClass: "CODE_ERROR", reason: `Fix applied but resubmit failed: ${submitErr instanceof Error ? submitErr.message : "unknown"}` };
  }
}

/**
 * Classify error using structured output.
 */
async function classifyError(
  errorContext: string,
  scriptContent: string,
  exitCode: number | null,
): Promise<ClassificationResult> {
  try {
    const { getModelForTier } = await import("@/lib/llm/auto-process");
    const { getModel, setLlmContext } = await import("@/lib/llm/provider");
    const { provider, modelId, proxyConfig } = await getModelForTier("standard");
    setLlmContext("auto-fix-classify", "system", {});
    const model = await getModel(provider, modelId, proxyConfig);

    const schema = z.object({
      errorClass: z.enum(["CODE_ERROR", "RESEARCH_FAILURE", "RESOURCE_ERROR"]),
      reason: z.string().describe("One-line description of the error"),
      fixDescription: z.string().optional().describe("For CODE_ERROR: what needs to change"),
    });

    const { object } = await generateObject({
      model,
      schema,
      system: `Classify this experiment error into exactly one category:

CODE_ERROR — A fixable bug in the Python script:
- TypeError, AttributeError, NameError, KeyError, IndexError
- Wrong function arguments, wrong API usage, typos in variable/method names
- OOM that can be fixed by reducing batch_size, adding gradient_checkpointing, or using half precision
- File not found errors for output paths that need to be created
- Import errors for packages that ARE installed but imported with wrong name
- Shape mismatches that can be fixed by adjusting tensor operations

RESEARCH_FAILURE — The experiment ran but produced bad results:
- The method produced degenerate outputs (NaN, all zeros, collapsed distributions)
- Metrics are much worse than expected (the approach doesn't work)
- The training diverged or didn't converge
- The hypothesis was disproven by the results

RESOURCE_ERROR — Infrastructure issue the user must fix:
- Package genuinely not installed (not just wrong import name)
- CUDA/GPU not available or driver mismatch
- Network/download failures
- Permission denied, disk full
- API key missing or expired

If exit code is 137 (SIGKILL), this is usually OOM — classify as CODE_ERROR with fix "reduce batch size or enable gradient checkpointing".`,
      prompt: `Exit code: ${exitCode}\n\n${errorContext}\n\nScript (first 3000 chars):\n${scriptContent.slice(0, 3000)}`,
    });

    return object;
  } catch (err) {
    console.warn("[auto-fix] Classification failed:", err);
    // Default to research failure if we can't classify
    return { errorClass: "RESEARCH_FAILURE", reason: "Could not classify error" };
  }
}

/**
 * Generate a targeted fix for a code error using structured output.
 */
async function generateFix(
  scriptContent: string,
  errorContext: string,
  scriptName: string,
  fixDescription: string,
): Promise<{ fixedCode: string; description: string; changeDescription: string } | null> {
  try {
    const { getModelForTier } = await import("@/lib/llm/auto-process");
    const { getModel, setLlmContext } = await import("@/lib/llm/provider");
    const { provider, modelId, proxyConfig } = await getModelForTier("standard");
    setLlmContext("auto-fix-generate", "system", {});
    const model = await getModel(provider, modelId, proxyConfig);

    const schema = z.object({
      fixedCode: z.string().describe("The complete fixed Python script"),
      description: z.string().describe("One-line description of what was wrong"),
      changeDescription: z.string().describe("What was changed (e.g., 'Changed batch_size from 32 to 8')"),
    });

    const { object } = await generateObject({
      model,
      schema,
      system: `You are a code fix agent. You receive a Python script that failed with an error.
Make the MINIMUM change needed to fix the error. Do NOT rewrite the script.
Do NOT change the experimental logic, hyperparameters (except batch size for OOM), or methodology.
Only fix the specific bug identified.

Rules:
- For OOM: halve the batch_size, or add gradient_checkpointing=True, or add torch_dtype=torch.float16
- For wrong API args: fix the argument name/value to match the library's actual API
- For missing imports: add the import
- For file not found: add os.makedirs(dir, exist_ok=True) before writing
- For shape mismatches: fix the tensor operation
- Return the COMPLETE script (not just the diff)`,
      prompt: `Script: ${scriptName}\nError: ${fixDescription}\n\n${errorContext}\n\nFull script:\n${scriptContent}`,
    });

    // Sanity check: the fix should be similar length (not a rewrite)
    const lengthRatio = object.fixedCode.length / scriptContent.length;
    if (lengthRatio < 0.5 || lengthRatio > 2.0) {
      console.warn(`[auto-fix] Fix changed script size too much (${lengthRatio.toFixed(2)}x). Rejecting.`);
      return null;
    }

    return object;
  } catch (err) {
    console.warn("[auto-fix] Fix generation failed:", err);
    return null;
  }
}
