export interface GrobidConfig {
  serverUrl: string;
  interactiveConcurrency: number;
  backfillConcurrency: number;
  maxQueueDepth: number;
  baseDeadlineMs: number;
  perPageDeadlineMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerWindowMs: number;
  circuitBreakerCooldownMs: number;
  maxRetries: number;
}

export const DEFAULT_GROBID_CONFIG: GrobidConfig = {
  serverUrl: "http://localhost:8070",
  interactiveConcurrency: 1,
  backfillConcurrency: 2,
  maxQueueDepth: 50,
  baseDeadlineMs: 30_000,
  perPageDeadlineMs: 2_000,
  circuitBreakerThreshold: 5,
  circuitBreakerWindowMs: 60_000,
  circuitBreakerCooldownMs: 30_000,
  maxRetries: 2,
};

export type GrobidRequestPriority = "interactive" | "backfill";
export type GrobidHealthStatus = "healthy" | "unhealthy" | "unknown";

export interface GrobidProcessReferencesRequest {
  pdfBuffer: Buffer;
  priority: GrobidRequestPriority;
  pageCount?: number;
  includeRawCitations?: boolean;
  consolidateCitations?: boolean;
}

export interface GrobidProcessReferencesResponse {
  teiXml: string;
  statusCode: number;
  durationMs: number;
}

export interface GrobidProcessFulltextRequest
  extends GrobidProcessReferencesRequest {}

export interface GrobidProcessFulltextResponse
  extends GrobidProcessReferencesResponse {}

export class GrobidUnavailableError extends Error {
  constructor(reason: string) {
    super(`GROBID unavailable: ${reason}`);
    this.name = "GrobidUnavailableError";
  }
}

export class GrobidTimeoutError extends Error {
  constructor(deadlineMs: number) {
    super(`GROBID request exceeded deadline of ${deadlineMs}ms`);
    this.name = "GrobidTimeoutError";
  }
}

export class GrobidQueueFullError extends Error {
  constructor(queueDepth: number) {
    super(`GROBID request queue full (${queueDepth} pending)`);
    this.name = "GrobidQueueFullError";
  }
}
