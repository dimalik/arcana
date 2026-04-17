-- CreateTable
CREATE TABLE "ResolverCacheEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lookupKey" TEXT NOT NULL,
    "lookupType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "responsePayload" TEXT,
    "resolvedEntityId" TEXT,
    "httpStatus" INTEGER NOT NULL,
    "cachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ResolverCacheEntry_lookupKey_lookupType_idx" ON "ResolverCacheEntry"("lookupKey", "lookupType");

-- CreateIndex
CREATE INDEX "ResolverCacheEntry_expiresAt_idx" ON "ResolverCacheEntry"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResolverCacheEntry_lookupKey_lookupType_provider_key" ON "ResolverCacheEntry"("lookupKey", "lookupType", "provider");
