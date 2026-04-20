# Production Readiness Roadmap — Next Execution

**Date:** 2026-04-20  
**Scope:** Workstreams 1-4 from [2026-04-19-production-readiness-next.md](/Users/dimi/projects/paper_finder/docs/superpowers/plans/2026-04-19-production-readiness-next.md:1)

## Objective

Land the next-layer product capabilities on top of the now-completed production-truth tranche:

- paper-scoped claims extraction
- cross-paper synthesis capabilities:
  - contradictions
  - research gaps
  - idea timeline
- paper chat convergence onto a shared backend answer engine
- materially better library search
- materially better recommended/latest surfaces

This tranche is about **analysis quality, retrieval quality, and product coherence**. It is **not** the place to restart section-aware summarization experiments, settings redesign, or appendix policy work.

## Current Reality

The current product still has five structural weaknesses:

1. **Paper chat is still full-text stuffing.**
   - [src/app/api/papers/[id]/llm/chat/route.ts](/Users/dimi/projects/paper_finder/src/app/api/papers/[id]/llm/chat/route.ts:1) builds a system prompt by concatenating the paper title and truncated full text.
   - [src/app/api/papers/[id]/conversations/[convId]/messages/route.ts](/Users/dimi/projects/paper_finder/src/app/api/papers/[id]/conversations/[convId]/messages/route.ts:1) does the same thing for the primary paper plus every attached conversation paper.
   - The UI shell in [paper-chat.tsx](/Users/dimi/projects/paper_finder/src/components/chat/paper-chat.tsx:1) is not the real problem. The backend answer path is.

2. **Cross-paper analysis routes are siloed prompt wrappers.**
   - [gap-finder](/Users/dimi/projects/paper_finder/src/app/api/papers/[id]/llm/gap-finder/route.ts:1), [timeline](/Users/dimi/projects/paper_finder/src/app/api/papers/[id]/llm/timeline/route.ts:1), and [compare-methodologies](/Users/dimi/projects/paper_finder/src/app/api/papers/[id]/llm/compare-methodologies/route.ts:1) each fetch related papers and then run their own bespoke prompt.
   - There is no shared claim substrate, no shared retrieval layer, and no shared analysis engine.

3. **There is no paper-scoped claim model.**
   - The repo has project-scoped [ResearchClaim](/Users/dimi/projects/paper_finder/prisma/schema.prisma:1759) and [ClaimEvidence](/Users/dimi/projects/paper_finder/prisma/schema.prisma:1812), but those are for research projects, not library papers.
   - Reusing them for paper analysis would blur paper truth with agent/project truth.

4. **Search quality is still substring-plus-rerank.**
   - [src/app/api/papers/route.ts](/Users/dimi/projects/paper_finder/src/app/api/papers/route.ts:1) does `contains` matching on title, abstract, authors, summary, and tags, then does a shallow client-facing rank bucket in process memory.
   - Author search technically exists because `authors` is searched as a JSON string blob, but that is not production-grade author retrieval.

5. **Recommendations are still heuristic and mostly external-source driven.**
   - [src/lib/recommendations/engine.ts](/Users/dimi/projects/paper_finder/src/lib/recommendations/engine.ts:1) is built from S2 recommendations, arXiv category browsing, and keyword fallback.
   - [src/lib/recommendations/interests.ts](/Users/dimi/projects/paper_finder/src/lib/recommendations/interests.ts:1) extracts interests from liked/engaged papers and tags, but not from a stronger search/relation/claim substrate.

## Explicit Non-Goals

This execution plan does **not** include:

- section-aware summarization
- appendix-aware summary policy
- settings/profile redesign
- replacing the paper chat UI shell first
- full research-agent filesystem artifacts inside paper chat
- a true paper merge workflow for duplicates

## Frozen Decisions

1. **Claims extraction is its own persistent paper-scoped substrate.**
   We will introduce paper-specific claim tables. We will **not** reuse `ResearchClaim` / `ClaimEvidence`.

2. **Claims are durable truth; contradictions, gaps, timelines, and methodology comparisons are derived artifacts.**
   Claims persist as first-class rows. Cross-paper synthesis outputs stay as versioned analysis artifacts, not as permanent canonical truth rows in this tranche.

3. **Paper chat convergence is backend-first.**
   The current `PaperChat` shell may survive this tranche. The backend answer engine changes first.

4. **The shared backend answer engine owns retrieval.**
   Paper chat and paper-analysis routes must stop stitching together their own prompt contexts from raw full text.

5. **This tranche does not ship a general autonomous paper agent.**
   The shared engine may do structured retrieve-plan-answer loops, but it does not become a free-form filesystem-writing research agent.

6. **Paper chat artifacts are typed conversation artifacts, not generic files.**
   If chat emits a timeline table, contradiction table, claim list, or gap list, those are persisted as typed paper-chat artifacts attached to a conversation. They are not arbitrary output-directory files.

