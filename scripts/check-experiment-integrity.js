#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ACTIVE_JOB_STATES = ["SYNCING", "QUEUED", "RUNNING"];
const TERMINAL_RUN_STATES = ["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"];
const NON_TERMINAL_RUN_STATES = ["QUEUED", "STARTING", "RUNNING"];
const TERMINAL_PROJECTION = {
  SUCCEEDED: "COMPLETED",
  FAILED: "FAILED",
  BLOCKED: "FAILED",
  CANCELLED: "CANCELLED",
};
const ALLOWED_TRANSITIONS = {
  QUEUED: new Set(["STARTING", "CANCELLED", "BLOCKED"]),
  STARTING: new Set(["RUNNING", "FAILED", "CANCELLED", "BLOCKED"]),
  RUNNING: new Set(["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"]),
  SUCCEEDED: new Set(),
  FAILED: new Set(["QUEUED", "BLOCKED", "CANCELLED"]),
  CANCELLED: new Set(["QUEUED"]),
  BLOCKED: new Set(["QUEUED", "CANCELLED"]),
};

function resolveDbPath() {
  const argPath = process.argv[2];
  if (argPath) return path.resolve(argPath);

  const rawDbUrl = process.env.DATABASE_URL || "";
  if (rawDbUrl.startsWith("file:")) {
    const rel = rawDbUrl.replace(/^file:/, "");
    return path.resolve(process.cwd(), rel);
  }

  return path.resolve(process.cwd(), "prisma", "dev.db");
}

function fmtRows(rows, mapper, limit = 8) {
  return rows
    .slice(0, limit)
    .map(mapper)
    .join("\n");
}

