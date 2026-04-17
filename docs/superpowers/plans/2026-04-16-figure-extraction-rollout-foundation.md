# Figure Extraction Rollout Foundation: Immutable Evidence, Versioned Snapshots, and Published Views

**Date:** 2026-04-16
**Status:** Proposed
**Depends on:** Tranche 1 (`d8325b5`, `b39a9ad`, `8610e01`), Tranche 2 (`a1348ae`, `ca3ecb2`, `75797e8`)
**Spec:** `docs/superpowers/specs/2026-04-15-figure-extraction-pipeline.md`
**Status note:** `docs/superpowers/notes/2026-04-15-figure-extraction-status.md`

## Executive Summary

The pipeline is now blocked by model and lifecycle flaws, not parser flaws.

The recurring failures all come from the same root problem:

- raw evidence, semantic identity, canonical projection, render outputs, and published views are still too entangled
- published state is still too close to mutable working state
- reruns still conceptually rewrite the same rows instead of promoting a new snapshot

The principled fix is:

**immutable evidence in, versioned derivations out, atomic promotion at the publication boundary**

That means:

1. blobs are content-addressed
2. source evidence is immutable
3. semantic identity is versioned
4. canonical projection is versioned
5. preview publication is versioned
6. the published view is a cache of active snapshots, not the workbench

This document is the final architecture for getting there.

---

## Design Principles

1. Every derived thing is versioned.
2. Every blob is content-addressed.
3. Only fully validated snapshots get promoted.
4. Published state is never edited in place.
5. Rendering is enrichment, not semantic truth.
6. Preview publication is a separate concern from semantic publication.
7. Capability is evaluator output, not a permanent attribute.
8. Human overrides are versioned policy inputs, not manual row edits.
9. Every reprocessing action targets one control plane only.

---

## Control Planes

The system is split into seven control planes:

1. **Metadata and capability**
   - identity recovery
   - source eligibility
   - stale/refresh rules
2. **Evidence extraction**
   - source candidates
   - source-local locators
   - source diagnostics
3. **Identity resolution**
   - semantic grouping of candidates
4. **Canonical projection**
   - choose content, base preview, and page anchor independently
   - build a publishable semantic snapshot
5. **Render generation**
   - HTML table renders
   - composed-figure container renders
6. **Preview publication**
   - choose the currently published preview for each projected figure
7. **Publication**
   - active-pointer swaps
   - compatibility-cache refresh

Patchiness happens when one plane mutates state owned by another.

---

## Non-Goals

This plan does **not** attempt to solve:

- generalized publisher expansion beyond the current allowlist
- UI polish for preview presentation
- math-aware cleanup of LaTeXML-heavy structured content
- a gold-standard benchmark with human-annotated bounding boxes

Those can follow later. This plan is about making extraction trustworthy enough for staged rollout.

---

## System Models

## 1. `Asset`

Content-addressed evidence blob.

Purpose:

- stable identity for images and renders
- duplicate reasoning across sources
- retention and GC safety

Required fields:

- `id`
- `contentHash`
- `storageUri`
- `mimeType`
- `byteSize`
- `width`
- `height`
- `assetKind`
  - `native_source`
  - `pdf_crop`
  - `rendered_preview`
- `producerType`
  - `extractor`
  - `renderer`
  - `ingester`
- `producerVersion`
- `createdAt`

Rule:

- filesystem paths are cache coordinates, not identity
- `contentHash` is the durable identity of the blob

## 2. `SourceCapabilityEvaluation`

Versioned per-source capability result for a paper.

Purpose:

- durable source eligibility state
- refresh and staleness control
- auditability of capability decisions

Required fields:

- `paperId`
- `source`
  - `pmc_jats`
  - `arxiv_html`
  - `publisher_html`
- `status`
  - `usable`
  - `unusable`
  - `unknown`
  - `stale`
- `reasonCode`
- `checkedAt`
- `evaluatorVersion`
- `inputsHash`

Rule:

- `structured_none` is **not** a source capability
- paper-level rollout class is derived separately

## 3. `PaperCoverageClass`

Derived paper-level classification from source evaluations.

Examples:

- `both`
- `pmc_usable`
- `arxiv_usable`
- `publisher_html_usable`
- `structured_none`

Purpose:

- drive rollout rings cleanly
- avoid pretending “no structured source” is a real source

## 4. `CapabilitySnapshot`

Immutable paper-scoped capability input for extraction.

Purpose:

- make extraction reproducible against exact eligibility inputs
- avoid depending on whichever capability rows happen to be active later

Required fields:

- `paperId`
- `snapshotVersion`
- `coverageClass`
- `inputsHash`
- `createdAt`

Rule:

- extraction consumes a `CapabilitySnapshot`, not ad hoc active capability rows

## 5. `CapabilitySnapshotEntry`

Per-source membership row inside one `CapabilitySnapshot`.

Purpose:

- preserve the exact capability evaluations used by extraction

Required fields:

- `capabilitySnapshotId`
- `source`
- `sourceCapabilityEvaluationId`
- `status`
- `reasonCode`

Rule:

- every real source represented in a snapshot points back to the concrete evaluation row used

## 6. `ExtractionRun`

One paper-scoped evidence extraction attempt.

Purpose:

- provenance for emitted candidates
- reproducibility
- run-level status and errors

Required fields:

- `paperId`
- `startedAt`, `finishedAt`
- `extractorVersion`
- `capabilitySnapshotId`
- `status`
- `errorSummary`
- `evidenceStatus`
  - `complete`
  - `partial`
  - `degraded`

## 7. `ExtractionSourceAttempt`

Per-source attempt record under one `ExtractionRun`.

Purpose:

- make evidence completeness explicit
- distinguish true absence from source failure or skip

Required fields:

- `extractionRunId`
- `source`
- `status`
  - `skipped_by_capability`
  - `attempted`
  - `partial`
  - `succeeded`
  - `failed`
  - `timed_out`
- `reasonCode`
- `startedAt`
- `finishedAt`
- `candidateCount`
- `errorSummary`

Rule:

- every real source gets a terminal attempt record per run

## 8. `FigureCandidate`

Immutable source fact emitted by one extractor in one run.

Purpose:

- preserve raw evidence
- keep canonical logic auditable
- keep source facts separate from product truth

Required fields:

- `paperId`
- `candidateOrigin`
  - `extracted`
  - `legacy_bootstrap`
- `extractionRunId` (required when `candidateOrigin = extracted`)
- `bootstrapRunId` (required when `candidateOrigin = legacy_bootstrap`)
- `sourceMethod`
- `type`
- `sourceLocalLocator`
- `locatorSupport`
  - `native`
  - `derived`
  - `unsupported`
