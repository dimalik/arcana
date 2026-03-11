"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles, Server, FileCode, Check, AlertCircle, ChevronDown, Play, X } from "lucide-react";
import { useStepActions } from "./use-step-actions";
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
  stdout: string | null;
  stderr: string | null;
  host: { alias: string; gpuType: string | null };
  createdAt: string;
  completedAt: string | null;
}

interface ExperimentPhaseProps {
  projectId: string;
  steps: Step[];
  hypotheses: { id: string; statement: string; status: string }[];
  onRefresh: () => void;
}

function parseOutput(output: string | null) {
  if (!output) return null;
  try { return JSON.parse(output); } catch { return null; }
}

export function ExperimentPhase({ projectId, steps, onRefresh }: ExperimentPhaseProps) {
  const {
    loadingStep, autoRunning, handleAutoRun, handleSkip,
    handleRestore, handleExecute, handleContinueNext,
  } = useStepActions(projectId, onRefresh);
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [remoteJobs, setRemoteJobs] = useState<RemoteJob[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());

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

  // Separate steps by type
  const codeSteps = steps.filter((s) => s.type === "generate_code");
  const runSteps = steps.filter((s) => s.type === "run_experiment");
  const pendingSteps = steps.filter((s) => s.status === "PROPOSED" || s.status === "APPROVED");
  const runningSteps = steps.filter((s) => s.status === "RUNNING");
  const runningJobs = remoteJobs.filter((j) => ["SYNCING", "QUEUED", "RUNNING"].includes(j.status));
  const completedJobs = remoteJobs.filter((j) => j.status === "COMPLETED" || j.status === "FAILED");

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleAutoRun}
          disabled={autoRunning || runningSteps.length > 0}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {autoRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {runningSteps.length > 0 ? "Generating code..." : "Generate experiment"}
        </button>
        {hosts.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            <Server className="h-3 w-3 inline mr-0.5" />
            {hosts.length} remote host{hosts.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Pending / Running agent steps */}
      {runningSteps.map((step) => (
        <div key={step.id} className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
              <h4 className="text-xs font-medium">{step.title}</h4>
              <span className="text-[10px] text-blue-400">Running...</span>
            </div>
            <button
              onClick={() => handleRestore(step.id)}
              disabled={loadingStep === step.id}
              className="inline-flex h-6 items-center gap-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted px-1.5 text-[10px] transition-colors"
            >
              <X className="h-3 w-3" /> Cancel
            </button>
          </div>
        </div>
      ))}

      {pendingSteps.map((step) => (
        <div key={step.id} className="rounded-md border border-border/50 bg-muted/30 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{step.title}</span>
              <span className="text-[10px] text-muted-foreground">{step.status === "APPROVED" ? "Queued" : "Up next"}</span>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => handleExecute(step.id)}
                disabled={!!loadingStep}
                className="inline-flex h-6 items-center gap-1 rounded-md bg-primary text-primary-foreground px-2 text-[11px] hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {loadingStep === step.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                Run
              </button>
            </div>
          </div>
        </div>
      ))}

      {/* Generated Scripts */}
      {codeSteps.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">Generated Scripts</h3>
          <div className="space-y-1">
            {codeSteps.map((step) => {
              const out = parseOutput(step.output);
              const filename = out?.filename || step.title.replace("Write: ", "");
              const canDeploy = step.status === "COMPLETED" && hosts.length > 0;
              return (
                <div key={step.id} className="flex items-center gap-2 py-1 group">
                  <FileCode className="h-3 w-3 text-blue-400 shrink-0" />
                  <span className="text-[11px] flex-1 truncate font-mono">{filename}</span>
                  {step.status === "COMPLETED" && <Check className="h-3 w-3 text-emerald-500 shrink-0" />}
                  {step.status === "FAILED" && <AlertCircle className="h-3 w-3 text-destructive shrink-0" />}
                  {out?.bytes && <span className="text-[9px] text-muted-foreground/50">{(out.bytes / 1024).toFixed(1)}KB</span>}
                  {canDeploy && (
                    <button
                      onClick={() => handleDeploy(step.id)}
                      disabled={deploying}
                      className="opacity-0 group-hover:opacity-100 inline-flex items-center gap-1 rounded text-[10px] text-muted-foreground hover:text-foreground px-1 py-0.5 hover:bg-muted transition-all"
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

      {/* Experiment Runs */}
      {(runSteps.length > 0 || runningJobs.length > 0 || completedJobs.length > 0) && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">Experiment Runs</h3>
          <div className="space-y-1.5">
            {/* Active remote jobs */}
            {runningJobs.map((job) => (
              <div key={job.id} className="rounded-md border border-blue-500/20 bg-blue-500/5 p-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                    <span className="text-xs font-medium">{job.host.alias}</span>
                    {job.host.gpuType && <span className="text-[10px] text-muted-foreground">{job.host.gpuType}</span>}
                    <span className="text-[10px] text-blue-400">{job.status}</span>
                  </div>
                  <button onClick={() => handleCancelJob(job.id)} className="text-[10px] text-muted-foreground hover:text-destructive transition-colors">
                    Cancel
                  </button>
                </div>
                {job.stdout && (
                  <pre className="mt-1.5 text-[10px] text-muted-foreground bg-background/50 rounded p-2 max-h-24 overflow-auto whitespace-pre-wrap font-mono">
                    {job.stdout.split("\n").filter(Boolean).slice(-8).join("\n")}
                  </pre>
                )}
              </div>
            ))}

            {/* Completed runs — compact table */}
            {completedJobs.map((job) => (
              <div key={job.id}>
                <button
                  onClick={() => toggleJob(job.id)}
                  className="flex items-center gap-2 w-full py-1 text-left group"
                >
                  {job.status === "COMPLETED"
                    ? <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                    : <AlertCircle className="h-3 w-3 text-destructive shrink-0" />
                  }
                  <span className="text-[11px] flex-1 truncate">{job.host.alias}</span>
                  <span className={`text-[10px] ${job.status === "COMPLETED" ? "text-emerald-500" : "text-destructive"}`}>
                    {job.status.toLowerCase()}
                  </span>
                  {job.completedAt && (
                    <span className="text-[9px] text-muted-foreground/50">
                      {new Date(job.completedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  )}
                  <ChevronDown className={`h-2.5 w-2.5 text-muted-foreground/40 transition-transform ${expandedJobs.has(job.id) ? "rotate-180" : ""}`} />
                </button>
                {expandedJobs.has(job.id) && (
                  <div className="ml-5 mb-1">
                    {job.stdout && (
                      <pre className="text-[10px] text-muted-foreground bg-muted/50 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono">
                        {job.stdout.split("\n").filter(Boolean).slice(-20).join("\n")}
                      </pre>
                    )}
                    {job.stderr && job.status === "FAILED" && (
                      <pre className="mt-1 text-[10px] text-destructive/70 bg-destructive/5 rounded p-2 max-h-16 overflow-auto whitespace-pre-wrap font-mono">
                        {job.stderr.split("\n").filter(Boolean).slice(-10).join("\n")}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* Local run steps (no remote job) — compact list */}
            {runSteps
              .filter((s) => s.status === "COMPLETED" || s.status === "FAILED")
              .filter((s) => {
                const out = parseOutput(s.output);
                return !out?.host; // only local runs
              })
              .map((step) => (
                <div key={step.id} className="flex items-center gap-2 py-1">
                  {step.status === "COMPLETED"
                    ? <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                    : <AlertCircle className="h-3 w-3 text-destructive shrink-0" />
                  }
                  <span className="text-[11px] text-muted-foreground truncate">{step.title}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {steps.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-4 text-center">
          <p className="text-xs text-muted-foreground">
            No experiments yet. Click above to generate experiment code automatically.
          </p>
        </div>
      )}
    </div>
  );
}
