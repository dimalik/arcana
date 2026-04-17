import { DEFAULT_GROBID_CONFIG, type GrobidConfig } from "./types";

export function loadGrobidConfig(): GrobidConfig {
  const env = process.env;
  return {
    serverUrl: env.GROBID_SERVER_URL ?? DEFAULT_GROBID_CONFIG.serverUrl,
    interactiveConcurrency: intEnv(
      env.GROBID_INTERACTIVE_CONCURRENCY,
      DEFAULT_GROBID_CONFIG.interactiveConcurrency,
    ),
    backfillConcurrency: intEnv(
      env.GROBID_BACKFILL_CONCURRENCY,
      DEFAULT_GROBID_CONFIG.backfillConcurrency,
    ),
    maxQueueDepth: intEnv(
      env.GROBID_MAX_QUEUE_DEPTH,
      DEFAULT_GROBID_CONFIG.maxQueueDepth,
    ),
    baseDeadlineMs: intEnv(
      env.GROBID_BASE_DEADLINE_MS,
      DEFAULT_GROBID_CONFIG.baseDeadlineMs,
    ),
    perPageDeadlineMs: intEnv(
      env.GROBID_PER_PAGE_DEADLINE_MS,
      DEFAULT_GROBID_CONFIG.perPageDeadlineMs,
    ),
    circuitBreakerThreshold: intEnv(
      env.GROBID_CB_THRESHOLD,
      DEFAULT_GROBID_CONFIG.circuitBreakerThreshold,
    ),
    circuitBreakerWindowMs: intEnv(
      env.GROBID_CB_WINDOW_MS,
      DEFAULT_GROBID_CONFIG.circuitBreakerWindowMs,
    ),
    circuitBreakerCooldownMs: intEnv(
      env.GROBID_CB_COOLDOWN_MS,
      DEFAULT_GROBID_CONFIG.circuitBreakerCooldownMs,
    ),
    maxRetries: intEnv(
      env.GROBID_MAX_RETRIES,
      DEFAULT_GROBID_CONFIG.maxRetries,
    ),
  };
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