- `sourceNamespace`
- `sourceOrder`
- `figureLabelRaw`
- `figureLabelNormalized`
- `captionTextRaw`
- `structuredContentRaw`
- `structuredContentType`
- `nativeAssetId`
- `nativePreviewTrust`
  - `trusted_native`
  - `untrusted_native`
  - `none`
- `pageAnchorCandidate`
- `confidence`
- `diagnostics`

Rule:

- candidates are immutable once written
- they are never rewritten into canonical truth

Supersession rule:

- when a paper has both `legacy_bootstrap` candidates and `extracted` candidates from a real extraction run, the `extracted` candidates **supersede** the bootstrap candidates for identity resolution and projection purposes
- identity resolution must exclude `legacy_bootstrap` candidates from the evidence pool when any `extracted` candidate set exists for the same paper
- bootstrap candidates remain immutable audit history but are no longer eligible as grouping or projection inputs once exact extraction has occurred
- this prevents duplicate identities and stale bootstrap facts from polluting the clean snapshot model during migration

## 9. `IdentityResolution`

Paper-scoped snapshot of semantic grouping.

Purpose:

- version identity logic
- prevent silent identity drift

Required fields:

- `paperId`
- `provenanceKind`
  - `extraction`
  - `legacy_bootstrap`
- `extractionRunId` (required when `provenanceKind = extraction`)
- `bootstrapRunId` (required when `provenanceKind = legacy_bootstrap`)
- `resolverVersion`
- `status`
- `createdAt`
- `promotedAt`

Rule:

- exactly one of `extractionRunId` or `bootstrapRunId` must be set, matching `provenanceKind`

## 10. `FigureIdentity`

Semantic object inside one `IdentityResolution`.

Purpose:

- group multiple candidates that refer to the same real figure/table

Required fields:

- `identityResolutionId`
- `paperId`
- `type`
- `identityNamespace`
- `canonicalLabelNormalized`
- `identityKey`

Rule:

- `identityKey` is resolver-owned
- normalized label is one signal, not identity itself

## 11. `PublishedFigureHandle`

Long-lived published handle for a semantic figure/table.

Purpose:

- preserve stable public/cache identity across promotions

Required fields:

- `paperId`
- `publicKey`
- `status`
- `createdAt`
- `retiredAt`

Rule:

- handles survive republishing when the semantic object is still the same

## 12. `ProjectionRun`

Paper-scoped canonical projection snapshot.

Purpose:

- build published semantic view off to the side
- support atomic promotion

Required fields:

- `paperId`
- `identityResolutionId`
- `provenanceKind`
  - `extraction`
  - `legacy_bootstrap`
- `projectionVersion`
- `status`
- `evidenceStatus`
  - `complete`
  - `partial`
  - `degraded`
- `comparisonStatus`
  - `not_compared`
  - `safe_to_replace`
  - `regression_blocked`
  - `forced`
- `comparisonSummary`
- `createdAt`
- `promotedAt`

Rule:

- `provenanceKind` must match the `provenanceKind` of the linked `IdentityResolution`

## 13. `ProjectionFigure`

One canonical projected figure/table inside a `ProjectionRun`.

Purpose:

- canonical content, base preview candidate, and page anchor chosen independently

Required fields:

- `projectionRunId`
- `figureIdentityId`
- `publishedFigureHandleId`
- `predecessorProjectionFigureId`
- `handleAssignmentDecision`
  - `reuse`
  - `new`
- `handleAssignmentVersion`
- `handleAssignmentEvidenceType`
- `handleAssignmentEvidenceIds`
- `publishedHandleAssignmentReason`
- `sourceMethod`
- `imageSourceMethod`
- `pageSourceMethod`
- `contentCandidateId`
- `basePreviewCandidateId`
- `pageAnchorCandidateId`
- `contentLineageQuality`
  - `exact`
  - `bootstrapped_legacy`
  - `unknown_legacy`
- `previewLineageQuality`
  - `exact`
  - `bootstrapped_legacy`
  - `unknown_legacy`
- `pageAnchorLineageQuality`
  - `exact`
  - `bootstrapped_legacy`
  - `unknown_legacy`
- `figureLabel`
- `captionText`
- `structuredContent`
- `structuredContentType`
- `contentDerivationReason`
- `previewDerivationReason`
- `pageAnchorDerivationReason`
- `basePreviewAssetId`
- `basePreviewTrust`
  - `trusted_native`
  - `none`
- `previewRenderIntent`
  - `none`
  - `render_table_container`
  - `render_figure_container`
- `pdfPage`
- `bbox`
- `gapReason`

Rule:

- semantic truth lives here
- currently published preview does **not** live here

## 14. `RenderRun`

Paper-scoped render-generation run against a `ProjectionRun`.

Purpose:

- version rendered outputs
- separate render provenance from semantic truth

Required fields:

- `paperId`
- `projectionRunId`
- `rendererVersion`
- `templateVersion`
- `browserVersion`
- `status`
- `createdAt`

## 15. `RenderedPreview`

Rendered output for one projected figure.

Required fields:

- `renderRunId`
- `projectionFigureId`
- `assetId`
- `renderMode`
  - `html_table`
  - `figure_container`
- `inputHash`

Rule:

- render existence does not publish it

## 16. `PreviewSelectionRun`

Paper-scoped preview-publication snapshot for one active `ProjectionRun`.

Purpose:

- publish preview choices separately from semantic projection
- keep preview publication versioned and auditable

Required fields:

- `paperId`
- `projectionRunId`
- `selectionVersion`
- `selectionKind`
  - `activation`
  - `enrichment`
  - `bootstrap`
- `supersedesPreviewSelectionRunId`
- `comparisonStatus`
  - `not_compared`
  - `safe_to_replace`
  - `regression_blocked`
  - `forced`
- `comparisonSummary`
- `publicationMode`
  - `normal`
  - `forced`
- `status`
- `createdAt`
- `promotedAt`

## 17. `PreviewSelectionFigure`

Published preview choice for one `ProjectionFigure`.

Required fields:

- `previewSelectionRunId`
- `projectionFigureId`
- `selectedPreviewAssetId`
- `selectedPreviewTrust`
- `selectedPreviewSource`
  - `native`
  - `rendered`
  - `none`
- `selectedRenderedPreviewId`
- `selectedNativeCandidateId`
- `selectionLineageQuality`
  - `exact`
  - `bootstrapped_legacy`
  - `unknown_legacy`
- `selectionReason`

Rule:

- this is the single published preview pointer

## 18. `PaperPublicationState`

Per-paper published-view pointers.

Required fields:

