#!/usr/bin/env node

import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const dbPath = process.argv[2] || path.join(process.cwd(), "prisma", "dev.db");
const db = new Database(dbPath);

function normalizeIdentifier(type, value) {
  const trimmed = String(value).trim();

  if (type === "doi") {
    let doi = trimmed;
    for (const prefix of [
      "https://doi.org/",
      "http://doi.org/",
      "https://dx.doi.org/",
      "http://dx.doi.org/",
    ]) {
      if (doi.toLowerCase().startsWith(prefix)) {
        doi = doi.slice(prefix.length);
        break;
      }
    }
    return doi.toLowerCase();
  }

  if (type === "arxiv") {
    let id = trimmed;
    for (const prefix of [
      "https://arxiv.org/abs/",
      "http://arxiv.org/abs/",
      "https://arxiv.org/pdf/",
      "http://arxiv.org/pdf/",
    ]) {
      if (id.toLowerCase().startsWith(prefix.toLowerCase())) {
        id = id.slice(prefix.length);
        break;
      }
    }
    if (id.endsWith(".pdf")) {
      id = id.slice(0, -4);
    }
    return id.replace(/v\d+$/, "");
  }

  if (type === "openalex") {
    let id = trimmed;
    const prefix = "https://openalex.org/";
    if (id.toLowerCase().startsWith(prefix)) {
      id = id.slice(prefix.length);
    }
    if (/^w\d+$/i.test(id)) {
      return id.charAt(0).toUpperCase() + id.slice(1);
    }
    return id;
  }

  return trimmed;
}

function orderedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function loadIdentifierMap() {
  const map = new Map();
  const rows = db.prepare("SELECT type, value, entityId FROM PaperIdentifier").all();
  for (const row of rows) {
    map.set(`${row.type}::${row.value}`, row.entityId);
  }
  return map;
}

function loadAssignedEntityPairs() {
  const set = new Set();
  const rows = db.prepare("SELECT userId, entityId FROM Paper WHERE userId IS NOT NULL AND entityId IS NOT NULL").all();
  for (const row of rows) {
    set.add(`${row.userId}::${row.entityId}`);
  }
  return set;
}

const insertPaperEntity = db.prepare(`
  INSERT INTO PaperEntity (
    id, title, authors, year, venue, abstract,
    titleSource, authorsSource, yearSource, venueSource,
    createdAt, updatedAt
  ) VALUES (
    @id, @title, @authors, @year, @venue, @abstract,
    @titleSource, @authorsSource, @yearSource, @venueSource,
    @createdAt, @updatedAt
  )
`);

const updatePaperEntity = db.prepare(`
  UPDATE PaperEntity
  SET
    title = COALESCE(title, @title),
    authors = COALESCE(authors, @authors),
    year = COALESCE(year, @year),
    venue = COALESCE(venue, @venue),
    abstract = COALESCE(abstract, @abstract),
    updatedAt = @updatedAt
  WHERE id = @id
`);

const insertPaperIdentifier = db.prepare(`
  INSERT OR IGNORE INTO PaperIdentifier (
    id, entityId, type, value, raw, source, confidence, createdAt
  ) VALUES (
    @id, @entityId, @type, @value, @raw, @source, @confidence, @createdAt
  )
`);

const insertCandidateLink = db.prepare(`
  INSERT OR IGNORE INTO PaperEntityCandidateLink (
    id, entityAId, entityBId, reason, confidence, status, createdAt
  ) VALUES (
    @id, @entityAId, @entityBId, @reason, @confidence, 'PENDING', @createdAt
  )
`);

const updatePaperEntityId = db.prepare("UPDATE Paper SET entityId = ? WHERE id = ?");
const updateProposalEntityId = db.prepare("UPDATE DiscoveryProposal SET entityId = ? WHERE id = ?");

