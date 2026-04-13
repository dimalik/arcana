#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-require-imports */
const {
  parseArg,
  firstPositionalArg,
  hasFlag,
  resolveDbPath,
  createSessionToken,
  apiFetchJson,
  createResearchProject,
} = require("./research-test-utils");

async function main() {
  const positionalProject = firstPositionalArg(process.argv, ["--base", "--query", "--db", "--project"]);
  let projectId = parseArg(process.argv, "--project", null) || positionalProject;

  const base = parseArg(process.argv, "--base", process.env.ARCANA_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const query = parseArg(process.argv, "--query", "stabilize training and prevent collapse");
  const persist = !hasFlag(process.argv, "--no-persist");
  const createProject = hasFlag(process.argv, "--create-project");
  const dbPath = resolveDbPath(process.argv);

  const session = createSessionToken(dbPath);
  if (!projectId || createProject) {
    const created = await createResearchProject(base, session.token, {
      title: "Superpowers Acceptance (Auto)",
      question: "Validate superpowers contracts with deterministic checks.",
      methodology: "exploratory",
      kind: "SYSTEM",
    });
    projectId = created.id;
  }

  console.log(`[acceptance] user=${session.userEmail} project=${projectId}`);
  console.log(`[acceptance] base=${base}`);

  try {
    const { res, payload } = await apiFetchJson(base, `/api/research/${projectId}/acceptance/superpowers`, {
      token: session.token,
      method: "POST",
      body: {
        query,
        persist_protocol: persist,
      },
    });
    if (!res.ok) {
      console.error(`[acceptance] HTTP ${res.status}`);
      console.error(payload);
      process.exit(1);
    }

    console.log(`[acceptance] summary:`, payload.summary);
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
  console.error("[acceptance] error:", err?.message || err);
  process.exit(1);
});