- `paperId`
- `activeProjectionRunId`
- `activeIdentityResolutionId`
- `activePreviewSelectionRunId`
- `lastPublishedAt`

Rule:

- API reads only the active published snapshot

## 19. `PaperFigure`

Compatibility publication cache for the active projection and preview selection.

Purpose:

- keep existing API/UI/read paths working during migration
- mirror the active published view in a familiar row shape

Rule:

- `PaperFigure` is not the source of truth
- it is keyed by stable `PublishedFigureHandle`
- it is repopulated from the active projection and active preview selection during both semantic publication and preview publication
- no extractor or merger writes business logic directly into `PaperFigure`

## 20. `PaperWorkLease`

Per-paper concurrency guard.

Required fields:

- `paperId`
- `leaseToken`
- `holder`
- `expiresAt`

Rule:

- at most one write pipeline owns a paper at a time

## 21. `AssetIngestionRun`

Legacy-asset bootstrap run for papers with pre-asset-store files.

Purpose:

- ingest existing preview/source files into the `Asset` model
- avoid a big-bang asset cutover

Required fields:

- `paperId`
- `ingesterVersion`
- `status`
- `createdAt`

## 22. `LegacyPublicationBootstrapRun`

Bootstrap run that lifts an already-published legacy paper into the snapshot model without pretending exact extractor lineage.

Purpose:

- create an honest initial snapshot pair for legacy papers
- avoid hidden big-bang re-extraction requirements
- own the migration plane separately from the real extraction contract

Required fields:

- `paperId`
- `bootstrapVersion`
- `status`
- `createdAt`

Rule:

- bootstrap lineage must be marked `bootstrapped_legacy` or `unknown_legacy`, never `exact`

Migration plane separation:

- bootstrap does **not** create a synthetic `CapabilitySnapshot`, `ExtractionRun`, or `ExtractionSourceAttempt` — those models are reserved for real extraction
- bootstrap emits `FigureCandidate` rows with `candidateOrigin = legacy_bootstrap` and `bootstrapRunId` pointing to this run (not `extractionRunId`)
- `IdentityResolution`, `ProjectionRun`, and `PreviewSelectionRun` created during bootstrap link to the `LegacyPublicationBootstrapRun` as their provenance root, not to a fake extraction chain
- this keeps `SourceCapabilityEvaluation`, `PaperCoverageClass`, `CapabilitySnapshot`, and `ExtractionRun` clean of migration-only state

## 22a. `PaperMigrationState`

Per-paper migration lifecycle tracking.

Purpose:

- track whether a paper has been bootstrapped into the snapshot model
- track when bootstrap lineage has been superseded by real extraction
- provide a single query point for migration status without inspecting candidate origins

Required fields:

- `paperId`
- `migrationStatus`
  - `not_started`
  - `assets_ingested`
  - `bootstrapped`
  - `superseded_by_extraction`
- `bootstrapRunId`
- `supersedingExtractionRunId` (set when first real extraction completes)
- `updatedAt`

Rule:

- `migrationStatus` transitions are monotonic: `not_started` → `assets_ingested` → `bootstrapped` → `superseded_by_extraction`
- once `superseded_by_extraction`, bootstrap candidates are excluded from identity resolution and projection (enforced by the supersession rule on `FigureCandidate`)

## 23. `FigureOverrideRule`

Versioned human override.

Purpose:

- handle irreducibly ambiguous cases without DB surgery

Required fields:

- `paperId`
- `overrideType`
  - `merge_identities`
  - `split_identity`
  - `force_preview_asset`
  - `suppress_preview`
  - `force_gap`
  - `force_namespace`
- `target`
- `createdBy`
- `reason`
- `version`
- `scope`
- `status`
  - `active`
  - `stale`
  - `superseded`
  - `disabled`

Rule:

- overrides are declarative inputs
- they are not manual edits to published rows

---

## Core Invariants

1. Published semantic state is a snapshot, not mutable working state.
2. Published preview state is a snapshot, not mutable working state.
3. `ProjectionRun` promotion is the only way published semantic state changes.
4. `PreviewSelectionRun` promotion is the only way published preview state changes.
5. `FigureCandidate` rows are immutable raw evidence.
6. `Asset` is content-addressed; paths are not evidence identity.
7. Semantic identity is resolver-owned and versioned.
8. Preview existence is not enough; preview trust must be explicit.
9. Suspicious native assets do not become canonical previews.
10. Rendering is deferred enrichment by default.
11. Capability is versioned derived state and can become stale.
12. PDF fallback emits rescue candidates; it does not self-promote to canonical truth.
13. Uncaptioned PDF assets never become canonical by default.
14. Manual overrides are versioned policy inputs, not edits to published rows.
15. Every published semantic snapshot has a matching published preview-selection snapshot.
16. Every published field choice points back to exact evidence lineage.
17. Normal publication may not silently replace a healthier active paper snapshot with a regressed one.
18. Extraction consumes an immutable capability snapshot, not live capability rows.
19. Published-handle reuse is deterministic and validated, not informal best effort.
20. Stage 4 publishes a validated semantic snapshot and a validated activation preview snapshot together.
21. Semantic non-regression and preview-improvement policy are evaluated separately.
22. Legacy bootstrap never claims exact lineage it does not have.
23. Bootstrap candidates are superseded and excluded from identity resolution and projection once any exact-lineage extraction exists for the same paper.
24. Retention must keep every `RenderRun` and `RenderedPreview` row reachable from the active preview selection — published preview lineage must not point at GC-eligible records.
25. Preview comparison must be computed and persisted before any preview publication validator runs — the validator consumes the persisted result, not an implicit assumption that comparison happened.

---

## Stage Transitions

## Stage 0: Capability Evaluation

Input:

- paper metadata
- evaluator version

Output:

- one or more `SourceCapabilityEvaluation` rows
- derived `PaperCoverageClass`

Rules:

- refresh if stale
- do not treat stale as false

## Stage 0.5: Capability Snapshot Creation

Input:

- current `SourceCapabilityEvaluation` rows
- derived `PaperCoverageClass`

Output:

- one `CapabilitySnapshot`
- one or more `CapabilitySnapshotEntry` rows

Rules:

- snapshot creation is immutable and paper-scoped
- extraction must link to the exact capability snapshot it consumed

## Stage 1: Evidence Extraction

Input:

- paper
- immutable `CapabilitySnapshot`
- extractor version

Output:

- one `ExtractionRun`
- terminal `ExtractionSourceAttempt` rows for all real sources
- immutable `FigureCandidate` rows
- referenced `Asset` rows

Rules:

