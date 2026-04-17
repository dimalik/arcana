#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { createSessionToken, resolveDbPath } = require("./research-test-utils");

function usage() {
  console.log("Usage:");
  console.log("  node scripts/metadata-rollout.js --missing [--limit N]");
  console.log("  node scripts/metadata-rollout.js --all [--limit N]");
  console.log("  node scripts/metadata-rollout.js --paper <paper-id> [--paper <paper-id> ...]");
  console.log("");
  console.log("Options:");
  console.log("  --base <url>        API base URL (default: http://127.0.0.1:3000)");
  console.log("  --dry-run           print selected papers, do not call API");
  console.log("  --log <path>        JSONL output path (default: tmp/metadata-rollout-<timestamp>.jsonl)");
  console.log("  --resume <path>     skip papers already marked ok=true in a prior JSONL log");
  process.exit(1);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
  const opts = {
    base: "http://127.0.0.1:3000",
    dryRun: false,
    bucket: null,
    paperIds: [],
    limit: null,
    logPath: null,
    resumePath: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--base":
        opts.base = argv[++i];
        break;
      case "--limit":
        opts.limit = parseInt(argv[++i], 10) || null;
        break;
      case "--log":
        opts.logPath = argv[++i];
        break;
      case "--resume":
        opts.resumePath = argv[++i];
        break;
      case "--paper":
        opts.paperIds.push(argv[++i]);
        break;
      case "--missing":
      case "--pdf-only":
      case "--all":
        opts.bucket = arg === "--pdf-only" ? "missing" : arg.slice(2);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
      case "-h":
        usage();
        break;
      default:
        if (arg.startsWith("--")) {
          console.error(`Unknown flag: ${arg}`);
          usage();
        }
        opts.paperIds.push(arg);
    }
  }

  if (opts.paperIds.length === 0 && !opts.bucket) {
    usage();
  }

  return opts;
}

function loadCompletedIds(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return new Set();
  const completed = new Set();
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.paperId && row.ok === true) {
        completed.add(row.paperId);
      }
    } catch {
      // Ignore malformed lines in resume logs.
    }
  }
  return completed;
}

function selectPapers(db, opts) {
  const limitClause = opts.limit ? ` LIMIT ${opts.limit}` : "";

  if (opts.paperIds.length > 0) {
    const placeholders = opts.paperIds.map(() => "?").join(",");
    return db.prepare(
      `SELECT id, title, year, arxivId, doi, sourceUrl, filePath
       FROM Paper
       WHERE id IN (${placeholders})
       ORDER BY title`,
    ).all(...opts.paperIds);
  }

  switch (opts.bucket) {
    case "missing":
      return db.prepare(
        `SELECT id, title, year, arxivId, doi, sourceUrl, filePath
         FROM Paper
         WHERE filePath IS NOT NULL
           AND arxivId IS NULL
           AND doi IS NULL
         ORDER BY title${limitClause}`,
      ).all();
    case "all":
      return db.prepare(
        `SELECT id, title, year, arxivId, doi, sourceUrl, filePath
         FROM Paper
         WHERE filePath IS NOT NULL
         ORDER BY title${limitClause}`,
      ).all();
    default:
      usage();
  }
}

function metadataIdentity(paper) {
  const parts = [];
  if (paper.year) parts.push(`year:${paper.year}`);
  if (paper.arxivId) parts.push(`arxiv:${paper.arxivId}`);
  if (paper.doi) parts.push(`doi:${paper.doi}`);
  if (!paper.arxivId && !paper.doi) parts.push("missing");
  return parts.join(" ");
}

function readPaper(db, paperId) {
  return db.prepare(
    `SELECT id, title, year, arxivId, doi, sourceUrl
     FROM Paper
     WHERE id = ?`,
  ).get(paperId);
}

