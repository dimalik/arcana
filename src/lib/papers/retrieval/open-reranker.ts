import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { z } from "zod";

export type OpenRelatedRerankerBackendId =
  | "qwen3_reranker_v1"
  | "bge_reranker_v1";

export interface OpenRelatedRerankerRequest {
  query: string;
  documents: Array<{
    id: string;
    text: string;
  }>;
}

interface OpenRelatedRerankerConfig {
  backendId: OpenRelatedRerankerBackendId;
  modelId: string;
  modelType: "qwen3" | "sequence_classification";
  instruction: string;
  maxLength: number;
  batchSize: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  pythonBin: string;
  scriptPath: string;
  device?: string;
  trustRemoteCode?: boolean;
  fallbackBackendId?: OpenRelatedRerankerBackendId;
}

const openRelatedRerankerResponseSchema = z
  .object({
    requestId: z.string(),
    modelId: z.string(),
    resolvedDevice: z.string().nullable().optional(),
    scores: z.array(
      z.object({
        id: z.string(),
        score: z.number(),
      }),
    ),
  })
  .passthrough();

const openRelatedRerankerErrorSchema = z
  .object({
    requestId: z.string(),
    error: z.string(),
  })
  .passthrough();

const DEFAULT_RELATED_OPEN_RERANK_INSTRUCTION =
  "Given a seed research paper, retrieve library papers that genuinely overlap in technical problem, method lineage, evaluation setting, deployment constraints, or strong citation neighborhood. Reject papers that are only broadly adjacent.";

