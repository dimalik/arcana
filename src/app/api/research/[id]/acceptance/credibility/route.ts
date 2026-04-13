import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import {
  attachClaimEvidence,
  createClaim,
  getClaimLedger,
  promoteClaimToMemory,
  repairDerivedResultClaims,
  repairDuplicateClaims,
  repairFailureReflectionClaims,
  repairLegacyClaimAssessments,
  repairMalformedNotebookClaims,
  repairResultBackedClaimProvenance,
  reviewClaim,
  transitionClaimMemory,
} from "@/lib/research/claim-ledger";
import {
  listClaimCoordinatorQueue,
  reconcileExperimentResultWithClaimCoordinator,
  syncClaimCoordinator,
} from "@/lib/research/claim-coordinator";
import { parseAgentTaskClaimIds, parseCoordinatorStepInput } from "@/lib/research/claim-graph";
import { generateResearchSummary } from "@/lib/research/research-summary";
import { cancelRemoteJob, submitRemoteJob } from "@/lib/research/remote-executor";
import { getProjectLineage } from "@/lib/research/lineage-audit";
import { importExperimentResultFromRemoteJob } from "@/lib/research/result-import";
import { createOrUpdateHelpRequest, parseHelpRequestMetadata, refreshProjectHelpRequests } from "@/lib/research/help-requests";
import { appendAgentTraceEvent, listAgentTraceEvents } from "@/lib/research/agent-trace";
import {
  repairFailureReflectionResults,
  repairPlanningDecisionLogs,
} from "@/lib/research/research-data-repair";
import { acquireExecutorLease, buildWorkspaceLeaseKey, releaseExecutorLease } from "@/lib/research/run-lifecycle";
import {
  classifyRemoteFailureRecovery,
  formatRemoteSubmissionFailure,
  getManagedScriptPolicyViolation,
} from "@/lib/research/execution-policy";
import {
  getExperimentSubmissionConvergenceBarrier,
  getManagedScriptCreationBarrier,
  getManagedScriptDeletionBarrier,
} from "@/lib/research/experiment-convergence";
import { evaluateCollectResultsCooldown } from "@/lib/research/collect-results-policy";
import { validateExperiment } from "@/lib/research/preflight";
import { extractRuntimeDependencies } from "@/lib/research/runtime-dependencies";
import { resolveExperimentContract } from "@/lib/research/experiment-contracts";

type Params = { params: Promise<{ id: string }> };

interface StepResult {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
}

const execFile = promisify(execFileCb);