- extractors must emit `sourceLocalLocator` and `sourceNamespace` whenever the source supports them
- if a source cannot provide one, it must explicitly mark support as `unsupported`
- suspicious native assets become `untrusted_native`, not previews
- every source that is usable or considered must produce a terminal attempt record

## Stage 2: Identity Resolution

Input:

- one evidence root: either an `ExtractionRun` (for real extraction) or a `LegacyPublicationBootstrapRun` (for bootstrap)
- all `FigureCandidate` rows linked to that evidence root (via `extractionRunId` or `bootstrapRunId` respectively)
- active overrides
- resolver version

Output:

- one `IdentityResolution` with `provenanceKind` matching the evidence root
- one or more `FigureIdentity` rows

Rules:

- deterministic for the same candidate set and resolver version
- if resolver version changes, compute a new snapshot rather than mutating old identities
- the resulting `IdentityResolution` records `extractionRunId` or `bootstrapRunId` matching its evidence root, never both
- when `extracted` candidates exist for the paper, `legacy_bootstrap` candidates are excluded from the evidence pool — the resolver operates only on exact-lineage evidence
- bootstrap candidates are only eligible for identity resolution when no real extraction run has produced candidates for the paper

## Stage 3: Canonical Projection

Input:

- one `IdentityResolution`
- source candidates
- projection version

Output:

- one `ProjectionRun`
- one or more `ProjectionFigure` rows

Rules:

- choose content source, base preview candidate, and page anchor independently
- canonical preview may be absent even when content is present
- page anchor may come from PDF even if the base preview candidate comes from an HTML/PMC native asset or the later published preview comes from rendering
- every published field choice records exact lineage back to candidate evidence
- attach or reuse stable `PublishedFigureHandle`s only through deterministic continuity rules

## Stage 3.5: Semantic Publication Comparison

Input:

- candidate `ProjectionRun`
- current active `ProjectionRun`, if one exists

Output:

- `ProjectionRun.comparisonStatus`
- `ProjectionRun.comparisonSummary`

Rules:

- compare semantic identity set, content coverage, page-anchor coverage, structured-source contribution, and evidence completeness against the active paper snapshot
- classify per-identity diffs as `additive_gain`, `duplicate_collapse`, `junk_suppression`, `anchor_improvement`, `namespace_correction`, `risky_loss`, `identity_split`, or `identity_merge`
- normal publication requires `safe_to_replace`
- duplicate collapse, junk suppression, namespace correction, and anchor improvement are cleanup-safe deltas, not regressions
- degraded snapshots may exist without being published
- forced publication requires explicit operator action or override-backed policy

## Stage 4: Semantic + Activation Preview Publication

Input:

- successful `ProjectionRun`
- held `PaperWorkLease`

Output:

- atomic pointer swap on `PaperPublicationState.activeProjectionRunId`
- atomic pointer swap on `activeIdentityResolutionId`
- creation and promotion of an activation `PreviewSelectionRun` aligned to the newly active projection
- atomic pointer swap on `activePreviewSelectionRunId` to that activation selection
- refresh of `PaperFigure` compatibility cache from the newly active projection and activation preview selection

Rules:

- compare-and-swap active pointers under the lease
- only fully validated projection and activation-preview pairs can be promoted
- normal publication may not promote a materially regressed projection over a healthier active snapshot
- activation preview selection carries forward the prior selected preview when semantic continuity holds and the prior preview remains valid for the newly activated projection
- activation preview selection falls back to trusted native base preview only when no valid carried-forward preview exists
- activation preview selection falls back to `none` only when neither carried-forward nor trusted native preview is valid
- previous active projection remains readable until swap succeeds
- `PaperFigure` cache refresh happens in the same semantic-publication transaction

## Stage 5: Render Generation

Input:

- active `ProjectionRun`
- projection figures with `previewRenderIntent != none`

Output:

- one `RenderRun`
- zero or more `RenderedPreview` rows
- new `Asset` rows for rendered previews

Rules:

- rendering does not change semantic truth
- rendering failure does not invalidate the active projection

## Stage 5.5: Preview Publication Comparison

Input:

- candidate `PreviewSelectionRun` (either activation from Stage 4 or enrichment after Stage 5)
- current active `PreviewSelectionRun`
- active `ProjectionRun`

Output:

- `PreviewSelectionRun.comparisonStatus`
- `PreviewSelectionRun.comparisonSummary`

Rules:

- compare candidate preview selection quality against the current active preview selection across all comparison dimensions defined in the preview publication comparison policy
- classify per-figure diffs as `render_improvement`, `equivalent_carry_forward`, `native_fallback`, `suppression`, `risky_preview_loss`, or `stale_render_drop`
- normal preview publication requires `safe_to_replace`
- forced preview publication requires explicit operator action
- this stage must run and persist its result before Stage 4 activation preview publication or Stage 6 enrichment preview publication — the validators depend on the persisted comparison status
- for Stage 4 activation preview selection, the comparison is computed as part of the Stage 4 transaction before the activation preview validator runs
- for Stage 6 enrichment preview publication, the comparison must be computed after render generation and before the preview publication validator runs

## Stage 6: Preview Publication

Input:

- active `ProjectionRun`
- successful `RenderRun`
- current active `PreviewSelectionRun`
- persisted preview comparison result from Stage 5.5
- held `PaperWorkLease`

Output:

- one `PreviewSelectionRun`
- one `PreviewSelectionFigure` row per active `ProjectionFigure`
- refresh of `PaperFigure` compatibility cache from the active projection and newly active preview selection

Rules:

- preview publication is separate from render generation
- only one published preview pointer exists per projected figure
- preview publication compares candidate preview selection quality against the current active preview selection, not against semantic publication gates
- latest valid render wins only through explicit preview publication
- preview publication produces a full paper-scoped snapshot, not a partial patch
- rows without a better rendered preview carry forward the currently selected preview choice
- preview publication does not mutate semantic projection state

---

## Semantic Identity Rules

The resolver groups candidates using:

- `type`
- normalized label
- namespace hint: main / appendix / supplement / source-local section
- source-local locator
- page-anchor compatibility
- caption similarity
- source-local ordinal fallback

Resolver precedence:

1. exact stable source-local locator match across reruns
2. normalized label + namespace + compatible page anchor
3. caption similarity + nearby page anchor
4. source-local ordinal fallback

This is what fixes:

- appendix `Table 1` vs main `Table 1`
- label drift
- unlabeled figures
- HTML/PDF duplicate rows for the same semantic object

Rule:

- normalized label is a merge hint, never the semantic primary key

---

## Published Handle Assignment

Published-handle reuse is a first-class, validated decision during projection.

Assignment precedence:

