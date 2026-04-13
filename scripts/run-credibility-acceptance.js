#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-require-imports */
const {
  parseArg,
  firstPositionalArg,
  createSessionToken,
  apiFetchJson,
  createResearchProject,
  resolveDbPath,
} = require("./research-test-utils");

async function main() {
  const positionalProject = firstPositionalArg(process.argv, ["--base", "--db", "--project"]);
  let projectId = parseArg(process.argv, "--project", null) || positionalProject;
  const base = parseArg(process.argv, "--base", process.env.ARCANA_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const dbPath = resolveDbPath(process.argv);

  const session = createSessionToken(dbPath);
  if (!projectId) {
    const created = await createResearchProject(base, session.token, {
      title: "Credibility Acceptance (Auto)",
      question: "Validate claim-ledger credibility contracts.",
      methodology: "exploratory",
      kind: "SYSTEM",
    });
    projectId = created.id;
  }

  console.log(`[credibility] user=${session.userEmail} project=${projectId}`);
  console.log(`[credibility] base=${base}`);

  try {
    const { res, payload } = await apiFetchJson(base, `/api/research/${projectId}/acceptance/credibility`, {
      token: session.token,
      method: "POST",
    });
    if (!res.ok) {
      console.error(`[credibility] HTTP ${res.status}`);
      console.error(payload);
      process.exit(1);
    }

    console.log(`[credibility] summary:`, payload.summary);
    for (const step of payload.steps || []) {
      const icon = step.status === "pass" ? "✓" : step.status === "fail" ? "✗" : step.status === "warn" ? "!" : "-";
      console.log(`${icon} ${step.name}: ${step.detail}`);
    }

    if (!payload.ok) process.exit(1);
  } finally {
    session.cleanup();
  }
}

main().catch((err) => {
  console.error("[credibility] error:", err?.message || err);
  process.exit(1);
});
