"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, Sparkles, Server, FileCode, Check, AlertCircle, ChevronDown, Play, X, RotateCcw, Monitor, FlaskConical } from "lucide-react";
import { useStepActions } from "./use-step-actions";
import { ExperimentCard } from "./experiment-card";
import { toast } from "sonner";

interface Step {
  id: string;
  type: string;
  status: string;
  title: string;
  description: string | null;
  output: string | null;
  agentSessionId: string | null;
}

interface RemoteHost {
  id: string;
  alias: string;
  gpuType: string | null;
  isDefault: boolean;
}

interface RemoteJob {
  id: string;
  status: string;
  command: string;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  errorClass: string | null;
  localDir: string;
  hostId: string;
  host: { alias: string; gpuType: string | null };
  createdAt: string;
  completedAt: string | null;
}

interface ExperimentResultData {
  id: string;
  scriptName: string;
  metrics: string | null;
  comparison: string | null;
  verdict: string | null;
  reflection: string | null;
  hypothesisId: string | null;
  branchId: string | null;
  jobId: string | null;
  createdAt: string;
  branch: { name: string; status: string } | null;
}

interface ExperimentJobData {
  id: string;
  status: string;
  exitCode: number | null;
  command: string;
  startedAt: string | null;
  completedAt: string | null;
  stderr: string | null;
  errorClass: string | null;
  host: { alias: string; gpuType: string | null };
}

interface FileEntry {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  modified: string;
  children?: FileEntry[];
}

interface ExperimentPhaseProps {
  projectId: string;
  steps: Step[];
  hypotheses: { id: string; statement: string; status: string }[];
  onRefresh: () => void;
  experimentResults?: ExperimentResultData[];
  experimentJobs?: ExperimentJobData[];
  hypothesesById?: Record<string, string>;
}

function parseOutput(output: string | null) {
  if (!output) return null;
  try { return JSON.parse(output); } catch { return null; }
}

/** Extract the primary script name from a step title or job command */
function extractScriptName(text: string): string | null {
  // "Write: train_model.py" → "train_model.py"
  const writeMatch = text.match(/^Write:\s*(.+\.py)$/i);
  if (writeMatch) return writeMatch[1].trim();
  // "python3 train_model.py ..." → "train_model.py"
  const pyMatch = text.match(/python3?\s+(\S+\.py)/);
  if (pyMatch) return pyMatch[1];
  // "Remote (host): python3 ..." or "Local: python3 ..."
  const prefixed = text.replace(/^(?:Remote\s*\([^)]+\)|Local):\s*/i, "");
  const pyMatch2 = prefixed.match(/python3?\s+(\S+\.py)/);
  if (pyMatch2) return pyMatch2[1];
  return null;
}

interface ExperimentGroup {
  name: string;
  scripts: Step[];
  runs: Step[];
  jobs: RemoteJob[];
}

