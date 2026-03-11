import type { AgentMode } from "./templates";

export const ANALYZE_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
export const MODIFY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Edit",
  "Write",
  "Bash",
];

export function buildSystemPrompt(
  paper: { title: string; abstract: string | null; fullText: string | null },
  mode: AgentMode
): string {
  const paperContent = paper.fullText || paper.abstract || "(no text available)";
  const truncated =
    paperContent.length > 80_000
      ? paperContent.slice(0, 80_000) + "\n\n[...truncated...]"
      : paperContent;

  const codebaseContext =
    mode === "modify"
      ? `
## Codebase orientation (for modify mode)
- Next.js 14 App Router + TypeScript + Tailwind + Prisma (SQLite)
- LLM prompts: src/lib/llm/prompts.ts
- Processing pipeline: src/lib/llm/auto-process.ts
- LLM provider setup: src/lib/llm/provider.ts
- Prisma schema: prisma/schema.prisma
- DB singleton: src/lib/prisma.ts
- Components: src/components/
- API routes: src/app/api/

IMPORTANT: Always create a git branch before modifying files.
`
      : "";

  return `You are an expert research paper analyst integrated into a paper management application.

## Paper under analysis
Title: ${paper.title}
${paper.abstract ? `Abstract: ${paper.abstract}` : ""}

## Full paper content
${truncated}
${codebaseContext}
Provide thorough, specific analysis. Cite numbers, methods, and specifics from the paper. Do not pad with generalities.`;
}
