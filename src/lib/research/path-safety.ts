import path from "path";

function trimTrailingSeparators(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed || path.sep;
}

function normalizeAbsolutePath(value: string): string {
  return trimTrailingSeparators(path.normalize(value));
}

export function isPathWithinRoot(rootDir: string, candidatePath: string): boolean {
  const normalizedRoot = normalizeAbsolutePath(rootDir);
  const normalizedCandidate = normalizeAbsolutePath(candidatePath);

  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}