function PendingStepRow({
  step,
  hosts,
  loading,
  disabled,
  onExecute,
}: {
  step: Step;
  hosts: RemoteHost[];
  loading: boolean;
  disabled: boolean;
  onExecute: (stepId: string, resourcePreference?: string) => void;
}) {
  const [resourcePref, setResourcePref] = useState("auto");
  const showSelector = hosts.length > 0;

  return (
    <div className="rounded-md border border-border/50 bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{step.title}</span>
          <span className="text-[11px] text-muted-foreground">{step.status === "APPROVED" ? "Queued" : "Up next"}</span>
        </div>
        <div className="flex items-center gap-1">
          {showSelector && (
            <select
              value={resourcePref}
              onChange={(e) => setResourcePref(e.target.value)}
              className="h-6 rounded-md border border-border bg-background px-1 text-[11px] text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              title="Where to run"
            >
              <option value="auto">Auto</option>
              <option value="local">Local</option>
              {hosts.map((h) => (
                <option key={h.alias} value={`remote:${h.alias}`}>
                  {h.alias}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => onExecute(step.id, resourcePref !== "auto" ? resourcePref : undefined)}
            disabled={disabled}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-primary text-primary-foreground px-2 text-[11px] hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Run
          </button>
        </div>
      </div>
    </div>
  );
}

export function ExperimentPhase({
  projectId, steps, onRefresh,
  experimentResults, experimentJobs, hypothesesById,
}: ExperimentPhaseProps) {
  const {
    loadingStep, autoRunning, handleAutoRun, handleSkip,
    handleRestore, handleExecute, handleContinueNext,
  } = useStepActions(projectId, onRefresh);
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [remoteJobs, setRemoteJobs] = useState<RemoteJob[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());
  const [projectFiles, setProjectFiles] = useState<FileEntry[]>([]);

  useEffect(() => {
    fetch("/api/research/remote-hosts")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setHosts(data); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`/api/research/remote-jobs?projectId=${projectId}`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setRemoteJobs(data); })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    const hasRunning = remoteJobs.some((j) => ["SYNCING", "RUNNING", "QUEUED"].includes(j.status));
    if (!hasRunning) return;
    const interval = setInterval(() => {
      fetch(`/api/research/remote-jobs?projectId=${projectId}`)
        .then((r) => r.json())
        .then((data) => {
          if (Array.isArray(data)) {
            const justCompleted = data.some((j: RemoteJob) =>
              (j.status === "COMPLETED" || j.status === "FAILED") &&
              remoteJobs.some((old) => old.id === j.id && old.status !== j.status)
            );
            setRemoteJobs(data);
            if (justCompleted) onRefresh();
          }
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [projectId, remoteJobs, onRefresh]);

  // Fetch project files for artifact matching
  const fetchFiles = useCallback(() => {
    fetch(`/api/research/${projectId}/files`)
      .then((r) => r.json())
      .then((data) => {
        if (data.files) setProjectFiles(data.files);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    fetchFiles();
    const interval = setInterval(fetchFiles, 30_000);
    return () => clearInterval(interval);
  }, [fetchFiles]);

  // Flatten project files for artifact matching
  const flatFiles: { name: string; path: string }[] = [];
  const walkFiles = (entries: FileEntry[]) => {
    for (const f of entries) {
      if (f.isDir && f.children) {
        walkFiles(f.children);
      } else if (!f.path.includes(".venv") && !f.path.includes("__pycache__")) {
        flatFiles.push({ name: f.name, path: f.path });
      }
    }
  };
  walkFiles(projectFiles);

  // Match artifacts to an experiment result by script name pattern
  const getArtifactsForResult = (result: ExperimentResultData) => {
    const stem = result.scriptName.replace(/\.py$/, "");
    // Extract number patterns from script name (e.g., poc_003 → "003", experiment_1 → "1")
    const numMatch = stem.match(/(\d+)/);
    const expNum = numMatch ? numMatch[1] : null;
    const artifactExts = /\.(png|jpg|jpeg|gif|svg|json|csv|tsv|pdf|txt|log)$/i;

    return flatFiles.filter((f) => {
      if (!artifactExts.test(f.name)) return false;
      // Match by: filename contains the script stem, or contains exp_NNN / NNN pattern
      const nameLower = f.name.toLowerCase();
      const stemLower = stem.toLowerCase();
      if (nameLower.includes(stemLower)) return true;
      if (expNum && (nameLower.includes(`exp_${expNum}`) || nameLower.includes(`_${expNum}`))) return true;
      return false;
    });
  };

  // Build job lookup by ID
  const jobsById: Record<string, ExperimentJobData> = {};
  if (experimentJobs) {
    for (const j of experimentJobs) {
      jobsById[j.id] = j;
    }
  }

  const completedResults = experimentResults || [];

  const handleCancelJob = async (jobId: string) => {
    try {
      await fetch(`/api/research/remote-jobs/${jobId}`, { method: "DELETE" });
      toast.success("Job cancelled");
      setRemoteJobs((prev) => prev.map((j) => j.id === jobId ? { ...j, status: "CANCELLED" } : j));
      onRefresh();
    } catch {
      toast.error("Failed to cancel");
    }
  };

  const handleRetryJob = async (job: RemoteJob) => {
    setDeploying(true);
    try {
      const res = await fetch("/api/research/remote-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostId: job.hostId,
          localDir: job.localDir,
          command: job.command,
          projectId,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Retry failed");
        return;
      }
      toast.success(`Retrying on ${job.host.alias}...`);
      const jobsRes = await fetch(`/api/research/remote-jobs?projectId=${projectId}`);
      const jobs = await jobsRes.json();
      if (Array.isArray(jobs)) setRemoteJobs(jobs);
    } catch {
      toast.error("Failed to retry job");
    } finally {
      setDeploying(false);
    }
  };

  const [runningLocally, setRunningLocally] = useState<string | null>(null);

  const handleRunLocally = async (job: RemoteJob) => {
    setRunningLocally(job.id);
    try {
      const res = await fetch(`/api/research/${projectId}/run-local`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: job.command,
          workDir: job.localDir,
          cancelJobId: job.id,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to run locally");
        return;
      }
      toast.success("Cancelled remote job — running locally now");
      // Update local state: mark remote job as cancelled
      setRemoteJobs((prev) => prev.map((j) => j.id === job.id ? { ...j, status: "CANCELLED" } : j));
      onRefresh();
    } catch {
      toast.error("Failed to move to local");
    } finally {
      setRunningLocally(null);
    }
  };

  const handleDeploy = async (stepId: string) => {
    const host = hosts.find((h) => h.isDefault) || hosts[0];
    if (!host) {
      toast.error("No remote hosts configured. Add one in Settings → Remote Hosts.");
      return;
    }

    setDeploying(true);
    try {
      const res = await fetch(`/api/research/${projectId}/steps/${stepId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId: host.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to deploy");
        return;
      }
      toast.success(`Deployed to ${host.alias} — syncing and running...`);
      const jobsRes = await fetch(`/api/research/remote-jobs?projectId=${projectId}`);
      const jobs = await jobsRes.json();
      if (Array.isArray(jobs)) setRemoteJobs(jobs);
    } catch {
      toast.error("Failed to deploy experiment");
    } finally {
      setDeploying(false);
    }
  };

  const toggleJob = (id: string) => {
    setExpandedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Separate steps
  const codeSteps = steps.filter((s) => s.type === "generate_code");
  const runSteps = steps.filter((s) => s.type === "run_experiment");
  const pendingSteps = steps.filter((s) => s.status === "PROPOSED" || s.status === "APPROVED");
  const runningSteps = steps.filter((s) => s.status === "RUNNING");

  // Build experiment groups by matching scripts to their runs.
  // Groups are created per Python script (excluding utility files like requirements.txt).
  // A file is a "utility" only if it's clearly config/helper (requirements.txt, utils.py, helpers.py, config.py, etc.)
  const groups: ExperimentGroup[] = [];
  const scriptToGroup = new Map<string, ExperimentGroup>();
  let utilityGroup: ExperimentGroup | null = null;

  const UTILITY_PATTERNS = /^(requirements\.txt|setup\.py|setup\.cfg|conftest\.py|__init__\.py|utils\.py|helpers?\.py|config\.py|common\.py)$/i;

  function getExpNumber(filename: string): number | null {
    const m = filename.match(/experiment[\s_-]*(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function makeGroupName(filename: string, index: number): string {
    // Try to extract experiment number from filename
    const num = getExpNumber(filename);
    if (num !== null) return `Experiment ${num}`;
    // Use the filename stem as the group name (e.g., "train_model.py" → "train_model")
    const stem = filename.replace(/\.py$/, "").replace(/[_-]/g, " ");
    // Capitalize first letter
    return stem.charAt(0).toUpperCase() + stem.slice(1);
  }

  // Group code generation steps: experiment scripts get their own group, utilities go to one group
  for (const step of codeSteps) {
    const out = parseOutput(step.output);
    const filename = out?.filename || step.title.replace("Write: ", "");

    if (UTILITY_PATTERNS.test(filename)) {
      if (!utilityGroup) {
        utilityGroup = { name: "Utilities", scripts: [], runs: [], jobs: [] };
      }
      utilityGroup.scripts.push(step);
      scriptToGroup.set(filename, utilityGroup);
    } else {
      // Each experiment script gets its own group (or joins an existing one with the same experiment number)
      const num = getExpNumber(filename);
      let existingGroup: ExperimentGroup | undefined;
      if (num !== null) {
        existingGroup = groups.find((g) => getExpNumber(g.name) === num || g.name === `Experiment ${num}`);
      }
      if (existingGroup) {
        existingGroup.scripts.push(step);
      } else {
        const g: ExperimentGroup = { name: makeGroupName(filename, groups.length + 1), scripts: [step], runs: [], jobs: [] };
        groups.push(g);
      }
      scriptToGroup.set(filename, groups[groups.length - 1]);
    }
  }

  // Add utility group at the end if it has items
  if (utilityGroup) groups.push(utilityGroup);

  // Match run steps to experiments by script name in the command
  for (const step of runSteps) {
    const script = extractScriptName(step.title);
    const g = script ? scriptToGroup.get(script) : undefined;
    if (g) {
      g.runs.push(step);
    } else {
      // Try matching by looking at each group's scripts
      let matched = false;
      if (script) {
        for (const group of groups) {
          if (group === utilityGroup) continue;
          const groupScripts = group.scripts.map((s) => {
            const o = parseOutput(s.output);
            return o?.filename || s.title.replace("Write: ", "");
          });
          if (groupScripts.some((gs) => script.includes(gs.replace(/\.py$/, "")) || gs.includes(script.replace(/\.py$/, "")))) {
            group.runs.push(step);
            matched = true;
            break;
          }
        }
      }
      // Fall back to most recent non-utility group
      if (!matched) {
        const expGroups = groups.filter((g) => g !== utilityGroup);
        if (expGroups.length > 0) {
          expGroups[expGroups.length - 1].runs.push(step);
        }
      }
    }
  }

  // Match remote jobs to experiments by script name
  for (const job of remoteJobs) {
    const script = extractScriptName(job.command);
    const g = script ? scriptToGroup.get(script) : undefined;
    if (g) {
      g.jobs.push(job);
    } else {
      let matched = false;
      if (script) {
        for (const group of groups) {
          if (group === utilityGroup) continue;
          const groupScripts = group.scripts.map((s) => {
            const o = parseOutput(s.output);
            return o?.filename || s.title.replace("Write: ", "");
          });
          if (groupScripts.some((gs) => script.includes(gs.replace(/\.py$/, "")) || gs.includes(script.replace(/\.py$/, "")))) {
            group.jobs.push(job);
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        const expGroups = groups.filter((g) => g !== utilityGroup);
        if (expGroups.length > 0) {
          expGroups[expGroups.length - 1].jobs.push(job);
        }
      }
    }
  }

  // Sort: numbered experiments first (by number), named experiments next (chronological), utilities last
  groups.sort((a, b) => {
    const aIsUtil = a === utilityGroup;
    const bIsUtil = b === utilityGroup;
    if (aIsUtil && !bIsUtil) return 1;
    if (!aIsUtil && bIsUtil) return -1;
    const aNum = a.name.match(/Experiment (\d+)/);
    const bNum = b.name.match(/Experiment (\d+)/);
    if (aNum && bNum) return parseInt(aNum[1]) - parseInt(bNum[1]);
    if (aNum) return -1;
    if (bNum) return 1;
    return 0;
  });

  const hasContent = groups.length > 0 || pendingSteps.length > 0 || runningSteps.length > 0 || completedResults.length > 0;

  return (
    <div className="space-y-4 pr-2">
      {/* Host info */}
      {hosts.length > 0 && (
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">
            <Server className="h-3 w-3 inline mr-0.5" />
            {hosts.length} remote host{hosts.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Pending / Running agent steps */}
      {runningSteps.map((step) => (
        <div key={step.id} className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
              <h4 className="text-xs font-medium">{step.title}</h4>
              <span className="text-[11px] text-blue-400">Running...</span>
            </div>
            <button
              onClick={() => handleRestore(step.id)}
              disabled={loadingStep === step.id}
              className="inline-flex h-6 items-center gap-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted px-1.5 text-[11px] transition-colors"
            >
              <X className="h-3 w-3" /> Cancel
            </button>
          </div>
        </div>
      ))}

      {pendingSteps.map((step) => (
        <PendingStepRow
          key={step.id}
          step={step}
          hosts={hosts}
          loading={loadingStep === step.id}
          disabled={!!loadingStep}
          onExecute={handleExecute}
        />
      ))}

      {/* Completed experiment results */}
      {completedResults.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <FlaskConical className="h-3.5 w-3.5 text-muted-foreground/40" />
            <span className="text-xs font-medium">
              Completed Experiments ({completedResults.length})
            </span>
          </div>
          {completedResults.map((result) => (
            <ExperimentCard
              key={result.id}
              result={result}
              job={result.jobId ? jobsById[result.jobId] : undefined}
              hypothesisStatement={result.hypothesisId ? hypothesesById?.[result.hypothesisId] : undefined}
              projectId={projectId}
              artifacts={getArtifactsForResult(result)}
            />
          ))}
        </div>
      )}

      {/* In-progress experiment groups */}
      {groups.length > 0 && completedResults.length > 0 && (
        <div className="flex items-center gap-1.5 pt-1">
          <span className="text-xs font-medium text-muted-foreground/60">In Progress</span>
        </div>
      )}

      {/* Experiment groups */}
      {groups.map((group) => (
        <ExperimentGroupCard
          key={group.name}
          group={group}
          hosts={hosts}
          deploying={deploying}
          expandedJobs={expandedJobs}
          runningLocally={runningLocally}
          onDeploy={handleDeploy}
          onToggleJob={toggleJob}
          onCancelJob={handleCancelJob}
          onRetryJob={handleRetryJob}
          onRunLocally={handleRunLocally}
        />
      ))}

      {/* Empty state */}
      {!hasContent && (
        <div className="rounded-md border border-dashed border-border p-4 text-center">
          <p className="text-xs text-muted-foreground">
            No experiments yet. Click above to generate experiment code automatically.
          </p>
        </div>
      )}

    </div>
  );
}

// ── Experiment Group Card ────────────────────────────────

function ExperimentGroupCard({
  group,
  hosts,
  deploying,
  expandedJobs,
  runningLocally,
  onDeploy,
  onToggleJob,
  onCancelJob,
  onRetryJob,
  onRunLocally,
}: {
  group: ExperimentGroup;
  hosts: RemoteHost[];
  deploying: boolean;
  expandedJobs: Set<string>;
  runningLocally: string | null;
  onDeploy: (stepId: string) => void;
  onToggleJob: (id: string) => void;
  onCancelJob: (id: string) => void;
  onRetryJob: (job: RemoteJob) => void;
  onRunLocally: (job: RemoteJob) => void;
}) {
  const runningJobs = group.jobs.filter((j) => ["SYNCING", "QUEUED", "RUNNING"].includes(j.status));
  const completedJobs = group.jobs.filter((j) => ["COMPLETED", "FAILED", "CANCELLED"].includes(j.status));
  const localRuns = group.runs.filter((s) => {
    if (s.status !== "COMPLETED" && s.status !== "FAILED") return false;
    const out = parseOutput(s.output);
    return !out?.host;
  });
  const hasRunningScripts = group.scripts.some((s) => s.status === "RUNNING");
  const isActive = runningJobs.length > 0 || hasRunningScripts;

  const [collapsed, setCollapsed] = useState(!isActive);

  // Auto-expand when group becomes active
  useEffect(() => {
    if (isActive) setCollapsed(false);
  }, [isActive]);

  const totalRuns = runningJobs.length + completedJobs.length + localRuns.length;
  const successCount = completedJobs.filter((j) => j.status === "COMPLETED").length
    + localRuns.filter((s) => s.status === "COMPLETED").length;
  // Only count RESEARCH_FAILURE as real failures — code bugs and resource errors don't count
  const failCount = completedJobs.filter((j) => j.status === "FAILED" && j.errorClass === "RESEARCH_FAILURE").length
    + localRuns.filter((s) => s.status === "FAILED").length;
  const codeBugCount = completedJobs.filter((j) => j.errorClass === "CODE_ERROR" || j.errorClass === "AUTO_FIXED").length;
  const resourceCount = completedJobs.filter((j) => j.errorClass === "RESOURCE_ERROR").length;

  return (
    <div className="rounded-md border border-border/60 overflow-hidden">
      {/* Group header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 w-full px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${collapsed ? "-rotate-90" : ""}`} />
        <span className="text-xs font-medium flex-1 truncate">{group.name}</span>
        {runningJobs.length > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-blue-400">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            running
          </span>
        )}
        {totalRuns > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {totalRuns} run{totalRuns !== 1 ? "s" : ""}
            {successCount > 0 && <span className="text-emerald-500 ml-1">{successCount} ok</span>}
            {failCount > 0 && <span className="text-destructive ml-1">{failCount} fail</span>}
            {codeBugCount > 0 && <span className="text-blue-500 ml-1">{codeBugCount} fixed</span>}
            {resourceCount > 0 && <span className="text-amber-500 ml-1">{resourceCount} setup</span>}
          </span>
        )}
      </button>

      {!collapsed && (
        <div className="px-3 py-2 space-y-2">
          {/* Files */}
          {group.scripts.length > 0 && (
            <div>
              <p className="text-[11px] text-muted-foreground/60 mb-1">Files</p>
              <div className="space-y-0.5">
              {group.scripts.map((step) => {
                const out = parseOutput(step.output);
                const filename = out?.filename || step.title.replace("Write: ", "");
                const canDeploy = step.status === "COMPLETED" && hosts.length > 0;
                return (
                  <div key={step.id} className="flex items-center gap-2 py-0.5 group">
                    <FileCode className="h-3 w-3 text-blue-400 shrink-0" />
                    <span className="text-[11px] font-mono truncate flex-1">{filename}</span>
                    {step.status === "COMPLETED" && <Check className="h-3 w-3 text-emerald-500 shrink-0" />}
                    {step.status === "FAILED" && <AlertCircle className="h-3 w-3 text-destructive shrink-0" />}
                    {out?.bytes && <span className="text-[11px] text-muted-foreground/50">{(out.bytes / 1024).toFixed(1)}KB</span>}
                    {canDeploy && (
                      <button
                        onClick={() => onDeploy(step.id)}
                        disabled={deploying}
                        className="opacity-0 group-hover:opacity-100 inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground px-1 py-0.5 hover:bg-muted transition-all"
                      >
                        <Server className="h-2.5 w-2.5" /> Deploy
                      </button>
                    )}
                  </div>
                );
              })}
              </div>
            </div>
          )}

          {/* Runs */}
          {(runningJobs.length > 0 || completedJobs.length > 0 || localRuns.length > 0) && (
            <p className="text-[11px] text-muted-foreground/60 mb-1">Runs</p>
          )}

          {/* Running jobs */}
          {runningJobs.map((job) => (
            <div key={job.id} className="rounded border border-blue-500/20 bg-blue-500/5 p-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                  <span className="text-[11px] font-medium">{job.host.alias}</span>
                  {job.host.gpuType && <span className="text-[11px] text-muted-foreground">{job.host.gpuType}</span>}
                  <span className="text-[11px] text-blue-400">{job.status}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onRunLocally(job)}
                    disabled={runningLocally === job.id}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    {runningLocally === job.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Monitor className="h-2.5 w-2.5" />}
                    Local
                  </button>
                  <button onClick={() => onCancelJob(job.id)} className="text-[11px] text-muted-foreground hover:text-destructive transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
              <pre className="mt-1 text-[11px] text-muted-foreground/60 font-mono bg-background/30 rounded px-1.5 py-0.5 whitespace-pre-wrap break-all">
                $ {job.command}
              </pre>
              {job.stdout && (
                <pre className="mt-1 text-[11px] text-muted-foreground bg-background/50 rounded p-2 max-h-24 overflow-auto whitespace-pre-wrap font-mono">
                  {job.stdout.split("\n").filter(Boolean).slice(-8).join("\n")}
                </pre>
              )}
            </div>
          ))}

          {/* Completed jobs + local runs */}
          {(completedJobs.length > 0 || localRuns.length > 0) && (
            <div className="space-y-0.5 ml-0.5">
              {completedJobs.map((job, idx) => {
                const isLatestFailed = job.status !== "COMPLETED" && idx === completedJobs.findIndex((j) => j.status !== "COMPLETED");
                const isExpanded = expandedJobs.has(job.id) || isLatestFailed;

                return (
                  <div key={job.id}>
                    <div className="flex items-center gap-2 w-full py-0.5 group">
                      <button
                        onClick={() => onToggleJob(job.id)}
                        className="flex items-center gap-2 flex-1 text-left min-w-0"
                      >
                        {job.status === "COMPLETED"
                          ? <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                          : job.errorClass === "AUTO_FIXED" || job.errorClass === "CODE_ERROR"
                            ? <AlertCircle className="h-3 w-3 text-blue-500 shrink-0" />
                            : job.errorClass === "RESOURCE_ERROR"
                              ? <AlertCircle className="h-3 w-3 text-amber-500 shrink-0" />
                              : <AlertCircle className="h-3 w-3 text-destructive shrink-0" />
                        }
                        <span className="text-[11px] truncate">{job.host.alias}</span>
                        <span className={`text-[11px] ${
                          job.status === "COMPLETED" ? "text-emerald-500"
                            : job.errorClass === "AUTO_FIXED" ? "text-blue-500"
                            : job.errorClass === "CODE_ERROR" ? "text-blue-400"
                            : job.errorClass === "RESOURCE_ERROR" ? "text-amber-500"
                            : "text-destructive"
                        }`}>
                          {job.errorClass === "AUTO_FIXED" ? "auto-fixed"
                            : job.errorClass === "CODE_ERROR" ? "code bug"
                            : job.errorClass === "RESOURCE_ERROR" ? "needs setup"
                            : job.status.toLowerCase()}
                        </span>
                        {job.completedAt && (
                          <span className="text-[11px] text-muted-foreground/50">
                            {new Date(job.completedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        )}
                        <ChevronDown className={`h-2.5 w-2.5 text-muted-foreground/40 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                      </button>
                      {job.status === "FAILED" && (
                        <button
                          onClick={() => onRetryJob(job)}
                          disabled={deploying}
                          className="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 hover:bg-muted transition-colors shrink-0"
                        >
                          <RotateCcw className="h-2.5 w-2.5" /> Retry
                        </button>
                      )}
                    </div>
                    {isExpanded && (
                      <div className="ml-5 mb-1">
                        <pre className="text-[11px] text-muted-foreground/60 font-mono bg-background/30 rounded px-1.5 py-0.5 mb-1 whitespace-pre-wrap break-all">
                          $ {job.command}
                        </pre>
                        {job.stdout && (
                          <pre className="text-[11px] text-muted-foreground bg-muted/50 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono">
                            {job.stdout.split("\n").filter(Boolean).slice(-30).join("\n")}
                          </pre>
                        )}
                        {job.status !== "COMPLETED" && (
                          <div className="mt-1 space-y-1">
                            {job.exitCode != null && (
                              <span className="text-[11px] text-destructive/60 font-mono">exit code: {job.exitCode}</span>
                            )}
                            {job.stderr && (
                              <pre className="text-[11px] text-destructive/70 bg-destructive/5 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono">
                                {job.stderr.split("\n").filter(Boolean).slice(-30).join("\n")}
                              </pre>
                            )}
                            {!job.stderr && !job.stdout && (
                              <p className="text-[11px] text-destructive/50 italic">No output captured — job may have failed during environment setup (venv/pip install).</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {localRuns.map((step) => (
                <div key={step.id} className="flex items-center gap-2 py-0.5">
                  {step.status === "COMPLETED"
                    ? <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                    : <AlertCircle className="h-3 w-3 text-destructive shrink-0" />
                  }
                  <span className="text-[11px] text-muted-foreground">local</span>
                  <span className={`text-[11px] ${step.status === "COMPLETED" ? "text-emerald-500" : "text-destructive"}`}>
                    {step.status.toLowerCase()}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* No runs yet */}
          {totalRuns === 0 && group.scripts.length > 0 && (
            <p className="text-[11px] text-muted-foreground/40 pl-5">No runs yet</p>
          )}
        </div>
      )}
    </div>
  );
}
