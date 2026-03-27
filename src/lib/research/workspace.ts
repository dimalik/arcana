/**
 * Workspace state cache — provides a structured view of the remote
 * experiment directory without repeated SSH calls.
 *
 * Replaces the pattern of agents running 100+ check_remote ls/find/cat
 * commands with a single cached manifest.
 */

import { quickRemoteCommand } from "./remote-executor";

export interface WorkspaceFile {
  path: string;
  size: number;
  modified: string;
}

export interface WorkspaceState {
  files: WorkspaceFile[];
  fileCount: number;
  results: { path: string; content: string }[];
  packages: string[];
  jobStatus: string | null;
  jobExitCode: number | null;
  oomDetected: boolean;
  cachedAt: number;
}

// In-memory cache keyed by projectId
const cache = new Map<string, WorkspaceState>();
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Get workspace state for a project. Returns cached if fresh,
 * otherwise fetches from remote via helper manifest command.
 */
export async function getWorkspaceState(
  projectId: string,
  hostId: string,
  forceRefresh = false,
): Promise<WorkspaceState | null> {
  const cached = cache.get(projectId);
  if (!forceRefresh && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const result = await quickRemoteCommand(hostId,
      `python3 ~/.arcana/helper.py manifest ~/experiments/*${projectId.slice(0, 8)}* 2>/dev/null || echo '{"ok":false}'`
    );

    if (!result.ok) return cached || null;

    const parsed = JSON.parse(result.output);
    if (!parsed.ok) return cached || null;

    const state: WorkspaceState = {
      files: parsed.files || [],
      fileCount: parsed.file_count || 0,
      results: parsed.results || [],
      packages: parsed.packages || [],
      jobStatus: parsed.job_status || null,
      jobExitCode: parsed.job_exit_code ?? null,
      oomDetected: parsed.oom_detected || false,
      cachedAt: Date.now(),
    };

    cache.set(projectId, state);
    return state;
  } catch {
    return cached || null;
  }
}

/** Invalidate cache for a project (call after job completes) */
export function invalidateWorkspace(projectId: string): void {
  cache.delete(projectId);
}

/** Format workspace state as a human-readable string for the agent */
export function formatWorkspace(state: WorkspaceState): string {
  const parts: string[] = [];

  const scripts = state.files.filter(f => f.path.endsWith('.py'));
  const dataFiles = state.files.filter(f => f.path.endsWith('.json') || f.path.endsWith('.csv'));
  const other = state.files.filter(f => !f.path.endsWith('.py') && !f.path.endsWith('.json') && !f.path.endsWith('.csv'));

  parts.push(`## Workspace (${state.fileCount} files)`);

  if (scripts.length > 0) {
    parts.push(`\n**Scripts (${scripts.length}):**`);
    for (const f of scripts.slice(0, 20)) {
      parts.push(`- ${f.path} (${formatSize(f.size)}, ${f.modified})`);
    }
  }

  if (dataFiles.length > 0) {
    parts.push(`\n**Data/Results (${dataFiles.length}):**`);
    for (const f of dataFiles.slice(0, 15)) {
      parts.push(`- ${f.path} (${formatSize(f.size)})`);
    }
  }

  if (other.length > 5) {
    parts.push(`\n**Other:** ${other.length} files (${other.map(f => f.path.split('.').pop()).filter((v, i, a) => a.indexOf(v) === i).join(', ')})`);
  }

  if (state.results.length > 0) {
    parts.push(`\n**Recent Results:**`);
    for (const r of state.results.slice(0, 5)) {
      parts.push(`\n### ${r.path}\n\`\`\`json\n${r.content.slice(0, 1000)}\n\`\`\``);
    }
  }

  if (state.packages.length > 0) {
    const keyPkgs = state.packages.filter(p =>
      /^(torch|transformers|accelerate|deepspeed|flash.attn|bitsandbytes|datasets|scipy|numpy|pandas)/.test(p)
    );
    if (keyPkgs.length > 0) {
      parts.push(`\n**Key Packages:** ${keyPkgs.join(', ')}`);
    }
  }

  if (state.jobStatus) {
    parts.push(`\n**Last Job:** ${state.jobStatus}${state.jobExitCode != null ? ` (exit ${state.jobExitCode})` : ''}${state.oomDetected ? ' ⚠ OOM DETECTED' : ''}`);
  }

  return parts.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
