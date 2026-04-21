import { extractFencedArtifacts } from "@/lib/chat/fenced-artifacts";
import type { ConversationArtifactKind } from "@/generated/prisma/client";

import type { PaperAnswerIntent } from "./metadata";

export interface PersistableConversationArtifactDraft {
  kind: ConversationArtifactKind;
  title: string;
  payloadJson: string;
}

function buildArtifactDraftsFromFences(
  content: string,
): PersistableConversationArtifactDraft[] {
  const { artifacts } = extractFencedArtifacts(content, 1);
  return artifacts.map((artifact, index) => ({
    kind: "CODE_SNIPPET",
    title: artifact.filename || `Artifact ${index + 1}`,
    payloadJson: JSON.stringify({
      summary: null,
      code: artifact.code,
      filename:
        artifact.filename ||
        `artifact-${index + 1}${artifact.language ? `.${artifact.language}` : ".txt"}`,
      language: artifact.language || "text",
      assumptions: [],
    }),
  }));
}

export function finalizePaperChatArtifacts(params: {
  content: string;
  intent: PaperAnswerIntent;
  preparedArtifacts: PersistableConversationArtifactDraft[];
}): {
  content: string;
  artifacts: PersistableConversationArtifactDraft[];
} {
  const parsed = extractFencedArtifacts(params.content, 1);
  const preparedCodeArtifacts = params.preparedArtifacts.filter(
    (artifact) => artifact.kind === "CODE_SNIPPET",
  );
  const otherPreparedArtifacts = params.preparedArtifacts.filter(
    (artifact) => artifact.kind !== "CODE_SNIPPET",
  );
  const fencedCodeArtifacts =
    preparedCodeArtifacts.length === 0
      ? buildArtifactDraftsFromFences(params.content)
      : [];
  const artifacts =
    fencedCodeArtifacts.length > 0
      ? [...otherPreparedArtifacts, ...fencedCodeArtifacts]
      : params.preparedArtifacts;
  const hasCodeArtifact = artifacts.some((artifact) => artifact.kind === "CODE_SNIPPET");

  if (params.intent === "generated_artifact" && hasCodeArtifact && parsed.artifacts.length > 0) {
    return {
      content: "",
      artifacts,
    };
  }

  return {
    content: parsed.prose || params.content,
    artifacts,
  };
}
