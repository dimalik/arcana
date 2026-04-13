#!/usr/bin/env node
/**
 * Dump the full agent trace for a project as JSONL to stdout.
 *
 * Usage:
 *   npm run trace <project-id>
 *   npm run trace <project-id> --pretty     # human-readable
 *   npm run trace <project-id> --reasoning   # only reasoning (no tool calls)
 *   npm run trace <project-id> --tools       # only tool calls (no reasoning)
 *   npm run trace <project-id> --last 20     # last N entries
 */
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "prisma", "dev.db");

const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith("--"));
const pretty = args.includes("--pretty");
const reasoningOnly = args.includes("--reasoning");
const toolsOnly = args.includes("--tools");
const lastIdx = args.indexOf("--last");
const lastN = lastIdx >= 0 ? parseInt(args[lastIdx + 1], 10) : null;

if (!projectId) {
  console.error("Usage: npm run trace <project-id> [--pretty] [--reasoning] [--tools] [--last N]");
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

// Resolve partial IDs
const matchedProject = db.prepare(
  "SELECT id, title FROM ResearchProject WHERE id LIKE ? || '%' LIMIT 2"
).all(projectId);

if (matchedProject.length === 0) {
  console.error(`No project found matching "${projectId}"`);
  process.exit(1);
}
if (matchedProject.length > 1) {
  console.error(`Ambiguous project ID "${projectId}". Matches:`);
  matchedProject.forEach((p) => console.error(`  ${p.id}  ${p.title}`));
  process.exit(1);
}

const project = matchedProject[0];
if (!pretty) {
  process.stderr.write(`Project: ${project.title}\n`);
}

// Build query
const types = [];
if (reasoningOnly) types.push("'agent_reasoning'");
else if (toolsOnly) types.push("'agent_tool_call'");
else types.push("'agent_reasoning'", "'agent_tool_call'", "'agent_suggestion'");

let sql = `
  SELECT type, content, metadata, createdAt
  FROM ResearchLogEntry
  WHERE projectId = ? AND type IN (${types.join(",")})
  ORDER BY createdAt ASC
`;

const rows = db.prepare(sql).all(project.id);

const output = lastN ? rows.slice(-lastN) : rows;

if (pretty) {
  console.log(`\n=== Agent Trace: ${project.title} ===`);
  console.log(`=== ${output.length} entries ===\n`);

  for (const row of output) {
    const ts = new Date(Number(row.createdAt)).toISOString().slice(0, 19).replace("T", " ");
    const meta = row.metadata ? JSON.parse(row.metadata) : {};
    const step = meta.step != null ? `[step ${meta.step}]` : "";

    if (row.type === "agent_reasoning") {
      console.log(`--- ${ts} ${step} REASONING ---`);
      console.log(row.content);
      console.log();
    } else if (row.type === "agent_tool_call") {
      const tool = meta.tool || "?";
      // Extract the JSON part after [toolName]
      const jsonStart = row.content.indexOf("]") + 2;
      const inputStr = row.content.slice(jsonStart);
      let formatted;
      try {
        formatted = JSON.stringify(JSON.parse(inputStr), null, 2);
      } catch {
        formatted = inputStr;
      }
      console.log(`--- ${ts} ${step} TOOL: ${tool} ---`);
      console.log(formatted);
      console.log();
    } else {
      // agent_suggestion (legacy)
      console.log(`--- ${ts} ${step} (legacy) ---`);
      console.log(row.content);
      console.log();
    }
  }
} else {
  // JSONL output
  for (const row of output) {
    const meta = row.metadata ? JSON.parse(row.metadata) : {};
    const entry = {
      type: row.type,
      step: meta.step ?? null,
      tool: meta.tool ?? null,
      timestamp: new Date(Number(row.createdAt)).toISOString(),
      content: row.content,
    };
    console.log(JSON.stringify(entry));
  }
}

db.close();
