# Retrieval Representation Design

This tranche introduces a retrieval substrate, not a final model choice.

## What ships in PR 5

- a persistent `PaperRepresentation` store keyed by `(paperId, representationKind)`
- one baseline representation kind: `shared_raw_features_v1`
- one baseline encoder version: `feature_hash_256_v1`
- shared candidate generation and diversification modules
- idempotent backfill tooling for existing papers

## Why the baseline is feature hashing

PR 5 needs a real, runnable substrate before PR 6 through PR 8 choose the winning retrieval and reranking families on judged benchmarks. A local hashed-vector baseline gives us:

- deterministic output
- zero network dependency
- cheap backfill and testability
- a stable persistence contract for later encoders

This is deliberately **not** the frozen final representation. The execution plan already allows:

- task-specific encoders per retrieval task
- cross-encoders or LLM/listwise rerankers when they win
- external ANN stores later if the judged suite and latency budgets justify them

## Feature document

`shared_raw_features_v1` builds one normalized feature document per paper from:

- title
- abstract
- summary
- key findings
- normalized author names
- venue and year
- tag names
- normalized claim text plus rhetorical role / facet / polarity / evaluation context fragments

The feature document is persisted as debug text alongside the vector so later ranking failures are inspectable.

## Persistence contract

- `representationKind` identifies the logical representation family
- `encoderVersion` identifies the concrete encoder implementation
- `sourceFingerprint` is the SHA-256 of the feature document
- reruns are idempotent: unchanged fingerprints do not create new rows

That means PR 6 through PR 8 can upgrade representation quality without rewriting the surrounding retrieval APIs.
