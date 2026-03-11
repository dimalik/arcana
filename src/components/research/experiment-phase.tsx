"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles, Server } from "lucide-react";
import { StepCard } from "./step-card";
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

export function ExperimentPhase({ projectId, steps, onRefresh }: ExperimentPhaseProps) {
  const {
    loadingStep, autoRunning, handleAutoRun, handleSkip,
    handleRestore, handleExecute, handleContinueNext,
  } = useStepActions(projectId, onRefresh);
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [remoteJobs, setRemoteJobs] = useState<RemoteJob[]>([]);
  const [deploying, setDeploying] = useState(false);

  // Fetch remote hosts on mount
  useEffect(() => {
    fetch("/api/research/remote-hosts")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setHosts(data); })
      .catch(() => {});
  }, []);

  // Fetch remote jobs for this project
  useEffect(() => {
    fetch(`/api/research/remote-jobs?projectId=${projectId}`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setRemoteJobs(data); })
      .catch(() => {});
  }, [projectId]);

  // Poll running remote jobs
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
    // Pick the default host, or the first one
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
      // Refresh remote jobs
      const jobsRes = await fetch(`/api/research/remote-jobs?projectId=${projectId}`);
      const jobs = await jobsRes.json();
      if (Array.isArray(jobs)) setRemoteJobs(jobs);
    } catch {
      toast.error("Failed to deploy experiment");
    } finally {
      setDeploying(false);
    }
  };

  const runningSteps = steps.filter((s) => s.status === "RUNNING");
  const pendingSteps = steps.filter((s) => s.status === "PROPOSED" || s.status === "APPROVED");
  const completedSteps = steps.filter((s) => s.status === "COMPLETED");
  const failedSteps = steps.filter((s) => s.status === "FAILED");
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

      {/* Running steps — prominent */}
      {runningSteps.map((step) => (
        <StepCard key={step.id} step={step} onRestore={handleRestore} loading={loadingStep === step.id} />
      ))}

      {/* Failed steps */}
      {failedSteps.map((step) => (
        <StepCard key={step.id} step={step} onRestore={handleRestore} loading={loadingStep === step.id} />
      ))}

      {/* Completed steps — latest with actions */}
      {completedSteps.length > 0 && (
        <div className="space-y-1">
          {completedSteps.length > 1 && (
            <div className="border-l-2 border-emerald-500/20 pl-3 space-y-0.5 mb-2">
              {completedSteps.slice(0, -1).map((step) => (
                <StepCard key={step.id} step={step} compact />
              ))}
            </div>
          )}
          {(() => {
            const latest = completedSteps[completedSteps.length - 1];
            const next = pendingSteps[0];
            return (
              <StepCard
                key={latest.id}
                step={latest}
                isLatestCompleted
                hasNextStep={!!next}
                nextStepTitle={next?.title}
                onContinue={next ? () => handleContinueNext(next.id) : undefined}
                onDeploy={hosts.length > 0 ? () => handleDeploy(latest.id) : undefined}
                loading={deploying || !!loadingStep}
              />
            );
          })()}
        </div>
      )}

      {/* Pending steps */}
      {pendingSteps.slice(completedSteps.length > 0 ? 1 : 0).map((step) => (
        <StepCard key={step.id} step={step} onSkip={handleSkip} onExecute={handleExecute} loading={loadingStep === step.id} />
      ))}

      {/* Running remote jobs */}
      {runningJobs.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            <Server className="h-3 w-3 inline mr-1" />
            Remote Jobs
          </h3>
          {runningJobs.map((job) => (
            <div key={job.id} className="rounded-md border border-blue-500/20 bg-blue-500/5 p-3">
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
                <pre className="mt-1.5 text-[10px] text-muted-foreground bg-background/50 rounded p-2 max-h-24 overflow-auto whitespace-pre-wrap">
                  {job.stdout.slice(-500)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Completed remote jobs */}
      {completedJobs.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Previous Runs</h3>
          {completedJobs.map((job) => (
            <div
              key={job.id}
              className={`rounded-md border p-2.5 ${
                job.status === "COMPLETED"
                  ? "border-emerald-500/20 bg-emerald-500/5"
                  : "border-destructive/20 bg-destructive/5"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{job.host.alias}</span>
                <span className={`text-[10px] ${job.status === "COMPLETED" ? "text-emerald-500" : "text-destructive"}`}>
                  {job.status}
                </span>
                {job.completedAt && (
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {new Date(job.completedAt).toLocaleString()}
                  </span>
                )}
              </div>
              {job.stdout && (
                <pre className="mt-1 text-[10px] text-muted-foreground bg-background/50 rounded p-1.5 max-h-20 overflow-auto whitespace-pre-wrap">
                  {job.stdout.slice(-300)}
                </pre>
              )}
              {job.stderr && job.status === "FAILED" && (
                <pre className="mt-1 text-[10px] text-destructive/80 bg-background/50 rounded p-1.5 max-h-16 overflow-auto whitespace-pre-wrap">
                  {job.stderr.slice(-200)}
                </pre>
              )}
            </div>
          ))}
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
