#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { chromium } = require("playwright");
const { resolveDbPath } = require("./research-test-utils");

const TABLE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    padding: 16px;
    background: white;
    color: #1a1a1a;
  }
  table, .ltx_tabular {
    border-collapse: collapse;
    width: auto;
    max-width: 100%;
  }
  td, th, .ltx_td, .ltx_th {
    padding: 4px 10px;
    border: 1px solid #d0d0d0;
    text-align: center;
    vertical-align: middle;
    font-size: 12px;
  }
  th, .ltx_th, .ltx_border_tt .ltx_td:first-child {
    background: #f5f5f5;
    font-weight: 600;
  }
  .ltx_tabular { display: table; }
  .ltx_tr { display: table-row; }
  .ltx_td, .ltx_th { display: table-cell; }
  .ltx_thead { display: table-header-group; }
  .ltx_tbody { display: table-row-group; }
  .ltx_border_tt { border-top: 2px solid #333; }
  .ltx_border_t { border-top: 1px solid #999; }
  .ltx_border_bb { border-bottom: 2px solid #333; }
  .ltx_border_b { border-bottom: 1px solid #999; }
  .ltx_align_left { text-align: left; }
  .ltx_align_center { text-align: center; }
  .ltx_align_right { text-align: right; }
  .ltx_font_bold { font-weight: 700; }
  .ltx_font_italic { font-style: italic; }
  annotation, .ltx_role_display { display: none; }
  .ltx_transformed_outer, .ltx_transformed_inner {
    transform: none !important;
    width: auto !important;
    height: auto !important;
    vertical-align: baseline !important;
  }
  .ltx_inline-block { display: inline-block; width: auto !important; }
`;

function usage() {
  console.log("Usage:");
  console.log("  node scripts/table-preview-backfill.js --rollout-log /tmp/figure-rollout-structured.jsonl");
  console.log("  node scripts/table-preview-backfill.js --paper <paper-id> [--paper <paper-id> ...]");
  console.log("  node scripts/table-preview-backfill.js --all");
  console.log("");
  console.log("Options:");
  console.log("  --dry-run           print candidate rows, do not render");
  console.log("  --limit <n>         limit candidate rows");
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    rolloutLog: null,
    paperIds: [],
    all: false,
    dryRun: false,
    limit: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--rollout-log":
        opts.rolloutLog = argv[++i];
        break;
      case "--paper":
        opts.paperIds.push(argv[++i]);
        break;
      case "--all":
        opts.all = true;
        break;
      case "--limit":
        opts.limit = parseInt(argv[++i], 10) || null;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
      case "-h":
        usage();
        break;
      default:
        console.error(`Unknown flag: ${arg}`);
        usage();
    }
  }

  if (!opts.rolloutLog && !opts.all && opts.paperIds.length === 0) {
    usage();
  }
  return opts;
}

function readRolloutPaperIds(logPath) {
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line).paperId);
}

function buildWhere(opts) {
  const clauses = [
    "isPrimaryExtraction = 1",
    "type = 'table'",
    "imagePath IS NULL",
    "gapReason = 'structured_content_no_preview'",
    "length(description) > 100",
  ];

  if (!opts.all) {
    let ids = opts.paperIds;
    if (opts.rolloutLog) {
      ids = readRolloutPaperIds(opts.rolloutLog);
    }
    if (ids.length > 0) {
      const quoted = ids.map((id) => `'${id}'`).join(",");
      clauses.push(`paperId IN (${quoted})`);
    }
  }

  return clauses.join(" AND ");
}

function buildHtml(tableContent) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>${TABLE_CSS}</style>
</head><body>
<div id="table-container">${tableContent}</div>
</body></html>`;
}

async function renderRow(browser, row, rootDir) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.setContent(buildHtml(row.description), { waitUntil: "load" });
    const container = page.locator("#table-container");
    const box = await container.boundingBox();
    if (!box || box.width < 10 || box.height < 10) {
      return { ok: false, error: "table container too small or not rendered" };
    }

    const safeLabel = (row.figureLabel || "table")
      .replace(/[^a-zA-Z0-9]/g, "_")
      .toLowerCase();
    const filename = `table-preview-${safeLabel}.png`;
    const outDir = path.join(rootDir, "uploads", "figures", row.paperId);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, filename);

    const buffer = await container.screenshot({ type: "png" });
    fs.writeFileSync(outPath, buffer);

    return {
      ok: true,
      imagePath: `uploads/figures/${row.paperId}/${filename}`,
      assetHash: crypto.createHash("sha256").update(buffer).digest("hex"),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await page.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const dbPath = resolveDbPath(process.argv);
  const db = new Database(dbPath);
  const rootDir = process.cwd();
  const where = buildWhere(opts);
  const limitClause = opts.limit ? ` LIMIT ${opts.limit}` : "";

  const candidates = db.prepare(`
    SELECT id, paperId, figureLabel, description
    FROM PaperFigure
    WHERE ${where}
    ORDER BY paperId, figureIndex${limitClause}
  `).all();

  console.log(`${opts.dryRun ? "[DRY RUN] " : ""}Eligible rows: ${candidates.length}`);
  if (opts.dryRun) {
    for (const row of candidates.slice(0, 50)) {
      console.log(`${row.paperId}\t${row.figureLabel}`);
    }
    db.close();
    return;
  }

  const browser = await chromium.launch({ headless: true });
  let rendered = 0;
  let failed = 0;

  try {
    const update = db.prepare(`
      UPDATE PaperFigure
      SET imagePath = ?,
          assetHash = ?,
          width = ?,
          height = ?,
          imageSourceMethod = 'html_table_render',
          gapReason = NULL
      WHERE id = ?
    `);

    for (const row of candidates) {
      const result = await renderRow(browser, row, rootDir);
      if (result.ok) {
        try {
          update.run(
            result.imagePath,
            result.assetHash,
            result.width,
            result.height,
            row.id,
          );
        } catch (error) {
          if (String(error && error.message).includes("PaperFigure.paperId, PaperFigure.sourceMethod, PaperFigure.assetHash")) {
            // Rendered previews can be visually identical across multiple tables in
            // the same paper. Preserve the preview and clear the hash rather than
            // aborting the batch on a dedup-key collision.
            update.run(
              result.imagePath,
              null,
              result.width,
              result.height,
              row.id,
            );
          } else {
            throw error;
          }
        }
        rendered += 1;
        console.log(`rendered\t${row.paperId}\t${row.figureLabel}\t${result.width}x${result.height}`);
      } else {
        failed += 1;
        console.warn(`failed\t${row.paperId}\t${row.figureLabel}\t${result.error}`);
      }
    }
  } finally {
    await browser.close();
    db.close();
  }

  console.log("─".repeat(60));
  console.log(`Rendered: ${rendered}`);
  console.log(`Failed: ${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
