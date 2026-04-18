import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  ensureInitialized: vi.fn(),
  readPersistedProcessingStatus: vi.fn(),
}));

vi.mock("@/lib/processing/queue", () => ({
  processingQueue: {
    ensureInitialized: hoisted.ensureInitialized,
  },
}));

vi.mock("@/lib/processing/runtime-ledger", () => ({
  readPersistedProcessingStatus: hoisted.readPersistedProcessingStatus,
}));

import { GET } from "./route";

describe("GET /api/processing/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads persisted runtime truth after queue initialization", async () => {
    hoisted.ensureInitialized.mockResolvedValue(undefined);
    hoisted.readPersistedProcessingStatus.mockResolvedValue({
      source: "persisted",
      processing: null,
      queue: [],
      queueLength: 0,
      activeCount: 0,
      batchPending: 0,
      activeRuns: [],
      activeBatches: [],
    });

    const response = await GET();
    const body = await response.json();

    expect(hoisted.ensureInitialized).toHaveBeenCalledTimes(1);
    expect(hoisted.readPersistedProcessingStatus).toHaveBeenCalledTimes(1);
    expect(body).toEqual({
      source: "persisted",
      processing: null,
      queue: [],
      queueLength: 0,
      activeCount: 0,
      batchPending: 0,
      activeRuns: [],
      activeBatches: [],
    });
  });
});
