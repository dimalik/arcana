export interface WorkspaceBusyGuard {
  activeJobId?: string | null;
  activeJobStatus?: string | null;
  activeCommand?: string | null;
  leaseKey?: string | null;
  blockingOwner?: string | null;
  leaseExpiresAt?: Date | null;
}

export type RemoteFailureRecoveryMode = "reflect" | "fix_code" | "diagnose" | "ignore";

export function classifyRemoteFailureRecovery(errorClass: string | null | undefined): {
  mode: RemoteFailureRecoveryMode;
  rationale: string;
} {
  switch (errorClass) {
    case "RESEARCH_FAILURE":
      return {
        mode: "reflect",
        rationale: "The method failed on scientific grounds and should be reflected into the notebook before pivoting.",
      };
    case "CODE_ERROR":
      return {
        mode: "fix_code",
        rationale: "This is a script/runtime bug. Fix the code or change the script before resubmitting; do not treat it as a research conclusion.",
      };
    case "RESOURCE_ERROR":
      return {
        mode: "diagnose",
        rationale: "This is a host, package, network, or control-plane issue. Diagnose the environment instead of forcing failure reflection.",
      };
    case "AUTO_FIXED":
      return {
        mode: "ignore",
        rationale: "The failure was already auto-fixed and superseded by a follow-up run.",
      };
    default:
      return {
        mode: "diagnose",
        rationale: "The failure class is unknown. Treat it as an operational issue until proven otherwise.",
      };
  }
}

const INFRASTRUCTURE_SCRIPT_NAME_PATTERNS: RegExp[] = [
  /(?:^|[_-])(connection|connectivity)(?:[_-]|$)/,
  /(?:^|[_-])(smoke|hello|ping)(?:[_-]|$)/,
  /(?:^|[_-])(env|environment|gpu|cuda|workspace|lock|status)(?:[_-])(?:check|test|probe|verify|sanity)(?:[_-]|$)/,
  /(?:^|[_-])(check|test|probe|verify|sanity)(?:[_-])(env|environment|gpu|cuda|workspace|lock|status)(?:[_-]|$)/,
];

export function getManagedScriptPolicyViolation(scriptName: string): string | null {
  const lowerName = scriptName.toLowerCase();
  const isPython = lowerName.endsWith(".py");
  if (!isPython) return null;
  const stem = lowerName.replace(/\.py$/, "");
  if (!/^(poc|exp|analysis|sweep)_\d{3}_/.test(stem)) return null;

  if (INFRASTRUCTURE_SCRIPT_NAME_PATTERNS.some((pattern) => pattern.test(stem))) {
    return [
      "BLOCKED — Infrastructure probe scripts are not valid research scripts.",
      "Do not write or run connection tests, smoke tests, hello-world probes, or workspace/GPU/env check scripts.",
      "Use built-in tools instead:",
      "- diagnose_remote_host(...) for SSH/helper/GPU diagnostics",
      "- validate_environment(...) for package/import validation",
      "- get_workspace(refresh=true) for workspace state",
      "- read_file(...) for logs and result files",
      "- check_job(...) or cancel_job(...) for remote run control",
      "Write a PoC that tests a research mechanism, not the infrastructure.",
    ].join("\n");
  }

  return null;
}

export function formatWorkspaceBusySubmissionBlock(hostAlias: string, guard: WorkspaceBusyGuard): string {
  const jobRef = guard.activeJobId ? guard.activeJobId.slice(0, 8) : null;
  const commandLine = guard.activeCommand ? `\nCurrent command: \`${guard.activeCommand}\`` : "";
  const leaseLine = !jobRef && guard.blockingOwner
    ? `\nActive lease owner: \`${guard.blockingOwner}\`${guard.leaseExpiresAt ? ` until ${guard.leaseExpiresAt.toISOString()}` : ""}`
    : "";
  const nextSteps = jobRef
    ? [
        `- \`check_job(job_id="${jobRef}")\``,
        `- \`cancel_job(job_id="${jobRef}")\` if it is clearly stuck`,
        "- `get_workspace(refresh=true)` or `read_file(...)` to inspect outputs",
        "- `diagnose_remote_host(...)` if the lock state looks inconsistent",
      ].join("\n")
    : [
        "- `get_workspace(refresh=true)` to refresh lease and run state",
        "- `read_file(...)` to inspect outputs/logs",
        "- `diagnose_remote_host(...)` if the workspace state still looks wrong",
      ].join("\n");

  return [
    `BLOCKED — Remote workspace on ${hostAlias} is already occupied${jobRef ? ` by job ${jobRef} (${guard.activeJobStatus || "RUNNING"})` : ""}.`,
    "Do NOT submit another script, connection test, or legacy execute_remote command while this workspace is busy.",
    commandLine,
    leaseLine,
    "",
    "Allowed next actions:",
    nextSteps,
    "",
    "This is a control-plane block, not an SSH/rsync failure.",
  ].filter(Boolean).join("\n");
}

export function formatRemoteSubmissionFailure(hostAlias: string, errMsg: string, guard?: WorkspaceBusyGuard | null): string {
  if (errMsg.includes("Workspace busy")) {
    return formatWorkspaceBusySubmissionBlock(hostAlias, guard ?? {});
  }

  return [
    `Failed to submit remote job to ${hostAlias}:`,
    errMsg,
    "",
    "This is a remote submission failure. It is not permission to retry with probe commands or shell tests.",
    "Use `diagnose_remote_host(...)` for SSH/helper/GPU diagnostics, `validate_environment(...)` for package/import validation, and `get_workspace(refresh=true)` for workspace state before retrying.",
  ].join("\n");
}