function ensureCandidateLink(entityAId, entityBId, reason, confidence) {
  if (!entityAId || !entityBId || entityAId === entityBId) return;
  const [orderedA, orderedB] = orderedPair(entityAId, entityBId);
  insertCandidateLink.run({
    id: crypto.randomUUID(),
    entityAId: orderedA,
    entityBId: orderedB,
    reason,
    confidence,
    createdAt: new Date().toISOString(),
  });
}

function chooseOrCreateEntity(record, source, identifierMap) {
  const identifiers = [];
  if (record.doi) identifiers.push({ type: "doi", raw: record.doi, value: normalizeIdentifier("doi", record.doi) });
  if (record.arxivId) identifiers.push({ type: "arxiv", raw: record.arxivId, value: normalizeIdentifier("arxiv", record.arxivId) });
  if (record.semanticScholarId) {
    identifiers.push({
      type: "semantic_scholar",
      raw: record.semanticScholarId,
      value: normalizeIdentifier("semantic_scholar", record.semanticScholarId),
    });
  }

  if (identifiers.length === 0) {
    return { entityId: null, identifiers };
  }

  let entityId = null;
  const conflictingEntities = new Set();

  for (const identifier of identifiers) {
    const existing = identifierMap.get(`${identifier.type}::${identifier.value}`);
    if (!existing) continue;
    if (!entityId) {
      entityId = existing;
    } else if (existing !== entityId) {
      conflictingEntities.add(existing);
    }
  }

  if (!entityId) {
    entityId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    insertPaperEntity.run({
      id: entityId,
      title: record.title,
      authors: record.authors || null,
      year: record.year || null,
      venue: record.venue || null,
      abstract: record.abstract || null,
      titleSource: source,
      authorsSource: record.authors ? source : null,
      yearSource: record.year || null ? source : null,
      venueSource: record.venue ? source : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } else {
    updatePaperEntity.run({
      id: entityId,
      title: record.title,
      authors: record.authors || null,
      year: record.year || null,
      venue: record.venue || null,
      abstract: record.abstract || null,
      updatedAt: new Date().toISOString(),
    });
  }

  for (const conflict of conflictingEntities) {
    ensureCandidateLink(entityId, conflict, "identifier_conflict", 0.8);
  }

  for (const identifier of identifiers) {
    const key = `${identifier.type}::${identifier.value}`;
    const existing = identifierMap.get(key);
    if (existing && existing !== entityId) {
      ensureCandidateLink(entityId, existing, "identifier_conflict", 0.8);
      continue;
    }

    insertPaperIdentifier.run({
      id: crypto.randomUUID(),
      entityId,
      type: identifier.type,
      value: identifier.value,
      raw: identifier.raw,
      source,
      confidence: 1.0,
      createdAt: new Date().toISOString(),
    });
    identifierMap.set(key, entityId);
  }

  return { entityId, identifiers };
}

function backfillEntities() {
  const identifierMap = loadIdentifierMap();
  const assignedPairs = loadAssignedEntityPairs();

  const paperRows = db.prepare(`
    SELECT id, userId, title, authors, year, venue, abstract, doi, arxivId
    FROM Paper
    WHERE entityId IS NULL
  `).all();

  const proposalRows = db.prepare(`
    SELECT id, title, authors, year, venue, doi, arxivId, semanticScholarId
    FROM DiscoveryProposal
    WHERE entityId IS NULL
  `).all();

  let papersUpdated = 0;
  let papersSkippedNoIds = 0;
  let papersSkippedDuplicate = 0;
  let proposalsUpdated = 0;
  let proposalsSkippedNoIds = 0;

  const run = db.transaction(() => {
    for (const paper of paperRows) {
      const { entityId, identifiers } = chooseOrCreateEntity(paper, "import", identifierMap);
      if (!entityId) {
        papersSkippedNoIds++;
        continue;
      }

      if (paper.userId) {
        const key = `${paper.userId}::${entityId}`;
        if (assignedPairs.has(key)) {
          papersSkippedDuplicate++;
          continue;
        }
        assignedPairs.add(key);
      }

      updatePaperEntityId.run(entityId, paper.id);
      papersUpdated++;
    }

    for (const proposal of proposalRows) {
      const { entityId, identifiers } = chooseOrCreateEntity(proposal, "discovery", identifierMap);
      if (!entityId || identifiers.length === 0) {
        proposalsSkippedNoIds++;
        continue;
      }

      updateProposalEntityId.run(entityId, proposal.id);
      proposalsUpdated++;
    }
  });

  run();

  return {
    papers: {
      updated: papersUpdated,
      skippedNoIds: papersSkippedNoIds,
      skippedDuplicate: papersSkippedDuplicate,
    },
    proposals: {
      updated: proposalsUpdated,
      skippedNoIds: proposalsSkippedNoIds,
    },
  };
}

function backfillReferenceEntries() {
  const identifierMap = loadIdentifierMap();

  const existingEntries = new Map(
    db.prepare(`
      SELECT id, legacyReferenceId, resolvedEntityId, resolveSource
      FROM ReferenceEntry
      WHERE legacyReferenceId IS NOT NULL
    `)
      .all()
      .filter((row) => row.legacyReferenceId)
      .map((row) => [row.legacyReferenceId, row])
  );

  const legacyReferences = db.prepare(`
    SELECT id, paperId, title, authors, year, venue, doi, arxivId, externalUrl, semanticScholarId, rawCitation, referenceIndex
    FROM Reference
  `).all();

  const insertReferenceEntry = db.prepare(`
    INSERT INTO ReferenceEntry (
      id, paperId, referenceIndex, rawCitation, title, authors, year, venue,
      doi, arxivId, externalUrl, semanticScholarId,
      resolvedEntityId, resolveConfidence, resolveSource,
      provenance, extractorVersion, legacyReferenceId, createdAt
    ) VALUES (
      @id, @paperId, @referenceIndex, @rawCitation, @title, @authors, @year, @venue,
      @doi, @arxivId, @externalUrl, @semanticScholarId,
      @resolvedEntityId, @resolveConfidence, @resolveSource,
      @provenance, @extractorVersion, @legacyReferenceId, @createdAt
    )
  `);

  const updateReferenceResolution = db.prepare(`
    UPDATE ReferenceEntry
    SET
      resolvedEntityId = @resolvedEntityId,
      resolveConfidence = @resolveConfidence,
      resolveSource = @resolveSource
    WHERE id = @id
  `);

  let created = 0;
  let rechecked = 0;
  let resolvedOnCreate = 0;
  let resolvedOnUpdate = 0;

  const run = db.transaction(() => {
    for (const reference of legacyReferences) {
      let resolvedEntityId = null;
      let resolveSource = null;
      if (reference.doi) {
        const match = identifierMap.get(`doi::${normalizeIdentifier("doi", reference.doi)}`);
        if (match) {
          resolvedEntityId = match;
          resolveSource = "doi_match";
        }
      }
      if (!resolvedEntityId && reference.arxivId) {
        const match = identifierMap.get(`arxiv::${normalizeIdentifier("arxiv", reference.arxivId)}`);
        if (match) {
          resolvedEntityId = match;
          resolveSource = "arxiv_match";
        }
      }

      const existing = existingEntries.get(reference.id);
      if (existing) {
        rechecked++;
        if (
          resolvedEntityId &&
          (existing.resolvedEntityId !== resolvedEntityId || existing.resolveSource !== resolveSource)
        ) {
          updateReferenceResolution.run({
            id: existing.id,
            resolvedEntityId,
            resolveConfidence: 1.0,
            resolveSource,
          });
          resolvedOnUpdate++;
        }
        continue;
      }

      insertReferenceEntry.run({
        id: crypto.randomUUID(),
        paperId: reference.paperId,
        referenceIndex: reference.referenceIndex,
        rawCitation: reference.rawCitation,
        title: reference.title,
        authors: reference.authors,
        year: reference.year,
        venue: reference.venue,
        doi: reference.doi,
        arxivId: reference.arxivId,
        externalUrl: reference.externalUrl,
        semanticScholarId: reference.semanticScholarId,
        resolvedEntityId,
        resolveConfidence: resolvedEntityId ? 1.0 : null,
        resolveSource,
        provenance: "llm_extraction",
        extractorVersion: "backfill_v1",
        legacyReferenceId: reference.id,
        createdAt: new Date().toISOString(),
      });

      created++;
      if (resolvedEntityId) resolvedOnCreate++;
    }
  });

  run();
  return { created, rechecked, resolvedOnCreate, resolvedOnUpdate };
}

function backfillRelationAssertions() {
  const rows = db.prepare(`
    SELECT
      pr.id,
      pr.sourcePaperId,
      pr.targetPaperId,
      pr.relationType,
      pr.description,
      pr.confidence,
      pr.isAutoGenerated,
      sp.entityId AS sourceEntityId,
      tp.entityId AS targetEntityId
    FROM PaperRelation pr
    JOIN Paper sp ON sp.id = pr.sourcePaperId
    JOIN Paper tp ON tp.id = pr.targetPaperId
  `).all();

  const upsertAssertion = db.prepare(`
    INSERT INTO RelationAssertion (
      id, sourceEntityId, targetEntityId, sourcePaperId,
      relationType, description, confidence, provenance, extractorVersion, createdAt
    ) VALUES (
      @id, @sourceEntityId, @targetEntityId, @sourcePaperId,
      @relationType, @description, @confidence, @provenance, @extractorVersion, @createdAt
    )
    ON CONFLICT(sourcePaperId, targetEntityId, relationType, provenance)
    DO UPDATE SET
      description = excluded.description,
      confidence = excluded.confidence,
      extractorVersion = excluded.extractorVersion
  `);

  let touched = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (const row of rows) {
      if (!row.sourceEntityId || !row.targetEntityId) {
        skipped++;
        continue;
      }

      const provenance = row.isAutoGenerated
        ? (row.relationType === "cites" ? "reference_match" : "llm_semantic")
        : "user_manual";

      upsertAssertion.run({
        id: crypto.randomUUID(),
        sourceEntityId: row.sourceEntityId,
        targetEntityId: row.targetEntityId,
        sourcePaperId: row.sourcePaperId,
        relationType: row.relationType,
        description: row.description,
        confidence: row.confidence,
        provenance,
        extractorVersion: "legacy_backfill_v1",
        createdAt: new Date().toISOString(),
      });

      touched++;
    }
  });

  run();
  return { touched, skipped };
}

function readCounts() {
  const count = (table) => db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
  return {
    Paper: count("Paper"),
    DiscoveryProposal: count("DiscoveryProposal"),
    PaperEntity: count("PaperEntity"),
    PaperIdentifier: count("PaperIdentifier"),
    Reference: count("Reference"),
    ReferenceEntry: count("ReferenceEntry"),
    PaperRelation: count("PaperRelation"),
    RelationAssertion: count("RelationAssertion"),
    linkedPapers: db.prepare("SELECT count(*) AS c FROM Paper WHERE entityId IS NOT NULL").get().c,
    linkedProposals: db.prepare("SELECT count(*) AS c FROM DiscoveryProposal WHERE entityId IS NOT NULL").get().c,
  };
}

function main() {
  const before = readCounts();
  const entities = backfillEntities();
  const references = backfillReferenceEntries();
  const assertions = backfillRelationAssertions();
  const after = readCounts();

  console.log(JSON.stringify({ dbPath, before, entities, references, assertions, after }, null, 2));
}

try {
  main();
} finally {
  db.close();
}
