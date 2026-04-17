import { loadGrobidConfig } from "./config";
import { CircuitBreaker, Semaphore } from "./admission";
import {
  DEFAULT_GROBID_CONFIG,
  type GrobidProcessFulltextRequest,
  type GrobidProcessFulltextResponse,
  GrobidQueueFullError,
  GrobidTimeoutError,
  GrobidUnavailableError,
  type GrobidConfig,
  type GrobidProcessReferencesRequest,
  type GrobidProcessReferencesResponse,
} from "./types";

const RETRY_BASE_DELAY_MS = 50;

export class GrobidClient {
  private readonly config: GrobidConfig;
  private readonly interactiveSem: Semaphore;
  private readonly backfillSem: Semaphore;
  private readonly breaker: CircuitBreaker;

  constructor(configOverrides: Partial<GrobidConfig> = {}) {
    this.config = {
      ...DEFAULT_GROBID_CONFIG,
      ...loadGrobidConfig(),
      ...configOverrides,
    };
    this.interactiveSem = new Semaphore(
      this.config.interactiveConcurrency,
      this.config.maxQueueDepth,
    );
    this.backfillSem = new Semaphore(
      this.config.backfillConcurrency,
      this.config.maxQueueDepth,
    );
    this.breaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerWindowMs,
      this.config.circuitBreakerCooldownMs,
    );
  }

  async processReferences(
    request: GrobidProcessReferencesRequest,
  ): Promise<GrobidProcessReferencesResponse> {
    return this.executeQueuedRequest("/api/processReferences", request);
  }

  async processFulltextDocument(
    request: GrobidProcessFulltextRequest,
  ): Promise<GrobidProcessFulltextResponse> {
    return this.executeQueuedRequest("/api/processFulltextDocument", request);
  }

  private async executeQueuedRequest(
    endpoint: string,
    request: GrobidProcessReferencesRequest,
  ): Promise<GrobidProcessReferencesResponse> {
    if (this.breaker.isOpen) {
      throw new GrobidUnavailableError("circuit breaker is open");
    }

    const semaphore =
      request.priority === "interactive" ? this.interactiveSem : this.backfillSem;

    let release: (() => void) | null = null;
    try {
      release = await semaphore.acquire();
    } catch (error) {
      if (error instanceof Error && error.message.includes("queue full")) {
        throw new GrobidQueueFullError(semaphore.pending);
      }
      throw error;
    }

    try {
      return await this.executeWithRetry(endpoint, request);
    } finally {
      release();
    }
  }

  private async executeWithRetry(
    endpoint: string,
    request: GrobidProcessReferencesRequest,
  ): Promise<GrobidProcessReferencesResponse> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        const response = await this.doRequest(endpoint, request);
        this.breaker.recordSuccess();
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryable(lastError)) {
          throw lastError;
        }

        this.breaker.recordFailure();
        if (this.breaker.isOpen) {
          throw new GrobidUnavailableError("circuit breaker tripped during retries");
        }

        if (attempt < this.config.maxRetries) {
          await sleep(this.retryDelayMs(attempt));
        }
      }
    }

    throw lastError ?? new Error("GROBID request failed");
  }

  private async doRequest(
    endpoint: string,
    request: GrobidProcessReferencesRequest,
  ): Promise<GrobidProcessReferencesResponse> {
    const url = `${this.config.serverUrl}${endpoint}`;
    const form = new FormData();
    form.append(
      "input",
      new Blob([new Uint8Array(request.pdfBuffer)]),
      "input.pdf",
    );
    form.append(
      "includeRawCitations",
      request.includeRawCitations !== false ? "1" : "0",
    );
    form.append(
      "consolidateCitations",
      request.consolidateCitations ? "1" : "0",
    );

    const deadlineMs =
      this.config.baseDeadlineMs +
      (request.pageCount ?? 0) * this.config.perPageDeadlineMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const teiXml = await response.text();
      const durationMs = Date.now() - startedAt;

      if (!response.ok) {
        const error = new Error(
          `GROBID returned ${response.status}: ${teiXml.slice(0, 200)}`,
        );
        (
          error as Error & {
            statusCode?: number;
          }
        ).statusCode = response.status;
        throw error;
      }

      return {
        teiXml,
        statusCode: response.status,
        durationMs,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw new GrobidTimeoutError(deadlineMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private isRetryable(error: Error): boolean {
    const statusCode = (
      error as Error & {
        statusCode?: number;
      }
    ).statusCode;

    if (statusCode === undefined) return true;
    return !(statusCode >= 400 && statusCode < 500);
  }

  private retryDelayMs(attempt: number): number {
    return RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