interface PendingRequest {
  resolve: (
    value: z.infer<typeof openRelatedRerankerResponseSchema>,
  ) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkerState {
  process: ChildProcessWithoutNullStreams;
  pending: Map<string, PendingRequest>;
  warmed: boolean;
}

const workerByBackend = new Map<OpenRelatedRerankerBackendId, WorkerState>();

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveOpenRelatedRerankerConfig(
  backendId: OpenRelatedRerankerBackendId,
): OpenRelatedRerankerConfig {
  const pythonBin =
    process.env.ARCANA_RELATED_OPEN_RERANKER_PYTHON_BIN?.trim() || "python3";
  const scriptPath =
    process.env.ARCANA_RELATED_OPEN_RERANKER_SCRIPT?.trim() ||
    path.join(
      process.cwd(),
      "training",
      "related_reranker",
      "score_open_reranker.py",
    );
  const globalDevice =
    process.env.ARCANA_RELATED_OPEN_RERANKER_DEVICE?.trim() || undefined;

  if (backendId === "qwen3_reranker_v1") {
    const allowCpu =
      process.env.ARCANA_RELATED_QWEN_RERANKER_ALLOW_CPU === "1";
    return {
      backendId,
      modelId:
        process.env.ARCANA_RELATED_QWEN_RERANKER_MODEL_ID?.trim() ||
        "Qwen/Qwen3-Reranker-0.6B",
      modelType: "qwen3",
      instruction:
        process.env.ARCANA_RELATED_QWEN_RERANKER_INSTRUCTION?.trim() ||
        DEFAULT_RELATED_OPEN_RERANK_INSTRUCTION,
      maxLength: parsePositiveInteger(
        process.env.ARCANA_RELATED_QWEN_RERANKER_MAX_LENGTH,
        1536,
      ),
      batchSize: parsePositiveInteger(
        process.env.ARCANA_RELATED_QWEN_RERANKER_BATCH_SIZE,
        2,
      ),
      startupTimeoutMs: parsePositiveInteger(
        process.env.ARCANA_RELATED_QWEN_RERANKER_STARTUP_TIMEOUT_MS,
        300_000,
      ),
      requestTimeoutMs: parsePositiveInteger(
        process.env.ARCANA_RELATED_QWEN_RERANKER_TIMEOUT_MS,
        45_000,
      ),
      pythonBin,
      scriptPath,
      device: globalDevice ?? (allowCpu ? undefined : "cuda"),
      fallbackBackendId: "bge_reranker_v1",
    };
  }

  return {
    backendId,
    modelId:
      process.env.ARCANA_RELATED_BGE_RERANKER_MODEL_ID?.trim() ||
      "BAAI/bge-reranker-v2-m3",
    modelType: "sequence_classification",
    instruction:
      process.env.ARCANA_RELATED_BGE_RERANKER_INSTRUCTION?.trim() ||
      DEFAULT_RELATED_OPEN_RERANK_INSTRUCTION,
    maxLength: parsePositiveInteger(
      process.env.ARCANA_RELATED_BGE_RERANKER_MAX_LENGTH,
      1024,
    ),
    batchSize: parsePositiveInteger(
      process.env.ARCANA_RELATED_BGE_RERANKER_BATCH_SIZE,
      8,
    ),
    startupTimeoutMs: parsePositiveInteger(
      process.env.ARCANA_RELATED_BGE_RERANKER_STARTUP_TIMEOUT_MS,
      180_000,
    ),
    requestTimeoutMs: parsePositiveInteger(
      process.env.ARCANA_RELATED_BGE_RERANKER_TIMEOUT_MS,
      30_000,
    ),
    pythonBin,
    scriptPath,
    device: globalDevice,
    trustRemoteCode:
      process.env.ARCANA_RELATED_BGE_RERANKER_TRUST_REMOTE_CODE === "1",
  };
}

function rejectPending(state: WorkerState, error: Error): void {
  for (const pending of Array.from(state.pending.values())) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.pending.clear();
}

function createWorker(
  config: OpenRelatedRerankerConfig,
): WorkerState {
  if (!fs.existsSync(config.scriptPath)) {
    throw new Error(`Open reranker script not found at ${config.scriptPath}`);
  }

  const child = spawn(config.pythonBin, [config.scriptPath, "--server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const state: WorkerState = {
    process: child,
    pending: new Map(),
    warmed: false,
  };

  const stdoutRl = readline.createInterface({ input: child.stdout });
  stdoutRl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const payload = JSON.parse(trimmed);
      if (payload.error) {
        const parsedError = openRelatedRerankerErrorSchema.parse(payload);
        const pending = state.pending.get(parsedError.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        state.pending.delete(parsedError.requestId);
        pending.reject(new Error(parsedError.error));
        return;
      }

      const parsed = openRelatedRerankerResponseSchema.parse(payload);
      const pending = state.pending.get(parsed.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      state.pending.delete(parsed.requestId);
      state.warmed = true;
      pending.resolve(parsed);
    } catch (error) {
      rejectPending(
        state,
        new Error(
          `Unable to parse open reranker worker response: ${error instanceof Error ? error.message : "unknown parse error"}`,
        ),
      );
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const text = chunk.trim();
    if (text) {
      console.warn(`[open-reranker:${config.backendId}] ${text}`);
    }
  });

  child.on("error", (error) => {
    rejectPending(
      state,
      new Error(
        `Open reranker worker error (${config.backendId}): ${error.message}`,
      ),
    );
    workerByBackend.delete(config.backendId);
  });

  child.on("close", (code, signal) => {
    rejectPending(
      state,
      new Error(
        `Open reranker worker exited (${config.backendId}) with code ${code ?? "null"} signal ${signal ?? "null"}`,
      ),
    );
    workerByBackend.delete(config.backendId);
  });

  return state;
}

function getWorker(config: OpenRelatedRerankerConfig): WorkerState {
  const existing = workerByBackend.get(config.backendId);
  if (existing && !existing.process.killed) {
    return existing;
  }

  const created = createWorker(config);
  workerByBackend.set(config.backendId, created);
  return created;
}

async function runJsonCommand(
  config: OpenRelatedRerankerConfig,
  request: OpenRelatedRerankerRequest,
): Promise<z.infer<typeof openRelatedRerankerResponseSchema>> {
  const worker = getWorker(config);
  const requestId = `${config.backendId}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  return new Promise((resolve, reject) => {
    const timeoutMs = worker.warmed
      ? config.requestTimeoutMs
      : config.startupTimeoutMs;
    const timer = setTimeout(() => {
      worker.pending.delete(requestId);
      if (!worker.warmed) {
        worker.process.kill("SIGKILL");
        workerByBackend.delete(config.backendId);
      }
      reject(
        new Error(
          `Open reranker timed out after ${timeoutMs}ms (${config.backendId})`,
        ),
      );
    }, timeoutMs);

    worker.pending.set(requestId, {
      resolve,
      reject,
      timer,
    });

    const payload = {
      requestId,
      modelId: config.modelId,
      modelType: config.modelType,
      instruction: config.instruction,
      maxLength: config.maxLength,
      batchSize: config.batchSize,
      device: config.device ?? null,
      trustRemoteCode: config.trustRemoteCode ?? false,
      query: request.query,
      documents: request.documents,
    };

    worker.process.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

export async function runOpenRelatedReranker(
  backendId: OpenRelatedRerankerBackendId,
  request: OpenRelatedRerankerRequest,
): Promise<Map<string, number>> {
  if (request.documents.length === 0) {
    return new Map();
  }

  const config = resolveOpenRelatedRerankerConfig(backendId);
  try {
    const response = await runJsonCommand(config, request);
    return new Map(
      response.scores.map((score) => [
        score.id,
        Number(Math.max(0, Math.min(score.score, 1)).toFixed(6)),
      ]),
    );
  } catch (error) {
    if (config.fallbackBackendId && config.fallbackBackendId !== backendId) {
      console.warn(
        `[open-reranker:${backendId}] Falling back to ${config.fallbackBackendId}:`,
        error,
      );
      return runOpenRelatedReranker(config.fallbackBackendId, request);
    }
    throw error;
  }
}
