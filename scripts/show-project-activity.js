#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require("better-sqlite3");
const {
  parseArg,
  firstPositionalArg,
  resolveDbPath,
} = require("./research-test-utils");

function usage() {
  console.error("Usage: node scripts/show-project-activity.js <project-id> [--db path] [--json]");
}

function formatTimestamp(value) {
  if (value == null) return null;
  if (typeof value === "number") return new Date(value).toLocaleString();
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && `${asNumber}` === `${value}`) {
    return new Date(asNumber).toLocaleString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function compactText(value, max = 220) {
  if (!value) return null;
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function pushTimeline(timeline, source, timestamp, title, detail, extra = {}) {
  timeline.push({
    source,
    timestamp,
    title,
    detail: compactText(detail, 400),
    ...extra,
  });
}

function main() {
  const projectId = parseArg(process.argv, "--project") || firstPositionalArg(process.argv, ["--db", "--project"]);
  if (!projectId) {
    usage();
    process.exit(2);
  }

  const jsonMode = process.argv.includes("--json");
  const dbPath = resolveDbPath(process.argv);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");

  const project = db.prepare(`
    SELECT
      id,
      title,
      status,
      currentPhase,
      methodology,
      brief,
      createdAt,
      updatedAt,
      collectionId
    FROM ResearchProject
    WHERE id = ?
  `).get(projectId);

  if (!project) {
    console.error(`Project not found: ${projectId}`);
    process.exit(1);
  }

  const stats = {
    papers: db.prepare(`
      SELECT COUNT(*) AS count
      FROM CollectionPaper
      WHERE collectionId = ?
    `).get(project.collectionId).count,
    hypotheses: db.prepare(`SELECT COUNT(*) AS count FROM ResearchHypothesis WHERE projectId = ?`).get(projectId).count,
    claims: db.prepare(`SELECT COUNT(*) AS count FROM ResearchClaim WHERE projectId = ? AND status != 'RETRACTED'`).get(projectId).count,
    tasks: db.prepare(`SELECT COUNT(*) AS count FROM AgentTask WHERE projectId = ?`).get(projectId).count,
    remoteJobs: db.prepare(`SELECT COUNT(*) AS count FROM RemoteJob WHERE projectId = ?`).get(projectId).count,
    results: db.prepare(`SELECT COUNT(*) AS count FROM ExperimentResult WHERE projectId = ?`).get(projectId).count,
    steps: db.prepare(`
      SELECT COUNT(*) AS count
      FROM ResearchStep rs
      JOIN ResearchIteration ri ON ri.id = rs.iterationId
      WHERE ri.projectId = ?
    `).get(projectId).count,
    traceEvents: db.prepare(`SELECT COUNT(*) AS count FROM AgentTraceEvent WHERE projectId = ?`).get(projectId).count,
  };

  const papers = db.prepare(`
    SELECT p.title, p.year, p.createdAt
    FROM Paper p
    JOIN CollectionPaper cp ON cp.paperId = p.id
    WHERE cp.collectionId = ?
    ORDER BY p.createdAt ASC, p.title ASC
  `).all(project.collectionId);

  const hypotheses = db.prepare(`
    SELECT status, statement, rationale, createdAt, updatedAt
    FROM ResearchHypothesis
    WHERE projectId = ?
    ORDER BY createdAt ASC
  `).all(projectId);

  const claims = db.prepare(`
    SELECT status, type, statement, summary, confidence, createdFrom, createdAt
    FROM ResearchClaim
    WHERE projectId = ? AND status != 'RETRACTED'
    ORDER BY createdAt ASC
  `).all(projectId);

  const tasks = db.prepare(`
    SELECT id, role, goal, status, error, output, createdAt, completedAt
    FROM AgentTask
    WHERE projectId = ?
    ORDER BY createdAt ASC
  `).all(projectId);

  const jobs = db.prepare(`
    SELECT id, status, command, exitCode, stdout, stderr, createdAt, completedAt
    FROM RemoteJob
    WHERE projectId = ?
    ORDER BY createdAt ASC
  `).all(projectId);

  const steps = db.prepare(`
    SELECT
      ri.number AS iterationNumber,
      rs.type,
      rs.status,
      rs.title,
      rs.output,
      rs.createdAt,
      rs.completedAt,
      rs.sortOrder
    FROM ResearchStep rs
    JOIN ResearchIteration ri ON ri.id = rs.iterationId
    WHERE ri.projectId = ?
    ORDER BY ri.number ASC, rs.sortOrder ASC, rs.createdAt ASC
  `).all(projectId);

  const logs = db.prepare(`
    SELECT type, content, metadata, createdAt
    FROM ResearchLogEntry
    WHERE projectId = ?
    ORDER BY createdAt ASC
  `).all(projectId);

  const traceEvents = db.prepare(`
    SELECT runId, sessionNumber, sequence, eventType, toolName, content, createdAt
    FROM AgentTraceEvent
    WHERE projectId = ?
    ORDER BY createdAt ASC, sequence ASC
  `).all(projectId);

  const timeline = [];
  for (const event of traceEvents) {
    const label = event.toolName ? `${event.eventType}:${event.toolName}` : event.eventType;
    pushTimeline(timeline, "trace", event.createdAt, label, event.content, {
      runId: event.runId,
      sessionNumber: event.sessionNumber,
      sequence: event.sequence,
    });
  }

  if (traceEvents.length === 0) {
    for (const step of steps) {
      pushTimeline(
        timeline,
        "step",
        step.completedAt || step.createdAt,
        `${step.status} ${step.type}`,
        step.title,
        { iterationNumber: step.iterationNumber, sortOrder: step.sortOrder },
      );
    }
    for (const log of logs) {
      pushTimeline(timeline, "log", log.createdAt, log.type, log.content);
    }
    for (const task of tasks) {
      pushTimeline(timeline, "task", task.createdAt, `${task.role}:${task.status}`, task.goal, {
        taskId: task.id,
      });
    }
    for (const job of jobs) {
      pushTimeline(timeline, "job", job.createdAt, `remote_job:${job.status}`, job.command, {
        jobId: job.id,
      });
    }
    timeline.sort((a, b) => {
      const aTs = typeof a.timestamp === "number" ? a.timestamp : Number(a.timestamp);
      const bTs = typeof b.timestamp === "number" ? b.timestamp : Number(b.timestamp);
      return aTs - bTs;
    });
  }

  const result = {
    project: {
      id: project.id,
      title: project.title,
      status: project.status,
      currentPhase: project.currentPhase,
      methodology: project.methodology,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    stats,
    papers: papers.map((paper) => ({
      title: paper.title,
      year: paper.year,
      createdAt: paper.createdAt,
    })),
    hypotheses: hypotheses.map((hypothesis) => ({
      status: hypothesis.status,
      statement: hypothesis.statement,
      rationale: hypothesis.rationale,
      createdAt: hypothesis.createdAt,
      updatedAt: hypothesis.updatedAt,
    })),
    claims: claims.map((claim) => ({
      status: claim.status,
      type: claim.type,
      statement: claim.statement,
      summary: claim.summary,
      confidence: claim.confidence,
      createdFrom: claim.createdFrom,
      createdAt: claim.createdAt,
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      role: task.role,
      goal: task.goal,
      status: task.status,
      error: task.error,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      outputPreview: compactText(task.output, 300),
    })),
    jobs: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      command: job.command,
      exitCode: job.exitCode,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      stdoutPreview: compactText(job.stdout, 220),
      stderrPreview: compactText(job.stderr, 220),
    })),
    steps: steps.map((step) => ({
      iterationNumber: step.iterationNumber,
      type: step.type,
      status: step.status,
      title: step.title,
      createdAt: step.createdAt,
      completedAt: step.completedAt,
      sortOrder: step.sortOrder,
      outputPreview: compactText(step.output, 280),
    })),
    logs: logs.map((log) => ({
      type: log.type,
      createdAt: log.createdAt,
      content: log.content,
      metadata: log.metadata,
    })),
    timeline,
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`# Project Activity`);
  console.log(`Project: ${project.title}`);
  console.log(`ID: ${project.id}`);
  console.log(`Status: ${project.status}`);
  console.log(`Phase: ${project.currentPhase}`);
  if (project.methodology) console.log(`Methodology: ${project.methodology}`);
  console.log(`Created: ${formatTimestamp(project.createdAt)}`);
  console.log(`Updated: ${formatTimestamp(project.updatedAt)}`);
  console.log("");

  console.log(`## Stats`);
  console.log(`- Papers: ${stats.papers}`);
  console.log(`- Hypotheses: ${stats.hypotheses}`);
  console.log(`- Claims: ${stats.claims}`);
  console.log(`- Sub-agent tasks: ${stats.tasks}`);
  console.log(`- Remote jobs: ${stats.remoteJobs}`);
  console.log(`- Experiment results: ${stats.results}`);
  console.log(`- Research steps: ${stats.steps}`);
  console.log(`- Trace events: ${stats.traceEvents}`);
  console.log("");

  console.log(`## Timeline`);
  if (timeline.length === 0) {
    console.log(`- No persisted trace or activity records.`);
  } else {
    for (const item of timeline) {
      const detail = item.detail ? `: ${item.detail}` : "";
      console.log(`- [${formatTimestamp(item.timestamp)}] ${item.title}${detail}`);
    }
  }
  console.log("");

  console.log(`## Hypotheses`);
  if (hypotheses.length === 0) {
    console.log(`- None`);
  } else {
    for (const hypothesis of hypotheses) {
      console.log(`- [${hypothesis.status}] ${compactText(hypothesis.statement, 240)}`);
    }
  }
  console.log("");

  console.log(`## Claims`);
  if (claims.length === 0) {
    console.log(`- None`);
  } else {
    for (const claim of claims) {
      console.log(`- [${claim.status}/${claim.type}] ${compactText(claim.statement, 240)}`);
    }
  }
  console.log("");

  console.log(`## Sub-Agent Tasks`);
  if (tasks.length === 0) {
    console.log(`- None`);
  } else {
    for (const task of tasks) {
      const error = task.error ? ` error=${compactText(task.error, 120)}` : "";
      console.log(`- [${task.status}] ${task.role} ${compactText(task.goal, 180)}${error}`);
    }
  }
  console.log("");

  console.log(`## Remote Jobs`);
  if (jobs.length === 0) {
    console.log(`- None`);
  } else {
    for (const job of jobs) {
      console.log(`- [${job.status}] ${compactText(job.command, 220)}${job.exitCode != null ? ` exit=${job.exitCode}` : ""}`);
    }
  }
  console.log("");

  console.log(`## Imported Papers`);
  if (papers.length === 0) {
    console.log(`- None`);
  } else {
    for (const paper of papers) {
      console.log(`- ${paper.title}${paper.year ? ` (${paper.year})` : ""}`);
    }
  }
}

main();
