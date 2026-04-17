#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const cwd = process.cwd();
  return {
    dryRun: argv.includes("--dry-run"),
    dbPath: valueFor(argv, "--db-path") ?? path.join(cwd, "prisma", "dev.db"),
    backupDir: valueFor(argv, "--backup-dir") ?? path.join(cwd, "prisma", "backups"),
    artifactDir: valueFor(argv, "--artifact-dir") ?? path.join(cwd, "benchmark", "graph"),
    integrationRef: valueFor(argv, "--integration-ref") ?? "tranche2-graph-convergence",
    merge: argv.includes("--merge"),
  };
}

function valueFor(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: process.cwd(),
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function stripVolatileFields(value) {
  if (Array.isArray(value)) {
    return value.map(stripVolatileFields);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "generatedAt" || key === "dbPath" || key === "baselinePath") continue;
      out[key] = stripVolatileFields(child);
    }
    return out;
  }
  return value;
}

function jsonEquals(aPath, bPath) {
  const left = stripVolatileFields(JSON.parse(fs.readFileSync(aPath, "utf-8")));
  const right = stripVolatileFields(JSON.parse(fs.readFileSync(bPath, "utf-8")));
  return JSON.stringify(left) === JSON.stringify(right);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const backupPath = path.join(args.backupDir, `tranche2-pre-cutover-${timestamp()}.db`);
  const preParityPath = path.join(args.artifactDir, "relation-parity.pre-cutover.json");
  const snapshotEntityPath = path.join(args.artifactDir, "entity-coverage.post-apply.json");
  const snapshotParityPath = path.join(args.artifactDir, "relation-parity.post-apply.json");
  const realEntityPath = path.join(args.artifactDir, "entity-coverage.post-apply.real.json");
  const realParityPath = path.join(args.artifactDir, "relation-parity.post-apply.real.json");

  const sequence = [
    `1. Backup real DB to ${backupPath}`,
    `2. Run backfill apply on ${args.dbPath}`,
    `3. Regenerate real post-apply artifacts in ${args.artifactDir}`,
    `4. Diff real artifacts against snapshot artifacts`,
    `5. Merge ${args.integrationRef}${args.merge ? " with --ff-only" : " (manual merge step omitted unless --merge is passed)"}`,
  ];

  if (args.dryRun) {
    console.log(JSON.stringify({
      mode: "dry-run",
      dbPath: args.dbPath,
      artifactDir: args.artifactDir,
      integrationRef: args.integrationRef,
      merge: args.merge,
      sequence,
    }, null, 2));
    return;
  }

  fs.mkdirSync(args.backupDir, { recursive: true });
  fs.copyFileSync(args.dbPath, backupPath);

  runOrThrow("node", [
    "scripts/backfill-paper-graph.mjs",
    "--apply",
    "--confirm-real-db",
    "--db-path",
    args.dbPath,
  ]);

  runOrThrow("node", [
    "scripts/graph-readiness.mjs",
    "--db-path",
    args.dbPath,
    "--waivers",
    path.join(args.artifactDir, "waivers.json"),
    "--baseline",
    preParityPath,
    "--entity-out",
    realEntityPath,
    "--parity-out",
    realParityPath,
  ]);

  if (!jsonEquals(snapshotEntityPath, realEntityPath) || !jsonEquals(snapshotParityPath, realParityPath)) {
    throw new Error(
      "Real post-apply artifacts differ from snapshot artifacts. " +
        `Restore ${backupPath} before attempting another cutover.`
    );
  }

  if (args.merge) {
    runOrThrow("git", ["merge", "--ff-only", args.integrationRef]);
  } else {
    console.log(
      JSON.stringify({
        mode: "applied-no-merge",
        backupPath,
        realEntityPath,
        realParityPath,
        message: `Artifacts match snapshot outputs. Merge ${args.integrationRef} manually or rerun with --merge.`,
      }, null, 2)
    );
  }
}

main();