1. explicit semantic continuity through predecessor lineage
2. same namespace plus resolver-approved continuity evidence
3. active override
4. otherwise allocate a new handle

Each `ProjectionFigure` must record:

- `publishedFigureHandleId`
- `predecessorProjectionFigureId`, if reused from prior publication
- `handleAssignmentDecision`
- `handleAssignmentVersion`
- `handleAssignmentEvidenceType`
- `handleAssignmentEvidenceIds`
- `publishedHandleAssignmentReason`

Validator rules:

- no two projected figures may claim the same published handle in one projection
- any handle reuse must carry a valid continuity reason
- any handle reuse must carry replayable structured continuity evidence, not only prose reason text

This is what keeps `PaperFigure` and published identifiers stable without relying on informal heuristics.

---

## Published Field Lineage

Every published semantic and preview choice must point back to exact evidence.

`ProjectionFigure` records:

- `contentCandidateId`
- `basePreviewCandidateId`
- `pageAnchorCandidateId`
- field-level lineage quality for content, preview, and page anchor
- derivation reasons for any synthesized or borrowed field choice

`PreviewSelectionFigure` records:

- `selectedPreviewAssetId`
- `selectedRenderedPreviewId`, when published preview is rendered
- `selectedNativeCandidateId`, when published preview is native
- `selectionLineageQuality`
- `selectionReason`

Rule:

- method names alone are not enough provenance; published rows must point to exact evidence ids
- bootstrap-derived lineage must be marked honestly as `bootstrapped_legacy` or `unknown_legacy`

---

## Preview Trust and Render Intent

Canonical base preview selection follows this policy:

1. if a native asset is present and trusted, it may become the base preview candidate
2. if a native asset is present but suspicious, it does not become the base preview candidate
3. set `previewRenderIntent`
4. allow deferred rendering and preview publication to fill the published preview later

This is what fixes:

- legend-strip assets
- wrong-child-image assets
- same-source bad previews that would otherwise win merely because an image exists

Rule:

- suspicious native asset => no base preview yet, not “preview plus later maybe render”

---

## Render Selection

Rendered previews are published separately from semantic projection.

Selection rules:

- every newly promoted semantic projection gets an activation `PreviewSelectionRun` immediately
- activation preview selection carries forward prior selected previews when semantic continuity holds and the previews remain valid
- activation preview selection uses trusted native base preview only when no valid carried-forward preview exists
- activation preview selection uses `none` only when neither carried-forward nor trusted native preview exists
- a `RenderedPreview` may be selected only for the active `ProjectionRun`
- selection must verify that `inputHash` still matches the current projection content
- latest valid render may win only through an explicit preview-publication step
- old valid selected preview remains published until a new preview selection is promoted

This prevents:

- accidental preview churn
- renderer output attaching to stale projections
- semantic state being mutated by rendering side effects

---

## Semantic Publication Comparison and Non-Regression Policy

Publishing a newer projection is not enough; it must also be safe to replace the active one.

Comparison inputs:

- candidate `ProjectionRun`
- current active `ProjectionRun`

Comparison dimensions:

- semantic identity set
- content coverage
- structured-source contribution
- page-anchor coverage
- source-attempt evidence completeness

Identity-level diff classes:

- `additive_gain`
- `duplicate_collapse`
- `junk_suppression`
- `anchor_improvement`
- `namespace_correction`
- `risky_loss`
- `identity_split`
- `identity_merge`

Publication modes:

- `normal`
  - allowed only when comparison is `safe_to_replace`
- `degraded_allowed`
  - allowed only for explicitly approved degraded run classes
- `forced`
  - allowed only through explicit operator action or override-backed policy

Rule:

- degraded or partial snapshots may be recorded without silently replacing a healthier active paper snapshot

---

## Preview Publication Comparison Policy

Preview publication is evaluated separately from semantic publication.

Comparison inputs:

- candidate `PreviewSelectionRun`
- current active `PreviewSelectionRun`
- active `ProjectionRun`

Comparison dimensions:

- trusted preview availability
- rendered-preview improvements over the current active preview layer
- carry-forward validity of existing selected previews during activation
- preview suppressions
- preview-source changes from `native` to `rendered` or vice versa

Preview diff classes:

- `render_improvement`
- `equivalent_carry_forward`
- `native_fallback`
- `suppression`
- `risky_preview_loss`
- `stale_render_drop`

Rule:

- preview enrichment may improve the active preview layer without blocking semantic publication, and semantic publication may proceed without waiting for preview enrichment
- preview publication persists its own comparison result and may not replace a healthier active preview layer in `normal` mode

---

## Projection Promotion Validator

Semantic publication is allowed only if all of these pass:

### Structural checks (all provenance kinds)

- every `FigureIdentity` resolves to at most one `ProjectionFigure`
- all referenced assets exist
- all projection rows belong to the same `ProjectionRun`
- all identities belong to the same `IdentityResolution`
- `ProjectionRun.provenanceKind` matches `IdentityResolution.provenanceKind`
- all published-handle assignments are unique and valid
- all published field lineage ids exist and belong to the expected run inputs
- all field-level lineage quality states are valid for the provenance actually available

### Provenance-specific structural checks

When `ProjectionRun.provenanceKind = extraction`:

- all usable or attempted sources have terminal `ExtractionSourceAttempt` rows
- `IdentityResolution.extractionRunId` references a valid `ExtractionRun`
- `ExtractionRun.capabilitySnapshotId` references a valid `CapabilitySnapshot`

When `ProjectionRun.provenanceKind = legacy_bootstrap`:

- `IdentityResolution.bootstrapRunId` references a valid `LegacyPublicationBootstrapRun`
- no `extractionRunId` or `capabilitySnapshotId` references exist on the identity resolution or its candidates
- all candidate `FigureCandidate.candidateOrigin` values are `legacy_bootstrap`
- all field-level lineage quality states are `bootstrapped_legacy` or `unknown_legacy`, never `exact`
- `PaperMigrationState.migrationStatus` is `bootstrapped` (not `not_started` or `assets_ingested`)

### Semantic checks

- no duplicate published semantic identities
- no impossible provenance combinations
- no uncaptioned PDF canonical if policy forbids it
- no base preview candidate from an untrusted native asset
- comparison status is `safe_to_replace`, unless publication mode explicitly allows degraded or forced publication

### Publication checks

- `PaperWorkLease` is held and valid
- active pointers have not changed incompatibly underneath the run
- dependency versions are recorded

Semantic publication only occurs after this validator succeeds.

---

## Activation Preview Selection Validator

Activation preview publication during Stage 4 is allowed only if all of these pass:

### Structural checks

