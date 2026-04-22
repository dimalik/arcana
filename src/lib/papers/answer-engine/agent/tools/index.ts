import "server-only";

import type { ToolSet } from "ai";

import type { ToolContext } from "./context";
import { finishTool } from "./finish";
import { readSectionTool } from "./read-section";
import { searchPassagesTool } from "./search-passages";
import { searchClaimsTool } from "./search-claims";
import { listFiguresTool } from "./list-figures";
import { inspectFigureTool } from "./inspect-figure";
import { generateCodeSnippetTool } from "./generate-code-snippet";

export type { ToolContext } from "./context";

export function buildToolSet(ctx: ToolContext): ToolSet {
  return {
    read_section: readSectionTool(ctx),
    search_passages: searchPassagesTool(ctx),
    search_claims: searchClaimsTool(ctx),
    list_figures: listFiguresTool(ctx),
    inspect_figure: inspectFigureTool(ctx),
    generate_code_snippet: generateCodeSnippetTool(ctx),
    finish: finishTool(ctx),
  };
}
