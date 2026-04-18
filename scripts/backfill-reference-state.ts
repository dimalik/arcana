import fs from "node:fs/promises";
import path from "node:path";

import { backfillReferenceStates, collectReferenceStateSnapshot } from "@/lib/references/reference-state";

interface CliOptions {
  apply: boolean;
  out: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  let apply = false;
  let out: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
      continue;
    }

    if (arg === "--out") {
      out = argv[i + 1] ?? null;
      i += 1;
    }
  }

  return { apply, out };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = options.apply
    ? await backfillReferenceStates()
    : await collectReferenceStateSnapshot();

  const payload = {
    generatedAt: new Date().toISOString(),
    apply: options.apply,
    ...snapshot,
  };

  if (options.out) {
    const outputPath = path.resolve(options.out);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`[reference-state] Wrote snapshot to ${outputPath}`);
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error("[reference-state] Failed:", error);
  process.exit(1);
});
