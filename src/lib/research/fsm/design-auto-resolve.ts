import { prisma } from "@/lib/prisma";
import {
  getEvaluationProtocol,
  saveEvaluationProtocol,
  deriveDefaultProtocol,
} from "../evaluation-protocol";

/**
 * Proactively resolve DESIGN prerequisites.
 * Called when the project enters DESIGN or when metrics are defined.
 *
 * Auto-creates evaluation protocol from metrics if:
 * - Metrics are defined
 * - No protocol exists yet
 *
 * Returns what was resolved for logging.
 */
export async function resolveDesignPrerequisites(
  projectId: string,
): Promise<string[]> {
  const resolved: string[] = [];

  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    select: { metricSchema: true },
  });

  if (!project?.metricSchema) return resolved;

  const existing = await getEvaluationProtocol(projectId);
  if (existing) return resolved;

  let metrics: Array<{ name: string; direction?: string }>;
  try {
    metrics = JSON.parse(project.metricSchema);
  } catch {
    return resolved;
  }

  const protocol = deriveDefaultProtocol(metrics);
  if (!protocol) return resolved;

  await saveEvaluationProtocol(projectId, protocol);
  resolved.push(
    `Auto-created evaluation protocol: primary=${protocol.primaryMetric}, ` +
    `seeds=[${protocol.seeds.join(", ")}], minRuns=${protocol.minRuns}`,
  );

  return resolved;
}
