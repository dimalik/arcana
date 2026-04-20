import fs from "fs";
import path from "path";

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function loadPatternRegexes() {
  const inlinePatterns = process.env.HOLDOUT_CASE_REGEXES;
  if (inlinePatterns) {
    return inlinePatterns
      .split("\n")
      .map((pattern) => pattern.trim())
      .filter(Boolean)
      .map((pattern) => new RegExp(pattern, "i"));
  }

  const patternPath = process.env.HOLDOUT_CASE_REGEX_PATH;
  if (!patternPath || !fs.existsSync(patternPath)) return [];
  return fs
    .readFileSync(patternPath, "utf8")
    .split("\n")
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => new RegExp(pattern, "i"));
}

function main() {
  const repoRoot = process.cwd();
  const benchmarkDir = path.join(repoRoot, "benchmark", "judged");
  const files = fs.existsSync(benchmarkDir) ? walk(benchmarkDir) : [];
  const holdoutFiles = files.filter((filePath) => /\.holdout\./.test(filePath));

  if (holdoutFiles.length > 0) {
    console.error("[check-holdout-leak] Holdout files must not live in the implementation repo:");
    for (const filePath of holdoutFiles) {
      console.error(` - ${path.relative(repoRoot, filePath)}`);
    }
    process.exit(1);
  }

  const patterns = loadPatternRegexes();
  const prText =
    process.env.PR_TEXT ??
    (process.env.PR_TEXT_PATH && fs.existsSync(process.env.PR_TEXT_PATH)
      ? fs.readFileSync(process.env.PR_TEXT_PATH, "utf8")
      : "");

  for (const regex of patterns) {
    if (regex.test(prText)) {
      console.error(`[check-holdout-leak] PR text matches holdout pattern ${regex}`);
      process.exit(1);
    }
  }

  console.log("[check-holdout-leak] OK");
}

main();
