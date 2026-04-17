import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCachedResult,
  setCachedResult,
  withCachedLookup,
  type CacheLookup,
} from "../resolver-cache";

vi.mock("../../prisma", () => ({
  prisma: {
    resolverCacheEntry: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

import { prisma } from "../../prisma";

const mockFindUnique = vi.mocked(prisma.resolverCacheEntry.findUnique);
const mockUpsert = vi.mocked(prisma.resolverCacheEntry.upsert);

describe("resolver cache", () => {
  const lookup: CacheLookup = {
    lookupKey: "10.1234/test",
    lookupType: "doi",
    provider: "crossref",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getCachedResult", () => {
    it("returns null on cache miss", async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      expect(await getCachedResult(lookup)).toBeNull();
    });

    it("returns null for expired entries", async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: "1",
        lookupKey: lookup.lookupKey,
        lookupType: lookup.lookupType,
        provider: lookup.provider,
        responsePayload: "{}",
        resolvedEntityId: null,
        httpStatus: 200,
        cachedAt: new Date("2025-01-01"),
        expiresAt: new Date("2025-01-02"),
      } as never);

      expect(await getCachedResult(lookup)).toBeNull();
    });

    it("returns valid non-expired hit", async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: "1",
        lookupKey: lookup.lookupKey,
        lookupType: lookup.lookupType,
        provider: lookup.provider,
        responsePayload: '{"title":"Test"}',
        resolvedEntityId: "entity-1",
        httpStatus: 200,
        cachedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      } as never);

      const result = await getCachedResult(lookup);
      expect(result).not.toBeNull();
      expect(result?.httpStatus).toBe(200);
    });
  });

  describe("setCachedResult", () => {
    it("upserts a cache entry", async () => {
      mockUpsert.mockResolvedValueOnce({} as never);

      await setCachedResult(lookup, {
        responsePayload: '{"title":"Test"}',
        resolvedEntityId: "e1",
        httpStatus: 200,
        ttlMs: 86_400_000,
      });

      expect(mockUpsert).toHaveBeenCalledTimes(1);
      const [call] = mockUpsert.mock.calls;
      expect(call?.[0].where).toEqual({
        lookupKey_lookupType_provider: {
          lookupKey: lookup.lookupKey,
          lookupType: lookup.lookupType,
          provider: lookup.provider,
        },
      });
    });
  });

  describe("withCachedLookup (dedup)", () => {
    it("collapses concurrent identical lookups into one fetcher call", async () => {
      mockFindUnique.mockResolvedValue(null);
      mockUpsert.mockResolvedValue({} as never);

      let fetcherCallCount = 0;
      const fetcher = async () => {
        fetcherCallCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          responsePayload: '{"ok":true}',
          resolvedEntityId: null,
          httpStatus: 200,
        };
      };

      const [r1, r2, r3] = await Promise.all([
        withCachedLookup(lookup, fetcher, 86_400_000),
        withCachedLookup(lookup, fetcher, 86_400_000),
        withCachedLookup(lookup, fetcher, 86_400_000),
      ]);

      expect(fetcherCallCount).toBe(1);
      expect(r1.httpStatus).toBe(200);
      expect(r2.httpStatus).toBe(200);
      expect(r3.httpStatus).toBe(200);
    });

    it("returns cached result without calling fetcher", async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: "1",
        lookupKey: lookup.lookupKey,
        lookupType: lookup.lookupType,
        provider: lookup.provider,
        responsePayload: '{"cached":true}',
        resolvedEntityId: "e1",
        httpStatus: 200,
        cachedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      } as never);

      const fetcher = vi.fn();
      const result = await withCachedLookup(lookup, fetcher, 86_400_000);

      expect(fetcher).not.toHaveBeenCalled();
      expect(result.httpStatus).toBe(200);
    });

    it("stores null payload misses with the miss ttl instead of the hit ttl", async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      mockUpsert.mockResolvedValue({} as never);

      const fetcher = vi.fn(async () => ({
        responsePayload: null,
        resolvedEntityId: null,
        httpStatus: 404,
      }));

      await withCachedLookup(lookup, fetcher, 86_400_000, 3_600_000);

      expect(mockUpsert).toHaveBeenCalledTimes(1);
      const [call] = mockUpsert.mock.calls;
      const update = call?.[0].update;
      expect(update).toBeDefined();
      expect((update?.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
      expect((update?.expiresAt as Date).getTime()).toBeLessThan(
        Date.now() + 5_000_000,
      );
    });
  });
});
