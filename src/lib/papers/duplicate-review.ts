export interface SafeAutoCollapseLoserInput {
  chatMessageCount: number;
  conversationCount: number;
  conversationPaperCount: number;
  notebookEntryCount: number;
  synthesisPaperCount: number;
  isLiked: boolean;
  paperTagCount: number;
  agentSessionCount: number;
  engagementCount: number;
  discoverySeedCount: number;
  discoveryImportCount: number;
  userManualRelationCount: number;
  promptResultCount: number;
  insightCount: number;
  extractedReferenceCount: number;
  incomingReferenceCount: number;
  citationMentionCount: number;
  figureCount: number;
  figureCandidateCount: number;
  figureIdentityCount: number;
  figureOverrideCount: number;
  claimEvidenceCount: number;
  derivedAssertionCount: number;
  recreatableReferenceMatchAssertionCount: number;
}

export function isSafeAutoCollapseLoser(
  loser: SafeAutoCollapseLoserInput,
): boolean {
  return (
    loser.chatMessageCount === 0 &&
    loser.conversationCount === 0 &&
    loser.conversationPaperCount === 0 &&
    loser.notebookEntryCount === 0 &&
    loser.synthesisPaperCount === 0 &&
    !loser.isLiked &&
    loser.paperTagCount === 0 &&
    loser.agentSessionCount === 0 &&
    loser.engagementCount === 0 &&
    loser.discoverySeedCount === 0 &&
    loser.discoveryImportCount === 0 &&
    loser.userManualRelationCount === 0 &&
    loser.promptResultCount === 0 &&
    loser.insightCount === 0 &&
    loser.extractedReferenceCount === 0 &&
    loser.incomingReferenceCount === 0 &&
    loser.citationMentionCount === 0 &&
    loser.figureCount === 0 &&
    loser.figureCandidateCount === 0 &&
    loser.figureIdentityCount === 0 &&
    loser.figureOverrideCount === 0 &&
    loser.claimEvidenceCount === 0 &&
    loser.derivedAssertionCount - loser.recreatableReferenceMatchAssertionCount === 0
  );
}

export function isUserManualRelationProvenance(provenance: string | null | undefined): boolean {
  return provenance === "user_manual";
}

export function isRecreatableReferenceMatchAssertion(
  assertion: { provenance: string | null; sourcePaperId: string | null },
): boolean {
  return assertion.provenance === "reference_match"
    && Boolean(assertion.sourcePaperId);
}
