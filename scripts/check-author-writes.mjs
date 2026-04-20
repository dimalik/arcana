import fs from "fs";
import path from "path";

const repoRoot = process.cwd();
const roots = ["src", "scripts"];
const allowedFiles = new Set([
  "src/lib/papers/authors/store.ts",
]);
const writePattern = /\.(author|paperAuthor)\.(create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/g;

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules"
      || entry.name === ".next"
      || entry.name === "generated"
      || entry.name.startsWith(".")
    ) {
      continue;
    }
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
  const fullRoot = path.join(repoRoot, root);
  if (!fs.existsSync(fullRoot)) continue;
  for (const filePath of walk(fullRoot)) {
    const relativePath = path.relative(repoRoot, filePath);
    if (allowedFiles.has(relativePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    let match;
    while ((match = writePattern.exec(source)) !== null) {
      const prefix = source.slice(0, match.index);
      const line = prefix.split("\n").length;
      violations.push(`${relativePath}:${line}: ${match[0]}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    "[check-author-writes] Author/PaperAuthor writes are only allowed in src/lib/papers/authors/store.ts\n"
    + violations.join("\n"),
  );
  process.exit(1);
}

console.log("[check-author-writes] OK");
