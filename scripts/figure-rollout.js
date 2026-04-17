#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { createSessionToken, resolveDbPath } = require("./research-test-utils");

function usage() {
  console.log("Usage:");
  console.log("  node scripts/figure-rollout.js --structured [--limit N]");
  console.log("  node scripts/figure-rollout.js --arxiv [--limit N]");
  console.log("  node scripts/figure-rollout.js --doi [--limit N]");
  console.log("  node scripts/figure-rollout.js --all [--limit N]");
  console.log("  node scripts/figure-rollout.js --paper <paper-id> [--paper <paper-id> ...]");
  console.log("");
  console.log("Options:");
  console.log("  --base <url>        API base URL (default: http://127.0.0.1:3000)");
  console.log("  --max-pages <n>     maxPages sent to extraction API (default: 30)");
  console.log("  --dry-run           print selected papers, do not call API");
  console.log("  --log <path>        JSONL output path (default: tmp/figure-rollout-<timestamp>.jsonl)");
  console.log("  --resume <path>     skip papers already marked ok=true in a prior JSONL log");
  process.exit(1);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
  const opts = {
    base: "http://127.0.0.1:3000",
    maxPages: 30,
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
      case "--max-pages":
        opts.maxPages = parseInt(argv[++i], 10) || 30;
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
      case "--structured":
      case "--arxiv":
      case "--doi":
      case "--all":
        opts.bucket = arg.slice(2);
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
      `SELECT id, title, arxivId, doi, filePath
       FROM Paper
       WHERE id IN (${placeholders})
       ORDER BY title`,
    ).all(...opts.paperIds);
  }

  switch (opts.bucket) {
    case "structured":
      return db.prepare(
        `SELECT id, title, arxivId, doi, filePath
         FROM Paper
         WHERE filePath IS NOT NULL
           AND (arxivId IS NOT NULL OR doi IS NOT NULL)
         ORDER BY CASE WHEN arxivId IS NOT NULL THEN 0 ELSE 1 END, title${limitClause}`,
      ).all();
    case "arxiv":
      return db.prepare(
        `SELECT id, title, arxivId, doi, filePath
         FROM Paper
         WHERE filePath IS NOT NULL
           AND arxivId IS NOT NULL
         ORDER BY title${limitClause}`,
      ).all();
    case "doi":
      return db.prepare(
        `SELECT id, title, arxivId, doi, filePath
         FROM Paper
         WHERE filePath IS NOT NULL
           AND doi IS NOT NULL
         ORDER BY title${limitClause}`,
      ).all();
    case "all":
      return db.prepare(
        `SELECT id, title, arxivId, doi, filePath
         FROM Paper
         WHERE filePath IS NOT NULL
         ORDER BY title${limitClause}`,
      ).all();
    default:
      usage();
  }
}

function identityString(paper) {
  const parts = [];
  if (paper.arxivId) parts.push(`arxiv:${paper.arxivId}`);
  if (paper.doi) parts.push(`doi:${paper.doi}`);
  if (!paper.arxivId && !paper.doi) parts.push("pdf-only");
  return parts.join(" ");
}

async function runOne(base, token, paper, maxPages) {
  const startedAt = new Date().toISOString();
  const started = Date.now();

  try {
    const res = await fetch(`${base}/api/papers/${paper.id}/figures`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `arcana_session=${token}`,
      },
      body: JSON.stringify({ maxPages }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });

    const payload = await res.json().catch(() => ({}));
    return {
      paperId: paper.id,
      title: paper.title,
      identity: identityString(paper),
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      httpStatus: res.status,
      ok: payload.ok === true,
      persistErrors: payload.persistErrors ?? null,
      totalFigures: payload.totalFigures ?? null,
      figuresWithImages: payload.figuresWithImages ?? null,
      gapPlaceholders: payload.gapPlaceholders ?? null,
      sources: payload.sources ?? [],
      error: payload.error ?? null,
    };
  } catch (error) {
    return {
      paperId: paper.id,
      title: paper.title,
      identity: identityString(paper),
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      httpStatus: null,
      ok: false,
      persistErrors: null,
      totalFigures: null,
      figuresWithImages: null,
      gapPlaceholders: null,
      sources: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const dbPath = resolveDbPath(process.argv);
  const db = new Database(dbPath, { readonly: true });
  const papers = selectPapers(db, opts);
  const completed = loadCompletedIds(opts.resumePath);
  const selected = papers.filter((paper) => !completed.has(paper.id));

  const logPath = opts.logPath
    ? path.resolve(opts.logPath)
    : path.join(process.cwd(), "tmp", `figure-rollout-${timestamp()}.jsonl`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  console.log(`${opts.dryRun ? "[DRY RUN] " : ""}Selected ${selected.length} papers`);
  console.log(`Log: ${logPath}`);
  if (opts.resumePath) {
    console.log(`Resume: skipping ${completed.size} previously successful papers from ${opts.resumePath}`);
  }
  console.log("");

  if (opts.dryRun) {
    selected.forEach((paper, index) => {
      console.log(`[${index + 1}/${selected.length}] ${paper.title} (${identityString(paper)})`);
    });
    return;
  }

  const session = createSessionToken(dbPath);
  let okCount = 0;
  let failCount = 0;
  let totalFigures = 0;
  let totalImages = 0;
  let totalGaps = 0;

  try {
    for (let i = 0; i < selected.length; i += 1) {
      const paper = selected[i];
      console.log(`[${i + 1}/${selected.length}] ${paper.title} (${identityString(paper)})`);
      const result = await runOne(opts.base, session.token, paper, opts.maxPages);
      fs.appendFileSync(logPath, `${JSON.stringify(result)}\n`);

      if (result.ok) {
        okCount += 1;
        totalFigures += result.totalFigures || 0;
        totalImages += result.figuresWithImages || 0;
        totalGaps += result.gapPlaceholders || 0;
        const sources = (result.sources || [])
          .filter((src) => src.attempted && src.figuresFound > 0)
          .map((src) => `${src.method}=${src.figuresFound}`)
          .join(", ") || "none";
        console.log(`  OK ${result.totalFigures} figures (${result.figuresWithImages} images, ${result.gapPlaceholders} gaps) from ${sources}`);
      } else {
        failCount += 1;
        console.log(`  FAIL status=${result.httpStatus ?? "n/a"} error=${result.error || "unknown"}`);
      }
      if (result.persistErrors && result.persistErrors > 0) {
        console.log(`  WARN persistErrors=${result.persistErrors}`);
      }
      console.log("");
    }
  } finally {
    session.cleanup();
    db.close();
  }

  console.log("─".repeat(60));
  console.log(`Completed: ${okCount} ok, ${failCount} failed`);
  console.log(`Totals: ${totalFigures} figures, ${totalImages} with images, ${totalGaps} gaps`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