async function runOne(base, token, before, db) {
  const startedAt = new Date().toISOString();
  const started = Date.now();

  try {
    const res = await fetch(`${base}/api/papers/${before.id}/refetch-metadata`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `arcana_session=${token}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(2 * 60 * 1000),
    });

    const payload = await res.json().catch(() => ({}));
    const after = readPaper(db, before.id);
    return {
      paperId: before.id,
      title: before.title,
      before: {
        year: before.year,
        arxivId: before.arxivId,
        doi: before.doi,
        sourceUrl: before.sourceUrl,
      },
      after: {
        year: after?.year ?? null,
        arxivId: after?.arxivId ?? null,
        doi: after?.doi ?? null,
        sourceUrl: after?.sourceUrl ?? null,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      httpStatus: res.status,
      ok: res.ok,
      updated: Array.isArray(payload.updated) ? payload.updated : [],
      source: payload.source ?? null,
      similarity: typeof payload.similarity === "number" ? payload.similarity : null,
      error: payload.error ?? null,
    };
  } catch (error) {
    return {
      paperId: before.id,
      title: before.title,
      before: {
        year: before.year,
        arxivId: before.arxivId,
        doi: before.doi,
        sourceUrl: before.sourceUrl,
      },
      after: {
        year: before.year,
        arxivId: before.arxivId,
        doi: before.doi,
        sourceUrl: before.sourceUrl,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      httpStatus: null,
      ok: false,
      updated: [],
      source: null,
      similarity: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const dbPath = resolveDbPath(process.argv);
  const db = new Database(dbPath);
  const papers = selectPapers(db, opts);
  const completed = loadCompletedIds(opts.resumePath);
  const selected = papers.filter((paper) => !completed.has(paper.id));

  const logPath = opts.logPath
    ? path.resolve(opts.logPath)
    : path.join(process.cwd(), "tmp", `metadata-rollout-${timestamp()}.jsonl`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  console.log(`${opts.dryRun ? "[DRY RUN] " : ""}Selected ${selected.length} papers`);
  console.log(`Log: ${logPath}`);
  if (opts.resumePath) {
    console.log(`Resume: skipping ${completed.size} previously successful papers from ${opts.resumePath}`);
  }
  console.log("");

  if (opts.dryRun) {
    selected.forEach((paper, index) => {
      console.log(`[${index + 1}/${selected.length}] ${paper.title} (${metadataIdentity(paper)})`);
    });
    db.close();
    return;
  }

  const session = createSessionToken(dbPath);
  let okCount = 0;
  let failCount = 0;
  let changedCount = 0;
  let newArxivCount = 0;
  let newDoiCount = 0;

  try {
    for (let i = 0; i < selected.length; i += 1) {
      const paper = selected[i];
      console.log(`[${i + 1}/${selected.length}] ${paper.title} (${metadataIdentity(paper)})`);
      const result = await runOne(opts.base, session.token, paper, db);
      fs.appendFileSync(logPath, `${JSON.stringify(result)}\n`);

      if (result.ok) {
        okCount += 1;
        const changed = result.updated.length > 0;
        if (changed) changedCount += 1;
        if (!result.before.arxivId && result.after.arxivId) newArxivCount += 1;
        if (!result.before.doi && result.after.doi) newDoiCount += 1;

        const updatedFields = result.updated.length > 0 ? result.updated.join(", ") : "none";
        const similarity = result.similarity != null ? result.similarity.toFixed(2) : "n/a";
        console.log(`  OK source=${result.source || "unknown"} similarity=${similarity} updated=${updatedFields}`);
        if (result.after.arxivId && result.after.arxivId !== result.before.arxivId) {
          console.log(`  arXiv: ${result.after.arxivId}`);
        }
        if (result.after.doi && result.after.doi !== result.before.doi) {
          console.log(`  DOI: ${result.after.doi}`);
        }
      } else {
        failCount += 1;
        console.log(`  FAIL status=${result.httpStatus ?? "n/a"} error=${result.error || "unknown"}`);
      }
      console.log("");
    }
  } finally {
    session.cleanup();
    db.close();
  }

  console.log("─".repeat(60));
  console.log(`Completed: ${okCount} ok, ${failCount} failed`);
  console.log(`Changed: ${changedCount} papers, new arXiv IDs: ${newArxivCount}, new DOIs: ${newDoiCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
