import { prisma } from "../prisma";

export interface CreateAssertionInput {
  sourceEntityId: string;
  targetEntityId: string;
  sourcePaperId?: string | null;
  relationType: string;
  description?: string | null;
  confidence: number;
  provenance: string;
  extractorVersion?: string | null;
  createdByUserId?: string | null;
}

export interface AddEvidenceInput {
  assertionId: string;
  type: string;
  excerpt?: string | null;
  citationMentionId?: string | null;
  referenceEntryId?: string | null;
}

export async function createRelationAssertion(input: CreateAssertionInput) {
  if (!input.sourcePaperId) {
    return prisma.relationAssertion.create({
      data: {
        sourceEntityId: input.sourceEntityId,
        targetEntityId: input.targetEntityId,
        sourcePaperId: input.sourcePaperId,
        relationType: input.relationType,
        description: input.description,
        confidence: input.confidence,
        provenance: input.provenance,
        extractorVersion: input.extractorVersion,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  return prisma.relationAssertion.upsert({
    where: {
      sourcePaperId_targetEntityId_relationType_provenance: {
        sourcePaperId: input.sourcePaperId,
        targetEntityId: input.targetEntityId,
        relationType: input.relationType,
        provenance: input.provenance,
      },
    },
    update: {
      confidence: input.confidence,
      description: input.description,
      extractorVersion: input.extractorVersion,
    },
    create: {
      sourceEntityId: input.sourceEntityId,
      targetEntityId: input.targetEntityId,
      sourcePaperId: input.sourcePaperId,
      relationType: input.relationType,
      description: input.description,
      confidence: input.confidence,
      provenance: input.provenance,
      extractorVersion: input.extractorVersion,
      createdByUserId: input.createdByUserId,
    },
  });
}

export async function addEvidence(input: AddEvidenceInput) {
  return prisma.relationEvidence.create({
    data: {
      assertionId: input.assertionId,
      type: input.type,
      excerpt: input.excerpt,
      citationMentionId: input.citationMentionId,
      referenceEntryId: input.referenceEntryId,
    },
  });
}

export async function createAssertionWithEvidence(
  assertion: CreateAssertionInput,
  evidenceList: Omit<AddEvidenceInput, "assertionId">[]
) {
  const created = await createRelationAssertion(assertion);
  for (const evidence of evidenceList) {
    await addEvidence({ ...evidence, assertionId: created.id });
  }
  return created;
}