- every active `ProjectionFigure` has exactly one activation `PreviewSelectionFigure`
- all activation selections belong to the same `PreviewSelectionRun`
- activation selection source is only `rendered`, `native`, or `none`

### Semantic checks

- when activation selection source is `rendered`, the carried-forward or reused render is still valid for the newly activated projection
- when activation selection source is `native`, `selectedNativeCandidateId` matches the projection’s `basePreviewCandidateId`
- when activation selection source is `none`, no rendered or native selection lineage is falsely attached
- no activation selection points at an untrusted native asset
- activation preview comparison status is `safe_to_replace`, unless publication mode explicitly allows forced replacement

### Publication checks

- activation preview selection targets the same projection being promoted in Stage 4
- `PaperWorkLease` is held and valid for the composite publication

Stage 4 publication only occurs after both the semantic validator and the activation-preview validator succeed.

---

## Preview Publication Validator

Preview publication is allowed only if all of these pass:

### Structural checks

- target `ProjectionRun` is still active
- all selected rendered assets exist
- all selected previews belong to the same `PreviewSelectionRun`
- every active `ProjectionFigure` has exactly one `PreviewSelectionFigure`
- all selected preview lineage ids are internally consistent with the active projection and chosen preview source

### Semantic checks

- when selected preview source is `rendered`, `RenderedPreview.inputHash` still matches the current projection content
- selected preview source is allowed by preview policy
- no selected preview points at an untrusted native asset
- preview comparison status is `safe_to_replace`, unless publication mode explicitly allows forced replacement

### Publication checks

- `PaperWorkLease` is held and valid, or active projection version is explicitly pinned
- active projection pointer has not changed incompatibly underneath the selection run

Preview publication only occurs after this validator succeeds.

---

## Rollback Semantics

### Capability evaluation failure

- no capability state is promoted
- previous non-stale capability state remains usable if policy allows

### Capability snapshot failure

- no capability snapshot is created
- extraction cannot proceed from live capability rows as a fallback

### Extraction failure

- `ExtractionRun.status = failed`
- no candidates are removed
- published semantic snapshot remains unchanged

### Identity resolution failure

- failed `IdentityResolution` remains non-active
- published semantic snapshot remains unchanged

### Projection failure

- failed `ProjectionRun` remains non-active
- published semantic snapshot remains unchanged

### Publication comparison failure

- `ProjectionRun.comparisonStatus = regression_blocked`
- candidate projection remains non-active
- published semantic snapshot remains unchanged

### Activation preview validation failure

- no semantic or preview pointer swap occurs for Stage 4
- `PaperFigure` cache remains on the previous published pair

### Semantic publication failure

- no semantic pointer swap occurs
- no `PaperFigure` cache refresh occurs
- published semantic snapshot remains unchanged

### Render generation failure

- failed `RenderRun` remains recorded
- active semantic snapshot remains unchanged

### Preview publication failure

- no preview-selection pointer swap occurs
- no `PaperFigure` cache refresh occurs
- previously selected preview remains published

Rule:

- all failures before publication are side snapshots, never published truth

---

## Concurrency Policy

Per-paper writes are serialized with `PaperWorkLease`.

Rules:

- only one extraction / projection / semantic-publication pipeline may hold the lease for a paper at a time
- preview publication must also respect the lease or target a still-active projection version
- a run may not promote if its lease is expired or if the paper’s active pointer changed incompatibly underneath it

This prevents:

- batch worker collisions
- manual reruns racing with background jobs
- renders attaching to stale projections

---

## Structured Content Migration

`structuredContent` migration is additive and compatibility-preserving.

### Phase M1: Additive schema

- add `structuredContent`
- add `structuredContentType`
- add `structuredContentBackfillState`
- keep `description` live

### Phase M2: Dual write

- all new structured payloads write to `structuredContent`
- prose continues to use `description`

### Phase M3: Dual read

- readers prefer `structuredContent`
- legacy fallback allowed only when `structuredContentBackfillState` says the row is a legacy structured-content row

### Phase M4: Deterministic backfill

Backfill only rows that pass an allowlist classifier, for example:

- `type = table`
- structured-source method
- strong structural markers such as `<table`, `ltx_tabular`, known JATS table fragments
- renderer/gap metadata that already proves structured backing

Ambiguous rows are not guessed. They are marked:

- `skipped`
- `manual_review`

### Phase M5: Cutover

- stop writing structured payloads into `description`
- keep compatibility reads for one more tranche
- remove fallback only after coverage is effectively complete

---

## Asset Ingestion Migration

The asset store must bootstrap the existing corpus.

### Phase A1: New writes only

- all new extraction and render outputs create `Asset` rows

### Phase A2: Legacy ingestion

- ingest currently referenced legacy `PaperFigure` files
- ingest known rendered preview files
- compute `contentHash`
- create `Asset`
- attach legacy references to `assetId`

### Phase A3: Touch-on-upgrade

- any paper entering the new snapshot pipeline must have its active legacy assets ingested first

This avoids a big-bang asset cutover.

---

## Legacy Publication Bootstrap

Legacy published papers need an explicit lift into the new source-of-truth model.

### Phase L1: Bootstrap eligibility

- a paper may enter bootstrap only after active legacy assets are ingested
- bootstrap consumes currently published `PaperFigure` rows plus ingested assets

### Phase L2: Bootstrap evidence import

- create a `LegacyPublicationBootstrapRun`
- emit `FigureCandidate` rows with `candidateOrigin = legacy_bootstrap` and `bootstrapRunId` linking to the bootstrap run
- attach ingested legacy assets and legacy-derived fields to those candidates
- set `PaperMigrationState.migrationStatus = bootstrapped`
- no `CapabilitySnapshot`, `ExtractionRun`, or `ExtractionSourceAttempt` is created — bootstrap lives in the migration plane, not the extraction plane

### Phase L3: Bootstrap snapshot creation

- create `PublishedFigureHandle`s for the currently published semantic objects
- create an `IdentityResolution`
- create a `ProjectionRun`
- create an activation `PreviewSelectionRun`
- mark lineage quality as `bootstrapped_legacy` or `unknown_legacy`

### Phase L4: Upgrade on first true extraction

- the first full snapshot-pipeline extraction supersedes bootstrap lineage with exact lineage
- once a real `ExtractionRun` with `extracted` candidates exists for a paper, all `legacy_bootstrap` candidates are excluded from identity resolution and projection — they remain as immutable audit history only
- `PaperMigrationState.migrationStatus` transitions to `superseded_by_extraction` and records the `supersedingExtractionRunId`
- identity resolution, projection, and publication proceed exclusively from the exact-lineage evidence pool
- bootstrap snapshots (identity resolution, projection, preview selection) remain readable audit history but are no longer active or promotable
- no manual intervention is required to trigger supersession — the presence of an `extracted` candidate set for the paper is sufficient

