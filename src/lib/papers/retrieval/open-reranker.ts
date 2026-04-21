import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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
  timeoutMs: number;
  pythonBin: string;
  scriptPath: string;
  device?: string;
  trustRemoteCode?: boolean;
}

const openRelatedRerankerResponseSchema = z
  .object({
    modelId: z.string(),
    scores: z.array(
      z.object({
        id: z.string(),
        score: z.number(),
      }),
    ),
  })
  .passthrough();

const DEFAULT_RELATED_OPEN_RERANK_INSTRUCTION =
  "Given a seed research paper, retrieve library papers that genuinely overlap in technical problem, method lineage, evaluation setting, deployment constraints, or strong citation neighborhood. Reject papers that are only broadly adjacent.";

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
  const device = process.env.ARCANA_RELATED_OPEN_RERANKER_DEVICE?.trim();
  const timeoutMs = parsePositiveInteger(
    process.env.ARCANA_RELATED_OPEN_RERANKER_TIMEOUT_MS,
    90_000,
  );
  const batchSize = parsePositiveInteger(
    process.env.ARCANA_RELATED_OPEN_RERANKER_BATCH_SIZE,
    8,
  );

  if (backendId === "qwen3_reranker_v1") {
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
        3072,
      ),
      batchSize,
      timeoutMs,
      pythonBin,
      scriptPath,
      device,
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
    batchSize,
    timeoutMs,
    pythonBin,
    scriptPath,
    device,
    trustRemoteCode:
      process.env.ARCANA_RELATED_BGE_RERANKER_TRUST_REMOTE_CODE === "1",
  };
}

async function runJsonCommand(
  config: OpenRelatedRerankerConfig,
  request: OpenRelatedRerankerRequest,
): Promise<z.infer<typeof openRelatedRerankerResponseSchema>> {
  if (!fs.existsSync(config.scriptPath)) {
    throw new Error(
      `Open reranker script not found at ${config.scriptPath}`,
    );
  }

  const payload = {
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

  return new Promise((resolve, reject) => {
    const child = spawn(
      config.pythonBin,
      [config.scriptPath, "--stdin"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Open reranker timed out after ${config.timeoutMs}ms (${config.backendId})`,
        ),
      );
    }, config.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            `Open reranker failed with exit code ${code}: ${stderr.trim() || stdout.trim() || "unknown error"}`,
          ),
        );
        return;
      }

      try {
        resolve(
          openRelatedRerankerResponseSchema.parse(JSON.parse(stdout.trim())),
        );
      } catch (error) {
        reject(
          new Error(
            `Unable to parse open reranker response: ${error instanceof Error ? error.message : "unknown parse error"}`,
          ),
        );
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
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
  const response = await runJsonCommand(config, request);

  return new Map(
    response.scores.map((score) => [
      score.id,
      Number(Math.max(0, Math.min(score.score, 1)).toFixed(6)),
    ]),
  );
}
