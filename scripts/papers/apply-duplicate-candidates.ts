import fs from "fs/promises";
import path from "path";

import {
  applyAcceptedPaperDuplicateCandidates,
  getPaperDuplicateDashboard,
} from "@/lib/papers/duplicate-candidates";

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(current, "true");
    } else {
      args.set(current, next);
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userId = args.get("--user-id");
  const outPath = args.get("--out");

  if (!userId) {
    throw new Error("Usage: node --import tsx scripts/papers/apply-duplicate-candidates.ts --user-id <user-id> [--out <path>]");
  }

  const applyResult = await applyAcceptedPaperDuplicateCandidates(userId);
  const dashboard = await getPaperDuplicateDashboard(userId);
  const payload = {
    generatedAt: new Date().toISOString(),
    userId,
    applyResult,
    dashboard,
  };

  if (outPath) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error("[apply-duplicate-candidates] Failed:", error);
  process.exit(1);
});