Rule:

- bootstrap is an explicit migration path through immutable evidence, not an implicit assumption that legacy papers already satisfy the new truth model

---

## Override Lifecycle

Override precedence:

- valid active override beats default resolver/projection policy
- conflicting active overrides fail validation and cannot be promoted

Override invalidation:

- if candidate set changes materially, override may become `stale`
- stale overrides require review before reuse
- superseded overrides remain for audit history

This prevents overrides from becoming a hidden second source of truth.

---

## Retention and Garbage Collection

Immutable evidence and snapshots require explicit retention rules.

### Keep indefinitely

- `PaperPublicationState`
- `PaperMigrationState`
- active `ProjectionRun`
- active `IdentityResolution`
- active `PreviewSelectionRun`
- active `PublishedFigureHandle`s
- the `ExtractionRun` referenced by the active `IdentityResolution` (when `provenanceKind = extraction`)
- the `CapabilitySnapshot` (and its `CapabilitySnapshotEntry` rows) referenced by that active `ExtractionRun`
- the `LegacyPublicationBootstrapRun` referenced by the active `IdentityResolution` (when `provenanceKind = legacy_bootstrap`)
- all `FigureCandidate` rows referenced by any active `ProjectionFigure` (via `contentCandidateId`, `basePreviewCandidateId`, `pageAnchorCandidateId`) or active `PreviewSelectionFigure` (via `selectedNativeCandidateId`)
- `RenderRun` rows referenced by active preview selections (the render run that produced the currently published rendered previews)
- `RenderedPreview` rows referenced by active `PreviewSelectionFigure.selectedRenderedPreviewId` (the rendered preview records backing the published preview pointers)
- assets referenced by active projections
- assets referenced by active preview selections
- manual overrides

### Keep for bounded history

- last `K` successful inactive projection runs per paper
- last `K` identity resolutions per paper
- last `K` preview selection runs per paper
- all `FigureCandidate` rows belonging to retained `ExtractionRun`s or retained `LegacyPublicationBootstrapRun`s (candidates are retained with their parent provenance root)
- retired `PublishedFigureHandle`s as tombstones when public references may still exist
- last `N` extraction runs per paper, together with their referenced `CapabilitySnapshot` and `CapabilitySnapshotEntry` rows
- the `LegacyPublicationBootstrapRun` referenced by any retained bootstrap-derived `IdentityResolution` or `ProjectionRun`
- failed runs for `T` days

### Retention closure

Retained snapshots form a dependency chain. Eviction must respect the closure:

- any retained `PreviewSelectionRun` retains its parent `ProjectionRun` (via `projectionRunId`)
- any retained `ProjectionRun` retains its parent `IdentityResolution` (via `identityResolutionId`)
- any retained `IdentityResolution` retains its provenance root (`ExtractionRun` or `LegacyPublicationBootstrapRun`, per `provenanceKind`)

Eviction order follows the dependency direction: evict preview selections first, then projections, then identity resolutions, then provenance roots. A parent row is GC-eligible only when no retained child references it.

### GC eligibility

An `Asset` may be GC’d only when:

- it is not referenced by any retained candidate
- it is not referenced by any retained rendered preview
- it is not referenced by any active or retained projection
- it is not referenced by any active or retained preview selection
- grace period has expired

A `RenderRun` may be GC’d only when:

- it is not referenced by any active preview selection
- none of its `RenderedPreview` rows are referenced by any retained preview selection
- grace period has expired

A `RenderedPreview` may be GC’d only when:

- it is not referenced by any active or retained `PreviewSelectionFigure.selectedRenderedPreviewId`
- its parent `RenderRun` is also GC-eligible or the specific row is unreferenced
- grace period has expired

A `FigureCandidate` may be GC'd only when:

- it is not referenced by any active or retained `ProjectionFigure` (via `contentCandidateId`, `basePreviewCandidateId`, or `pageAnchorCandidateId`)
- it is not referenced by any active or retained `PreviewSelectionFigure` (via `selectedNativeCandidateId`)
- its parent provenance root (`ExtractionRun` or `LegacyPublicationBootstrapRun`) is also GC-eligible
- grace period has expired

Rule:

- GC is reference-based over `Asset`, `RenderRun`, `RenderedPreview`, and `FigureCandidate`, never path-based cleanup
- no active or retained `IdentityResolution`, `ProjectionRun`, or `PreviewSelectionRun` may reference a GC-eligible provenance root (`ExtractionRun`, `CapabilitySnapshot`, or `LegacyPublicationBootstrapRun`)
- no published lineage id (`contentCandidateId`, `basePreviewCandidateId`, `pageAnchorCandidateId`, `selectedNativeCandidateId`) may reference a GC-eligible `FigureCandidate`

---

## Operator Reprocessing Verbs

Operators need first-class actions, not “rerun everything.”

Supported verbs:

1. `refresh-capability`
   - recompute source eligibility only
2. `create-capability-snapshot`
   - freeze current source capability inputs for extraction
3. `extract-evidence`
   - produce `ExtractionRun` + `FigureCandidate`
4. `resolve-identities`
   - build a new `IdentityResolution` from existing candidates
5. `project-canonical`
   - build a new `ProjectionRun` from an existing identity snapshot
6. `compare-publication`
   - compute non-regression comparison against the active paper snapshot
7. `publish-projection`
   - run semantic-publication validator and swap active semantic pointers plus activation preview selection
8. `render-previews`
   - build `RenderRun` for the active projection
9. `compare-preview-publication`
   - compute and persist preview non-regression comparison against the active preview selection
10. `publish-previews`
   - run preview-publication validator and promote a new `PreviewSelectionRun`
11. `rebuild-from-evidence`
   - skip extraction, reuse candidates, rerun resolution/projection
12. `ingest-legacy-assets`
   - bootstrap existing files into `Asset`
13. `bootstrap-legacy-publication`
   - create bootstrap evidence and then publish an honest bootstrap snapshot pair for an already-published legacy paper

Rule:

- each operator action targets one control plane only

---

## GROBID Integration: PDF Evidence Provider

GROBID serves as a Stage 1 PDF evidence extractor — a better `pdf_structural`, not a new top-level canonical source and not a substitute for the architecture in this plan.

### What GROBID provides

GROBID's `processFulltextDocument` returns TEI with `teiCoordinates` support, including figure/table annotations. Its fulltext model represents tables as `figure type="table"`.

This makes it a good fit for:

