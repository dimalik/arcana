export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueueDepth: number = Number.POSITIVE_INFINITY,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    if (this.queue.length >= this.maxQueueDepth) {
      return Promise.reject(new Error(`queue full (${this.queue.length} pending)`));
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(this.createRelease());
      });
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

export class CircuitBreaker {
  private failures: number[] = [];
  private openedAt: number | null = null;
  private halfOpen = false;

  constructor(
    private readonly threshold: number,
    private readonly windowMs: number,
    private readonly cooldownMs: number,
  ) {}

  get state(): "closed" | "open" | "half-open" {
    if (this.openedAt !== null) {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.halfOpen = true;
        return "half-open";
      }
      return "open";
    }

    return "closed";
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  recordFailure(): void {
    const now = Date.now();

    if (this.state === "half-open") {
      this.failures = [now];
      this.halfOpen = false;
      this.openedAt = now;
      return;
    }

    if (this.openedAt !== null) return;

    this.failures.push(now);
    this.failures = this.failures.filter((timestamp) => timestamp > now - this.windowMs);
    if (this.failures.length >= this.threshold) {
      this.openedAt = now;
    }
  }

  recordSuccess(): void {
    if (this.state !== "closed") {
      this.halfOpen = false;
      this.openedAt = null;
    }
    this.failures = [];
  }
}
