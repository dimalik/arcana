import { describe, expect, it } from "vitest";

import {
  collectPromptResultManifestTypesFromText,
  collectPromptResultWriterTypesFromText,
  collectSetLlmContextCallsFromText,
  collectStatusDataWritesFromText,
  collectTrackedSchemaFieldsFromText,
} from "../lib/runtime-foundation-guardrails.mjs";

describe("runtime foundation guardrails", () => {
  it("extracts live prompt types from PromptResult writers only", () => {
    const source = `
      await prisma.promptResult.create({
        data: { paperId, promptType: "summarize", result, provider, model: modelId },
      });
      const unrelated = { promptType: "ignore-me" };
    `;

    expect(collectPromptResultWriterTypesFromText(source)).toEqual([
      expect.objectContaining({ promptType: "summarize", line: 3 }),
    ]);
  });

  it("extracts manifest prompt types from the schema manifest object", () => {
    const source = `
      const promptResultSchemaManifest = {
        extract: { storage: "json_object" },
        summarize: { storage: "text" },
      };
    `;

    expect(collectPromptResultManifestTypesFromText(source).map((entry) => entry.promptType)).toEqual([
      "extract",
      "summarize",
    ]);
  });

  it("counts only tracked field writes inside data blocks", () => {
    const source = `
      await prisma.paper.update({
        where: { processingStatus: "COMPLETED" },
        data: {
          processingStatus: "FAILED",
          processingStep: null,
          processingStartedAt: null,
        },
        select: { processingStatus: true },
      });
    `;

    expect(collectStatusDataWritesFromText(source).map((match) => match.field)).toEqual([
      "processingStatus",
      "processingStep",
      "processingStartedAt",
    ]);
  });

  it("flags tracked fields in zod request schemas", () => {
    const source = `
      const schema = z.object({
        title: z.string(),
        processingStatus: z.string().optional(),
      });
    `;

    expect(collectTrackedSchemaFieldsFromText(source)).toEqual([
      { field: "processingStatus", line: 4, column: 9 },
    ]);
  });

  it("finds direct setLlmContext calls", () => {
    const source = `
      setLlmContext("batch_extractCitationContexts_fallback", userId, { paperId });
      await generateLLMResponse(params);
    `;

    expect(collectSetLlmContextCallsFromText(source)).toEqual([
      { line: 2, column: 7 },
    ]);
  });
});
