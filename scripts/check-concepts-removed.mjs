import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const removedPaths = [
  "src/components/concepts",
  "src/app/api/papers/[id]/concepts",
];

const forbiddenPatterns = [
  {
    file: "src/app/papers/[id]/page.tsx",
    patterns: ["ConceptMindmap", '"concepts"'],
  },
  {
    file: "src/components/paper-detail/right-panel.tsx",
    patterns: ['"concepts"', "Concepts"],
  },
  {
    file: "src/lib/llm/prompts.ts",
    patterns: ["buildConceptExpandPrompt", "conceptExpand:", "concepts: `"],
  },
  {
    file: "src/lib/llm/prompt-result-schemas.ts",
    patterns: ["concepts: {"],
  },
  {
    file: "src/app/api/papers/[id]/engage/route.ts",
    patterns: ["concept_explore"],
  },
  {
    file: "src/app/engagement/page.tsx",
    patterns: ["concept_explore", "Concepts Explored"],
  },
  {
    file: "scripts/paper-llm-route-inventory.json",
    patterns: ['"src/app/api/papers/[id]/concepts/route.ts"', '"/concepts/[conceptId]/expand/route.ts"'],
  },
  {
    file: "prisma/schema.prisma",
    patterns: ["model Concept {", "concepts           Concept[]"],
  },
  {
    file: "docs/api-reference.md",
    patterns: ["/api/papers/[id]/concepts"],
  },
  {
    file: "docs/architecture.md",
    patterns: ["references, concepts"],
  },
];

async function getNestedFiles(relativePath) {
  try {
    const absolutePath = path.join(repoRoot, relativePath);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const nestedFiles = [];

    for (const entry of entries) {
      if (entry.isFile()) {
        nestedFiles.push(path.posix.join(relativePath, entry.name));
        continue;
      }
      if (entry.isDirectory()) {
        const childFiles = await getNestedFiles(path.join(relativePath, entry.name));
        nestedFiles.push(...childFiles);
      }
    }

    return nestedFiles;
  } catch {
    return [];
  }
}

async function main() {
  const violations = [];

  for (const relativePath of removedPaths) {
    const nestedFiles = await getNestedFiles(relativePath);
    if (nestedFiles.length > 0) {
      violations.push(`${relativePath} still contains files: ${nestedFiles.join(", ")}`);
    }
  }

  for (const entry of forbiddenPatterns) {
    const absolutePath = path.join(repoRoot, entry.file);
    const text = await fs.readFile(absolutePath, "utf8");
    for (const pattern of entry.patterns) {
      if (text.includes(pattern)) {
        violations.push(`${entry.file} still contains forbidden pattern: ${pattern}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error("[check-concepts-removed] Concepts removal guardrail violations detected.");
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }

  console.log("[check-concepts-removed] OK (concept feature surfaces removed)");
}

main().catch((error) => {
  console.error("[check-concepts-removed] Failed:", error);
  process.exit(1);
});
