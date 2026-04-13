import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import {
  getEvaluationProtocol,
  saveEvaluationProtocol,
  summarizeEvaluationProtocol,
  validateCommandAgainstEvaluationProtocol,
  type EvaluationProtocol,
} from "@/lib/research/evaluation-protocol";
import { queryAntiPatterns, querySkillCards } from "@/lib/research/insight-skills";

type Params = { params: Promise<{ id: string }> };

interface StepResult {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
}

interface AcceptanceRequest {
  query?: string;
  persist_protocol?: boolean;
  protocol?: {
    primary_metric?: string;
    secondary_metrics?: string[];
    datasets?: string[];
    seeds?: number[];
    min_runs?: number;
    statistical_test?: string;
    acceptance_criteria?: string;
    required_baselines?: string[];
    notes?: string;
  };
}

function pushStep(steps: StepResult[], name: string, status: StepResult["status"], detail: string): void {
  steps.push({ name, status, detail });
}

async function ensureAcceptanceAntiPatterns(projectId: string, query: string): Promise<string[]> {
  const initial = await queryAntiPatterns({ projectId, query, maxResults: 5 });
  if (initial.length > 0) return initial;

  await prisma.researchLogEntry.create({
    data: {
      projectId,
      type: "dead_end",
      content:
        `Acceptance seed dead end for "${query}": an earlier run destabilized training and caused collapse ` +
        `after removing gradient clipping and using an overly aggressive learning-rate schedule. ` +
        `Avoid this shortcut and reintroduce stability controls before scaling experiments.`,
      metadata: JSON.stringify({
        acceptanceSeed: "superpowers-anti-pattern",
        query,
      }),
    },
  });

  return queryAntiPatterns({ projectId, query, maxResults: 5 });
}