- figure/table label and caption extraction from PDF
- page anchors and bounding boxes
- richer structural PDF evidence than the current caption-and-crop path
- replacing or augmenting the current low-priority `pdf_structural` source method

### What GROBID does not replace

- preview publication logic
- canonical identity resolution
- HTML/PMC evidence extraction
- high-quality preview rendering

### Integration model

1. Add GROBID as a Stage 1 PDF evidence provider, emitting `FigureCandidate` rows with `sourceMethod = grobid_tei`
2. Map GROBID TEI output to `FigureCandidate` fields:
   - `figureLabelRaw` — from TEI figure label
   - `captionTextRaw` — from TEI figure caption / `figDesc`
   - `type` — `figure` or `table` from TEI `figure type` attribute
   - `sourceLocalLocator` — from TEI `xml:id`
   - `pageAnchorCandidate` / `bbox` — from TEI coordinates
   - `structuredContentRaw` — from TEI table content, when useful for tables
3. Preview generation remains separate — GROBID coordinates may drive smarter crop/render, but GROBID does not decide published previews
4. GROBID candidates participate in identity resolution and projection alongside other PDF candidates, subject to the source-method priority below

### Source-method priority

`grobid_tei` sits below structured HTML/JATS sources and replaces `pdf_structural` in priority, not structured sources. Canonical projection must respect this ordering:

1. `pmc_jats` — highest priority structured source
2. `arxiv_html`
3. `publisher_html`
4. `grobid_tei` — highest priority PDF source, replaces `pdf_structural`
5. `pdf_embedded`
6. `pdf_render_crop`

Rules:

- `grobid_tei` never outranks trusted structured-source content (`pmc_jats`, `arxiv_html`, `publisher_html`) for labels, captions, or structured content
- `grobid_tei` may outrank weaker PDF heuristics (`pdf_embedded`, `pdf_render_crop`) for labels and page anchors
- when a structured source and `grobid_tei` both contribute candidates for the same semantic identity, projection selects content from the structured source and may use `grobid_tei` page anchors / bounding boxes as supplementary evidence

### Validation requirements

Validate GROBID on a PDF-only cohort against the current pipeline on:

- label recall
- page-anchor accuracy
- table/figure type accuracy
- bad preview crop rate

### Rollout position

GROBID integration fits within **Tranche F** (PDF rescue rebuild) as a replacement for the current `pdf_structural` evidence path. It does not block Tranches A–E.

---

## Rollout Rings

Roll out by derived paper coverage class:

1. Ring 1: `both`, `pmc_usable`, `arxiv_usable`
2. Ring 2: `publisher_html_usable`
3. preview enrichment sweep
4. explicit decision on `structured_none`

Architectural rule:

- publisher HTML is a first-class peer source in the extraction contract
- publisher HTML is not required to be a first-ring rollout source

`structured_none` remains a separate trust tier until rescue quality proves good enough.

---

## Acceptance Gates

These are rollout-level gates, not vague goals.

- identity audit precision for committed metadata buckets: at least `98%`
- figure/supplement DOI misassignment: effectively `0`
- zero duplicate published canonicals by semantic identity in the validation cohort
- zero unlabeled PDF canonicals
- zero automatic normal-mode publications that materially regress a healthier active paper snapshot
- zero Stage 4 promotions without a validated activation preview-selection snapshot
- canonical `table | pdf_render_crop` rows: at most `10%` of canonical tables in structured-source rollout rings
- bad PDF table crops in manual audit sample: below `10%`
- structured-source papers: at least `90%` of rollout waves before `structured_none` is enabled
- canonical `table | pdf_render_crop` rows in structured-source buckets: at least `75%` lower than pre-tranche baseline
- preview-render failures: must not corrupt published semantic state

---

## Tranche Order

1. Tranche 0: source capability substrate
2. Tranche A: asset store + legacy asset ingestion + evidence extraction runs + figure candidates
3. Tranche B: identity resolution snapshots
4. Tranche C: projection runs + `PaperWorkLease` + publication state + stable published handles + activation preview selection + Stage 5.5 activation-mode preview comparison + Stage 4 composite publication + `PaperFigure` cache semantics + legacy publication bootstrap + `PaperMigrationState`
5. Tranche D: structured-content migration + preview trust / render intent + render generation + Stage 5.5 enrichment-mode preview comparison + Stage 6 enrichment preview publication
6. Tranche E: structured-source rebuild
7. Tranche F: PDF rescue rebuild + GROBID integration as `pdf_structural` replacement
8. Tranche G: validation cohort, retention, operator verbs, and rollout gates

This order is deliberate:

- capability must exist before extraction depends on it
- extraction must depend on an immutable capability snapshot, not live capability state
- evidence must exist before identity can be correct
- identity must exist before canonicals can be projected
- `PaperWorkLease` must exist before any publication path can be safe — it is a prerequisite for Stage 4, not a late addition
- activation preview selection and its comparison logic are part of the Stage 4 transaction, so both must ship in Tranche C alongside projection and semantic publication
- Stage 5.5 preview comparison is split across tranches: activation-mode comparison ships in C (Stage 4 depends on it), enrichment-mode comparison ships in D (Stage 6 depends on it)
- enrichment preview publication (Stage 6) depends on render generation, preview trust, and enrichment-mode comparison, so it ships in Tranche D alongside those concerns
- publication must be snapshot-based before rollout can be safe
- legacy published papers need an explicit bootstrap into the snapshot model before partial adoption is trustworthy
- rescue logic becomes sane only after those boundaries exist

---

## Decision Rules

Proceed to broad rollout only if all are true:

- immutable evidence, versioned identity, and versioned projection are all in place
- published semantic state changes only by semantic snapshot promotion
- published preview state changes only by preview snapshot promotion
- `PaperFigure` is purely a compatibility publication cache
- every published projection has an aligned published preview-selection snapshot
- normal publication cannot silently replace a healthier active paper snapshot with a regressed one
- legacy migrated papers never pretend to have exact lineage unless they were actually re-extracted under the new pipeline
- suspicious native assets no longer win previews simply because an image exists
- capability is versioned and refreshable
- rendering failure cannot corrupt semantic truth
- PDF cannot silently outrank structured sources for the wrong reasons
- `structured_none` remains an explicit product decision, not accidental spillover

Do **not** proceed with broad extraction if any of these remain false.

---

## Why This Plan Is Not Patch-Driven

This plan does not add one more parser branch and hope the rest holds.

It changes:

- the asset model
- the evidence model
- the identity model
- the semantic projection model
- the preview publication model
- the compatibility publication model
- the capability lifecycle
- the concurrency model
- the retention model
- the operator model

That is the minimum level of change required to stop rediscovering the same failures under new paper-specific symptoms.
