import fs from "node:fs/promises";
import path from "node:path";

import { PaperDuplicateAction } from "@/generated/prisma/enums";
import {
  getPaperDuplicateDashboard,
  listPaperDuplicateCandidates,
  reviewPaperDuplicateCandidate,
} from "@/lib/papers/duplicate-candidates";

interface CliOptions {
  userId: string | null;
  out: string | null;
  mode: "hide-all";
}

function parseArgs(argv: string[]): CliOptions {
  let userId: string | null = null;
  let out: string | null = null;
  let mode: "hide-all" = "hide-all";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--user-id") {
      userId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--out") {
      out = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--mode") {
      const value = argv[index + 1];
      if (value === "hide-all") {
        mode = value;
      }
      index += 1;
    }
  }

  return { userId, out, mode };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.userId) {
    throw new Error(
      "Usage: node --import tsx scripts/papers/review-duplicate-candidates.ts --user-id <user-id> [--mode hide-all] [--out <path>]",
    );
  }

  const candidates = await listPaperDuplicateCandidates(options.userId);
  const collisions = candidates.filter((candidate) => candidate.canonicalEntityCollision);
  if (collisions.length > 0) {
    throw new Error(
      `Refusing bulk duplicate review because ${collisions.length} candidate(s) report canonical entity collisions.`,
    );
  }

  let accepted = 0;
  let dismissed = 0;

  for (const candidate of candidates) {
    if (options.mode === "hide-all") {
      await reviewPaperDuplicateCandidate({
        userId: options.userId,
        candidateId: candidate.id,
        reviewStatus: "ACCEPTED",
        chosenAction: PaperDuplicateAction.HIDE,
      });
      accepted += 1;
    }
  }

  const dashboard = await getPaperDuplicateDashboard(options.userId);
  const reviewedCandidates = await listPaperDuplicateCandidates(options.userId);

  const payload = {
    generatedAt: new Date().toISOString(),
    userId: options.userId,
    mode: options.mode,
    reviewed: {
      accepted,
      dismissed,
      total: candidates.length,
    },
    dashboard,
    candidates: reviewedCandidates,
  };

  if (options.out) {
    const outputPath = path.resolve(options.out);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error("[review-duplicate-candidates] Failed:", error);
  process.exit(1);
});
