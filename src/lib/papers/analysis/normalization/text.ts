export function normalizeAnalysisText(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\r\n/g, "\n")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeIdentifierLikeText(
  value: string | null | undefined,
): string {
  return normalizeAnalysisText(value).replace(/\b(the|a|an)\b/g, " ").replace(/\s+/g, " ").trim();
}
