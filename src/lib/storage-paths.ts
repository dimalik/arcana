import path from "path";

function normalizeDatabaseUrl(databaseUrl: string | undefined): string {
  return databaseUrl ?? `file:${path.join(process.cwd(), "prisma", "dev.db")}`;
}

function parseSqliteFilePath(databaseUrl: string | undefined): string | null {
  const normalized = normalizeDatabaseUrl(databaseUrl);
  if (!normalized.startsWith("file:")) {
    return null;
  }

  const rawPath = decodeURIComponent(normalized.slice("file:".length));
  if (!rawPath || rawPath === ":memory:") {
    return null;
  }

  return path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(process.cwd(), rawPath);
}

export function getDatabaseProjectRoot(databaseUrl: string | undefined = process.env.DATABASE_URL): string | null {
  const databasePath = parseSqliteFilePath(databaseUrl);
  if (!databasePath) {
    return null;
  }

  const databaseDir = path.dirname(databasePath);
  return path.basename(databaseDir) === "prisma"
    ? path.dirname(databaseDir)
    : databaseDir;
}

export function resolveStorageCandidates(relativeOrAbsolutePath: string): string[] {
  if (path.isAbsolute(relativeOrAbsolutePath)) {
    return [path.normalize(relativeOrAbsolutePath)];
  }

  const candidates = [path.join(process.cwd(), relativeOrAbsolutePath)];
  const databaseProjectRoot = getDatabaseProjectRoot();
  if (databaseProjectRoot) {
    const databaseCandidate = path.join(databaseProjectRoot, relativeOrAbsolutePath);
    if (!candidates.includes(databaseCandidate)) {
      candidates.push(databaseCandidate);
    }
  }

  return candidates;
}