7. **Search quality uses one shared library search service.**
   `/api/papers`, paper pickers, selectors, and search UIs must share one ranking contract. No surface-specific ranking forks.

8. **Search must remain SQLite-safe.**
   This tranche does not rely on a database-engine-specific full-text implementation unless there is a deliberate cross-engine story. Default path is normalized retrieval plus deterministic reranking in app code.

9. **Recommendations consume the same visibility and duplicate truth as library search.**
   Hidden/collapsed losers must not leak back in through recommendation seeds or recommendation outputs.

10. **Recommended/latest improve after search and analysis truth, not instead of it.**
    Cosmetic sidebar tweaks are out of scope until the underlying ranking and seeding are better.

## New Runtime/Data Surfaces

### Paper Claim Substrate

Add new Prisma models:

- `PaperClaimRun`
  - `id`
  - `paperId`
  - `extractorVersion`
  - `status`
  - `sourceTextHash`
  - `createdAt`
  - `completedAt`

- `PaperClaim`
  - `id`
  - `paperId`
  - `runId`
  - `claimType`
  - `text`
  - `normalizedText`
  - `confidence`
  - `sectionLabel`
  - `sourceExcerpt`
  - `excerptHash`
  - `orderIndex`
  - `createdAt`

Why this split:

- runs give re-extract/idempotence/versioning semantics
- claims give a stable analysis substrate for contradictions/gaps/timeline/chat retrieval
- excerpt hash + normalized text give deterministic dedupe semantics

### Conversation Artifact Surface

Add a new paper-chat artifact model:

- `ConversationArtifact`
  - `id`
  - `conversationId`
  - `messageId` nullable
  - `kind`
  - `title`
  - `payloadJson`
  - `createdAt`

Allowed `kind` values in this tranche:

- `claim_list`
- `contradiction_table`
- `gap_list`
- `timeline`
- `methodology_compare`

This lets paper chat produce structured outputs without pretending to be the research agent’s file/artifact system.

## Workstreams

### Workstream A — Paper Analysis Substrate

Goal:

- create the shared paper-claim and retrieval substrate that all later analysis and chat paths depend on

Primary files:

- `prisma/schema.prisma`
- new migration(s)
- `src/lib/papers/analysis/*`
- `src/lib/llm/paper-llm-operations.ts`
- `src/lib/llm/paper-llm-context.ts`
- `src/lib/llm/prompt-result-schemas.ts`

Deliverables:

- paper claim models + migration
- shared claim extraction store/reload helpers
- shared retrieval helpers for:
  - paper excerpts/snippets
  - references
  - figures
  - related papers
  - claims
- route inventory + guardrail so paper analysis routes use the shared substrate

### Workstream B — Cross-Paper Analysis Capability Split

Goal:

- make claims, contradictions, gaps, and timeline separate capabilities with one shared backend engine

Primary files:

- `src/app/api/papers/[id]/llm/gap-finder/route.ts`
- `src/app/api/papers/[id]/llm/timeline/route.ts`
- `src/app/api/papers/[id]/llm/compare-methodologies/route.ts`
- new `src/lib/papers/analysis/*`

Deliverables:

- claim extraction route/service
- contradiction analysis capability over claim sets + related papers
- gap analysis capability over claim sets + related papers
- timeline capability over dated related papers + claims
- methodology comparison moved onto the same backend engine as a sibling capability

### Workstream C — Paper Chat Convergence

Goal:

- make paper chat use the same retrieval/analysis substrate instead of raw full-text stuffing

Primary files:

- `src/app/api/papers/[id]/llm/chat/route.ts`
- `src/app/api/papers/[id]/conversations/[convId]/messages/route.ts`
- `src/components/chat/paper-chat.tsx`
- `src/components/chat/conversation-view.tsx`
- `src/components/chat/conversation-list.tsx`
- new `src/lib/papers/answer-engine/*`

Deliverables:

- shared answer engine
- intent classification:
  - direct paper QA
  - claim-oriented
  - cross-paper comparison
  - contradiction/gap/timeline request
- retrieval-plan-answer flow
- answer packet with:
  - final answer text
  - cited paper/snippet references
  - optional typed artifacts
- conversation artifact persistence

### Workstream D — Search And Recommendation Quality

Goal:

- make search materially better and feed better discovery/recommendation quality from it

Primary files:

- `src/app/api/papers/route.ts`
- `src/components/layout/topbar-search.tsx`
- `src/components/chat/paper-picker.tsx`
- `src/components/synthesis/paper-selector.tsx`
- `src/lib/recommendations/engine.ts`
- `src/lib/recommendations/interests.ts`
- new `src/lib/papers/search.ts`

Deliverables:

- one shared paper search service
- normalized query parser:
  - title phrase
  - title token
  - author token
  - DOI/arXiv exact
  - tag token
- deterministic scoring contract
- explicit match diagnostics in API output
- recommendation engine recalibrated to:
  - exclude losers via the visibility contract
  - use stronger paper seeds
  - use stronger latest/recommended ranking

