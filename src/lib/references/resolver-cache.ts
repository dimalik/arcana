import { prisma } from "../prisma";

export interface CacheLookup {
  lookupKey: string;
  lookupType: string;
  provider: string;
}

export interface CacheEntry {
  responsePayload: string | null;
  resolvedEntityId: string | null;
  httpStatus: number;
  cachedAt: Date;
  expiresAt: Date;
}

export interface CacheWriteInput {
  responsePayload: string | null;
  resolvedEntityId: string | null;
  httpStatus: number;
  ttlMs: number;
}

export interface FetcherResult {
  responsePayload: string | null;
  resolvedEntityId: string | null;
  httpStatus: number;
}

export const CACHE_TTL = {
  hit: 7 * 24 * 60 * 60 * 1000,
  miss: 24 * 60 * 60 * 1000,
} as const;

const inflight = new Map<string, Promise<FetcherResult>>();

function inflightKey(lookup: CacheLookup): string {
  return `${lookup.provider}:${lookup.lookupType}:${lookup.lookupKey}`;
}

export async function getCachedResult(
  lookup: CacheLookup,
): Promise<CacheEntry | null> {
  const entry = await prisma.resolverCacheEntry.findUnique({
    where: {
      lookupKey_lookupType_provider: {
        lookupKey: lookup.lookupKey,
        lookupType: lookup.lookupType,
        provider: lookup.provider,
      },
    },
  });

  if (!entry) return null;
  if (entry.expiresAt <= new Date()) return null;

  return {
    responsePayload: entry.responsePayload,
    resolvedEntityId: entry.resolvedEntityId,
    httpStatus: entry.httpStatus,
    cachedAt: entry.cachedAt,
    expiresAt: entry.expiresAt,
  };
}

export async function setCachedResult(
  lookup: CacheLookup,
  input: CacheWriteInput,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMs);

  await prisma.resolverCacheEntry.upsert({
    where: {
      lookupKey_lookupType_provider: {
        lookupKey: lookup.lookupKey,
        lookupType: lookup.lookupType,
        provider: lookup.provider,
      },
    },
    create: {
      lookupKey: lookup.lookupKey,
      lookupType: lookup.lookupType,
      provider: lookup.provider,
      responsePayload: input.responsePayload,
      resolvedEntityId: input.resolvedEntityId,
      httpStatus: input.httpStatus,
      cachedAt: now,
      expiresAt,
    },
    update: {
      responsePayload: input.responsePayload,
      resolvedEntityId: input.resolvedEntityId,
      httpStatus: input.httpStatus,
      cachedAt: now,
      expiresAt,
    },
  });
}

export async function withCachedLookup(
  lookup: CacheLookup,
  fetcher: () => Promise<FetcherResult>,
  ttlMs: number,
  missTtlMs = CACHE_TTL.miss,
): Promise<FetcherResult> {
  const cached = await getCachedResult(lookup);
  if (cached) {
    return {
      responsePayload: cached.responsePayload,
      resolvedEntityId: cached.resolvedEntityId,
      httpStatus: cached.httpStatus,
    };
  }

  const key = inflightKey(lookup);
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await fetcher();
      await setCachedResult(lookup, {
        ...result,
        ttlMs: result.responsePayload ? ttlMs : missTtlMs,
      });
      return result;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}
