/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

function parseArg(argv, name, fallback = null) {
  const idx = argv.indexOf(name);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return fallback;
}

function firstPositionalArg(argv, valueFlags = []) {
  const flagsWithValues = new Set(valueFlags);
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (flagsWithValues.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function resolveDbPath(argv) {
  const explicit = parseArg(argv, "--db", null);
  if (explicit) return path.resolve(explicit);
  const raw = process.env.DATABASE_URL || "file:./prisma/dev.db";
  if (raw.startsWith("file:")) return path.resolve(process.cwd(), raw.replace(/^file:/, ""));
  return path.resolve(process.cwd(), "prisma/dev.db");
}

function ensureDefaultUser(db) {
  const existing = db.prepare("SELECT id, email FROM User ORDER BY createdAt ASC LIMIT 1").get();
  if (existing) return existing;

  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO User (id, email, name, role, onboardingCompleted, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(userId, "user@localhost", "Default User", "admin", 1, now, now);

  return { id: userId, email: "user@localhost" };
}

function createSessionToken(dbPath) {
  const db = new Database(dbPath);
  const user = ensureDefaultUser(db);

  const token = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  db.prepare(
    "INSERT INTO UserSession (id, userId, token, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, user.id, token, expires.toISOString(), now.toISOString());

  return {
    userId: user.id,
    userEmail: user.email,
    token,
    cleanup() {
      try {
        db.prepare("DELETE FROM UserSession WHERE id = ?").run(sessionId);
      } catch {
        // ignore
      }
      db.close();
    },
  };
}

function setProjectPhase(dbPath, projectId, currentPhase, status = null) {
  const db = new Database(dbPath);
  try {
    const now = new Date().toISOString();
    const update = status
      ? db.prepare("UPDATE ResearchProject SET currentPhase = ?, status = ?, updatedAt = ? WHERE id = ?")
      : db.prepare("UPDATE ResearchProject SET currentPhase = ?, updatedAt = ? WHERE id = ?");
    const result = status
      ? update.run(currentPhase, status, now, projectId)
      : update.run(currentPhase, now, projectId);

    if (result.changes === 0) {
      throw new Error(`Project not found in DB: ${projectId}`);
    }
  } finally {
    db.close();
  }
}

async function apiFetchJson(base, routePath, { token, method = "GET", body } = {}) {
  const res = await fetch(`${base}${routePath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Cookie: `arcana_session=${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  return { res, payload };
}

async function createResearchProject(base, token, overrides = {}) {
  const body = {
    title: "CI Superpowers Acceptance",
    question: "Can the agent run robust deterministic experiment workflows?",
    methodology: "exploratory",
    resources: "all",
    kind: "SYSTEM",
    ...overrides,
  };
  const { res, payload } = await apiFetchJson(base, "/api/research", { token, method: "POST", body });
  if (!res.ok) {
    throw new Error(`Failed to create project: HTTP ${res.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function ensureRemoteHost(base, token, alias = "mock-ci-host") {
  const body = {
    alias,
    host: "mock.invalid",
    user: "mock",
    workDir: "~/mock-experiments",
    backend: "ssh",
  };
  const { res, payload } = await apiFetchJson(base, "/api/research/remote-hosts", { token, method: "POST", body });
  if (res.ok || res.status === 409) return;
  throw new Error(`Failed to create remote host: HTTP ${res.status} ${JSON.stringify(payload)}`);
}

module.exports = {
  parseArg,
  firstPositionalArg,
  hasFlag,
  resolveDbPath,
  createSessionToken,
  setProjectPhase,
  apiFetchJson,
  createResearchProject,
  ensureRemoteHost,
};
