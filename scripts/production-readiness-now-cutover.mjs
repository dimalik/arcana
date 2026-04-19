#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const cwd = process.cwd();
  return {
    dryRun: !argv.includes("--execute"),
    snapshotMode: argv.includes("--snapshot"),
    dbPath: valueFor(argv, "--db-path") ?? path.join(cwd, "prisma", "dev.db"),
    backupDir: valueFor(argv, "--backup-dir") ?? path.join(cwd, "prisma", "backups"),
    artifactDir:
      valueFor(argv, "--artifact-dir") ?? path.join(cwd, "benchmark", "production-readiness-now"),
    userId: valueFor(argv, "--user-id") ?? null,
    days: Number.parseInt(valueFor(argv, "--days") ?? "30", 10) || 30,
    integrationRef: valueFor(argv, "--integration-ref") ?? "production-readiness-now",
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

function runJsonCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "inherit"],
    cwd: process.cwd(),
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result.stdout.trim();
}

function sqliteBackup(sourcePath, backupPath) {
  runOrThrow("sqlite3", [sourcePath, `.backup ${backupPath}`]);
}

function sqliteScalar(dbPath, sql) {
  return runJsonCommand("sqlite3", [dbPath, sql]).trim();
}

function buildPaths({ backupDir, artifactDir }) {
  const stamp = timestamp();
  return {
    backupPath: path.join(backupDir, `production-readiness-now-pre-cutover-${stamp}.db`),
    duplicatePrePath: path.join(artifactDir, "duplicates.pre.json"),
    duplicateApplyPath: path.join(artifactDir, "duplicates.apply.json"),
    duplicatePostPath: path.join(artifactDir, "duplicates.post.json"),
    deterministicPath: path.join(artifactDir, "deterministic-relatedness.snapshot.json"),
    costPath: path.join(artifactDir, "paper-costs.snapshot.json"),
    summaryPath: path.join(artifactDir, "cutover.summary.json"),
  };
}

function buildSequence(args, paths) {
  return [
    `1. Backup target DB with sqlite .backup to ${paths.backupPath}`,
    "2. Apply Prisma migrations for PR 5 and PR 6",
    "3. Verify Concept table is gone on the migrated DB",
    `4. Run duplicate scan for user ${args.userId ?? "<user-id>"} -> ${paths.duplicatePrePath}`,
    `5. Run duplicate apply -> ${paths.duplicateApplyPath}`,
    `6. Re-run duplicate scan -> ${paths.duplicatePostPath}`,
    `7. Run paper cost reconciliation -> ${paths.costPath}`,
    args.snapshotMode
      ? `8. Run deterministic relatedness snapshot apply -> ${paths.deterministicPath}`
      : "8. Post-restart: run deterministic relatedness live backfill",
    `9. Deploy/restart the integration-branch artifact pinned to ${args.integrationRef} only after DB-side checks are clean`,
  ];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = buildPaths(args);
  const sequence = buildSequence(args, paths);

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          snapshotMode: args.snapshotMode,
          dbPath: args.dbPath,
          userId: args.userId,
          days: args.days,
          integrationRef: args.integrationRef,
          artifactPaths: paths,
          sequence,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!args.userId) {
    throw new Error("--user-id is required in execute mode");
  }

  fs.mkdirSync(args.backupDir, { recursive: true });
  fs.mkdirSync(args.artifactDir, { recursive: true });

  sqliteBackup(args.dbPath, paths.backupPath);

  const databaseUrl = `file:${args.dbPath}`;
  runOrThrow("./node_modules/.bin/prisma", ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  runOrThrow("node", ["--import", "tsx", "scripts/check-concepts-removed.mjs"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  const conceptTableExists = sqliteScalar(
    args.dbPath,
    "select count(*) from sqlite_master where type='table' and name='Concept';",
  );
  if (conceptTableExists !== "0") {
    throw new Error("Concept table still exists after migrations");
  }

  runOrThrow("node", [
    "--import",
    "tsx",
    "scripts/papers/scan-duplicate-candidates.ts",
    "--user-id",
    args.userId,
    "--out",
    paths.duplicatePrePath,
  ], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  runOrThrow("node", [
    "--import",
    "tsx",
    "scripts/papers/apply-duplicate-candidates.ts",
    "--user-id",
    args.userId,
    "--out",
    paths.duplicateApplyPath,
  ], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  runOrThrow("node", [
    "--import",
    "tsx",
    "scripts/papers/scan-duplicate-candidates.ts",
    "--user-id",
    args.userId,
    "--out",
    paths.duplicatePostPath,
  ], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  runOrThrow("node", [
    "--import",
    "tsx",
    "scripts/reconcile-paper-costs.ts",
    "--days",
    String(args.days),
    "--out",
    paths.costPath,
  ], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  if (args.snapshotMode) {
    runOrThrow("node", [
      "--import",
      "tsx",
      "scripts/assertions/backfill-deterministic-relatedness.ts",
      "--apply",
      "--out",
      paths.deterministicPath,
    ], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  }

  const summary = {
    executedAt: new Date().toISOString(),
    snapshotMode: args.snapshotMode,
    dbPath: args.dbPath,
    backupPath: paths.backupPath,
    artifactPaths: paths,
    nextSteps: args.snapshotMode
      ? [
          "Review duplicate pre/apply/post artifacts together.",
          "Review deterministic relatedness snapshot artifact.",
          "Review paper cost reconciliation artifact.",
          "If all artifacts are clean, repeat the DB-side steps on the live DB during the maintenance window.",
          "Deploy the integration-branch artifact after the live DB-side steps complete.",
        ]
      : [
          "Deploy the integration-branch artifact and verify boot against the migrated schema.",
          "Run deterministic relatedness live backfill after restart.",
          "Re-run duplicate scan, then admin cost reconciliation smoke.",
        ],
  };

  fs.writeFileSync(paths.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main();
