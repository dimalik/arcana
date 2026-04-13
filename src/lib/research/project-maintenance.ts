import { cleanupStaleJobs } from "./remote-executor";
import { recoverProjectRemoteResults, repairAutoImportedStdoutClaims } from "./result-import";
import { repairResearchProjectReadModel } from "./research-data-repair";

const projectMaintenanceInFlight = new Map<string, Promise<void>>();
const lastProjectMaintenanceAt = new Map<string, number>();

interface ProjectMaintenanceOptions {
  minIntervalMs?: number;
}

async function runProjectMaintenance(projectId: string): Promise<void> {
  await cleanupStaleJobs(projectId);
  await recoverProjectRemoteResults(projectId);
  await repairAutoImportedStdoutClaims(projectId);
  await repairResearchProjectReadModel(projectId);
}

export function ensureProjectMaintenance(
  projectId: string,
  options?: ProjectMaintenanceOptions,
): Promise<void> {
  const minIntervalMs = options?.minIntervalMs ?? 10_000;
  const now = Date.now();
  const lastRunAt = lastProjectMaintenanceAt.get(projectId) ?? 0;
  const existing = projectMaintenanceInFlight.get(projectId);

  if (existing) {
    return existing;
  }

  if (now - lastRunAt < minIntervalMs) {
    return Promise.resolve();
  }

  const promise = runProjectMaintenance(projectId)
    .catch((err) => {
      console.warn("[project-maintenance] Failed:", err);
      throw err;
    })
    .finally(() => {
      projectMaintenanceInFlight.delete(projectId);
      lastProjectMaintenanceAt.set(projectId, Date.now());
    });

  projectMaintenanceInFlight.set(projectId, promise);
  return promise;
}
