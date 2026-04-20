import fs from "fs";
import path from "path";

const repoRoot = process.cwd();
const roots = [
  "src/lib/papers/retrieval",
  "src/lib/recommendations",
];
const allowedFiles = new Set([
  "src/lib/papers/search.ts",
]);
const riskyPattern = /\b(authorId|author\.id|authorId:|author\.id\b)\b/g;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

const violations = [];

for (const root of roots) {
  for (const filePath of walk(path.join(repoRoot, root))) {
    const relativePath = path.relative(repoRoot, filePath);
    if (allowedFiles.has(relativePath)) continue;
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    lines.forEach((lineText, index) => {
      if (!riskyPattern.test(lineText)) return;
      riskyPattern.lastIndex = 0;
      if (
        lineText.includes("orcid")
        || lineText.includes("semanticScholarAuthorId")
      ) {
        return;
      }
      violations.push(`${relativePath}:${index + 1}: ${lineText.trim()}`);
    });
  }
}

if (violations.length > 0) {
  console.error(
    "[check-author-identity-usage] Ranking/recommendation code must not rely on Author.id equality without trusted ids.\n"
    + violations.join("\n"),
  );
  process.exit(1);
}

console.log("[check-author-identity-usage] OK");
