import "server-only";

import type {
  AgentActionSummary,
  AnswerCitation,
  PaperAnswerIntent,
} from "../metadata";
import type {
  AgentObservation,
  PaperAgentArtifactDraft,
  PaperAgentPaperContext,
  PreparedPaperAgentEvidence,
} from "../agent";

export type { AgentActionSummary, AnswerCitation, PaperAnswerIntent };
export type {
  AgentObservation,
  PaperAgentArtifactDraft,
  PaperAgentPaperContext,
  PreparedPaperAgentEvidence,
};

export type SummarySectionName = "overview" | "methodology" | "results";

export interface PreparedPaperAgentEvidenceV2 extends PreparedPaperAgentEvidence {
  /** The planner's final guidance string, used by phase-B streaming prompt. */
  answerPlan: string | null;
}

export const AGENT_MAX_TURNS = 12;
