import { Prisma } from "@prisma/client";

import { getPriority } from "./source-merger";

export const FIGURE_IDENTITY_RESOLVER_VERSION = "figure-identity-resolver-v1";

type FigureIdentityTx = Prisma.TransactionClient;

type IdentityResolutionInput =
  | {
    paperId: string;
    provenanceKind: "extraction";
    extractionRunId: string;
  }
  | {
    paperId: string;
    provenanceKind: "legacy_bootstrap";
    bootstrapRunId: string;
  };

interface CandidateIdentityInput {
  id: string;
  paperId: string;
  type: string;
  sourceMethod: string;
  sourceNamespace: string | null;
  sourceLocalLocator: string | null;
  sourceOrder: number;
  figureLabelNormalized: string | null;
  nativeAssetHash: string | null;
}

interface IdentityGroup {
  key: string;
  type: string;
  identityNamespace: string | null;
  canonicalLabelNormalized: string | null;
  members: CandidateIdentityInput[];
}

function namespaceKey(namespace: string | null): string {
  return namespace?.trim() || "default";
}

function sortCandidates(candidates: CandidateIdentityInput[]): CandidateIdentityInput[] {
  return [...candidates].sort((a, b) => {
    const priorityDelta = getPriority(a.sourceMethod) - getPriority(b.sourceMethod);
    if (priorityDelta !== 0) return priorityDelta;
    const orderDelta = a.sourceOrder - b.sourceOrder;
    if (orderDelta !== 0) return orderDelta;
    return a.id.localeCompare(b.id);
  });
}

function findMatchingGroup(
  groups: IdentityGroup[],
  candidate: CandidateIdentityInput,
): IdentityGroup | null {
  for (const group of groups) {
    if (group.type !== candidate.type) continue;

    const candidateNamespace = namespaceKey(candidate.sourceNamespace);
    const groupNamespace = namespaceKey(group.identityNamespace);
    if (candidateNamespace !== groupNamespace) continue;

    const sharesLabel = !!candidate.figureLabelNormalized
      && !!group.canonicalLabelNormalized
      && candidate.figureLabelNormalized === group.canonicalLabelNormalized;
    if (sharesLabel) return group;

    const sharesAsset = !!candidate.nativeAssetHash
      && group.members.some((member) => member.nativeAssetHash === candidate.nativeAssetHash);
    if (sharesAsset) return group;
  }

  return null;
}

function buildIdentityKey(group: IdentityGroup): string {
  const namespace = namespaceKey(group.identityNamespace);
  if (group.canonicalLabelNormalized) {
    return `${group.type}:${namespace}:label:${group.canonicalLabelNormalized}`;
  }

  const assetHash = group.members.find((member) => member.nativeAssetHash)?.nativeAssetHash;
  if (assetHash) {
    return `${group.type}:${namespace}:asset:${assetHash}`;
  }

  const locator = group.members[0]?.sourceLocalLocator ?? `member:${group.members[0]?.id ?? "unknown"}`;
  return `${group.type}:${namespace}:locator:${locator}`;
}

export function resolveCandidateIdentityGroups(
  candidates: CandidateIdentityInput[],
): IdentityGroup[] {
  const sorted = sortCandidates(candidates);
  const groups: IdentityGroup[] = [];

  for (const candidate of sorted) {
    const match = findMatchingGroup(groups, candidate);
    if (match) {
      match.members.push(candidate);
      if (!match.canonicalLabelNormalized && candidate.figureLabelNormalized) {
        match.canonicalLabelNormalized = candidate.figureLabelNormalized;
      }
      continue;
    }

    groups.push({
      key: "",
      type: candidate.type,
      identityNamespace: candidate.sourceNamespace ?? null,
      canonicalLabelNormalized: candidate.figureLabelNormalized,
      members: [candidate],
    });
  }

  return groups.map((group) => ({
    ...group,
    key: buildIdentityKey(group),
  }));
}

export async function createIdentityResolutionSnapshot(
  tx: FigureIdentityTx,
  input: IdentityResolutionInput,
): Promise<string> {
  const candidateWhere = input.provenanceKind === "extraction"
    ? { paperId: input.paperId, extractionRunId: input.extractionRunId }
    : { paperId: input.paperId, bootstrapRunId: input.bootstrapRunId };

  const candidates = await tx.figureCandidate.findMany({
    where: candidateWhere,
    include: {
      nativeAsset: {
        select: { contentHash: true },
      },
    },
    orderBy: [
      { sourceMethod: "asc" },
      { sourceOrder: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });

  const candidateInputs: CandidateIdentityInput[] = candidates.map(
    (candidate: (typeof candidates)[number]) => ({
      id: candidate.id,
      paperId: candidate.paperId,
      type: candidate.type,
      sourceMethod: candidate.sourceMethod,
      sourceNamespace: candidate.sourceNamespace,
      sourceLocalLocator: candidate.sourceLocalLocator,
      sourceOrder: candidate.sourceOrder,
      figureLabelNormalized: candidate.figureLabelNormalized,
      nativeAssetHash: candidate.nativeAsset?.contentHash ?? null,
    }),
  );

  const groups = resolveCandidateIdentityGroups(candidateInputs);

  const resolution = await tx.identityResolution.create({
    data: {
      paperId: input.paperId,
      provenanceKind: input.provenanceKind,
      extractionRunId: input.provenanceKind === "extraction" ? input.extractionRunId : null,
      bootstrapRunId: input.provenanceKind === "legacy_bootstrap" ? input.bootstrapRunId : null,
      resolverVersion: FIGURE_IDENTITY_RESOLVER_VERSION,
      status: "completed",
      metadata: JSON.stringify({
        candidateCount: candidates.length,
        identityCount: groups.length,
        provenanceKind: input.provenanceKind,
      }),
    },
    select: { id: true },
  });

  for (const group of groups) {
    const identity = await tx.figureIdentity.create({
      data: {
        identityResolutionId: resolution.id,
        paperId: input.paperId,
        type: group.type,
        identityNamespace: group.identityNamespace,
        canonicalLabelNormalized: group.canonicalLabelNormalized,
        identityKey: group.key,
        metadata: JSON.stringify({
          memberCount: group.members.length,
          sourceMethods: Array.from(new Set(group.members.map((member) => member.sourceMethod))),
        }),
      },
      select: { id: true },
    });

    await tx.figureIdentityMember.createMany({
      data: group.members.map((member) => ({
        figureIdentityId: identity.id,
        figureCandidateId: member.id,
      })),
    });
  }

  return resolution.id;
}

export const identityResolutionInternals = {
  sortCandidates,
  resolveCandidateIdentityGroups,
};