## PR Sequence

### PR 1 — Paper Analysis Substrate And Schemas

Ship:

- Prisma migration for `PaperClaimRun`, `PaperClaim`, `ConversationArtifact`
- shared paper-analysis schemas/helpers
- paper analysis route inventory guardrail
- shared paper-analysis operations in `paper-llm-operations`

Do not ship yet:

- full claim extraction backfill
- paper chat convergence
- search changes

Acceptance:

- migration applies cleanly on snapshot DB
- guardrail fails if new paper-analysis routes bypass shared substrate
- typecheck/lint green

### PR 2 — Claim Extraction

Ship:

- claim extraction service
- `PaperClaimRun`/`PaperClaim` persistence
- dedupe/idempotence rules
- claim extraction route
- benchmark corpus and fixture artifact for claims

Acceptance:

- rerunning claim extraction with the same source text hash is idempotent
- duplicate claims do not accumulate
- claim fixtures show stable output shape across reruns

### PR 3 — Contradictions, Gaps, Timeline, Methodology Compare On Shared Engine

Ship:

- shared cross-paper analysis engine
- contradiction capability
- gap capability
- timeline capability
- methodology compare moved onto the same engine
- route wrappers updated

Acceptance:

- existing routes become thin wrappers over shared engine
- outputs use committed structured schemas
- route-level focused tests cover no-related-paper, sparse-claim, and normal cluster cases

### PR 4 — Paper Chat Backend Convergence

Ship:

- shared answer engine
- retrieval-plan-answer flow
- paper chat + conversation message routes moved to shared engine
- typed conversation artifacts
- UI additive rendering for artifact cards and citations

Acceptance:

- no route concatenates whole paper text directly into the final answer prompt path anymore
- chat supports citations and artifact cards
- legacy conversation history still renders

### PR 5 — Search Quality

Ship:

- `src/lib/papers/search.ts`
- `/api/papers` migration to shared search service
- paper picker, topbar search, synthesis selector compatibility
- author-aware ranking and diagnostics

Acceptance:

- shared search service is the only ranking contract
- author queries behave materially better than raw JSON-string substring matching
- pagination and `see more` remain compatible

### PR 6 — Recommendations And Latest

Ship:

- recommendation seed cleanup on top of visibility + search truth
- recommendation engine ranking refresh
- latest/recommended sidebars consume improved data

Acceptance:

- duplicate losers never seed or appear in recommendations
- recommended/latest snapshot artifact improves determinism and cleanliness

### PR 7 — Integration, Benchmarks, Merge

Ship:

- integrated validation
- benchmark artifacts
- snapshot verification on populated DB copy
- final merge prep

Acceptance:

- claims benchmark artifact committed
- search relevance artifact committed
- recommendations snapshot committed
- paper chat smoke passes on the integrated branch

## Benchmark / Evidence Artifacts

Tracked outputs for this tranche:

- `benchmark/paper-analysis/claims.snapshot.json`
- `benchmark/paper-analysis/contradictions.snapshot.json`
- `benchmark/paper-analysis/timeline.snapshot.json`
- `benchmark/search/relevance.snapshot.json`
- `benchmark/recommendations/recommendations.snapshot.json`

These are review artifacts, not throwaway local notes.

## Guardrails

Add CI checks for:

- paper-analysis route inventory uses shared engine
- search ranking goes through `src/lib/papers/search.ts`
- paper chat routes use shared answer engine
- no new paper-analysis capability writes ad hoc prompt results without a structured schema

## Main Risks

1. **Overloading the tranche with section-aware ambitions.**
   This plan must stay on claims/retrieval/chat/search/recommendations, not GROBID section experiments.

2. **Paper chat convergence drifting into “build a second research agent.”**
   The paper answer engine must stay scoped to paper analysis and typed artifacts.

3. **Claims substrate becoming noisy and unusable.**
   Claim extraction quality and dedupe rules must be validated early, or every downstream capability degrades.

4. **Search work becoming a UI task instead of a retrieval task.**
   The deliverable is better retrieval and ranking, not a prettier search modal.

5. **Recommendation improvements remaining heuristic-only.**
   The engine must consume stronger seeds and stronger visibility/search truth, not just more prompt text.

## Readiness Gate

This execution plan is ready to start when all of the following are true:

1. `now` tranche remains green on `main`
2. this doc is reviewed and accepted as the `next` execution sequence
3. `PaperClaimRun` / `PaperClaim` / `ConversationArtifact` schema direction is accepted
4. the benchmark artifact paths above are accepted as tracked evidence

## Success Criteria

- paper claims exist as first-class paper-scoped rows
- gap/timeline/compare stop being isolated prompt wrappers
- paper chat uses a shared retrieval/analysis backend
- paper chat can emit typed artifacts
- `/api/papers` search ranking is shared and materially better
- recommendations/latest consume better search and visibility truth