function pushStep(steps: StepResult[], name: string, status: StepResult["status"], detail: string) {
  steps.push({ name, status, detail });
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id: projectId } = await params;
    const project = await prisma.researchProject.findFirst({
      where: { id: projectId, userId },
      select: { id: true, title: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const steps: StepResult[] = [];
    const now = new Date();
    const acceptanceWorkDir = path.join(process.cwd(), "output", `credibility-acceptance-${projectId.slice(0, 8)}`);
    await mkdir(acceptanceWorkDir, { recursive: true });
    const reviewerTask = await prisma.agentTask.create({
      data: {
        projectId,
        role: "reviewer",
        goal: "Acceptance reviewer task",
        status: "COMPLETED",
        output: JSON.stringify({ verdict: "contested" }),
        completedAt: now,
      },
    });
    const reproducerTask = await prisma.agentTask.create({
      data: {
        projectId,
        role: "reproducer",
        goal: "Acceptance reproducer task",
        status: "COMPLETED",
        output: JSON.stringify({ verdict: "reproduced" }),
        completedAt: now,
      },
    });
    const acceptanceLog = await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "observation",
        content: "Credibility acceptance log entry.",
      },
    });

    try {
      await createClaim({
        projectId,
        statement: "## Broken synthesis\n1. first point\n2. second point",
        summary: "This should be rejected.",
        type: "finding",
        createdBy: "system",
        createdFrom: "acceptance_credibility",
      });
      pushStep(steps, "malformed_claim_rejected", "fail", "Malformed markdown summary was accepted as a claim.");
    } catch (err) {
      pushStep(steps, "malformed_claim_rejected", "pass", err instanceof Error ? err.message : "Malformed claim rejected.");
    }

    const blockedProbeScript = getManagedScriptPolicyViolation("poc_000_connection_test.py");
    if (blockedProbeScript?.includes("Infrastructure probe scripts")) {
      pushStep(steps, "block_probe_scripts", "pass", "Connection-test probe scripts are rejected by the shared execution policy.");
    } else {
      pushStep(steps, "block_probe_scripts", "fail", "Connection-test probe script was still considered valid.");
    }

    const researchRecovery = classifyRemoteFailureRecovery("RESEARCH_FAILURE");
    const codeRecovery = classifyRemoteFailureRecovery("CODE_ERROR");
    const resourceRecovery = classifyRemoteFailureRecovery("RESOURCE_ERROR");
    const unknownRecovery = classifyRemoteFailureRecovery(null);
    if (
      researchRecovery.mode === "reflect"
      && codeRecovery.mode === "fix_code"
      && resourceRecovery.mode === "diagnose"
      && unknownRecovery.mode === "diagnose"
    ) {
      pushStep(steps, "failure_recovery_classification", "pass", "Execution failures are classified into reflection, code-fix, and diagnostics flows deterministically.");
    } else {
      pushStep(steps, "failure_recovery_classification", "fail", "Failed-job recovery classification no longer matches the control-plane contract.");
    }

    const helperProbeWorkDir = path.join(acceptanceWorkDir, "helper-probe");
    await mkdir(helperProbeWorkDir, { recursive: true });
    const helperProbePayload = Buffer.from(JSON.stringify({ kind: "runtime_smoke" }), "utf-8").toString("base64url");
    try {
      const { stdout } = await execFile("python3", ["scripts/arcana_helper.py", "probe", helperProbeWorkDir, helperProbePayload], {
        cwd: process.cwd(),
        timeout: 30_000,
      });
      const helperProbe = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() || "{}") as { ok?: boolean; kind?: string };
      if (helperProbe.ok && helperProbe.kind === "runtime_smoke") {
        pushStep(steps, "helper_runtime_smoke_probe", "pass", "Remote helper runtime smoke probe executes through the typed probe surface.");
      } else {
        pushStep(steps, "helper_runtime_smoke_probe", "fail", "Runtime smoke probe returned an unexpected payload.");
      }
    } catch (err) {
      pushStep(steps, "helper_runtime_smoke_probe", "fail", err instanceof Error ? err.message : "Runtime smoke probe failed.");
    }

    const semanticWorkDir = path.join(acceptanceWorkDir, "semantic-preflight");
    await mkdir(semanticWorkDir, { recursive: true });
    await writeFile(
      path.join(semanticWorkDir, "poc_001_semantic_guard.py"),
      [
        "import os",
        "import torch",
        'os.environ["CUDA_VISIBLE_DEVICES"] = "0"',
        'print(torch.cuda.get_device_properties(0).total_mem)',
      ].join("\n"),
    );
    const semanticPreflight = await validateExperiment(
      semanticWorkDir,
      "python3 poc_001_semantic_guard.py --seed 42",
      8,
    );
    const semanticCodes = new Set(semanticPreflight.violations.map((violation) => violation.code));
    if (
      !semanticPreflight.ok
      && semanticCodes.has("INVALID_TORCH_CUDA_PROPERTY")
      && semanticCodes.has("MANUAL_GPU_PINNING")
    ) {
      pushStep(steps, "semantic_preflight_for_poc", "pass", "PoC scripts still receive semantic/API validation before remote submission.");
    } else {
      pushStep(steps, "semantic_preflight_for_poc", "fail", "PoC semantic/API misuse was not blocked by preflight.");
    }

    await writeFile(
      path.join(semanticWorkDir, "poc_002_sharded_input_guard.py"),
      [
        "import torch",
        "from transformers import AutoModelForCausalLM, AutoTokenizer",
        'DEVICE = "cuda:0"',
        'tokenizer = AutoTokenizer.from_pretrained("Qwen/Qwen2.5-0.5B-Instruct")',
        'model = AutoModelForCausalLM.from_pretrained("Qwen/Qwen2.5-0.5B-Instruct", torch_dtype=torch.float16, device_map="auto")',
        'inputs = tokenizer("hello", return_tensors="pt").to(DEVICE)',
        "outputs = model.generate(**inputs, max_new_tokens=8)",
        "print(outputs.shape)",
      ].join("\n"),
    );
    const shardedInputPreflight = await validateExperiment(
      semanticWorkDir,
      "python3 poc_002_sharded_input_guard.py --seed 42",
      8,
    );
    if (
      !shardedInputPreflight.ok
      && shardedInputPreflight.violations.some((violation) => violation.code === "SHARDED_MODEL_SINGLE_DEVICE_INPUTS")
    ) {
      pushStep(steps, "sharded_model_input_guard", "pass", "Preflight blocks single-device input placement for sharded device_map=\"auto\" models.");
    } else {
      pushStep(steps, "sharded_model_input_guard", "fail", "Sharded-model input placement bug was not blocked by preflight.");
    }

    await writeFile(
      path.join(semanticWorkDir, "exp_003_small_eval_argparse.py"),
      [
        "import argparse",
        "parser = argparse.ArgumentParser()",
        'parser.add_argument("--n_test", type=int, default=50)',
        "args = parser.parse_args()",
        "print(args.n_test)",
      ].join("\n"),
    );
    const smallEvalArgparsePreflight = await validateExperiment(
      semanticWorkDir,
      "python3 exp_003_small_eval_argparse.py --seed 42",
      8,
    );
    if (
      !smallEvalArgparsePreflight.ok
      && smallEvalArgparsePreflight.violations.some((violation) => violation.code === "SMALL_EVAL_SIZE")
    ) {
      pushStep(steps, "small_eval_argparse_guard", "pass", "Preflight blocks undersized eval defaults hidden in argparse configuration.");
    } else {
      pushStep(steps, "small_eval_argparse_guard", "fail", "Undersized argparse eval defaults were not blocked.");
    }

    await writeFile(
      path.join(semanticWorkDir, "exp_004_synthetic_proxy_guard.py"),
      [
        "import json",
        "",
        "def lexical_diversity(text):",
        "    return len(set(text.split())) / max(1, len(text.split()))",
        "",
        "def bigram_repeat_rate(text):",
        "    return 0.0",
        "",
        "def primary_detector_score(text):",
        "    return 1.0 - lexical_diversity(text)",
        "",
        "def holdout_detector_score(text):",
        "    return bigram_repeat_rate(text)",
        "",
        "def make_human(i):",
        "    templates = ['Residents said service improved after the change.']",
        "    return templates[i % len(templates)]",
        "",
        "def make_raw_ai(i):",
        "    templates = ['The program improved service quality and increased satisfaction.']",
        "    return templates[i % len(templates)]",
        "",
        "humans = [make_human(i) for i in range(120)]",
        "raws = [make_raw_ai(i) for i in range(120)]",
        "with open('results.json', 'w', encoding='utf-8') as f:",
        "    json.dump({'humans': len(humans), 'raws': len(raws)}, f)",
      ].join("\n"),
    );
    const syntheticProxyPreflight = await validateExperiment(
      semanticWorkDir,
      "python3 exp_004_synthetic_proxy_guard.py --seed 42",
      8,
    );
    if (
      !syntheticProxyPreflight.ok
      && syntheticProxyPreflight.violations.some((violation) => violation.code === "SYNTHETIC_PROXY_BENCHMARK")
    ) {
      pushStep(steps, "synthetic_proxy_benchmark_guard", "pass", "Preflight blocks self-generated detector-proxy benchmarks from entering the main experiment track.");
    } else {
      pushStep(steps, "synthetic_proxy_benchmark_guard", "fail", "Synthetic proxy benchmark script was not blocked.");
    }

    const syntheticDeclaredCode = [
      "# ARCANA: purpose=synthetic_proxy grounding=synthetic",
      "def primary_detector_score(text):",
      "    return 0.5",
      "def holdout_detector_score(text):",
      "    return 0.5",
      "def make_human(i):",
      "    return 'Human sentence.'",
      "def make_raw_ai(i):",
      "    return 'AI sentence.'",
      "humans = [make_human(i) for i in range(120)]",
      "raws = [make_raw_ai(i) for i in range(120)]",
      "print(len(humans), len(raws))",
    ].join("\n");
    await writeFile(
      path.join(semanticWorkDir, "exp_005_synthetic_proxy_declared.py"),
      syntheticDeclaredCode,
    );
    const syntheticDeclaredContract = resolveExperimentContract({
      scriptName: "exp_005_synthetic_proxy_declared.py",
      command: "python3 exp_005_synthetic_proxy_declared.py --seed 42",
      code: syntheticDeclaredCode,
    });
    const syntheticDeclaredPreflight = await validateExperiment(
      semanticWorkDir,
      "python3 exp_005_synthetic_proxy_declared.py --seed 42",
      8,
    );
    if (
      !syntheticDeclaredPreflight.violations.some((violation) => violation.code === "SYNTHETIC_PROXY_BENCHMARK")
      && syntheticDeclaredContract.experimentPurpose === "SYNTHETIC_PROXY"
      && syntheticDeclaredContract.grounding === "SYNTHETIC"
      && syntheticDeclaredContract.claimEligibility === "EXPLORATORY"
    ) {
      pushStep(steps, "synthetic_proxy_declared_contract", "pass", "Explicit synthetic contracts are allowed as exploratory runs instead of being misclassified as main-track evidence.");
    } else {
      pushStep(steps, "synthetic_proxy_declared_contract", "fail", "Explicit synthetic contract did not bypass the main-track synthetic guard cleanly.");
    }

    const mainEvalContract = resolveExperimentContract({
      scriptName: "exp_006_grounded_eval.py",
      command: "python3 exp_006_grounded_eval.py --seed 42",
      code: [
        "from datasets import load_dataset",
        "from transformers import AutoTokenizer, AutoModelForSequenceClassification",
        "dataset = load_dataset('cnn_dailymail', '3.0.0', split='test')",
        "model = AutoModelForSequenceClassification.from_pretrained('distilbert-base-uncased')",
        "print(len(dataset), model.config.num_labels)",
      ].join("\n"),
    });
    if (
      mainEvalContract.experimentPurpose === "MAIN_EVAL"
      && mainEvalContract.claimEligibility === "DECISIVE"
      && mainEvalContract.evidenceClass === "DECISIVE"
    ) {
      pushStep(steps, "main_eval_contract_inference", "pass", "Grounded exp_* scripts materialize as decisive evidence-bearing experiment contracts.");
    } else {
      pushStep(steps, "main_eval_contract_inference", "fail", "Grounded exp_* contract inference did not classify decisive evidence correctly.");
    }

    const dependencyWorkDir = path.join(acceptanceWorkDir, "runtime-deps");
    await mkdir(dependencyWorkDir, { recursive: true });
    await writeFile(
      path.join(dependencyWorkDir, "eval_utils.py"),
      [
        "from datasets import load_dataset",
        "",
        "def load_dataset_texts():",
        '    ds = load_dataset("cnn_dailymail", "3.0.0", split="train", trust_remote_code=True)',
        "    return ds[0]",
      ].join("\n"),
    );
    await writeFile(
      path.join(dependencyWorkDir, "exp_001_dep_graph.py"),
      [
        "from eval_utils import load_dataset_texts",
        "",
        "print(load_dataset_texts())",
      ].join("\n"),
    );
    const runtimeDeps = await extractRuntimeDependencies(dependencyWorkDir, "exp_001_dep_graph.py");
    if (runtimeDeps.some((dep) => dep.kind === "huggingface_dataset" && dep.name === "cnn_dailymail")) {
      pushStep(steps, "runtime_dependency_graph", "pass", "Runtime dependency extraction follows local helper imports instead of scanning only the entry script.");
    } else {
      pushStep(steps, "runtime_dependency_graph", "fail", "Runtime dependency extraction missed helper-defined dataset dependencies.");
    }

    const busyMessage = formatRemoteSubmissionFailure("acceptance-host", "Workspace busy on acceptance-host: active job deadbeef (RUNNING).", {
      activeJobId: "deadbeef-dead-beef-dead-beefdeadbeef",
      activeJobStatus: "RUNNING",
      activeCommand: "python3 poc_001_real_experiment.py --seed 42",
    });
    if (busyMessage.includes("Do NOT submit another script") && !busyMessage.includes("rsync or SSH failed")) {
      pushStep(steps, "workspace_busy_guidance", "pass", "Workspace-busy failures return deterministic next-step guidance instead of a fake SSH diagnosis.");
    } else {
      pushStep(steps, "workspace_busy_guidance", "fail", "Workspace-busy submission failure still produced misleading transport guidance.");
    }

    const pollCooldown = evaluateCollectResultsCooldown([
      {
        id: reviewerTask.id,
        role: "synthesizer",
        goal: "Acceptance long-running synthesis",
        status: "RUNNING",
        createdAt: new Date(now.getTime() - 5 * 60 * 1000),
        completedAt: null,
        updatedAt: new Date(now.getTime() - 2 * 60 * 1000),
        lastCollectedAt: new Date(now.getTime() - 60 * 1000),
      },
    ], now);
    if (pollCooldown?.blocked && pollCooldown.remainingMs > 0) {
      pushStep(steps, "collect_results_cooldown", "pass", "Repeated collect_results polling is blocked for unchanged running tasks.");
    } else {
      pushStep(steps, "collect_results_cooldown", "fail", "Repeated collect_results polling was not blocked.");
    }

    const traceRunId = `acceptance-trace-${projectId.slice(0, 8)}`;
    await appendAgentTraceEvent({
      projectId,
      runId: traceRunId,
      sessionNumber: 1,
      sequence: 1,
      event: {
        type: "thinking",
        content: "Acceptance trace: the agent is planning the next experiment.",
        activity: { phase: "thinking", stepCount: 1 },
      },
    });
    await appendAgentTraceEvent({
      projectId,
      runId: traceRunId,
      sessionNumber: 1,
      sequence: 2,
      event: {
        type: "tool_call",
        toolName: "run_experiment",
        args: { script: "poc_001_fixture.py", args: "--seed 11" },
      },
    });
    const traceEvents = await listAgentTraceEvents({ projectId, runId: traceRunId, limit: 10 });
    if (
      traceEvents.length === 2
      && traceEvents.some((event) => event.eventType === "thinking")
      && traceEvents.some((event) => event.toolName === "run_experiment")
    ) {
      pushStep(steps, "agent_trace_persistence", "pass", "Thinking and tool-call events are persisted in the append-only agent trace.");
    } else {
      pushStep(steps, "agent_trace_persistence", "fail", "Agent trace events were not persisted correctly.");
    }

    const legacyNotebookClaim = await prisma.researchClaim.create({
      data: {
        projectId,
        statement: "## Legacy notebook synthesis\n- bullet one\n- bullet two",
        summary: "Legacy malformed claim to repair.",
        type: "finding",
        status: "DRAFT",
        confidence: "PRELIMINARY",
        createdBy: "system",
        createdFrom: "log_finding",
      },
    });
    await prisma.claimEvidence.create({
      data: {
        claimId: legacyNotebookClaim.id,
        kind: "log_entry",
        logEntryId: acceptanceLog.id,
        supports: true,
        strength: "DIRECT",
        rationale: "Legacy notebook-origin claim",
      },
    });

    const repairSummary = await repairMalformedNotebookClaims(projectId);
    const repairedClaim = await prisma.researchClaim.findUnique({ where: { id: legacyNotebookClaim.id } });
    if (repairSummary.repaired >= 1 && !repairedClaim) {
      pushStep(steps, "repair_malformed_notebook_claims", "pass", `Repaired ${repairSummary.repaired} malformed notebook claim(s).`);
    } else {
      pushStep(steps, "repair_malformed_notebook_claims", "fail", "Malformed notebook claim was not repaired.");
    }

    const legacyFailureClaim = await prisma.researchClaim.create({
      data: {
        projectId,
        statement: "legacy_failure.py exposed a failure risk: Exit -1 means the process was killed.",
        summary: "Legacy failure reflection claim to repair.",
        type: "risk",
        status: "SUPPORTED",
        confidence: "MODERATE",
        createdBy: "system",
        createdFrom: "reflect_on_failure",
      },
    });
    await prisma.claimEvidence.create({
      data: {
        claimId: legacyFailureClaim.id,
        kind: "log_entry",
        logEntryId: acceptanceLog.id,
        supports: true,
        strength: "DIRECT",
        rationale: "Legacy failure reflection evidence",
      },
    });

    const failureRepairSummary = await repairFailureReflectionClaims(projectId);
    const repairedFailureClaim = await prisma.researchClaim.findUnique({ where: { id: legacyFailureClaim.id } });
    if (failureRepairSummary.repaired >= 1 && !repairedFailureClaim) {
      pushStep(steps, "repair_failure_reflection_claims", "pass", `Repaired ${failureRepairSummary.repaired} legacy failure reflection claim(s).`);
    } else {
      pushStep(steps, "repair_failure_reflection_claims", "fail", "Operational failure reflection claim was not repaired.");
    }

    const legacyReviewedClaim = await prisma.researchClaim.create({
      data: {
        projectId,
        statement: "Legacy reviewed claim should gain a structured assessment.",
        summary: "Created without ClaimAssessment rows to verify repair.",
        type: "finding",
        status: "RETRACTED",
        confidence: "MODERATE",
        createdBy: "reviewer",
        createdFrom: "review_claim",
      },
    });
    const legacyAssessmentRepair = await repairLegacyClaimAssessments(projectId);
    const repairedLegacyAssessments = await prisma.claimAssessment.findMany({
      where: { claimId: legacyReviewedClaim.id },
      select: { actorRole: true, verdict: true },
    });
    if (
      legacyAssessmentRepair.createdAssessments >= 1
      && repairedLegacyAssessments.some((assessment) =>
        assessment.actorRole === "reviewer" && assessment.verdict === "RETRACTED"
      )
    ) {
      pushStep(steps, "repair_legacy_claim_assessments", "pass", "Legacy reviewed claims are backfilled with structured assessment rows.");
    } else {
      pushStep(steps, "repair_legacy_claim_assessments", "fail", "Legacy reviewed claim did not receive a structured assessment.");
    }

    const planningDecision = await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "decision",
        content: "SESSION 99 PLAN — RESEARCH PLAN\n\nSITUATION ASSESSMENT:\n- acceptance planning note\n\nFIXES NEEDED:\n- none",
      },
    });
    const planningRepairSummary = await repairPlanningDecisionLogs(projectId);
    const repairedPlanningDecision = await prisma.researchLogEntry.findUnique({
      where: { id: planningDecision.id },
      select: { type: true },
    });
    if (planningRepairSummary.reclassified >= 1 && repairedPlanningDecision?.type === "planning_note") {
      pushStep(steps, "repair_planning_notes", "pass", "Session-plan notebook entries are reclassified out of decision logs.");
    } else {
      pushStep(steps, "repair_planning_notes", "fail", "Planning notebook entry was not reclassified.");
    }

    const runtimeRepairHost = await prisma.remoteHost.create({
      data: {
        alias: `credibility-runtime-${projectId.slice(0, 8)}`,
        host: "runtime.invalid",
        user: "mock",
        workDir: "~/mock-experiments",
      },
    });
    const failedRuntimeJob = await prisma.remoteJob.create({
      data: {
        hostId: runtimeRepairHost.id,
        projectId,
        localDir: acceptanceWorkDir,
        remoteDir: "~/mock-experiments/failure-reflection",
        command: "python3 legacy_runtime_failure.py",
        status: "CANCELLED",
        stdout: "",
        stderr: "Process terminated by scheduler",
        completedAt: now,
      },
    });
    const legacyFailureResult = await prisma.experimentResult.create({
      data: {
        projectId,
        jobId: failedRuntimeJob.id,
        scriptName: "legacy_runtime_failure.py",
        verdict: "error",
        reflection: "ROOT CAUSE: scheduler termination\nLESSON: do not model runtime failures as experiment results",
      },
    });
    const failureResultRepairSummary = await repairFailureReflectionResults(projectId);
    const repairedFailureResult = await prisma.experimentResult.findUnique({ where: { id: legacyFailureResult.id } });
    const migratedFailureLog = await prisma.researchLogEntry.findFirst({
      where: {
        projectId,
        type: "dead_end",
        metadata: { contains: failedRuntimeJob.id },
      },
      select: { id: true },
    });
    if (failureResultRepairSummary.repaired >= 1 && !repairedFailureResult && migratedFailureLog) {
      pushStep(steps, "repair_failure_reflection_results", "pass", "Operational failure results are migrated back into dead-end notebook entries.");
    } else {
      pushStep(steps, "repair_failure_reflection_results", "fail", "Operational failure result was not repaired cleanly.");
    }

    const stdoutImportDir = path.join(acceptanceWorkDir, "stdout-import");
    await mkdir(stdoutImportDir, { recursive: true });
    const stdoutImportHost = await prisma.remoteHost.create({
      data: {
        alias: `credibility-stdout-${projectId.slice(0, 8)}`,
        host: "stdout.invalid",
        user: "mock",
        workDir: "~/mock-experiments",
      },
    });
    const stdoutImportJob = await prisma.remoteJob.create({
      data: {
        hostId: stdoutImportHost.id,
        projectId,
        localDir: stdoutImportDir,
        remoteDir: "~/mock-experiments/stdout-import",
        command: "python3 poc_legacy_stdout.py --seed 7",
        status: "COMPLETED",
        stdout: [
          "SUMMARY (10 samples)",
          "======================================================================",
          "                  Mean PPL   ASR@40   Mean Sim",
          "     Human text       62.4    60.0%        N/A",
          " Paraphrase t=1       64.2    60.0%      0.884",
          "Paraphrase t=1.5       92.6    90.0%      0.886",
          "======================================================================",
        ].join("\n"),
        stderr: "",
        completedAt: now,
      },
    });
    const importedStdoutResult = await importExperimentResultFromRemoteJob(stdoutImportJob.id);
    const importedLegacyStdout = importedStdoutResult.imported && importedStdoutResult.resultId
      ? await prisma.experimentResult.findUnique({
          where: { id: importedStdoutResult.resultId },
          select: { id: true, condition: true, rawMetrics: true },
        })
      : null;
    if (importedStdoutResult.imported && importedLegacyStdout?.condition === "Paraphrase t=1.5") {
      pushStep(steps, "import_legacy_stdout_summary", "pass", "Legacy tabular stdout summary imported into an ExperimentResult.");
    } else {
      pushStep(steps, "import_legacy_stdout_summary", "fail", "Legacy tabular stdout summary was not imported.");
    }

    const namedJsonImportDir = path.join(acceptanceWorkDir, "named-json-import");
    await mkdir(namedJsonImportDir, { recursive: true });
    await writeFile(
      path.join(namedJsonImportDir, "poc_002_results.json"),
      JSON.stringify({
        human_mean_ppl: 28.9,
        conditions: {
          "default_T0.7": {
            asr_ppl40: 0.53,
            quality_asr: 0.46,
            semantic_sim: 0.851,
            mean_ppl: 43.4,
          },
          "humanize_T1.5": {
            asr_ppl40: 0.73,
            quality_asr: 0.2,
            semantic_sim: 0.747,
            mean_ppl: 48.6,
          },
        },
      }, null, 2),
    );
    const namedJsonHost = await prisma.remoteHost.create({
      data: {
        alias: `credibility-named-json-${projectId.slice(0, 8)}`,
        host: "named-json.invalid",
        user: "mock",
        workDir: "~/mock-experiments",
      },
    });
    const namedJsonJob = await prisma.remoteJob.create({
      data: {
        hostId: namedJsonHost.id,
        projectId,
        localDir: namedJsonImportDir,
        remoteDir: "~/mock-experiments/named-json-import",
        command: "python3 poc_002_ppl_test.py --seed 42",
        status: "COMPLETED",
        stdout: [
          "=== SUMMARY ===",
          "Human PPL: 28.9 | PPL>40: 26.7%",
          "default_T0.7: ASR=53.0% QASR=46.0% Sim=0.851 PPL=43.4",
          "humanize_T1.5: ASR=73.0% QASR=20.0% Sim=0.747 PPL=48.6",
          "Done!",
        ].join("\n"),
        stderr: "",
        completedAt: now,
      },
    });
    const importedNamedJson = await importExperimentResultFromRemoteJob(namedJsonJob.id);
    const importedNamedJsonResult = importedNamedJson.imported && importedNamedJson.resultId
      ? await prisma.experimentResult.findUnique({
          where: { id: importedNamedJson.resultId },
          select: { id: true, condition: true, rawMetrics: true },
        })
      : null;
    if (
      importedNamedJson.imported
      && importedNamedJsonResult?.condition === "humanize_T1.5"
      && importedNamedJsonResult.rawMetrics?.includes("default_t0_7__asr_ppl40")
    ) {
      pushStep(steps, "import_named_root_result_json", "pass", "Completed runs import root-level named result JSON files into canonical ExperimentResult rows.");
    } else {
      pushStep(steps, "import_named_root_result_json", "fail", "Named root-level result JSON did not import into ExperimentResult.");
    }

    const pendingImportDir = path.join(acceptanceWorkDir, "pending-result-barrier");
    await mkdir(pendingImportDir, { recursive: true });
    const pendingImportHost = await prisma.remoteHost.create({
      data: {
        alias: `credibility-pending-${projectId.slice(0, 8)}`,
        host: "pending.invalid",
        user: "mock",
        workDir: "~/mock-experiments",
      },
    });
    const pendingImportJob = await prisma.remoteJob.create({
      data: {
        hostId: pendingImportHost.id,
        projectId,
        localDir: pendingImportDir,
        remoteDir: "~/mock-experiments/pending-result-barrier",
        command: "python3 poc_010_pending_result.py --seed 42",
        status: "COMPLETED",
        stdout: "run complete but no structured artifact yet",
        stderr: "",
        completedAt: now,
      },
    });
    const creationBarrier = await getManagedScriptCreationBarrier(projectId, "poc_011_new_branch.py");
    const submissionBarrier = await getExperimentSubmissionConvergenceBarrier(projectId, "poc_011_new_branch.py");
    const deletionBarrier = await getManagedScriptDeletionBarrier(projectId, "poc_010_pending_result.py");
    if (
      creationBarrier?.includes("canonical ExperimentResult")
      && submissionBarrier?.includes("analysis before another run")
      && deletionBarrier?.includes("persisted experiment history")
      && pendingImportJob.id
    ) {
      pushStep(steps, "experiment_convergence_barriers", "pass", "Controller blocks new script churn while completed experiment output still needs canonical ingestion.");
    } else {
      pushStep(steps, "experiment_convergence_barriers", "fail", "Experiment convergence barriers did not block script churn as expected.");
    }

    const duplicateEvidenceClaimId = await createClaim({
      projectId,
      statement: "Validation claim for provenance repair.",
      summary: "Should keep experiment evidence but drop remote job duplication.",
      type: "finding",
      createdBy: "system",
      createdFrom: "acceptance_credibility",
      resultId: importedLegacyStdout?.id || null,
      evidence: importedLegacyStdout ? [
        {
          kind: "experiment_result",
          resultId: importedLegacyStdout.id,
          supports: true,
          strength: "DIRECT",
          rationale: "Acceptance experiment evidence.",
        },
        {
          kind: "remote_job",
          remoteJobId: stdoutImportJob.id,
          supports: true,
          strength: "DIRECT",
          rationale: "Acceptance duplicate provenance.",
        },
      ] : [],
    });
    const provenanceRepair = await repairResultBackedClaimProvenance(projectId);
    const duplicateEvidenceClaim = await prisma.researchClaim.findUnique({
      where: { id: duplicateEvidenceClaimId },
      include: { evidence: { select: { kind: true } } },
    });
    if (
      provenanceRepair.removed >= 1
      && duplicateEvidenceClaim?.evidence.some((evidence) => evidence.kind === "experiment_result")
      && !duplicateEvidenceClaim?.evidence.some((evidence) => evidence.kind === "remote_job")
    ) {
      pushStep(steps, "repair_result_backed_provenance", "pass", "Result-backed claims keep experiment evidence and drop duplicate remote-job provenance.");
    } else {
      pushStep(steps, "repair_result_backed_provenance", "fail", "Result-backed provenance repair did not remove duplicate remote-job evidence.");
    }

    const retiredResultClaim = importedLegacyStdout
      ? await prisma.researchClaim.create({
          data: {
            projectId,
            statement: "Temporary result-derived claim for retirement repair.",
            summary: "Should be retired back to the ExperimentResult layer.",
            type: "finding",
            status: "DRAFT",
            confidence: "PRELIMINARY",
            createdBy: "system",
            createdFrom: "record_result",
            resultId: importedLegacyStdout.id,
          },
        })
      : null;
    if (retiredResultClaim && importedLegacyStdout) {
      await prisma.claimEvidence.create({
        data: {
          claimId: retiredResultClaim.id,
          kind: "experiment_result",
          resultId: importedLegacyStdout.id,
          supports: true,
          strength: "DIRECT",
          rationale: "Acceptance derived-result repair.",
        },
      });
    }
    const derivedRepair = await repairDerivedResultClaims(projectId);
    const retiredResultClaimState = retiredResultClaim
      ? await prisma.researchClaim.findUnique({
      where: { id: retiredResultClaim.id },
      select: { status: true },
    })
      : null;
    if (derivedRepair.retracted >= 1 && retiredResultClaimState?.status === "RETRACTED") {
      pushStep(steps, "retire_result_claims", "pass", "Result-derived claims are retired out of the canonical ledger.");
    } else {
      pushStep(steps, "retire_result_claims", "fail", "Result-derived claims were not retired as expected.");
    }

    const duplicateClaimA = await prisma.researchClaim.create({
      data: {
        projectId,
        statement: "Human CNN/DailyMail text only reaches 70% ASR at threshold 40, so the detector has a 30% false positive rate on human text.",
        summary: "Acceptance duplicate A.",
        type: "methodological",
        status: "DRAFT",
        confidence: "PRELIMINARY",
        createdBy: "system",
        createdFrom: "acceptance_credibility",
      },
    });
    const duplicateClaimB = await prisma.researchClaim.create({
      data: {
        projectId,
        statement: "The threshold-40 detector misclassifies 30% of human CNN/DailyMail text, since human text achieves just 70% ASR@40.",
        summary: "Acceptance duplicate B.",
        type: "finding",
        status: "DRAFT",
        confidence: "PRELIMINARY",
        createdBy: "system",
        createdFrom: "acceptance_credibility",
      },
    });
    const duplicateRepair = await repairDuplicateClaims(projectId);
    const duplicateClaims = await prisma.researchClaim.findMany({
      where: {
        id: { in: [duplicateClaimA.id, duplicateClaimB.id] },
      },
      select: { id: true, status: true },
    });
    const activeDuplicateClaims = duplicateClaims.filter((claim) => claim.status !== "RETRACTED");
    if (duplicateRepair.retracted >= 1 && activeDuplicateClaims.length === 1) {
      pushStep(steps, "merge_duplicate_claims", "pass", "Near-duplicate raw claims collapse into one canonical active claim.");
    } else {
      pushStep(steps, "merge_duplicate_claims", "fail", "Duplicate claim repair did not collapse the duplicate family.");
    }

    const syntheticHost = await prisma.remoteHost.create({
      data: {
        alias: `credibility-mock-${projectId.slice(0, 8)}`,
        host: "blocked.invalid",
        user: "mock",
        workDir: "~/mock-experiments",
      },
    });
    try {
      await submitRemoteJob({
        hostId: syntheticHost.id,
        localDir: acceptanceWorkDir,
        command: "python3 blocked.py",
        projectId,
      });
      pushStep(steps, "synthetic_host_block", "fail", "Synthetic .invalid host was allowed for normal research execution.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Synthetic host rejected.";
      if (message.includes("synthetic test host")) {
        pushStep(steps, "synthetic_host_block", "pass", message);
      } else {
        pushStep(steps, "synthetic_host_block", "fail", message);
      }
    }

    const leaseWorkDir = path.join(acceptanceWorkDir, "lease-smoke");
    await mkdir(leaseWorkDir, { recursive: true });
    const leaseHost = await prisma.remoteHost.create({
      data: {
        alias: `credibility-lease-${projectId.slice(0, 8)}`,
        host: "lease.invalid",
        user: "mock",
        workDir: "~/mock-experiments",
      },
    });
    const leaseSubmit = await submitRemoteJob({
      hostId: leaseHost.id,
      localDir: leaseWorkDir,
      command: "python3 poc_lease_smoke.py --seed 11",
      projectId,
      mock: {
        enabled: true,
        mode: "success",
        writeResultFile: true,
      },
    });
    const leaseJob = await prisma.remoteJob.findUnique({
      where: { id: leaseSubmit.jobId },
      select: { runId: true },
    });
    const workspaceLeaseKey = buildWorkspaceLeaseKey(leaseHost.id, `${leaseHost.workDir}/lease-smoke`);
    const survivingLease = await prisma.executorLease.findUnique({
      where: { leaseKey: workspaceLeaseKey },
    });
    const latestLeaseAttempt = leaseJob?.runId
      ? await prisma.experimentAttempt.findFirst({
          where: { runId: leaseJob.runId },
          orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
          select: { state: true },
        })
      : null;
    if (!survivingLease && latestLeaseAttempt?.state === "TERMINAL") {
      pushStep(steps, "workspace_lease_release", "pass", "Workspace lease was acquired and released around a successful mock run.");
    } else {
      pushStep(steps, "workspace_lease_release", "fail", "Successful run left behind an active workspace lease.");
    }

    const blockingLease = await acquireExecutorLease({
      leaseKey: workspaceLeaseKey,
      owner: {
        ownerId: "acceptance-preexisting-lease",
        scope: "workspace",
        hostId: leaseHost.id,
        projectId,
        metadata: { reason: "acceptance_blocking_test" },
      },
    });
    if (!blockingLease.acquired) {
      pushStep(steps, "workspace_lease_block", "fail", "Failed to seed a blocking workspace lease for acceptance.");
    } else {
      try {
        await submitRemoteJob({
          hostId: leaseHost.id,
          localDir: leaseWorkDir,
          command: "python3 poc_lease_blocked.py --seed 11",
          projectId,
          mock: {
            enabled: true,
            mode: "success",
          },
        });
        pushStep(steps, "workspace_lease_block", "fail", "Active workspace lease did not block a second submission.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Workspace lease blocked submission.";
        if (message.includes("Workspace busy") || message.includes("lease")) {
          pushStep(steps, "workspace_lease_block", "pass", message);
        } else {
          pushStep(steps, "workspace_lease_block", "fail", message);
        }
    } finally {
        await releaseExecutorLease({
          leaseKey: workspaceLeaseKey,
          leaseToken: blockingLease.acquired ? blockingLease.lease.leaseToken : undefined,
          reason: "Acceptance lease cleanup",
        }).catch(() => {});
      }
    }

    const cancelHost = await prisma.remoteHost.create({
      data: {
        alias: `credibility-cancel-${projectId.slice(0, 8)}`,
        host: "cancel.invalid",
        user: "mock",
        workDir: "~/mock-experiments",
      },
    });
    const cancelRun = await prisma.experimentRun.create({
      data: {
        projectId,
        requestedHostId: cancelHost.id,
        command: "python3 exp_cancel_acceptance.py",
        scriptName: "exp_cancel_acceptance.py",
        state: "RUNNING",
        startedAt: now,
      },
    });
    const cancelAttempt = await prisma.experimentAttempt.create({
      data: {
        runId: cancelRun.id,
        attemptNumber: 1,
        hostId: cancelHost.id,
        localDir: acceptanceWorkDir,
        remoteDir: "~/mock-experiments/cancel-acceptance",
        runDir: "run_cancel_acceptance",
        helperVersion: "acceptance",
        state: "RUNNING",
        startedAt: now,
        heartbeatAt: now,
      },
    });
    const cancelLeaseKey = buildWorkspaceLeaseKey(cancelHost.id, "~/mock-experiments/cancel-acceptance");
    await acquireExecutorLease({
      leaseKey: cancelLeaseKey,
      owner: {
        ownerId: `attempt:${cancelAttempt.id}`,
        scope: "workspace",
        runId: cancelRun.id,
        attemptId: cancelAttempt.id,
        hostId: cancelHost.id,
        projectId,
      },
    });
    const cancelJob = await prisma.remoteJob.create({
      data: {
        hostId: cancelHost.id,
        projectId,
        runId: cancelRun.id,
        localDir: acceptanceWorkDir,
        remoteDir: "~/mock-experiments/cancel-acceptance",
        command: "python3 exp_cancel_acceptance.py",
        status: "RUNNING",
        startedAt: now,
      },
    });
    await cancelRemoteJob(cancelJob.id);
    const [cancelledJob, cancelledRun, cancelledAttempt, cancelledLease] = await Promise.all([
      prisma.remoteJob.findUnique({ where: { id: cancelJob.id }, select: { status: true } }),
      prisma.experimentRun.findUnique({ where: { id: cancelRun.id }, select: { state: true } }),
      prisma.experimentAttempt.findUnique({ where: { id: cancelAttempt.id }, select: { state: true, errorReason: true } }),
      prisma.executorLease.findUnique({ where: { leaseKey: cancelLeaseKey } }),
    ]);
    if (
      cancelledJob?.status === "CANCELLED"
      && cancelledRun?.state === "CANCELLED"
      && cancelledAttempt?.state === "TERMINAL"
      && !cancelledLease
    ) {
      pushStep(steps, "cancel_job_releases_lease", "pass", "Cancelling a remote job now finalizes the run/attempt and releases the workspace lease.");
    } else {
      pushStep(steps, "cancel_job_releases_lease", "fail", "Cancelling a remote job did not fully clear run state and lease ownership.");
    }

    await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "help_request",
        content: "The workspace has 31 Python scripts and write_file is blocked for new experiment scripts.",
        metadata: JSON.stringify({
          category: "env_issue",
          title: "Cannot write files - 31 Python scripts limit reached",
          suggestion: "Delete obsolete scripts.",
          resolved: false,
        }),
      },
    });
    await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "help_request",
        content: "The workspace has 31 Python scripts and write_file is blocked for new experiment scripts.",
        metadata: JSON.stringify({
          category: "env_issue",
          title: "CRITICAL: Cannot modify ANY Python files due to 31-script limit",
          suggestion: "Delete obsolete scripts.",
          resolved: false,
        }),
      },
    });
    const helpRefresh = await refreshProjectHelpRequests(projectId);
    const scriptLimitHelpEntries = await prisma.researchLogEntry.findMany({
      where: {
        projectId,
        type: "help_request",
        metadata: { contains: "\"issueType\":\"script_limit\"" },
      },
      select: { metadata: true },
    });
    const allScriptLimitResolved = scriptLimitHelpEntries.every((entry) => {
      const metadata = parseHelpRequestMetadata(entry.metadata);
      return metadata.resolved === true && metadata.requiresUserAction === false;
    });
    if (helpRefresh.updated >= 1 && allScriptLimitResolved) {
      pushStep(steps, "script_limit_help_autoresolve", "pass", "Script-budget env issues no longer require user attention and are auto-resolved.");
    } else {
      pushStep(steps, "script_limit_help_autoresolve", "fail", "Script-budget help requests still require manual user acknowledgement.");
    }

    const dedupedHelp = await createOrUpdateHelpRequest({
      projectId,
      category: "package",
      title: "Install flash_attn on acceptance-host",
      detail: "Packages not found in host environment: flash_attn",
      suggestion: "pip install flash-attn",
      metadata: { hostAlias: "acceptance-host" },
    });
    const dedupedHelpAgain = await createOrUpdateHelpRequest({
      projectId,
      category: "package",
      title: "Install flash_attn on acceptance-host",
      detail: "Packages not found in host environment: flash_attn",
      suggestion: "pip install flash-attn",
      metadata: { hostAlias: "acceptance-host" },
    });
    if (dedupedHelp.id === dedupedHelpAgain.id) {
      pushStep(steps, "help_request_upsert", "pass", "Canonical help-request keys upsert repeated package issues instead of duplicating notifications.");
    } else {
      pushStep(steps, "help_request_upsert", "fail", "Repeated package issues still created duplicate help-request rows.");
    }

    const blockedTrackHost = await prisma.remoteHost.create({
      data: {
        alias: `credibility-track-${projectId.slice(0, 8)}`,
        host: "track.invalid",
        user: "mock",
        workDir: "~/mock-experiments",
      },
    });
    await prisma.experimentRun.create({
      data: {
        projectId,
        requestedHostId: blockedTrackHost.id,
        command: "python3 blocked_retry.py",
        scriptName: "blocked_retry.py",
        state: "BLOCKED",
        completedAt: now,
      },
    });
    const lineage = await getProjectLineage(projectId);
    const blockedOnlyTrack = lineage.tracks.find((track) => track.label.includes("Blocked on"));
    if (!blockedOnlyTrack) {
      pushStep(steps, "hide_blocked_retry_tracks", "pass", "Standalone blocked retry runs are omitted from the lineage audit view.");
    } else {
      pushStep(steps, "hide_blocked_retry_tracks", "fail", "Blocked retry run still appeared as a standalone audit chain.");
    }

    const result = await prisma.experimentResult.create({
      data: {
        projectId,
        scriptName: "poc_credibility_acceptance.py",
        metrics: JSON.stringify({ f1: 0.71, accuracy: 0.81 }),
        rawMetrics: JSON.stringify({ f1: 0.71, accuracy: 0.81 }),
        verdict: "better",
        reflection: "Acceptance result for credibility ledger.",
      },
    });
    const validationHypothesis = await prisma.researchHypothesis.create({
      data: {
        projectId,
        statement: "Acceptance hypothesis for coordinator experiment obligations.",
        rationale: "Used to verify deterministic experiment requirements.",
        status: "TESTING",
      },
    });

    const draftClaimId = await createClaim({
      projectId,
      statement: "Draft claim acceptance signal.",
      summary: "Should not be promotable yet.",
      type: "finding",
      status: "DRAFT",
      confidence: "PRELIMINARY",
      createdBy: "system",
      createdFrom: "acceptance_credibility",
      resultId: result.id,
      evidence: [{
        kind: "experiment_result",
        resultId: result.id,
        supports: true,
        strength: "DIRECT",
      }],
    });

    try {
      await promoteClaimToMemory({
        claimId: draftClaimId,
        userId,
        category: "general",
        lesson: "Draft claim should not promote",
        projectId,
      });
      pushStep(steps, "draft_promotion_block", "fail", "Draft claim promoted unexpectedly.");
    } catch (err) {
      pushStep(steps, "draft_promotion_block", "pass", err instanceof Error ? err.message : "Draft promotion blocked.");
    }

    const supportedClaimId = await createClaim({
      projectId,
      statement: "Supported claim acceptance signal.",
      summary: "Used to verify summary/export grounding.",
      type: "finding",
      status: "SUPPORTED",
      confidence: "MODERATE",
      createdBy: "system",
      createdFrom: "acceptance_credibility",
      resultId: result.id,
      evidence: [{
        kind: "experiment_result",
        resultId: result.id,
        supports: true,
        strength: "DIRECT",
      }],
    });
    await attachClaimEvidence(supportedClaimId, {
      kind: "log_entry",
      logEntryId: acceptanceLog.id,
      supports: true,
      strength: "CONTEXT",
      rationale: "Acceptance log context",
    });
    pushStep(steps, "supported_claim", "pass", `Created supported claim ${supportedClaimId.slice(0, 8)}.`);

    try {
      await promoteClaimToMemory({
        claimId: supportedClaimId,
        userId,
        category: "general",
        lesson: "Supported claim without review should not promote.",
        projectId,
      });
      pushStep(steps, "supported_promotion_requires_review", "fail", "Supported claim promoted before review.");
    } catch (err) {
      pushStep(steps, "supported_promotion_requires_review", "pass", err instanceof Error ? err.message : "Supported promotion blocked before review.");
    }

    const firstCoordinatorSync = await syncClaimCoordinator(projectId, {
      autoDispatch: true,
      launchTaskRunner: false,
    });
    const queueAfterFirstSync = await listClaimCoordinatorQueue(projectId, { activeOnly: true });
    if (queueAfterFirstSync.some((item) => item.type === "claim_review_required" && item.claimId === supportedClaimId)) {
      pushStep(steps, "coordinator_queue_active", "pass", "Queue exposes active review obligations.");
    } else {
      pushStep(steps, "coordinator_queue_active", "fail", "Queue did not expose the expected review obligation.");
    }
    const firstCoordinatorTasks = await prisma.agentTask.findMany({
      where: { id: { in: firstCoordinatorSync.createdTaskIds } },
      select: { id: true, role: true, input: true },
    });
    const coordinatorReviewer = firstCoordinatorTasks.find((task) =>
      task.role === "reviewer" && parseAgentTaskClaimIds(task.input).includes(supportedClaimId)
    );
    if (coordinatorReviewer) {
      pushStep(steps, "coordinator_review_dispatch", "pass", `Coordinator dispatched reviewer ${coordinatorReviewer.id.slice(0, 8)}.`);
      await prisma.agentTask.update({
        where: { id: coordinatorReviewer.id },
        data: {
          status: "COMPLETED",
          completedAt: now,
          output: JSON.stringify({
            claimReviews: [{
              claimId: supportedClaimId,
              status: "SUPPORTED",
              confidence: "MODERATE",
              notes: "Coordinator reviewer accepted the claim.",
            }],
          }),
        },
      });
      await reviewClaim({
        claimId: supportedClaimId,
        status: "SUPPORTED",
        confidence: "MODERATE",
        notes: "Coordinator reviewer accepted the claim.",
        createdBy: "reviewer",
        evidence: [{
          kind: "agent_task",
          taskId: coordinatorReviewer.id,
          supports: true,
          strength: "DIRECT",
          rationale: "Coordinator reviewer approved the claim.",
        }],
      });
    } else {
      pushStep(steps, "coordinator_review_dispatch", "fail", "Coordinator did not dispatch a reviewer for the supported claim.");
    }

    const secondCoordinatorSync = await syncClaimCoordinator(projectId, {
      autoDispatch: true,
      launchTaskRunner: false,
    });
    const secondCoordinatorTasks = await prisma.agentTask.findMany({
      where: { id: { in: secondCoordinatorSync.createdTaskIds } },
      select: { id: true, role: true, input: true },
    });
    const coordinatorReproducer = secondCoordinatorTasks.find((task) =>
      task.role === "reproducer" && parseAgentTaskClaimIds(task.input).includes(supportedClaimId)
    );
    if (coordinatorReproducer) {
      pushStep(steps, "coordinator_reproduction_dispatch", "pass", `Coordinator dispatched reproducer ${coordinatorReproducer.id.slice(0, 8)}.`);
    } else {
      pushStep(steps, "coordinator_reproduction_dispatch", "fail", "Coordinator did not dispatch a reproducer for the reviewed supported claim.");
    }

    const contestedClaimId = await createClaim({
      projectId,
      statement: "Contested claim acceptance noise.",
      summary: "Should be excluded from key findings.",
      type: "finding",
      status: "DRAFT",
      confidence: "PRELIMINARY",
      createdBy: "system",
      createdFrom: "acceptance_credibility",
      hypothesisId: validationHypothesis.id,
    });
    await reviewClaim({
      claimId: contestedClaimId,
      status: "CONTESTED",
      confidence: "PRELIMINARY",
      notes: "Reviewer contested this claim.",
      createdBy: "reviewer",
      evidence: [{
        kind: "agent_task",
        taskId: reviewerTask.id,
        supports: false,
        strength: "REBUTTAL",
        rationale: "Reviewer rejected the claim.",
      }],
    });
    pushStep(steps, "contested_claim_review", "pass", `Contested claim ${contestedClaimId.slice(0, 8)} reviewed.`);

    const directValidationClaimId = await createClaim({
      projectId,
      statement: "Reviewed claim still missing direct experimental validation.",
      summary: "Should queue a focused validation experiment.",
      type: "hypothesis_assessment",
      status: "SUPPORTED",
      confidence: "MODERATE",
      createdBy: "system",
      createdFrom: "acceptance_credibility",
      hypothesisId: validationHypothesis.id,
      evidence: [{
        kind: "log_entry",
        logEntryId: acceptanceLog.id,
        supports: true,
        strength: "CONTEXT",
        rationale: "Notebook synthesis suggests this should work, but no direct experiment exists yet.",
      }],
    });
    await reviewClaim({
      claimId: directValidationClaimId,
      status: "SUPPORTED",
      confidence: "MODERATE",
      notes: "Reviewer agrees the claim is plausible, but it still needs a dedicated validation experiment.",
      createdBy: "reviewer",
      evidence: [{
        kind: "agent_task",
        taskId: reviewerTask.id,
        supports: true,
        strength: "DIRECT",
        rationale: "Reviewer approved the claim pending direct validation.",
      }],
    });
    pushStep(steps, "direct_validation_claim_review", "pass", `Direct-validation claim ${directValidationClaimId.slice(0, 8)} reviewed.`);

    const thirdCoordinatorSync = await syncClaimCoordinator(projectId, {
      autoDispatch: true,
      launchTaskRunner: false,
    });
    const queueAfterThirdSync = await listClaimCoordinatorQueue(projectId, { activeOnly: true });
    const experimentSteps = await prisma.researchStep.findMany({
      where: {
        iterationId: thirdCoordinatorSync.activeIterationId,
        type: "claim_experiment_required",
        status: "PROPOSED",
      },
      select: { id: true, input: true },
    });
    const experimentStepInputs = experimentSteps.map((step) => ({
      stepId: step.id,
      parsed: parseCoordinatorStepInput(step.input),
    }));
    const hasContestedExperiment = queueAfterThirdSync.some((item) =>
      item.type === "claim_experiment_required"
      && item.claimId === contestedClaimId
      && item.experimentReason === "resolve_contestation"
    ) && experimentStepInputs.some((item) =>
      item.parsed.claimId === contestedClaimId
      && item.parsed.experimentReason === "resolve_contestation"
    );
    const hasDirectValidationExperiment = queueAfterThirdSync.some((item) =>
      item.type === "claim_experiment_required"
      && item.claimId === directValidationClaimId
      && item.experimentReason === "direct_validation"
    ) && experimentStepInputs.some((item) =>
      item.parsed.claimId === directValidationClaimId
      && item.parsed.experimentReason === "direct_validation"
    );
    if (hasContestedExperiment && hasDirectValidationExperiment) {
      pushStep(steps, "coordinator_experiment_queue", "pass", "Coordinator created deterministic experiment obligations for contested and weak-evidence claims.");
    } else {
      pushStep(steps, "coordinator_experiment_queue", "fail", "Coordinator did not materialize the expected claim-driven experiment obligations.");
    }

    const resolutionResult = await prisma.experimentResult.create({
      data: {
        projectId,
        hypothesisId: validationHypothesis.id,
        scriptName: "exp_credibility_resolution.py",
        metrics: JSON.stringify({ f1: 0.74, accuracy: 0.83 }),
        rawMetrics: JSON.stringify({ f1: 0.74, accuracy: 0.83 }),
        verdict: "better",
        reflection: "Coordinator resolution experiment.",
      },
    });
    const reconciliation = await reconcileExperimentResultWithClaimCoordinator({
      projectId,
      resultId: resolutionResult.id,
      hypothesisId: validationHypothesis.id,
      verdict: "better",
      scriptName: resolutionResult.scriptName,
      explicitClaimIds: [directValidationClaimId],
    });
    await syncClaimCoordinator(projectId, {
      autoDispatch: true,
      launchTaskRunner: false,
    });
    const queueAfterResolution = await listClaimCoordinatorQueue(projectId, { activeOnly: true });
    const directValidationClaim = await prisma.researchClaim.findUnique({
      where: { id: directValidationClaimId },
      include: { evidence: true },
    });
    if (
      reconciliation.matchedClaimIds.includes(directValidationClaimId)
      && !queueAfterResolution.some((item) =>
        item.type === "claim_experiment_required"
        && item.claimId === directValidationClaimId
      )
      && directValidationClaim?.evidence.some((evidence) =>
        evidence.kind === "experiment_result" && evidence.resultId === resolutionResult.id
      )
    ) {
      pushStep(steps, "coordinator_experiment_resolution", "pass", "Experiment reconciliation attached evidence and closed the direct-validation obligation.");
    } else {
      pushStep(steps, "coordinator_experiment_resolution", "fail", "Coordinator experiment obligation did not close after result reconciliation.");
    }

    const reproductionClaimId = await createClaim({
      projectId,
      statement: "Reproduced claim acceptance proof.",
      summary: "Validated by reproducer task.",
      type: "reproduction",
      status: "DRAFT",
      confidence: "PRELIMINARY",
      createdBy: "system",
      createdFrom: "acceptance_credibility",
    });
    await reviewClaim({
      claimId: reproductionClaimId,
      status: "REPRODUCED",
      confidence: "STRONG",
      notes: "Reproducer validated the claim.",
      createdBy: "reproducer",
      evidence: [{
        kind: "agent_task",
        taskId: reproducerTask.id,
        supports: true,
        strength: "DIRECT",
        rationale: "Reproducer task completed successfully.",
      }],
    });
    pushStep(steps, "reproduced_claim_review", "pass", `Reproduced claim ${reproductionClaimId.slice(0, 8)} reviewed.`);

    const candidateMemory = await promoteClaimToMemory({
      claimId: supportedClaimId,
      userId,
      category: "general",
      lesson: "Supported claim acceptance signal.",
      context: "Credibility acceptance promotion.",
      projectId,
    });
    if (candidateMemory.sourceClaimId === supportedClaimId && candidateMemory.status === "CANDIDATE") {
      pushStep(steps, "claim_candidate_promotion", "pass", `Memory ${candidateMemory.id.slice(0, 8)} created as candidate memory.`);
    } else {
      pushStep(steps, "claim_candidate_promotion", "fail", "Supported claim did not promote into candidate memory.");
    }

    const approvedSupportedMemory = await transitionClaimMemory({
      memoryId: candidateMemory.id,
      userId,
      status: "APPROVED",
    });
    if (approvedSupportedMemory.status === "APPROVED") {
      pushStep(steps, "claim_memory_approval", "pass", `Candidate memory ${approvedSupportedMemory.id.slice(0, 8)} was explicitly approved.`);
    } else {
      pushStep(steps, "claim_memory_approval", "fail", "Explicit memory approval did not reach APPROVED state.");
    }

    const reproducedMemory = await promoteClaimToMemory({
      claimId: reproductionClaimId,
      userId,
      category: "general",
      lesson: "Reproduced claim acceptance proof.",
      context: "Credibility acceptance reproduced promotion.",
      projectId,
    });
    if (reproducedMemory.sourceClaimId === reproductionClaimId && reproducedMemory.status === "APPROVED") {
      pushStep(steps, "reproduced_claim_promotion", "pass", `Reproduced claim promoted directly to approved memory ${reproducedMemory.id.slice(0, 8)}.`);
    } else {
      pushStep(steps, "reproduced_claim_promotion", "fail", "Reproduced claim did not promote directly to approved memory.");
    }

    const summary = await generateResearchSummary(projectId, acceptanceWorkDir);
    const keyFindingsMatch = summary.full.match(/## Key Findings([\s\S]*?)## Methods/);
    const keyFindingsSection = keyFindingsMatch?.[1] || "";
    if (
      keyFindingsSection.includes("Supported claim acceptance signal.")
      && !keyFindingsSection.includes("Draft claim acceptance signal.")
      && !keyFindingsSection.includes("Contested claim acceptance noise.")
    ) {
      pushStep(steps, "summary_grounding", "pass", "Summary key findings follow supported/reproduced claims only.");
    } else {
      pushStep(steps, "summary_grounding", "fail", "Summary key findings were not claim-grounded as expected.");
    }

    const exportRes = await fetch(new URL(`/api/research/${projectId}/export`, request.url), {
      headers: {
        cookie: request.headers.get("cookie") || "",
      },
    });
    const exported = await exportRes.json().catch(() => null) as
      | {
        claims?: Array<{ id: string; evidence?: unknown[]; assessments?: unknown[] }>;
        memories?: Array<{ sourceClaimId?: string; status?: string }>;
        summary?: { structured?: { keyFindings?: Array<{ status: string }> } };
        lineage?: { overview?: { tracks?: number } };
        trace?: { total?: number; returned?: number; events?: Array<{ eventType?: string; runId?: string }> };
      }
      | null;
    if (
      exportRes.ok
      && exported?.claims?.some((claim) =>
        claim.id === supportedClaimId
        && (claim.evidence?.length || 0) > 0
        && (claim.assessments?.length || 0) > 0
      )
      && exported?.memories?.some((memory) => memory.sourceClaimId === supportedClaimId && memory.status === "APPROVED")
      && exported.summary?.structured?.keyFindings?.every((finding) => finding.status === "SUPPORTED" || finding.status === "REPRODUCED")
      && typeof exported.lineage?.overview?.tracks === "number"
      && (exported.trace?.total || 0) >= 2
      && exported.trace?.events?.some((event) => event.eventType === "thinking" && event.runId === traceRunId)
    ) {
      pushStep(steps, "claim_export_shape", "pass", "Project export includes grounded summary, lineage, and agent trace data.");
    } else {
      pushStep(steps, "claim_export_shape", "fail", "Grounded summary, lineage, or agent trace data missing from export output.");
    }

    const ledger = await getClaimLedger(projectId);
    if (ledger.some((claim) => claim.id === reproductionClaimId && claim.status === "REPRODUCED")) {
      pushStep(steps, "ledger_status", "pass", `Ledger contains ${ledger.length} claims.`);
    } else {
      pushStep(steps, "ledger_status", "fail", "Ledger did not retain reproduced claim.");
    }

    const failed = steps.filter((step) => step.status === "fail").length;
    const passed = steps.filter((step) => step.status === "pass").length;
    const warned = steps.filter((step) => step.status === "warn").length;
    const skipped = steps.filter((step) => step.status === "skip").length;

    return NextResponse.json({
      ok: failed === 0,
      project: { id: project.id, title: project.title },
      summary: { passed, failed, warned, skipped, total: steps.length },
      steps,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown credibility acceptance error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
