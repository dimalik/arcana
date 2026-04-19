import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

import { prisma } from "../../src/lib/prisma";
import { collectReferenceQualityAudit } from "../../src/lib/references/reference-quality-audit";

function parseArgs(argv: string[]): { outPath: string } {
  let outPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      outPath = argv[index + 1] ? resolve(process.cwd(), argv[index + 1]) : null;
      index += 1;
    }
  }

  if (!outPath) {
    throw new Error("Usage: node --import tsx scripts/references/scan-reference-quality.ts --out <path>");
  }

  return { outPath };
}

async function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  const report = await collectReferenceQualityAudit(prisma);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

  console.log(
    JSON.stringify(
      {
        outPath,
        totals: report.totals,
        metadataRows: report.metadataRows.length,
        citationContextRows: report.citationContextRows.length,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
