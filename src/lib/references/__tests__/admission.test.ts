import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, Semaphore } from "../grobid/admission";

describe("Semaphore", () => {
  it("allows up to maxConcurrency concurrent acquisitions", async () => {
    const semaphore = new Semaphore(2);
    const release1 = await semaphore.acquire();
    const release2 = await semaphore.acquire();
    expect(semaphore.pending).toBe(0);

    let thirdResolved = false;
    const thirdPromise = semaphore.acquire().then((release) => {
      thirdResolved = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(thirdResolved).toBe(false);
    expect(semaphore.pending).toBe(1);

    release1();
    const release3 = await thirdPromise;
    expect(thirdResolved).toBe(true);

    release2();
    release3();
  });

  it("rejects when queue exceeds maxQueueDepth", async () => {
    const semaphore = new Semaphore(1, 1);
    const release1 = await semaphore.acquire();

    const second = semaphore.acquire();
    await expect(semaphore.acquire()).rejects.toThrow("queue full");

    release1();
    const release2 = await second;
    release2();
  });
});

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts closed", () => {
    const breaker = new CircuitBreaker(3, 60_000, 30_000);
    expect(breaker.state).toBe("closed");
  });

  it("trips after threshold errors within window", () => {
    const breaker = new CircuitBreaker(3, 60_000, 30_000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(true);
  });

  it("resets error count on success", () => {
    const breaker = new CircuitBreaker(3, 60_000, 30_000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(false);
  });

  it("transitions to half-open after cooldown", () => {
    const breaker = new CircuitBreaker(3, 60_000, 30_000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    vi.advanceTimersByTime(30_001);
    expect(breaker.state).toBe("half-open");
  });

  it("closes on success during half-open", () => {
    const breaker = new CircuitBreaker(3, 60_000, 30_000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    vi.advanceTimersByTime(30_001);
    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");
  });

  it("re-opens on failure during half-open", () => {
    const breaker = new CircuitBreaker(3, 60_000, 30_000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    vi.advanceTimersByTime(30_001);
    breaker.recordFailure();
    expect(breaker.state).toBe("open");
  });

  it("evicts stale errors outside window", () => {
    const breaker = new CircuitBreaker(3, 60_000, 30_000);
    breaker.recordFailure();
    breaker.recordFailure();
    vi.advanceTimersByTime(61_000);
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(false);
  });
});
