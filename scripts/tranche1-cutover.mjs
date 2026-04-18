import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export function buildTranche1CutoverPlan({
  dbPath = path.join(repoRoot, "prisma/dev.db"),
  backupDir = path.join(repoRoot, "prisma/backups"),
} = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `tranche1-pre-cutover-${timestamp}.db`);

  return [
    "Stop the running Next.js app against the target DB.",
    `Create a pre-cutover backup: cp ${dbPath} ${backupPath}`,
    "Apply schema migrations via prisma migrate deploy.",
    "Run the referenceState backfill to completion.",
    "Run verification checks: referenceState null count, ledger row counts, reconciliation dry-run, in-process persisted-status reader probe.",
    "Fast-forward merge the integration branch to main.",
    "Restart the app and run reconciliation live.",
  ];
}

function main() {
  const dryRun = !process.argv.includes("--execute");
  const steps = buildTranche1CutoverPlan();

  console.log("[tranche1-cutover] Processing Runtime Foundation cutover plan");
  console.log(`  repo: ${repoRoot}`);
  console.log(`  mode: ${dryRun ? "dry-run" : "execute"}`);

  steps.forEach((step, index) => {
    console.log(`  ${index + 1}. ${step}`);
  });

  if (!dryRun) {
    console.error(
      "[tranche1-cutover] Execute mode is intentionally disabled until PR 3-5 land. Use --dry-run during PR 1 review.",
    );
    process.exit(1);
  }
}

main();
