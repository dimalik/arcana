import fs from "fs";
import path from "path";

import { z } from "zod";

const configSchema = z.object({
  matcherVersion: z.string().min(1),
  spanIouWeight: z.number().nonnegative(),
  textSimWeight: z.number().nonnegative(),
  fieldAgreementWeight: z.number().nonnegative(),
  assignmentMatchThreshold: z.number().nonnegative(),
  textSimilarity: z.object({
    mode: z.enum(["edit_distance_ratio", "embedding_cosine"]),
    modelId: z.string().optional(),
    modelVersion: z.string().optional(),
    modelChecksum: z.string().optional(),
  }),
});

export type ClaimMatcherConfig = z.infer<typeof configSchema>;

export interface ClaimLike {
  id: string;
  text: string;
  rhetoricalRole?: string | null;
  facet?: string | null;
  polarity?: string | null;
  sourceSpan?: {
    charStart: number;
    charEnd: number;
  } | null;
}

export interface ClaimMatch {
  leftId: string;
  rightId: string;
  cost: number;
}

export function loadClaimMatcherConfig(
  repoRoot = process.cwd(),
): ClaimMatcherConfig {
  return configSchema.parse(
    JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "benchmark", "claim-matcher-config.json"),
        "utf8",
      ),
    ),
  );
}

function editDistanceRatio(left: string, right: string): number {
  if (!left && !right) return 1;
  const dp = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0),
  );

  for (let i = 0; i <= left.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  const distance = dp[left.length][right.length];
  const maxLength = Math.max(left.length, right.length, 1);
  return 1 - distance / maxLength;
}

function spanIou(
  left: ClaimLike["sourceSpan"],
  right: ClaimLike["sourceSpan"],
): number {
  if (!left || !right) return 0;
  const intersection = Math.max(
    0,
    Math.min(left.charEnd, right.charEnd) - Math.max(left.charStart, right.charStart),
  );
  const union =
    Math.max(left.charEnd, right.charEnd) - Math.min(left.charStart, right.charStart);
  return union > 0 ? intersection / union : 0;
}

function fieldAgreement(left: ClaimLike, right: ClaimLike): number {
  const fields = [
    ["rhetoricalRole", left.rhetoricalRole, right.rhetoricalRole],
    ["facet", left.facet, right.facet],
    ["polarity", left.polarity, right.polarity],
  ];
  const comparable = fields.filter(([, l, r]) => l && r);
  if (comparable.length === 0) return 0;
  const matches = comparable.filter(([, l, r]) => l === r).length;
  return matches / comparable.length;
}

function buildCostMatrix(
  leftClaims: ClaimLike[],
  rightClaims: ClaimLike[],
  config: ClaimMatcherConfig,
): number[][] {
  return leftClaims.map((leftClaim) =>
    rightClaims.map((rightClaim) => {
      const textSimilarity =
        config.textSimilarity.mode === "edit_distance_ratio"
          ? editDistanceRatio(leftClaim.text.toLowerCase(), rightClaim.text.toLowerCase())
          : 0;
      const overlap = spanIou(leftClaim.sourceSpan, rightClaim.sourceSpan);
      const agreement = fieldAgreement(leftClaim, rightClaim);
      const score =
        overlap * config.spanIouWeight +
        textSimilarity * config.textSimWeight +
        agreement * config.fieldAgreementWeight;
      return 1 - score;
    }),
  );
}

function hungarian(costs: number[][]): Array<[number, number]> {
  const n = costs.length;
  const m = Math.max(...costs.map((row) => row.length), 0);
  if (!n || !m) return [];
  const size = Math.max(n, m);
  const matrix = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => costs[i]?.[j] ?? 1),
  );

  const u = Array(size + 1).fill(0);
  const v = Array(size + 1).fill(0);
  const p = Array(size + 1).fill(0);
  const way = Array(size + 1).fill(0);

  for (let i = 1; i <= size; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(size + 1).fill(Infinity);
    const used = Array(size + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= size; j += 1) {
        if (used[j]) continue;
        const cur = matrix[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= size; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment: Array<[number, number]> = [];
  for (let j = 1; j <= size; j += 1) {
    if (p[j] > 0 && p[j] <= n && j <= m) {
      assignment.push([p[j] - 1, j - 1]);
    }
  }
  return assignment;
}

export function matchClaims(
  leftClaims: ClaimLike[],
  rightClaims: ClaimLike[],
  config: ClaimMatcherConfig = loadClaimMatcherConfig(),
): { matcherVersion: string; matches: ClaimMatch[] } {
  const costMatrix = buildCostMatrix(leftClaims, rightClaims, config);
  const assignment = hungarian(costMatrix);
  const matches = assignment
    .map(([leftIndex, rightIndex]) => {
      const cost = costMatrix[leftIndex]?.[rightIndex];
      if (typeof cost !== "number" || cost > config.assignmentMatchThreshold) {
        return null;
      }
      return {
        leftId: leftClaims[leftIndex].id,
        rightId: rightClaims[rightIndex].id,
        cost: Number(cost.toFixed(6)),
      };
    })
    .filter((match): match is ClaimMatch => Boolean(match));

  return {
    matcherVersion: config.matcherVersion,
    matches,
  };
}
