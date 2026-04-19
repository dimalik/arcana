import { createHash } from "crypto";
import type { SearchSource, S2Result } from "../import/semantic-scholar";

export type ReferenceMetadataField = "title" | "authors" | "venue";
export type ReferenceMetadataFieldAction = "replace" | "leave" | "suppress";
export type CitationContextAction = "replace_normalized" | "leave";
export type CitationContextScope = "legacy_reference_context" | "mention_projection";

export interface ReferenceMetadataPollutedField {
  field: ReferenceMetadataField;
  beforeValue: string | null;
}

export interface RepairConfidence {
  score: number | null;
  reason: string;
}

export interface ReferenceMetadataFieldActions {
  title?: ReferenceMetadataFieldAction;
  authors?: ReferenceMetadataFieldAction;
  venue?: ReferenceMetadataFieldAction;
}

export interface ReferenceMetadataDecision {
  manifestRowId: string;
  kind: "reference_metadata";
  referenceEntryId: string;
  legacyReferenceId: string | null;
  paperId: string;
  pollutedFields: ReferenceMetadataPollutedField[];
  candidate: (Omit<S2Result, "source"> & { source?: SearchSource | "arxiv" }) | null;
  candidateSource: SearchSource | "arxiv" | "none";
  candidateIdentifiers: {
    doi: string | null;
    arxivId: string | null;
    semanticScholarId: string | null;
    externalUrl: string | null;
  };
  confidence: RepairConfidence;
  fieldActions: ReferenceMetadataFieldActions;
  persistIdentifiers: boolean;
  actionReason: string;
}

export interface CitationContextDecision {
  manifestRowId: string;
  kind: "citation_context";
  referenceEntryId: string;
  legacyReferenceId: string | null;
  paperId: string;
  scope: CitationContextScope;
  mentionId: string | null;
  beforeValue: string | null;
  normalizedValue: string | null;
  action: CitationContextAction;
  actionReason: string;
}

export type ReferenceQualityManifestDecision =
  | ReferenceMetadataDecision
  | CitationContextDecision;

export function buildManifestRowId(
  kind: ReferenceQualityManifestDecision["kind"],
  stableParts: Array<string | null | undefined>,
): string {
  const hash = createHash("sha1");
  hash.update(kind);
  hash.update("\n");
  for (const part of stableParts) {
    hash.update(part ?? "");
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

export function decisionToJsonl(
  decision: ReferenceQualityManifestDecision,
): string {
  return JSON.stringify(decision);
}

export function parseManifestLine(
  line: string,
): ReferenceQualityManifestDecision {
  return JSON.parse(line) as ReferenceQualityManifestDecision;
}

export function validateManifestDecision(
  decision: ReferenceQualityManifestDecision,
): string[] {
  return decision.kind === "reference_metadata"
    ? validateReferenceMetadataDecision(decision)
    : validateCitationContextDecision(decision);
}

export function assertValidManifestDecision(
  decision: ReferenceQualityManifestDecision,
): void {
  const errors = validateManifestDecision(decision);
  if (errors.length > 0) {
    throw new Error(
      `Invalid manifest row ${decision.manifestRowId}: ${errors.join("; ")}`,
    );
  }
}

function validateReferenceMetadataDecision(
  decision: ReferenceMetadataDecision,
): string[] {
  const errors: string[] = [];
  const pollutedFieldNames = new Set(decision.pollutedFields.map((field) => field.field));
  const replaceFields = new Set<ReferenceMetadataField>();

  for (const [field, action] of Object.entries(decision.fieldActions) as Array<
    [ReferenceMetadataField, ReferenceMetadataFieldAction | undefined]
  >) {
    if (!action) continue;
    if (field === "title" || field === "authors") {
      if (action === "suppress") {
        errors.push(`${field} cannot be suppressed`);
      }
    }
    if (field === "venue" && !["replace", "leave", "suppress"].includes(action)) {
      errors.push(`venue has invalid action ${action}`);
    }
    if ((field === "title" || field === "authors") && !["replace", "leave"].includes(action)) {
      errors.push(`${field} has invalid action ${action}`);
    }
    if (!pollutedFieldNames.has(field)) {
      errors.push(`${field} action provided but field was not classified as polluted`);
    }
    if (action === "replace") {
      replaceFields.add(field);
    }
  }

  for (const pollutedField of decision.pollutedFields) {
    if (!decision.fieldActions[pollutedField.field]) {
      errors.push(`missing field action for ${pollutedField.field}`);
    }
  }

  if (replaceFields.size > 0) {
    if (!decision.candidate) {
      errors.push("replace action requires candidate");
    }
    if (decision.candidateSource === "none") {
      errors.push("replace action requires non-none candidateSource");
    }
  }

  if (decision.persistIdentifiers && replaceFields.size === 0) {
    errors.push("persistIdentifiers=true requires at least one replace action");
  }

  if (!decision.persistIdentifiers && replaceFields.size === 0 && decision.candidateIdentifiers.doi) {
    // no-op; candidateIdentifiers may still be present for review context
  }

  return errors;
}

function validateCitationContextDecision(
  decision: CitationContextDecision,
): string[] {
  const errors: string[] = [];

  if (decision.action === "replace_normalized" && decision.normalizedValue == null) {
    errors.push("replace_normalized requires normalizedValue");
  }

  if (decision.scope === "mention_projection" && !decision.mentionId) {
    errors.push("mention_projection requires mentionId");
  }

  if (decision.scope === "legacy_reference_context" && decision.mentionId) {
    errors.push("legacy_reference_context cannot carry mentionId");
  }

  return errors;
}