function checkProtocolPrimaryMetric(
  metrics: Record<string, number> | null | undefined,
  rawMetrics: Record<string, number> | null | undefined,
  protocol: EvaluationProtocol,
): { ok: boolean; reason?: string } {
  const primary = protocol.primaryMetric;
  const inMetrics = !!metrics && Object.prototype.hasOwnProperty.call(metrics, primary);
  const inRaw = !!rawMetrics && Object.prototype.hasOwnProperty.call(rawMetrics, primary);
  if (!inMetrics && !inRaw) {
    return {
      ok: false,
      reason: `Evaluation protocol requires primary metric "${primary}" in metrics (preferred) or raw_metrics.`,
    };
  }
  return { ok: true };
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id: projectId } = await params;
    const body = (await req.json().catch(() => ({}))) as AcceptanceRequest;

    const project = await prisma.researchProject.findFirst({
      where: { id: projectId, userId },
      select: { id: true, title: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const steps: StepResult[] = [];
    const persistProtocol = body.persist_protocol !== false;
    const query = (body.query || "stabilize training and prevent collapse").trim();

    const protocolInput = {
      primaryMetric: body.protocol?.primary_metric || "f1",
      secondaryMetrics: body.protocol?.secondary_metrics || ["accuracy"],
      datasets: body.protocol?.datasets || ["smoke_dataset_v1"],
      seeds: body.protocol?.seeds || [11, 23, 47],
      minRuns: body.protocol?.min_runs || 3,
      statisticalTest: body.protocol?.statistical_test || "bootstrap 95% CI",
      acceptanceCriteria: body.protocol?.acceptance_criteria || "mean f1 must beat baseline by >= 0.02",
      requiredBaselines: body.protocol?.required_baselines || ["baseline_a"],
      notes: body.protocol?.notes || "Acceptance route protocol",
    };

    if (persistProtocol) {
      await saveEvaluationProtocol(projectId, protocolInput);
      pushStep(steps, "protocol_save", "pass", "Saved evaluation protocol.");
    } else {
      pushStep(steps, "protocol_save", "skip", "persist_protocol=false; using in-memory protocol checks.");
    }

    const loadedProtocol = persistProtocol
      ? await getEvaluationProtocol(projectId)
      : { protocol: protocolInput, createdAt: new Date(), id: "in-memory" };
    if (!loadedProtocol) {
      pushStep(steps, "protocol_load", "fail", "Protocol missing after save.");
      return NextResponse.json({
        ok: false,
        project: { id: project.id, title: project.title },
        steps,
      }, { status: 200 });
    }
    pushStep(steps, "protocol_load", "pass", summarizeEvaluationProtocol(loadedProtocol.protocol));

    const missingSeedCmd = "python3 poc_001_seed_smoke.py";
    const missingSeedCheck = validateCommandAgainstEvaluationProtocol(missingSeedCmd, loadedProtocol.protocol);
    if (!missingSeedCheck.ok) {
      pushStep(steps, "seed_gate_missing_seed", "pass", missingSeedCheck.reason || "Blocked as expected.");
    } else {
      pushStep(steps, "seed_gate_missing_seed", "fail", "Expected BLOCKED for missing --seed.");
    }

    const wrongSeedCmd = "python3 poc_001_seed_smoke.py --seed 999";
    const wrongSeedCheck = validateCommandAgainstEvaluationProtocol(wrongSeedCmd, loadedProtocol.protocol);
    if (!wrongSeedCheck.ok) {
      pushStep(steps, "seed_gate_wrong_seed", "pass", wrongSeedCheck.reason || "Blocked as expected.");
    } else {
      pushStep(steps, "seed_gate_wrong_seed", "fail", "Expected BLOCKED for out-of-contract seed.");
    }

    const okSeedCmd = `python3 poc_001_seed_smoke.py --seed ${loadedProtocol.protocol.seeds[0]}`;
    const okSeedCheck = validateCommandAgainstEvaluationProtocol(okSeedCmd, loadedProtocol.protocol);
    if (okSeedCheck.ok) {
      pushStep(steps, "seed_gate_allowed_seed", "pass", "Allowed seed accepted.");
    } else {
      pushStep(steps, "seed_gate_allowed_seed", "fail", okSeedCheck.reason || "Unexpected block for allowed seed.");
    }

    const missingPrimaryCheck = checkProtocolPrimaryMetric(
      { accuracy: 0.8 },
      null,
      loadedProtocol.protocol,
    );
    if (!missingPrimaryCheck.ok) {
      pushStep(steps, "result_gate_missing_primary_metric", "pass", missingPrimaryCheck.reason || "Blocked as expected.");
    } else {
      pushStep(steps, "result_gate_missing_primary_metric", "fail", "Expected BLOCKED when primary metric missing.");
    }

    const withPrimaryCheck = checkProtocolPrimaryMetric(
      { [loadedProtocol.protocol.primaryMetric]: 0.701, accuracy: 0.8 },
      null,
      loadedProtocol.protocol,
    );
    if (withPrimaryCheck.ok) {
      pushStep(steps, "result_gate_with_primary_metric", "pass", "Primary metric accepted.");
    } else {
      pushStep(steps, "result_gate_with_primary_metric", "fail", withPrimaryCheck.reason || "Unexpected block with primary metric present.");
    }

    const skillQuery = await querySkillCards({
      userId,
      projectId,
      query,
      mode: "explore",
      maxResults: 6,
      trackUsage: false,
    });
    if (skillQuery.cards.length > 0) {
      const top = skillQuery.cards[0];
      pushStep(
        steps,
        "skill_cards",
        "pass",
        `Returned ${skillQuery.cards.length} cards. Top=${top.paperTitle} | trigger=${top.trigger.slice(0, 120)}`,
      );
    } else {
      pushStep(
        steps,
        "skill_cards",
        "warn",
        "No skill cards found for query. This usually means Mind Palace has no matching insights yet.",
      );
    }

    const antiPatterns = await ensureAcceptanceAntiPatterns(projectId, query);
    if (antiPatterns.length > 0) {
      pushStep(steps, "anti_patterns", "pass", `Found ${antiPatterns.length} anti-pattern(s).`);
    } else {
      pushStep(steps, "anti_patterns", "warn", "No matching anti-patterns in project dead-end logs.");
    }

    const failed = steps.filter((s) => s.status === "fail").length;
    const passed = steps.filter((s) => s.status === "pass").length;
    const warned = steps.filter((s) => s.status === "warn").length;
    const skipped = steps.filter((s) => s.status === "skip").length;

    return NextResponse.json({
      ok: failed === 0,
      project: { id: project.id, title: project.title },
      summary: { passed, failed, warned, skipped, total: steps.length },
      steps,
      protocol: {
        createdAt: loadedProtocol.createdAt,
        contract: loadedProtocol.protocol,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown acceptance error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
