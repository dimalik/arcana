#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require("better-sqlite3");
const {
  parseArg,
  firstPositionalArg,
  resolveDbPath,
  createSessionToken,
  setProjectPhase,
  createResearchProject,
  ensureRemoteHost,
} = require("./research-test-utils");

async function readSseEvents(res, timeoutMs) {
  if (!res.body || typeof res.body.getReader !== "function") {
    throw new Error("SSE response body is not readable.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for SSE events.")), remaining);
      reader.read().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });

    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });

    let splitIdx = buffer.indexOf("\n\n");
    while (splitIdx >= 0) {
      const frame = buffer.slice(0, splitIdx);
      buffer = buffer.slice(splitIdx + 2);

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          events.push(JSON.parse(raw));
        } catch {
          // ignore malformed frames
        }
      }
      splitIdx = buffer.indexOf("\n\n");
    }

    const finished = events.some((e) => e.type === "done" && typeof e.content === "string" && e.content.includes("Agent finished"));
    if (finished) break;
  }

  try { await reader.cancel(); } catch { /* ignore */ }
  return events;
}

async function main() {
  const base = parseArg(process.argv, "--base", process.env.ARCANA_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const fixture = parseArg(process.argv, "--fixture", "poc_smoke_success");
  const timeoutMs = Number(parseArg(process.argv, "--timeout-ms", "180000"));
  const dbPath = resolveDbPath(process.argv);

  const session = createSessionToken(dbPath);
  const positionalProject = firstPositionalArg(process.argv, ["--base", "--fixture", "--timeout-ms", "--db", "--project"]);
  let projectId = parseArg(process.argv, "--project", null) || positionalProject;

  if (!projectId) {
    const created = await createResearchProject(base, session.token, {
      title: "Agent Mock E2E",
      question: "Can the fixture-driven agent submit deterministic experiment runs?",
      methodology: "exploratory",
      kind: "SYSTEM",
    });
    projectId = created.id;
  }

  console.log(`[agent-e2e] user=${session.userEmail} project=${projectId}`);
  console.log(`[agent-e2e] base=${base} fixture=${fixture}`);

  try {
    await ensureRemoteHost(base, session.token, "mock-ci-host");
    setProjectPhase(dbPath, projectId, "experiment", "ACTIVE");

    const startRes = await fetch(`${base}/api/research/${projectId}/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `arcana_session=${session.token}`,
      },
      body: JSON.stringify({
        message: "Run deterministic acceptance fixture.",
        disable_auto_continue: true,
        mock_llm_fixture: fixture,
        mock_executor: {
          enabled: true,
          mode: "success",
          write_result_file: true,
        },
      }),
    });
    if (!startRes.ok) {
      const payload = await startRes.json().catch(() => ({}));
      throw new Error(`Failed to start agent: HTTP ${startRes.status} ${JSON.stringify(payload)}`);
    }

    const events = await readSseEvents(startRes, timeoutMs);
    const toolCalls = events.filter((e) => e.type === "tool_call").map((e) => e.toolName);
    const runResult = events.find((e) => e.type === "tool_result" && e.toolName === "run_experiment");
    const done = events.some((e) => e.type === "done" && typeof e.content === "string" && e.content.includes("Agent finished"));

    if (!toolCalls.includes("run_experiment")) {
      throw new Error(`Fixture did not call run_experiment. tool_calls=${JSON.stringify(toolCalls)}`);
    }
    if (!runResult || !String(runResult.result || "").includes("Job submitted")) {
      throw new Error(`run_experiment output missing expected submission message. output=${JSON.stringify(runResult?.result || null)}`);
    }
    if (!done) {
      throw new Error(`Agent did not emit terminal done event within timeout (${timeoutMs}ms).`);
    }

    const db = new Database(dbPath, { readonly: true });
    try {
      const latestJob = db.prepare(
        "SELECT id, status, command, stdout FROM RemoteJob WHERE projectId = ? ORDER BY createdAt DESC LIMIT 1",
      ).get(projectId);
      if (!latestJob) {
        throw new Error("No RemoteJob created by fixture run.");
      }
      if (latestJob.status !== "COMPLETED") {
        throw new Error(`Expected latest RemoteJob to be COMPLETED, got ${latestJob.status}.`);
      }
      if (!String(latestJob.stdout || "").includes("[mock-executor]")) {
        throw new Error("Latest RemoteJob stdout missing [mock-executor] marker.");
      }
      const importedResult = db.prepare(
        "SELECT id, verdict, reflection FROM ExperimentResult WHERE jobId = ? LIMIT 1",
      ).get(latestJob.id);
      if (!importedResult) {
        throw new Error("Mock executor completed but no ExperimentResult was imported automatically.");
      }
      console.log(`[agent-e2e] remote_job=${latestJob.id} status=${latestJob.status}`);
      console.log(`[agent-e2e] experiment_result=${importedResult.id} verdict=${importedResult.verdict}`);
      console.log(`[agent-e2e] command=${latestJob.command}`);
    } finally {
      db.close();
    }

    console.log(`[agent-e2e] events=${events.length} tool_calls=${toolCalls.length}`);
    console.log(`[agent-e2e] PASS`);
  } finally {
    session.cleanup();
  }
}

main().catch((err) => {
  console.error("[agent-e2e] error:", err?.message || err);
  process.exit(1);
});
