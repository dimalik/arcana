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

type RelationAssertionWriteDb = Pick<typeof prisma, "relationAssertion">;
type RelationEvidenceDb = Pick<typeof prisma, "relationEvidence">;
type RelationAssertionDb = RelationAssertionWriteDb & RelationEvidenceDb;

export async function createRelationAssertion(
  input: CreateAssertionInput,
  db: RelationAssertionWriteDb = prisma
) {
  if (!input.sourcePaperId) {
    return db.relationAssertion.create({
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

  return db.relationAssertion.upsert({
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

export async function addEvidence(
  input: AddEvidenceInput,
  db: RelationEvidenceDb = prisma
) {
  return db.relationEvidence.create({
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
  evidenceList: Omit<AddEvidenceInput, "assertionId">[],
  db: RelationAssertionDb = prisma
) {
  const created = await createRelationAssertion(assertion, db);
  for (const evidence of evidenceList) {
    await addEvidence({ ...evidence, assertionId: created.id }, db);
  }
  return created;
}

type RelationEvidenceReplaceDb = Pick<
  typeof prisma,
  "relationAssertion" | "relationEvidence"
>;

export async function upsertAssertionWithEvidence(
  assertion: CreateAssertionInput,
  evidenceList: Omit<AddEvidenceInput, "assertionId">[],
  db: RelationEvidenceReplaceDb = prisma,
) {
  const created = await createRelationAssertion(assertion, db);

  await db.relationEvidence.deleteMany({
    where: { assertionId: created.id },
  });

  if (evidenceList.length > 0) {
    await db.relationEvidence.createMany({
      data: evidenceList.map((evidence) => ({
        assertionId: created.id,
        type: evidence.type,
        excerpt: evidence.excerpt ?? null,
        citationMentionId: evidence.citationMentionId ?? null,
        referenceEntryId: evidence.referenceEntryId ?? null,
      })),
    });
  }

  return created;
}