function main() {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(`[integrity] Database not found: ${dbPath}`);
    process.exit(2);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");

  const failures = [];
  const warnings = [];

  const runCount = db.prepare("SELECT COUNT(*) AS count FROM ExperimentRun").get().count;
  const jobCount = db.prepare("SELECT COUNT(*) AS count FROM RemoteJob").get().count;

  const badAttemptCounts = db.prepare(`
    SELECT r.id AS runId, r.attemptCount AS recordedAttempts, COUNT(a.id) AS actualAttempts
    FROM ExperimentRun r
    LEFT JOIN ExperimentAttempt a ON a.runId = r.id
    GROUP BY r.id
    HAVING recordedAttempts != actualAttempts
  `).all();
  if (badAttemptCounts.length > 0) {
    failures.push(
      [
        `attemptCount mismatch in ${badAttemptCounts.length} run(s):`,
        fmtRows(
          badAttemptCounts,
          (r) => `  - run ${r.runId.slice(0, 8)} recorded=${r.recordedAttempts} actual=${r.actualAttempts}`,
        ),
      ].join("\n"),
    );
  }

  const missingTerminalCompletion = db.prepare(`
    SELECT id, state
    FROM ExperimentRun
    WHERE state IN (${TERMINAL_RUN_STATES.map(() => "?").join(", ")})
      AND completedAt IS NULL
  `).all(...TERMINAL_RUN_STATES);
  if (missingTerminalCompletion.length > 0) {
    failures.push(
      [
        `terminal runs missing completedAt (${missingTerminalCompletion.length}):`,
        fmtRows(
          missingTerminalCompletion,
          (r) => `  - run ${r.id.slice(0, 8)} state=${r.state}`,
        ),
      ].join("\n"),
    );
  }

  const nonTerminalWithCompletion = db.prepare(`
    SELECT id, state
    FROM ExperimentRun
    WHERE state IN (${NON_TERMINAL_RUN_STATES.map(() => "?").join(", ")})
      AND completedAt IS NOT NULL
  `).all(...NON_TERMINAL_RUN_STATES);
  if (nonTerminalWithCompletion.length > 0) {
    failures.push(
      [
        `non-terminal runs with completedAt set (${nonTerminalWithCompletion.length}):`,
        fmtRows(
          nonTerminalWithCompletion,
          (r) => `  - run ${r.id.slice(0, 8)} state=${r.state}`,
        ),
      ].join("\n"),
    );
  }

  const terminalProjectionMismatches = db.prepare(`
    SELECT j.id AS jobId, r.id AS runId, r.state AS runState, j.status AS jobStatus
    FROM RemoteJob j
    JOIN ExperimentRun r ON r.id = j.runId
    WHERE r.state IN (${TERMINAL_RUN_STATES.map(() => "?").join(", ")})
      AND (
        (r.state = 'SUCCEEDED' AND j.status != 'COMPLETED')
        OR (r.state IN ('FAILED', 'BLOCKED') AND j.status != 'FAILED')
        OR (r.state = 'CANCELLED' AND j.status != 'CANCELLED')
      )
  `).all(...TERMINAL_RUN_STATES);
  if (terminalProjectionMismatches.length > 0) {
    failures.push(
      [
        `terminal run/job projection mismatches (${terminalProjectionMismatches.length}):`,
        fmtRows(
          terminalProjectionMismatches,
          (r) =>
            `  - run ${r.runId.slice(0, 8)} (${r.runState}) -> job ${r.jobId.slice(0, 8)} status=${r.jobStatus}`,
        ),
      ].join("\n"),
    );
  }

  const activeWorkspaceCollisions = db.prepare(`
    SELECT hostId, remoteDir, COUNT(*) AS activeCount, GROUP_CONCAT(SUBSTR(id, 1, 8), ',') AS jobIds
    FROM RemoteJob
    WHERE status IN (${ACTIVE_JOB_STATES.map(() => "?").join(", ")})
      AND remoteDir IS NOT NULL
      AND remoteDir != ''
    GROUP BY hostId, remoteDir
    HAVING activeCount > 1
  `).all(...ACTIVE_JOB_STATES);
  if (activeWorkspaceCollisions.length > 0) {
    failures.push(
      [
        `active workspace collisions on host+remoteDir (${activeWorkspaceCollisions.length}):`,
        fmtRows(
          activeWorkspaceCollisions,
          (r) => `  - host=${r.hostId.slice(0, 8)} dir=${r.remoteDir} jobs=${r.jobIds}`,
        ),
      ].join("\n"),
    );
  }

  const activeLegacyCollisions = db.prepare(`
    SELECT hostId, localDir, COUNT(*) AS activeCount, GROUP_CONCAT(SUBSTR(id, 1, 8), ',') AS jobIds
    FROM RemoteJob
    WHERE status IN (${ACTIVE_JOB_STATES.map(() => "?").join(", ")})
      AND (remoteDir IS NULL OR remoteDir = '')
    GROUP BY hostId, localDir
    HAVING activeCount > 1
  `).all(...ACTIVE_JOB_STATES);
  if (activeLegacyCollisions.length > 0) {
    failures.push(
      [
        `active collisions on legacy jobs with empty remoteDir (${activeLegacyCollisions.length}):`,
        fmtRows(
          activeLegacyCollisions,
          (r) => `  - host=${r.hostId.slice(0, 8)} localDir=${r.localDir} jobs=${r.jobIds}`,
        ),
      ].join("\n"),
    );
  }

  const runsMissingCreatedEvent = db.prepare(`
    SELECT r.id
    FROM ExperimentRun r
    LEFT JOIN ExperimentEvent e
      ON e.runId = r.id
      AND e.type = 'RUN_CREATED'
    WHERE e.id IS NULL
  `).all();
  if (runsMissingCreatedEvent.length > 0) {
    warnings.push(
      [
        `runs missing RUN_CREATED event (${runsMissingCreatedEvent.length})`,
        fmtRows(
          runsMissingCreatedEvent,
          (r) => `  - run ${r.id.slice(0, 8)}`,
        ),
      ].join("\n"),
    );
  }

  const transitionEvents = db.prepare(`
    SELECT runId, stateFrom, stateTo, createdAt
    FROM ExperimentEvent
    WHERE type = 'RUN_STATE_TRANSITION'
      AND stateFrom IS NOT NULL
      AND stateTo IS NOT NULL
    ORDER BY createdAt ASC
  `).all();
  const badTransitions = [];
  for (const row of transitionEvents) {
    const allowed = ALLOWED_TRANSITIONS[row.stateFrom];
    if (!allowed) {
      badTransitions.push({
        runId: row.runId,
        from: row.stateFrom,
        to: row.stateTo,
      });
      continue;
    }
    if (row.stateFrom !== row.stateTo && !allowed.has(row.stateTo)) {
      badTransitions.push({
        runId: row.runId,
        from: row.stateFrom,
        to: row.stateTo,
      });
    }
  }
  if (badTransitions.length > 0) {
    failures.push(
      [
        `illegal run state transitions in event log (${badTransitions.length}):`,
        fmtRows(
          badTransitions,
          (r) => `  - run ${r.runId.slice(0, 8)} ${r.from} -> ${r.to}`,
        ),
      ].join("\n"),
    );
  }

  console.log(`[integrity] db=${dbPath}`);
  console.log(`[integrity] runs=${runCount} jobs=${jobCount}`);
  console.log(`[integrity] expected terminal mapping: ${Object.entries(TERMINAL_PROJECTION).map(([k, v]) => `${k}->${v}`).join(", ")}`);

  if (warnings.length > 0) {
    console.log(`\n[integrity] warnings (${warnings.length})`);
    for (const warning of warnings) {
      console.log(`\n${warning}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n[integrity] failures (${failures.length})`);
    for (const failure of failures) {
      console.error(`\n${failure}`);
    }
    process.exit(1);
  }

  console.log("\n[integrity] OK: no invariant violations detected.");
}

main();
