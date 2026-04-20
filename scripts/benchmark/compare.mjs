import fs from "fs";

function valueFor(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function flatten(prefix, value, acc) {
  if (Array.isArray(value)) {
    acc[prefix] = `[array:${value.length}]`;
    return acc;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flatten(prefix ? `${prefix}.${key}` : key, child, acc);
    }
    return acc;
  }
  acc[prefix] = value;
  return acc;
}

function main() {
  const argv = process.argv.slice(2);
  const beforePath = valueFor(argv, "--before");
  const afterPath = valueFor(argv, "--after");

  if (!beforePath || !afterPath) {
    throw new Error("--before and --after are required");
  }

  const before = readJson(beforePath);
  const after = readJson(afterPath);

  if (
    before.matcherVersion &&
    after.matcherVersion &&
    before.matcherVersion !== after.matcherVersion
  ) {
    throw new Error(
      `Refusing cross-version comparison: ${before.matcherVersion} vs ${after.matcherVersion}`,
    );
  }

  const beforeFlat = flatten("", before, {});
  const afterFlat = flatten("", after, {});
  const keys = Array.from(new Set([...Object.keys(beforeFlat), ...Object.keys(afterFlat)])).sort();
  const diff = [];

  for (const key of keys) {
    if (beforeFlat[key] === afterFlat[key]) continue;
    diff.push({
      key,
      before: beforeFlat[key] ?? null,
      after: afterFlat[key] ?? null,
    });
  }

  console.log(JSON.stringify({ diff }, null, 2));
}

try {
  main();
} catch (error) {
  console.error("[compare-benchmark] Failed:", error);
  process.exit(1);
}
