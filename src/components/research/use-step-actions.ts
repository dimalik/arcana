import { useState } from "react";
import { toast } from "sonner";

export function useStepActions(projectId: string, onRefresh: () => void) {
  const [loadingStep, setLoadingStep] = useState<string | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);

  const handleAutoRun = async () => {
    setAutoRunning(true);
    try {
      const res = await fetch(`/api/research/${projectId}/autorun`, { method: "POST" });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      if (data.status === "started") {
        toast.success("Steps queued and executing");
      } else if (data.status === "already_active") {
        toast("Steps are already running");
      } else if (data.status === "no_suggestions") {
        toast("No next steps suggested for this phase");
      }
      onRefresh();
    } catch {
      toast.error("Failed to run");
    } finally {
      setAutoRunning(false);
    }
  };

  const handleSkip = async (stepId: string) => {
    setLoadingStep(stepId);
    try {
      await fetch(`/api/research/${projectId}/steps/${stepId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "SKIPPED" }),
      });
      onRefresh();
    } catch {
      toast.error("Failed to skip step");
    } finally {
      setLoadingStep(null);
    }
  };

  const handleRestore = async (stepId: string) => {
    setLoadingStep(stepId);
    try {
      // Cancel any remote jobs linked to this step
      try {
        const jobsRes = await fetch(`/api/research/remote-jobs?stepId=${stepId}`);
        if (jobsRes.ok) {
          const jobs: { id: string; status: string }[] = await jobsRes.json();
          for (const job of jobs) {
            if (["RUNNING", "SYNCING", "QUEUED"].includes(job.status)) {
              await fetch(`/api/research/remote-jobs/${job.id}`, { method: "DELETE" });
            }
          }
        }
      } catch {
        // Non-critical — proceed with step restore
      }

      await fetch(`/api/research/${projectId}/steps/${stepId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PROPOSED", output: null }),
      });
      onRefresh();
    } catch {
      toast.error("Failed to restore step");
    } finally {
      setLoadingStep(null);
    }
  };

  const handleExecute = async (stepId: string, resourcePreference?: string) => {
    setLoadingStep(stepId);
    try {
      // Approve then execute — include resource preference if specified
      const patchBody: Record<string, unknown> = { status: "APPROVED" };
      if (resourcePreference && resourcePreference !== "auto") {
        patchBody.input = { resourcePreference };
      }
      await fetch(`/api/research/${projectId}/steps/${stepId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      await fetch(`/api/research/${projectId}/steps/${stepId}/execute`, { method: "POST" });
      onRefresh();
    } catch {
      toast.error("Failed to execute step");
    } finally {
      setLoadingStep(null);
    }
  };

  /** Run the next PROPOSED step (used by "Continue" button) */
  const handleContinueNext = async (nextStepId: string) => {
    await handleExecute(nextStepId);
  };

  /** Re-run a search_papers step to find more papers */
  const handleSearchMore = async () => {
    setAutoRunning(true);
    try {
      // Create a new search_papers step via the orchestrator
      const res = await fetch(`/api/research/${projectId}/autorun`, { method: "POST" });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      if (data.status === "started") {
        toast.success("Searching for more papers...");
      }
      onRefresh();
    } catch {
      toast.error("Failed to search");
    } finally {
      setAutoRunning(false);
    }
  };

  return {
    loadingStep,
    autoRunning,
    handleAutoRun,
    handleSkip,
    handleRestore,
    handleExecute,
    handleContinueNext,
    handleSearchMore,
  };
}
