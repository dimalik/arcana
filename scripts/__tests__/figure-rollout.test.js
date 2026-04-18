import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

const {
  buildRunResult,
  loadCompletedIds,
  normalizeExtractionStatus,
  parseArgs,
} = require("../figure-rollout.js");

describe("figure-rollout consumer contract", () => {
  const tempPaths = [];

  afterEach(() => {
    while (tempPaths.length > 0) {
      const target = tempPaths.pop();
      if (target && fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
    }
  });

  it("accepts --db without rejecting the rollout invocation", () => {
    expect(
      parseArgs([
        "node",
        "scripts/figure-rollout.js",
        "--all",
        "--db",
        "/tmp/custom.db",
      ]),
    ).toMatchObject({
      bucket: "all",
      dbPath: "/tmp/custom.db",
    });
  });

  it("prefers explicit extraction status from the hardened route contract", () => {
    expect(normalizeExtractionStatus({ status: "partial", ok: true }, 207)).toBe("partial");
    expect(normalizeExtractionStatus({ status: "conflict", ok: false }, 409)).toBe("conflict");
  });

  it("falls back to legacy ok-only payloads for older logs or servers", () => {
    expect(normalizeExtractionStatus({ ok: true }, 200)).toBe("success");
    expect(normalizeExtractionStatus({ ok: false }, 500)).toBe("failed");
  });

  it("uses hardened HTTP semantics when the status field is stripped in transit", () => {
    expect(normalizeExtractionStatus({ ok: false, persistErrors: 3 }, 207)).toBe("partial");
    expect(normalizeExtractionStatus({ ok: false, error: "leased" }, 409)).toBe("conflict");
  });

  it("records request errors separately from route-declared extraction conflicts", () => {
    const result = buildRunResult({
      paper: { id: "paper-1", title: "Paper", arxivId: null, doi: null },
      startedAt: "2026-04-18T01:00:00.000Z",
      started: Date.now(),
      httpStatus: null,
      payload: null,
      error: "socket hang up",
    });

    expect(result.extractionStatus).toBe("request_error");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("socket hang up");
  });

  it("resumes only successful papers from both new and legacy log formats", () => {
    const logPath = path.join(os.tmpdir(), `figure-rollout-${Date.now()}-${Math.random()}.jsonl`);
    tempPaths.push(logPath);
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({ paperId: "paper-success-new", extractionStatus: "success", ok: true }),
        JSON.stringify({ paperId: "paper-success-legacy", ok: true }),
        JSON.stringify({ paperId: "paper-partial", extractionStatus: "partial", ok: false }),
        JSON.stringify({ paperId: "paper-conflict", extractionStatus: "conflict", ok: false }),
      ].join("\n"),
    );

    expect([...loadCompletedIds(logPath)].sort()).toEqual([
      "paper-success-legacy",
      "paper-success-new",
    ]);
  });
});
