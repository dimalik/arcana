# Production Readiness Roadmap — Next Execution

**Date:** 2026-04-20  
**Scope:** Workstreams 1-4 from [2026-04-19-production-readiness-next.md](/Users/dimi/projects/paper_finder/docs/superpowers/plans/2026-04-19-production-readiness-next.md:1)

## Objective

Land the next-layer product capabilities on top of the now-completed production-truth tranche:

- paper-scoped claims extraction on a structured substrate rich enough for real cross-paper synthesis (rhetorical role, facet, stance, citation anchors, normalized section path)
- cross-paper synthesis capabilities built on that substrate:
  - contradictions (over aligned stance triples)
  - research gaps (over limitation/future-work rhetorical roles)
  - idea timeline (over dated, citation-anchored claims)
- paper chat convergence onto a shared backend answer engine
- **three distinct task-aware retrievers** — Related(seed_paper), Search(query), and Recommended(user_profile) — each with a multi-stage pipeline and its own judged benchmark. Not one shared "better ranking" bucket.
- diversification and anti-hub control as obligatory stages across all three retrievers

This tranche is about **analysis quality, retrieval quality, and product coherence**. It treats related/search/recommended as **IR/recommender-system problems informed by the literature**, not as heuristic-cleanup engineering. It is **not** the place to restart section-aware summarization experiments, settings redesign, or appendix policy work.

## Current Reality

The current product has six structural weaknesses. **Three of them are distinct IR/retrieval problems** and must not be conflated into a single "better ranking" bucket, because the scholarly IR literature is clear that ranking, search, and recommendation are different task formats that a single representation struggles to generalize across ([SciRepEval, Singh et al. 2023](https://aclanthology.org/2023.emnlp-main.338/); see also [SPECTER, Cohan et al. 2020](https://aclanthology.org/2020.acl-main.207/) on task-aware document embeddings).

1. **Paper chat is still full-text stuffing.**
   - [src/app/api/papers/[id]/llm/chat/route.ts](/Users/dimi/projects/paper_finder/src/app/api/papers/[id]/llm/chat/route.ts:1) builds a system prompt by concatenating the paper title and truncated full text.
   - [src/app/api/papers/[id]/conversations/[convId]/messages/route.ts](/Users/dimi/projects/paper_finder/src/app/api/papers/[id]/conversations/[convId]/messages/route.ts:1) does the same thing for the primary paper plus every attached conversation paper.
   - The UI shell in [paper-chat.tsx](/Users/dimi/projects/paper_finder/src/components/chat/paper-chat.tsx:1) is not the real problem. The backend answer path is.

2. **Cross-paper analysis routes are siloed prompt wrappers.**
   - [gap-finder](/Users/dimi/projects/paper_finder/src/app/api/papers/[id]/llm/gap-finder/route.ts:1), [timeline](/Users/dimi/projects/paper_finder/src/app/api/papers/[id]/llm/timeline/route.ts:1), and [compare-methodologies](/Users/dimi/projects/paper_finder/src/app/api/papers/[id]/llm/compare-methodologies/route.ts:1) each fetch related papers and then run their own bespoke prompt.
   - There is no shared claim substrate, no shared retrieval layer, and no shared analysis engine.

3. **There is no paper-scoped claim model, and the model we ship must be rich enough to support contradiction / gap / timeline analysis.**
   - The repo has project-scoped [ResearchClaim](/Users/dimi/projects/paper_finder/prisma/schema.prisma:1759) and [ClaimEvidence](/Users/dimi/projects/paper_finder/prisma/schema.prisma:1812), but those are for research projects, not library papers.
   - A thin `{ text, normalizedText, sectionLabel, sourceExcerpt }` schema is not enough — downstream contradiction/gap/timeline analysis on top of thin claims collapses into LLM prose over weak blobs. The substrate needs rhetorical role, facet, stance/polarity, citation anchors, and a normalized section path (see Workstream A).

4. **Related papers ranking is a single fixed-weight mixture, not a task-aware retriever.**
   - The current scorer at [src/lib/assertions/deterministic-relatedness.ts:12-21](/Users/dimi/projects/paper_finder/src/lib/assertions/deterministic-relatedness.ts:12) is `0.40 direct_citation + 0.20 reverse_citation + 0.20 bibliographic_coupling + 0.10 co_citation + 0.10 title_similarity` with a `0.35` threshold and a top-20 cap.
   - That is a baseline, not a ranker. For hub papers like "Attention Is All You Need" it collapses on the same citation clique; for niche papers the citation signals are too sparse to fire; for ambiguous titles the weak title-similarity term is not enough. Pure relevance over graph+text without diversity control overconcentrates on the same community (see [Abdollahpouri et al. 2021, *Search results diversification for effective fair ranking in academic search*](https://link.springer.com/article/10.1007/s10791-021-09399-z)).
   - The production literature points at multi-stage retrieval: content+citation-informed candidate generation plus discriminative reranking ([Bhagavatula et al. 2018, *Content-Based Citation Recommendation*](https://aclanthology.org/N18-1022/)), and dense retrieval over scientific articles materially beats lexical baselines ([Dense Retrieval for Scientific Articles, EMNLP Industry 2022](https://aclanthology.org/2022.emnlp-industry.32/)).

5. **Library search is substring-plus-rerank.**
   - [src/app/api/papers/route.ts:41-54](/Users/dimi/projects/paper_finder/src/app/api/papers/route.ts:41) does `contains` matching on title, abstract, authors, summary, and tags, then a shallow client-facing rank bucket in process memory.
   - Author search is a JSON-string blob `contains` match — not production-grade author retrieval.
   - Search is its own task: given a query, rank library papers. It is not the same task as related (given a seed paper) or recommendation (given a user profile), and its retrieval stack should reflect that.

6. **Recommendations are heuristic and mostly external-source driven.**
   - [src/lib/recommendations/engine.ts](/Users/dimi/projects/paper_finder/src/lib/recommendations/engine.ts:1) is built from S2 recommendations, arXiv category browsing, and keyword fallback.
   - [src/lib/recommendations/interests.ts](/Users/dimi/projects/paper_finder/src/lib/recommendations/interests.ts:1) extracts interests from liked/engaged papers and tags, but not from a stronger claim/relation substrate.
   - Recommendations is its own task: given a user/library profile, propose novel and diverse papers. Diversity and novelty are first-class concerns, not afterthoughts.

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

7. **Related papers, library search, and recommendations are three distinct retrieval tasks and are shipped as three distinct products.**
   - **Related(seed_paper)** — given a seed paper, rank library papers by relatedness. Owned by Workstream D1.
   - **Search(query)** — given a free-form query, rank library papers. Owned by Workstream D2.
   - **Recommended(user_profile)** — given the current user's library/engagement profile, propose papers (internal or external sources). Owned by Workstream D3.
   No single ranking pipeline, no single set of weights, no single evaluation. These tasks have different inputs, different relevance definitions, different diversity/novelty requirements, and different evaluation harnesses. This is the position taken by the scholarly IR literature ([SciRepEval, 2023](https://aclanthology.org/2023.emnlp-main.338/); [SPECTER, 2020](https://aclanthology.org/2020.acl-main.207/)) and it is a correction to earlier thinking that treated "better ranking" as one bucket.

8. **Each retrieval task uses a multi-stage stack: lexical filters → candidate generation → task-specific reranking → diversification/anti-hub layer.** The stages are obligatory; the implementations can start simple and strengthen over the tranche, but no task ships with only one stage.
   - **Lexical filters**: exact match on DOI, arXiv id, title phrase, author token. SQLite-safe. Used for short-circuit retrieval and candidate-pool seeding.
   - **Candidate generation**: the primary recall layer. For related-papers this is the graph layer (direct/reverse citation, bibliographic coupling, co-citation, canonical-entity overlap); for search and recommendations this is the content layer. Content-layer candidate generation uses dense retrieval over precomputed paper representations ([Bhagavatula 2018](https://aclanthology.org/N18-1022/); [Dense Retrieval for Scientific Articles, 2022](https://aclanthology.org/2022.emnlp-industry.32/)). The embedding store lives outside SQLite's remit, but the SQL path still serves the lexical filter and id-lookup workload — "SQLite-safe" means the DB itself stays workable, not that we forgo embeddings.
   - **Task-specific reranking**: the precision layer. Each task owns its own reranker contract. Related reranks on signal-weighted graph/text features with an anti-hub penalty; search reranks on query–paper similarity with author/title/tag boosts; recommendations reranks on interest-profile similarity with novelty/freshness. The current fixed-weight deterministic scorer at `src/lib/assertions/deterministic-relatedness.ts` stays in the pipeline as the **baseline** relatedness signal, but is not the end of the story — Workstream D1 layers a task-aware reranker on top.
   - **Diversification / anti-hub**: obligatory stage for related and recommendations, optional-but-default for search. See Frozen Decision 11.

9. **Deterministic-relatedness is a floor, not a ceiling.** The fixed-weight mixture at `deterministic-relatedness.ts:12-21` is kept as an explainable baseline and as evidence for each relation's `RelationEvidence` rows (already shipped in the `now` tranche). The task-aware related-papers reranker consumes this signal alongside others; it does not replace it. No UI surface consumes the raw baseline as the final relatedness ordering.

10. **Diversification and anti-hub control are first-class ranker stages, not polish.** For hub papers like "Attention Is All You Need" the naïve top-K of pure relevance collapses on the same citation clique. Every user-facing retrieval surface runs an explicit diversification stage with:
    - a subtopic-coverage objective (cluster candidates by topic or graph community; enforce coverage across the top-K)
    - an anti-hub damping factor (papers whose combined fan-in + fan-out exceeds a percentile threshold receive a penalty proportional to overlap with already-selected results, so a hub paper can still appear but does not dominate)
    - an MMR-style diversity trade-off with a task-specific λ (related tolerates higher diversity; search tolerates less when the query is specific; recommendations tolerates the most)
    - for recommendations specifically, a novelty term that down-weights papers already in the user's library or adjacent to many already-engaged papers
    The diversification contract is shared across tasks but its coefficients are per-task.

11. **Search quality uses one shared library search service, but the service is task-aware.**
    `/api/papers`, paper pickers, selectors, and search UIs all call the same Search(query) service. They do not fork ranking; they do not call the related-papers or recommendations services. Surface differences (paper picker shows fewer results, topbar search supports inline preview) are presentation-layer only.

12. **Search stays SQLite-safe at the DB layer; dense retrieval lives in its own store.**
    The SQLite schema does not depend on a database-engine-specific FTS implementation. Lexical filters run in SQLite; dense retrieval runs against a separately-maintained embedding index (ANN store or in-process index depending on library size). A deliberate cross-engine FTS migration is out of scope for this tranche.

13. **Recommendations consume the same visibility and duplicate truth as library search.**
    Hidden/collapsed losers must not leak back in through recommendation seeds or recommendation outputs. This was already an invariant from the `now` tranche; it applies here uniformly across seeds and output.

14. **Recommended/latest improve after search and analysis truth, not instead of it.**
    Cosmetic sidebar tweaks are out of scope until the underlying seeding and ranking are better.

15. **Reranker model family is chosen by the judged benchmark within the per-task latency / cost / freshness budget below; budgets are frozen in this plan and revised only with judged evidence.**
    For D1 / D2 / D3, the reranker implementation is selected by the quality/cost tradeoff on the judged suite, not by an *a priori* preference for "small, explainable, in-process." Allowed families, all of which are fair game:
    - feature-based rankers (linear, logistic, gradient-boosted over committed features)
    - cross-encoder rerankers (small discriminative models scoring (query, candidate) or (seed, candidate) pairs)
    - distilled rerankers (compact models distilled from a larger teacher)
    - LLM / listwise rerankers with prompted scoring or pairwise preference, including zero-/few-shot variants ([Few-shot Reranking for Multi-hop QA, ACL 2023](https://aclanthology.org/2023.acl-long.885/); [Zero-Shot Cross-Lingual Reranking with LLMs, ACL 2024](https://aclanthology.org/2024.acl-short.59/))
    Rule: if an LLM or cross-encoder reranker wins materially on the judged set within the budget below, that wins. A simpler family is preferred only when it ties on quality at materially lower cost. Each task's reranker choice is committed alongside the judged artifact that selected it, including the latency/cost measurement that informed the decision. Swapping families later is a plan update backed by new judged numbers, not a drive-by refactor.

    **Per-task budgets (frozen; revised only with judged evidence):**

    - **Search** — strict interactive: user is typing and waiting for results.
      - end-to-end API p95 ≤ 600 ms (lexical filter → candidate generation → reranker → diversify → response)
      - reranker stage alone p95 ≤ 400 ms
      - candidate count handed to the reranker: ≤ 50 per query (cap)
      - cost per query p95 ≤ $0.005 (committed baseline; revisable when committed holdout lift justifies it)
      - **degraded path**: if the chosen reranker exceeds its latency budget or its provider is unavailable, the pipeline falls back to the feature-based reranker on the same candidate set. Fallback activations are logged. A judged run on holdout is required before any fallback becomes the default.
      - async reranking is **not** allowed; search results must be final before the response body flushes.

    - **Related** — paper-detail-page load. User-initiated but not typed; one paper at a time.
      - API p95 ≤ 1500 ms when served from cache
      - reranking **may be computed async-cached**: the ranker runs once per seed paper (on paper ingest or on first cache-miss access) and the result is cached ≤ 7 days or until invalidated. Cache invalidation on: new incoming citations to this paper, new matched references from this paper, deterministic-relatedness re-scoring.
      - candidate count handed to the reranker: ≤ 200 per seed (larger than Search because caching amortizes cost)
      - cost per seed p95 ≤ $0.02 amortized over the cache lifetime (committed baseline)
      - **degraded path**: on cold cache with reranker unavailable, serve the deterministic-relatedness baseline ordering (already persisted in `RelationEvidence`) with a UI signal that a stronger ranking is being computed.

    - **Recommendations** — background surface; user is browsing Home or a sidebar.
      - **offline batch reranking is allowed and is the default**. The profile-driven retriever runs on a schedule; online reads serve precomputed rankings from a per-user cache.
      - freshness SLA: per-user profile recomputation ≤ 24 h after the triggering event (new like, new engagement, new tag) or on a nightly cadence, whichever is sooner
      - online read p95 ≤ 200 ms (it is a cache lookup; no reranker call on the read path)
      - cost per user per day p95 ≤ $0.10 amortized (committed baseline)
      - **degraded path**: if the nightly batch fails, the previous day's cached ranking is served with a staleness indicator in the response for the admin view. No user-facing degraded UI is required.

    Budget numbers are stored in `benchmark/budgets.json` alongside the floors file so the benchmark harness can enforce them automatically. A reranker choice whose measured latency or cost exceeds its committed budget does not ship, regardless of judged lift.

16. **Paper representations are not assumed to be shared across the three retrieval tasks.**
    Related(seed→paper), Search(query→paper), and Recommended(profile→paper) have different inputs and different relevance notions; the IR literature is explicit that one representation struggles to generalize across all three ([SciRepEval, 2023](https://aclanthology.org/2023.emnlp-main.338/)). The substrate allows but does not require shared representations:
    - a **shared raw paper feature store** is permitted and is the default (title, abstract, normalized claim-facet text, author index, graph features) — this is storage, not a learned representation
    - **task-specific encoders, heads, and ANN indexes are permitted when the judged suite shows they beat a shared representation** at acceptable cost
    - the decision is per-task and is recorded in the judged artifact that validated it
    - we never assume a single embedding generalizes across the three tasks without evidence; a tied-representation deployment is acceptable only when the judged runs for the other two tasks have demonstrated the tie is not a regression for them

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
  - `claimType` — coarse category (e.g. `factual`, `methodological`, `evaluative`) retained for backward compatibility with existing prompts
  - `rhetoricalRole` — one of `background` | `motivation` | `research_question` | `hypothesis` | `definition` | `assumption` | `method` | `dataset` | `result` | `evaluation` | `limitation` | `future_work` | `contribution`. Controlled enum. This is what downstream contradiction/gap/timeline capabilities actually key off — a "result" that says X improves Y contradicts a "result" that says it does not; a "limitation" becomes a candidate gap; a "method" feeds methodology comparison. Without a controlled rhetorical role, those capabilities devolve into prompt theatre.
  - `facet` — one of `problem` | `approach` | `result` | `comparison` | `limitation` | `resource`. Orthogonal to `rhetoricalRole` (a result-role claim can be an approach-facet or a comparison-facet). Used to group claims across papers for synthesis.
  - `polarity` — one of `assertive` | `negated` | `conditional` | `speculative`. Required for contradiction analysis: "X improves Y" (assertive) contradicts "X does not improve Y" (negated) only when the subject/predicate/object align.
  - `stance` — nullable structured object `{ subjectText, predicateText, objectText, qualifierText? }` for claims where a triple can be extracted. Null for claims that are inherently unstructured. Claims without a stance triple cannot be used as contradiction inputs; they can still feed gap/timeline synthesis.
  - `evaluationContext` — nullable structured object capturing the experimental conditions a comparison claim depends on. Required for any claim that is going to be eligible as a contradiction input; null otherwise. Fields:
    - `task` — the downstream task being evaluated (e.g. `"machine translation"`, `"image classification"`, `"question answering"`)
    - `dataset` — normalized dataset / benchmark identifier (e.g. `"MNLI"`, `"SQuAD 1.1"`, `"ImageNet"`); controlled where possible, free-text otherwise with a normalization pass
    - `metric` — normalized metric name (e.g. `"accuracy"`, `"F1"`, `"BLEU"`, `"exact match"`)
    - `comparator` — normalized identifier for the baseline or competing method the claim is compared against (e.g. `"BERT-base"`, `"human baseline"`, `"prior SOTA on WMT14"`)
    - `setting` — free-text experimental setting / condition (e.g. `"zero-shot"`, `"fine-tuned on 10k examples"`, `"in-distribution test set"`)
    - `split` — nullable split identifier where applicable (e.g. `"dev"`, `"test"`, `"held-out"`)
    Without at least `task` + `dataset` + `metric` recoverable, a claim is not a valid contradiction input. The literature on document-level scientific IE makes this concrete and achievable: dataset/method/metric extraction is a well-studied task ([SciREX, 2020](https://aclanthology.org/2020.acl-main.670/); [TDMSci, 2021](https://aclanthology.org/2021.eacl-main.59/); [SciER, 2024](https://aclanthology.org/2024.emnlp-main.726/); [Extracting Fine-Grained Knowledge Graphs of Scientific Claims, 2021](https://aclanthology.org/2021.emnlp-main.381/)).
  - `text` — the claim as expressed
  - `normalizedText` — canonicalized form for dedupe
  - `confidence` — extractor confidence in `[0, 1]`
  - `sectionLabel` — the section label as it appeared in the source
  - `sectionPath` — normalized section path, e.g. `introduction`, `related_work`, `method/3.1`, `results`, `discussion`, `limitations`, `conclusion`, `appendix/A`. Mapped from `sectionLabel` through a committed normalization table so cross-paper synthesis can reason about "results across papers" reliably.
  - `sourceExcerpt` — the exact source excerpt the claim was extracted from
  - `excerptHash` — hash of the excerpt for dedupe / idempotence
  - `sourceSpan` — nullable `{ charStart, charEnd, page }` for reproducible anchoring back to the source
  - `citationAnchors` — nullable JSON array of `{ citationMentionId?, referenceEntryId?, rawMarker }` tying in-text citation markers in the excerpt to the paper's own `CitationMention` / `ReferenceEntry` rows. Lets contradiction/gap/timeline trace which cited work a claim depends on.
  - `evidenceType` — one of `primary` (this paper asserts it on its own evidence) | `secondary` (this paper restates a claim from cited work) | `citing` (this paper is citing the claim as context, not asserting it). Required to avoid synthesizing contradictions out of citing-role claims that merely quote others.
  - `orderIndex` — stable ordering within the paper
  - `createdAt`

Why this shape:

- runs give re-extract/idempotence/versioning semantics
- the rhetorical/facet/polarity/stance quartet is the minimum structure downstream contradiction/gap/timeline synthesis needs to produce anything other than prompt prose
- `sectionPath` + `citationAnchors` + `sourceSpan` + `evidenceType` make claims auditable and cross-paper linkable
- excerpt hash + normalized text + stance triple give deterministic dedupe semantics at both the textual and semantic level

Controlled-enum committed files:

- `src/lib/papers/analysis/rhetorical-roles.ts` — the enum, plus a `classifyRhetoricalRole(claim, section)` helper that the extractor uses
- `src/lib/papers/analysis/section-normalization.ts` — the `sectionLabel → sectionPath` mapping table with tests on representative label variants

### Author Index

Author retrieval is not a ranking tweak; it is a data-model, indexing, and backfill decision. Today `Paper.authors` is a JSON-string blob ([`prisma/schema.prisma:294`](/Users/dimi/projects/paper_finder/prisma/schema.prisma:294)) and `/api/papers` does a `contains` substring match on that blob ([`src/app/api/papers/route.ts:49`](/Users/dimi/projects/paper_finder/src/app/api/papers/route.ts:49)). "Real author index" has to pick one of three storage options; the decision is frozen in this plan so PR 7 does not quietly choose under deadline pressure.

**Frozen decision: a normalized `Author` + `PaperAuthor` join table is the author index for this tranche.** Rationale:

- solves the substring-blob problem at the schema layer (names are rows, not JSON fragments), which is the root cause of the current author search failure
- enables author-token indexing via standard SQLite lookups on the join table — no external service dependency and no derived-inverted-index process to keep consistent
- opens a clean path for future author-specific features (author pages, author-based recommendations, author disambiguation) without another schema rewrite
- a derived inverted index or external retrieval index can still be layered on top later if dense author retrieval becomes warranted, but the normalized table is the source of truth

Rejected alternatives:

- **derived inverted index only, over the existing JSON blob** — leaves the blob as truth, keeps the data-model debt, and creates a cache that must be invalidated on every paper write. Rejected on consistency grounds.
- **external retrieval index only** — adds a runtime dependency and a separate availability story for a workload that SQLite handles at our library sizes. Not justified at this tranche's scale.

Schema shape (committed in PR 7's migration):

- `Author`
  - `id`
  - `canonicalName`
  - `normalizedName` (lowercased, unicode-folded, punctuation-stripped; used for lexical matching)
  - `orcid` (nullable)
  - `semanticScholarAuthorId` (nullable)
  - `createdAt`
  - `@@unique([normalizedName])` — **frozen**: normalized name is the bucket key and therefore globally unique in this tranche. Two physical people sharing a normalized name collapse into one `Author` row; that is the explicit lexical-bucket semantics from the section below. Person identity is recovered separately via `orcid` / `semanticScholarAuthorId`, not by allowing duplicate `Author` rows.
  - `@@index([normalizedName])` — covers the uniqueness constraint; also supports prefix lookups from the query parser

- `PaperAuthor`
  - `id`
  - `paperId`
  - `authorId`
  - `orderIndex` (author order on the paper, preserved from the original `Paper.authors` JSON)
  - `rawName` (as it appeared on the paper — kept for audit)
  - `createdAt`
  - `@@unique([paperId, authorId])`
  - `@@index([authorId, paperId])`

Write-path contract (frozen):

- every `Author` write — backfill insert, paper-ingest insert, refetch-metadata insert — is an **upsert keyed on `normalizedName`**. The canonical helper is a single `upsertAuthorByNormalizedName(rawName)` function; no code path inserts `Author` rows through any other route.
- `PaperAuthor` writes upsert on `(paperId, authorId)` so re-ingestion of the same paper does not duplicate rows.
- the ingest path that computes `normalizedName` uses the same normalization function the query parser uses, imported from a single module (`src/lib/papers/authors/normalize.ts`). Drift between write-side and read-side normalization would silently fragment buckets and is the primary reason to keep one shared function.
- a CI guardrail (`scripts/check-author-writes.mjs`) fails on any new `prisma.author.create` / `createMany` outside the canonical helper.

Migration and backfill:

- new migration introduces both tables with the uniqueness and indexes above
- backfill script parses every `Paper.authors` JSON blob, normalizes names via the canonical normalization function, upserts `Author` rows keyed on `normalizedName` (so re-runs collapse into the same buckets), populates `PaperAuthor` rows, and preserves `orderIndex` from the original array position
- backfill is idempotent and resumable because it drives exclusively through the upsert-on-normalized-name helper; a second run against the same DB produces zero new `Author` rows and only idempotent `PaperAuthor` upserts
- `Paper.authors` is retained during this tranche as a denormalized convenience field (so existing JSON-consuming UI code does not break) and is kept in sync on paper writes; a follow-up tranche removes the JSON field once every consumer reads from the join table
- the backfill emits a reviewable artifact (`benchmark/paper-analysis/author-backfill.snapshot.json`) listing the `rawName → normalizedName` bucket decisions and any parse anomalies
- if the migration ever encounters an `Author` row that would collide on `normalizedName` but differs on a trusted identifier (different `orcid` or different `semanticScholarAuthorId`), the migration aborts with a clear error rather than silently merging. Identity-level conflicts are a disambiguation-tranche problem, not a bucket-merge problem.

Author disambiguation beyond exact normalized-name equality (e.g. "J. Smith" across institutions) is explicitly out of scope for this tranche. The schema supports it via `orcid` / `semanticScholarAuthorId`, but the disambiguator itself is a follow-up.

**Author rows in this tranche are a lexical retrieval index, not a trusted identity graph.** This distinction is load-bearing for any downstream feature that consumes "same author" information:

- `Author.id` equality means **normalized-name equality within this user's library's ingestion history**, nothing more. Two unrelated "J. Smith" authors at different institutions will share a row.
- Ranking and reranking features that want to express "these two papers share an author" may use **normalized raw-name overlap** (compare `PaperAuthor.rawName` or `Author.normalizedName` directly) and are free to do so.
- Ranking and reranking features must **not** treat `Author.id` equality as identity evidence unless **at least one** of the authors on both sides carries a matching `orcid` or `semanticScholarAuthorId`. Identity-backed overlap is a strictly stronger signal than lexical overlap and must be scored separately. The D1 reranker feature list below reflects this by exposing two distinct features.
- Any future capability that relies on author identity (author pages, author-based recommendations, co-author graphs) must either consume the identified subset (`orcid` / S2 id present) or go through a disambiguation tranche first.

A CI guardrail (`scripts/check-author-identity-usage.mjs`) fails on any code path that joins or compares on `Author.id` for ranking/recommendation purposes without also requiring a non-null `orcid` or `semanticScholarAuthorId` on the participating `Author` rows. The search path (lexical retrieval) is explicitly exempt — it is allowed to use `Author.id` as a lookup handle because its semantics are exactly "this name bucket."

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

- paper claim models + migration, including the expanded fields (`rhetoricalRole`, `facet`, `polarity`, `stance`, `sectionPath`, `sourceSpan`, `citationAnchors`, `evidenceType`)
- committed controlled enums for `rhetoricalRole`, `facet`, `polarity`, `evidenceType`
- committed `sectionLabel → sectionPath` normalization table with tests on representative real-paper variants
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

- claim extraction route/service that populates the expanded PaperClaim schema, including the rhetorical-role classifier and stance-triple extractor
- **contradiction analysis** operating over aligned stance triples with opposing polarity **and aligned `evaluationContext`** across the seed paper's claims and its related papers' claims. Two claims qualify as a candidate contradiction only when:
  - both claims carry a non-null stance triple
  - both claims carry a non-null `evaluationContext` with `task`, `dataset`, and `metric` resolvable to the same normalized values (normalization helpers live under `src/lib/papers/analysis/normalization/`)
  - the stance predicates oppose in direction (e.g. `improves` vs `does not improve`; polarity flip on the same predicate also qualifies)
  - `evidenceType` is not `citing` for either claim (requotes are excluded to avoid flagging quoted disagreements as the paper's own position)
  Claims that fail any of these gates are not valid contradiction inputs; they can still feed gap/timeline synthesis. This rule eliminates the false-contradiction failure mode where "X improves Y on MNLI" and "X does not improve Y on SST-2" would otherwise be synthesized as a disagreement.
  The contradiction capability emits a `ContradictionCandidate` per qualified pair with explicit provenance: both claims, their evaluation contexts, and the normalization decisions that aligned them. A capability that wants to present contradictions to the user consumes candidates, not raw claim pairs.
- **gap analysis** operating primarily over `rhetoricalRole ∈ { limitation, future_work }` claims and facet-grouped comparisons of `method` and `result` claims across the related set
- **timeline capability** operating over dated related papers plus citation-anchored claims, using `sectionPath` and `citationAnchors` to sequence how a thread of ideas evolved
- methodology comparison moved onto the same backend engine as a sibling capability, consuming `facet = approach` claims grouped by rhetorical role
- each capability is tested against the corresponding slice of the claims judged set so the output is evaluable, not only reviewable

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

### Workstream D1 — Related Papers As A Task-Aware Retriever

Goal:

- lift related-papers from a fixed-weight mixture to a multi-stage task-aware retriever so hub papers stop collapsing on their own citation clique

Primary files:

- `src/lib/assertions/deterministic-relatedness.ts` (baseline layer; retained, not deleted)
- new `src/lib/papers/retrieval/related-ranker.ts` (task-aware reranker)
- new `src/lib/papers/retrieval/embeddings.ts` (paper representation store and lookup)
- new `src/lib/papers/retrieval/candidate-generation.ts` (graph + content candidate pools)
- [src/app/api/papers/[id]/relations/route.ts](/Users/dimi/projects/paper_finder/src/app/api/papers/[id]/relations/route.ts:1)
- shared relation-reader module from the `now` tranche (consumer of the new ranker)

Deliverables:

- candidate-generation layer that unions:
  - graph candidates (direct/reverse citation, bibliographic coupling, co-citation, canonical-entity overlap) from the existing deterministic pipeline
  - content candidates from dense retrieval over a committed Related-task paper representation (e.g. a SPECTER-style citation-informed document embedding; the exact representation is committed in a design note alongside the ranker, informed by [SPECTER, 2020](https://aclanthology.org/2020.acl-main.207/) and [Dense Retrieval for Scientific Articles, 2022](https://aclanthology.org/2022.emnlp-industry.32/))
  - per Frozen Decision 16, the Related representation may be shared with D2 / D3 or may be task-specific; the choice is recorded in the judged artifact that validated it
- task-specific reranker for Related(seed_paper):
  - inputs: deterministic-relatedness signal breakdown (already persisted as `RelationEvidence`), candidate-paper features (shared references count, co-citation count, **lexical author overlap** computed from normalized raw names, **identity-backed author overlap** computed from matching ORCID / Semantic Scholar author ids, venue overlap, year proximity), seed–candidate content similarity, plus any additional features the chosen reranker family needs. Lexical author overlap and identity-backed author overlap are separate features — the reranker learns whatever weighting applies — because `Author.id` equality alone does not imply person identity per the Author Index section.
  - per Frozen Decision 15, the reranker family is selected by the judged benchmark. Feature rankers, cross-encoders, distilled rerankers, and LLM/listwise rerankers are all fair game. The chosen family and its latency/cost measurement are committed alongside the related-papers judged artifact that justified the choice.
  - simpler families are preferred only when they tie on judged quality at materially lower cost
- diversification stage per Frozen Decision 10 (see Workstream E)
- the UI continues to consume `PaperRelation` via the shared relation-reader; the reranker output replaces the ordering, not the schema

### Workstream D2 — Library Search As A Multi-Stage Retriever

Goal:

- move `/api/papers` search from substring-plus-rerank to a multi-stage retrieval pipeline

Primary files:

- [src/app/api/papers/route.ts](/Users/dimi/projects/paper_finder/src/app/api/papers/route.ts:1)
- `src/components/layout/topbar-search.tsx`
- `src/components/chat/paper-picker.tsx`
- `src/components/synthesis/paper-selector.tsx`
- new `src/lib/papers/search.ts`
- shared `src/lib/papers/retrieval/embeddings.ts` (from D1)

Deliverables:

- one shared library-search service
- normalized query parser:
  - title phrase
  - title token
  - author token (backed by the normalized `Author` / `PaperAuthor` join tables introduced in the Author Index section, not the JSON-blob `contains` path — the join-table lookup is the only author retrieval path after PR 7)
  - DOI / arXiv exact
  - tag token
- multi-stage pipeline:
  - exact/lexical short-circuit for DOI / arXiv / full-title matches
  - lexical candidate pool (title + author + tag) — SQLite-safe
  - semantic candidate pool via dense retrieval. Per Frozen Decision 16, Search may share D1's paper representation or commit a Search-specific representation. The initial representation and the decision rationale are recorded in the search judged artifact.
  - query-specific reranker combining lexical scores, author/title/tag boosts, and query–paper semantic similarity. Per Frozen Decision 15, reranker family (feature / cross-encoder / distilled / LLM-listwise) is selected by the search judged suite, not by a preference for in-process deterministic models. The chosen family, its latency budget, and its cost are committed alongside the judged artifact.
  - diversification stage per Frozen Decision 10 with a lower λ (specific queries should not be artificially diversified)
- explicit match diagnostics in API output so the UI can surface *why* a result matched
- topbar search, paper pickers, and synthesis selector all call the shared service

### Workstream D3 — Recommendations As A Profile-Driven Retriever

Goal:

- move recommendations from heuristic S2/arXiv pulls to a profile-driven retriever with real novelty and diversity control

Primary files:

- `src/lib/recommendations/engine.ts`
- `src/lib/recommendations/interests.ts`
- new `src/lib/papers/retrieval/recommendations-ranker.ts`
- shared embeddings and candidate-generation modules from D1
- shared diversification module from Workstream E

Deliverables:

- profile construction that reads stronger signals than liked+engaged+tags:
  - liked/engaged papers (existing)
  - paper-claim facets the user has interacted with (from the Workstream A claim substrate)
  - paper-chat engagement (from Workstream C)
  - library tags (existing)
  - the user's related-papers consumption history
- candidate generation:
  - dense retrieval around the profile centroid(s), not single-term keyword fallback. Per Frozen Decision 16, Recommendations may share D1's representation or commit a Recommendations-specific representation (e.g. a profile encoder that pools over library papers rather than encoding a single document). The initial representation and the decision rationale are recorded in the recommendations judged artifact.
  - external sources (S2, arXiv) stay as optional candidate pools with their current adapters, but they are one input among many, not the spine
- task-specific reranker for Recommended(user_profile):
  - interest-profile similarity
  - freshness/recency
  - novelty penalty for papers already in library or adjacent to many already-engaged papers
  - anti-hub penalty per Frozen Decision 10
  - per Frozen Decision 15, reranker family is selected by the recommendations judged suite; committed alongside the judged artifact with its latency/cost measurement
- diversification stage per Frozen Decision 10 with the highest λ across the three tasks (recommendation variety matters most)
- visibility-contract pass-through: neither seeds nor output ever include hidden/archived/collapsed losers

### Workstream E — Diversification And Anti-Hub Control

Goal:

- commit one shared diversification contract that D1, D2, and D3 all consume with per-task coefficients

Primary files:

- new `src/lib/papers/retrieval/diversify.ts`
- consumed by the D1, D2, D3 rerankers

Deliverables:

- shared diversification module exposing:
  - `diversify(candidates, { lambda, hubPenalty, subtopicSignal })` with deterministic output
  - subtopic signal inputs (paper-entity clusters, keyword/tag clusters, or graph community assignments — the specific signal is committed in a design note and can evolve without changing the call sites)
  - anti-hub damping based on combined fan-in + fan-out percentile thresholds computed over the library
- per-task coefficient defaults:
  - related: λ = medium, hub penalty = high
  - search: λ = low, hub penalty = low
  - recommendations: λ = high, hub penalty = medium
  - coefficients are committed constants, not configuration — changes require a plan update and an updated benchmark run
- novelty term available as an optional input for recommendations
- fairness/diversification framing informed by [Abdollahpouri et al. 2021, *Search results diversification for effective fair ranking in academic search*](https://link.springer.com/article/10.1007/s10791-021-09399-z)

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

### PR 5 — Retrieval Substrate: Embeddings, Candidate Generation, And Diversification

Ship:

- `src/lib/papers/retrieval/embeddings.ts` — paper representation store and lookup (dense index), with the committed representation design note
- `src/lib/papers/retrieval/candidate-generation.ts` — shared graph+content candidate-generation module
- `src/lib/papers/retrieval/diversify.ts` — shared diversification / anti-hub module (Workstream E)
- backfill script to compute paper representations for existing library papers
- committed judged benchmark scaffolding (see Benchmark section) with the initial query/seed set but no rerankers yet

Acceptance:

- embedding backfill is idempotent and resumable
- diversification module has unit tests covering coverage, anti-hub, and per-task λ defaults
- judged benchmark scaffolding exists and is reviewable, even before rerankers land

### PR 6 — Related Papers: Task-Aware Reranker (Workstream D1)

Ship:

- `src/lib/papers/retrieval/related-ranker.ts`
- related reranker consumed by the relation-reader module from the `now` tranche
- related benchmark judged set filled in and scored against the new ranker
- documented lift over the deterministic-relatedness baseline on the judged set (especially hub and niche cases)

Acceptance:

- `deterministic-relatedness` signals continue to populate `RelationEvidence` (no regression on explainability)
- the reranker replaces the ordering the UI consumes; the schema is unchanged
- **dev** judged-set metrics (nDCG@10, Recall@20, ILS, subtopic-coverage) meet the committed **dev** floor; "Attention Is All You Need" and niche test seeds both pass their case-specific dev gates
- holdout evaluation is **not** required at PR 6 merge; holdout runs at PR 9 / merge-to-main
- measured reranker latency and cost are within the Search/Related/Recommendations budget in Frozen Decision 15 (Related budget applies here)

### PR 7 — Library Search: Multi-Stage Retriever (Workstream D2)

Ship:

- **normalized `Author` + `PaperAuthor` join tables** per the Author Index section, with idempotent backfill and the committed `benchmark/paper-analysis/author-backfill.snapshot.json` artifact; `Paper.authors` retained and kept in sync for this tranche
- `src/lib/papers/search.ts` as a multi-stage pipeline (lexical → semantic → query reranker → diversify); reranker family selected by search judged suite per Frozen Decision 15
- normalized query parser
- `/api/papers` migration to the shared search service; author-token queries served by the join-table lookup (the JSON-blob `contains` path is removed from the search pipeline)
- paper picker, topbar search, synthesis selector compatibility
- explicit match diagnostics in API output (lexical match, semantic match, rerank score, author-index hits, diversification penalty)
- search **dev** judged set scored; holdout is not run at PR 7 (reviewer-scoped CI job runs holdout at PR 9). Reranker choice and its latency/cost committed alongside the dev scored artifact.

Acceptance:

- shared search service is the only ranking contract
- **dev** search judged-set metrics meet the committed **dev** floor; hub-title queries ("bert", "transformer"), niche queries, ambiguous-title queries, and author queries all pass their case-specific **dev** gates
- holdout evaluation is **not** required at PR 7 merge; holdout runs at PR 9 / merge-to-main
- measured reranker latency and cost are within the Search budget in Frozen Decision 15; the degraded-path fallback to the feature-based reranker is implemented and tested
- pagination and `see more` remain compatible
- the JSON-blob `authors contains` path is removed from the search pipeline; all author retrieval flows through the `Author` / `PaperAuthor` join tables

### PR 8 — Recommendations: Profile-Driven Retriever (Workstream D3)

Ship:

- `src/lib/recommendations/engine.ts` replaced or rewired around the profile-driven retriever
- recommendation seed cleanup on top of visibility + search + claim truth
- `src/lib/papers/retrieval/recommendations-ranker.ts`
- latest/recommended sidebars consume improved data
- recommendations benchmark judged set filled in and scored, including novelty and diversity metrics

Acceptance:

- duplicate losers never seed or appear in recommendations
- **dev** recommendations judged-set metrics (nDCG@10, novelty@10, ILS@10, subtopic-coverage@10) meet their committed **dev** floors
- holdout evaluation is **not** required at PR 8 merge; holdout runs at PR 9 / merge-to-main
- offline batch reranker runs within the Recommendations freshness SLA (24 h) and cost budget in Frozen Decision 15; online read p95 is within the cached-read budget
- recommendation lift over the current heuristic baseline is documented on the dev judged set

### PR 9 — Integration, Benchmarks, Merge

Ship:

- integrated validation
- all judged benchmark artifacts and snapshot artifacts
- snapshot verification on populated DB copy
- final merge prep

Acceptance:

- **reviewer-scoped CI job runs the holdout harness** for claims, related, search, and recommendations; every task meets its committed **holdout** floor. This is the blocking evaluation for merge-to-main.
- scored holdout artifacts (metric numbers only — no case content) are committed under `benchmark/scored/` in the implementation repo
- committed holdout floors (`benchmark/floors.json`) are updated when a holdout run delivers a lift; lowering a floor requires a plan update
- related-papers holdout: per-seed-class gates pass (hub ILS / subtopic-coverage; niche Recall@20; ambiguous-title sense-correct nDCG@10; cross-community subtopic-coverage)
- search holdout: DOI / arXiv / full-title classes show MRR@1 = 1.0; author and concept classes meet committed nDCG@10 / MRR@10 floors
- recommendations holdout: relevance, novelty, ILS, subtopic-coverage all clear committed floors
- claims holdout: claim F1 under the frozen matcher, rhetorical-role accuracy, and `evaluationContext` recall on contradiction-eligible claims all clear committed floors
- determinism snapshots for each surface committed alongside the scored holdout artifacts
- paper chat smoke passes on the integrated branch

## Benchmark / Evidence Artifacts

**Determinism snapshots prove reproducibility; judged sets prove relevance.** This tranche ships both, and the judged sets are non-negotiable: a surface that regresses a judged metric below its committed floor blocks merge regardless of how clean its snapshot looks. The literature is explicit that ranking, search, and recommendation are different evaluation tasks that need task-aware judged sets ([SciDocs in SPECTER, 2020](https://aclanthology.org/2020.acl-main.207/); [SciRepEval, 2023](https://aclanthology.org/2023.emnlp-main.338/)).

### Determinism snapshots (no relevance claims)

- `benchmark/paper-analysis/claims.snapshot.json` — stable extraction output for a fixture corpus
- `benchmark/paper-analysis/contradictions.snapshot.json`
- `benchmark/paper-analysis/timeline.snapshot.json`
- `benchmark/search/relevance.snapshot.json` — deterministic output for fixture queries (does not grade relevance)
- `benchmark/recommendations/recommendations.snapshot.json` — deterministic output for fixture profiles

### Judged sets (relevance, novelty, diversity)

**Dev / holdout split is mandatory for every judged task**, to keep the benchmark a guardrail and not a target. If the same engineers tune rerankers against the same visible seeds/queries/profiles, the benchmark becomes fit-to. The discipline is:

- **Dev judged set** (`benchmark/judged/<task>.dev.judged.json`) — visible to implementation engineers. Lives in the implementation repo. Used for iteration during PR 6 / 7 / 8. Metrics are reported on dev in PR narratives.
- **Holdout judged set** — **lives outside the implementation repo and is never committed to it**. A committed file under `benchmark/judged/` is visible by definition and is not a holdout; any mechanism that claims otherwise is performative. This plan picks one real storage mechanism and sticks with it:
  - **Primary mechanism: a separate private holdout repo** (e.g. `paper-finder-holdout`) owned by reviewers. Contents mirror the dev structure (`<task>.holdout.judged.json` files plus annotation provenance). Implementation engineers have no read access.
  - **Secondary mechanism (if a separate repo is not practical): a reviewer-held artifact store** (encrypted object store, private gist, or similar) whose location is supplied to CI as a secret URL + pull token. Implementation engineers have no read access to the secret.
  - **The implementation repo never contains holdout JSON, holdout case ids, holdout answer keys, or holdout answer-key hashes.** A check-in of any holdout content to the implementation repo rotates that case to dev per the rotation rule and triggers reviewer authorship of a replacement.
- **Dev:holdout size ratio** is roughly 2:1, with the holdout covering every case class the dev set covers — hub, niche, ambiguous-title, cross-community for related; all five query classes for search; all four profile classes for recommendations.
- **Rotation rule**: if a holdout case ever appears in implementation context (cited in PR text, added to a test fixture, surfaced in ad-hoc smoke output, or committed anywhere in the implementation repo), it is moved to dev and a reviewer authors a replacement before the PR that leaked it can merge. The rotation is tracked in the holdout repo's changelog.

**Annotation guidelines** are committed under `benchmark/judged/GUIDELINES.md` and cover:

- relevance scale (`0` = not relevant, `1` = relevant, `2` = highly relevant; with concrete examples per task)
- subtopic-label taxonomy per task (what clusters count as distinct subtopics; informed by library tags and canonical-entity clusters, with reviewer override)
- novelty criteria for recommendations (what counts as "already in the library or adjacent to many engaged papers")
- diversity criteria: what counts as a redundant result for the purposes of ILS and subtopic coverage
- adjudication rules (next bullet)

**Adjudication process**: every judged case is labelled by at least two annotators. Disagreements on relevance grades ≥ 1 apart, or any disagreement on subtopic/novelty/stance labels, go to a third reviewer-owner for adjudication. The adjudicated label is the committed label. Inter-annotator agreement (Cohen's κ or percent agreement, per label type) is reported in a per-task agreement artifact; dev agreement lives at `benchmark/judged/<task>.dev.agreement.json` in the implementation repo, and holdout agreement lives at `<task>.holdout.agreement.json` in the private holdout store. A κ below the committed floor blocks acceptance of that split.

Each judged set is a committed JSON artifact containing input cases with human-graded labels. The judged set is the contract; the metric runner consumes it and emits a scored artifact. Storage paths differ by split:

- **dev sets** live in the implementation repo under `benchmark/judged/<task>.dev.judged.json`
- **holdout sets** live in the private holdout store described above (separate private repo *or* reviewer-held artifact store). The reviewer-scoped CI job resolves the holdout location from `HOLDOUT_FIXTURE_PATH` or `HOLDOUT_FIXTURE_URL`; the paths inside that store mirror the dev structure but are never path-referenced from the implementation repo.

Per-task ground truth:

- **claims** — dev file `benchmark/judged/claims.dev.judged.json` (implementation repo); holdout file `claims.holdout.judged.json` (private holdout store)
  - dev: ≥ 10 library papers spanning ML, systems, NLP, and one non-CS paper; holdout: ≥ 5 additional papers with the same class coverage, reviewer-owned
  - for each paper: the expected claim set with rhetorical role, facet, polarity, `evaluationContext` (where applicable), and stance triple (where applicable)
  - primary match: **span-overlap + field match**, not exact excerpt-hash. Extracted claims are aligned to ground-truth claims via Hungarian assignment on a pairwise cost combining source-span character-level IoU, normalized-text similarity, and field agreement. Assignment cost below a committed threshold counts as a match. Exact excerpt-hash equality is a bonus signal for idempotence tests, not the primary relevance criterion. This protects against punishing semantically correct claims extracted from slightly different overlapping spans, especially under LLM extraction.
  - **the matcher is a versioned, frozen artifact** — not prose. The benchmark infrastructure commits:
    - `scripts/benchmark/claim-matcher.ts` — exact implementation of the Hungarian assignment cost function; changes to this file require a reviewer-run holdout rescoring in the same PR
    - `benchmark/claim-matcher-config.json` — frozen config with:
      - `matcherVersion` (semver; bumped on any behavioral change)
      - `spanIouWeight`, `textSimWeight`, `fieldAgreementWeight` (cost components)
      - `assignmentMatchThreshold` (below this cost = match)
      - `textSimilarity.mode` — one of `edit_distance_ratio` (deterministic, no model) or `embedding_cosine` (requires a pinned model)
      - when mode is `embedding_cosine`: `textSimilarity.modelId`, `textSimilarity.modelVersion`, `textSimilarity.modelChecksum` — the model artifact is pinned; a change to any of these is a matcher-version bump
    - **floor recalibration policy**: any change to `matcherVersion` (cost weights, threshold, text-similarity mode, or pinned model) requires the same PR to (a) run the reviewer holdout harness under the new matcher, (b) emit a rebaselined `benchmark/floors.json` for the claims task, (c) include a reviewer-signed note explaining why the matcher change is not just a benchmark manipulation. Dev floors may shift in the matcher-update PR with the same rationale. Without this protocol, extractor quality and evaluator behavior can silently drift together.
    - the scored artifact from every claims harness run records the `matcherVersion` it ran under; the compare script refuses to diff two runs under different `matcherVersion` values
  - metrics on matched pairs: rhetorical-role classification accuracy, facet classification accuracy, polarity accuracy, stance-triple field-level F1 (subject / predicate / object), `evaluationContext` field recall for claims where it applies
  - metrics on the assignment as a whole: claim precision, recall, F1 at the span-overlap threshold
  - merge floor: claim F1 ≥ committed baseline on holdout; rhetorical-role accuracy ≥ committed baseline on holdout; `evaluationContext` recall ≥ committed baseline on the subset of claims that qualify as contradiction inputs

- **related papers** — dev file `benchmark/judged/related-papers.dev.judged.json` (implementation repo); holdout file `related-papers.holdout.judged.json` (private holdout store)
  - seed papers covering four required classes:
    - **hub** (e.g. "Attention Is All You Need", "BERT", "Adam: A Method for Stochastic Optimization")
    - **niche** (papers with few library citations)
    - **ambiguous-title** (papers whose title phrase collides with other works)
    - **cross-community** (papers whose related set should include work from adjacent subfields, testing diversification)
  - for each seed: a graded list of candidate related papers with relevance labels (`0`/`1`/`2`) and subtopic annotations
  - metrics: nDCG@10, Recall@20, MRR@10, intra-list similarity (ILS, lower is better for hubs), subtopic-coverage@10
  - case-specific gates:
    - hub seed: ILS ≤ committed ceiling, subtopic-coverage@10 ≥ committed floor (this is the "Attention Is All You Need does not return only its own clique" gate)
    - niche seed: Recall@20 ≥ committed floor (the retrieval layer must find them at all)
    - ambiguous-title seed: nDCG@10 ≥ committed floor with the correct sense ranked above the wrong sense
    - cross-community seed: subtopic-coverage@10 ≥ committed floor

- **search** — dev file `benchmark/judged/search.dev.judged.json` (implementation repo); holdout file `search.holdout.judged.json` (private holdout store)
  - queries across five required classes:
    - DOI / arXiv exact
    - full-title phrase
    - partial-title / hub-title keyword (e.g. "bert", "transformer")
    - author-only
    - concept / topic (e.g. "attention mechanism", "instruction tuning")
  - for each query: graded library results with relevance labels
  - metrics: nDCG@10, MRR@10, Recall@20, plus class-specific reciprocal rank on the expected top-1 for DOI/arXiv/full-title classes
  - case-specific gates:
    - DOI / arXiv / full-title: MRR@1 = 1.0
    - author queries: MRR@10 ≥ committed floor (must not regress on author retrieval)
    - hub-title keyword: nDCG@10 ≥ committed floor; spot-check that the canonical paper ranks in the top-3

- **recommendations** — dev file `benchmark/judged/recommendations.dev.judged.json` (implementation repo); holdout file `recommendations.holdout.judged.json` (private holdout store)
  - synthetic library profiles (not real user data), covering:
    - single-interest profile
    - multi-interest profile
    - hub-heavy profile (library dominated by famous papers — tests anti-hub)
    - new-to-field profile (small library — tests cold-start)
  - for each profile: graded candidate lists with relevance, novelty (not-in-library), and subtopic annotations
  - metrics: nDCG@10, novelty@10 (fraction of top-10 not in the library), ILS@10 (diversity), subtopic-coverage@10
  - merge floors on all four metrics; recommendations regresses-on-any-metric blocks merge

### Harness

- `scripts/benchmark/run-judged.mjs` runs a judged set, writes a scored artifact under `benchmark/scored/`, and compares to committed floors. Accepts `--split dev|holdout`. The `--split holdout` path reads holdout data from a location specified by the env var `HOLDOUT_FIXTURE_PATH` (for the separate-repo mechanism) or `HOLDOUT_FIXTURE_URL` + `HOLDOUT_FIXTURE_TOKEN` (for the secret-backed mechanism). If neither env is set, `--split holdout` exits with a clear error. Implementation-engineer CI jobs do not have these env/secrets configured; reviewer CI jobs do.
- `scripts/benchmark/compare.mjs` diffs the current run against the previous committed scored artifact and flags regressions. For the holdout split, only the scored artifact (metric numbers) is ever written to the implementation repo; the raw cases are not.
- **Who runs what, when:**
  - Dev harness: runs on implementation-engineer CI for every PR touching Workstream A / D1 / D2 / D3 / E. Dev lifts are informational, not blocking.
  - Holdout harness: runs only in a reviewer-scoped CI job that has access to the holdout store. Triggered at PR 9 and at merge gates. **Holdout is the blocking evaluation.** A PR that lifts dev but regresses holdout does not merge.
- Metric floors are committed values **on the holdout set**, stored as `benchmark/floors.json` in the implementation repo (numbers only, no case content). Raising a holdout floor is part of the PR that earned the lift (after reviewer CI validates the lift on holdout). Lowering a holdout floor requires a plan update with explicit rationale. Dev floors are advisory and live alongside the dev sets.
- `scripts/benchmark/check-holdout-leak.mjs` runs as a CI check in implementation-engineer jobs. It fails on any file under `benchmark/judged/` whose name matches a `*.holdout.*` pattern, any commit that adds content to such a file, and any PR-narrative string matching committed holdout case-id patterns (case-id patterns are published by reviewers as regex, not as the case ids themselves). This check is structural defense against accidental leakage; the primary defense is that holdout never enters the implementation repo in the first place.

These are review artifacts, not throwaway local notes.

## Guardrails

Add CI checks for:

- paper-analysis route inventory uses shared engine
- search ranking goes through `src/lib/papers/search.ts`
- related-papers ordering goes through `src/lib/papers/retrieval/related-ranker.ts` (no UI surface bypasses the ranker)
- recommendations go through `src/lib/papers/retrieval/recommendations-ranker.ts`
- every user-facing retrieval surface runs the shared `diversify(...)` stage with a committed λ for its task
- paper chat routes use shared answer engine
- no new paper-analysis capability writes ad hoc prompt results without a structured schema
- the judged-benchmark **dev** harness runs on every implementation PR that touches Workstream A, D1, D2, D3, or E; **dev floors gate PRs 6-8, holdout floors gate PR 9 / merge-to-main**. Implementation-engineer CI cannot invoke `--split holdout`; the holdout harness runs only in a reviewer-scoped CI job
- `check-holdout-leak.mjs` runs on every PR and fails on any committed file under `benchmark/judged/*.holdout.*`, or PR text matching reviewer-published holdout case-id regex patterns
- **measured reranker latency and cost are within the per-task budget in Frozen Decision 15**; a PR that proposes a reranker exceeding budget cannot merge even with judged lift. Budget and lift numbers are both committed alongside the scored artifact
- **`Author.id` equality is not used as identity evidence in ranking/recommendation code paths** unless matching `orcid` or `semanticScholarAuthorId` is also required; `check-author-identity-usage.mjs` enforces this
- **claim-matcher version** is consistent between compared scored artifacts; `scripts/benchmark/compare.mjs` refuses cross-version diffs; a matcher-version bump requires a rebaselined `floors.json` in the same PR
- `rhetoricalRole`, `facet`, `polarity`, `sectionPath`, `evidenceType` are controlled-enum inputs (no free-form values leak into the DB); `evaluationContext` fields carry their normalization decisions with them
- every `ContradictionCandidate` carries explicit `evaluationContext` alignment evidence; a contradiction emitted without aligned `task` + `dataset` + `metric` on both claims fails CI
- author-token retrieval after PR 7 goes through the `Author` / `PaperAuthor` join tables; CI fails on new JSON-blob `authors contains` queries in the search pipeline
- every reranker in D1 / D2 / D3 has a committed choice-of-family and latency/cost measurement in the judged artifact that selected it; CI fails on a reranker swap without an accompanying judged run

## Main Risks

1. **Conflating the three retrieval tasks.**
   Related(seed), Search(query), and Recommended(profile) are different IR problems with different inputs, relevance criteria, and diversity/novelty requirements ([SciRepEval, 2023](https://aclanthology.org/2023.emnlp-main.338/)). Shipping one shared ranker across all three will reproduce the current hub-paper failure mode. Mitigated by the three-workstream split (D1/D2/D3) and the task-separated judged benchmarks.

2. **"Clean up the heuristics" framing bleeding back into Frozen Decisions.**
   The prior version of Decision 8 constrained search to "normalized retrieval plus deterministic reranking in app code." That is too narrow. Mitigated by Decisions 7, 8, and 9, which require multi-stage retrieval with a dense-retrieval stage and task-specific rerankers, and by the judged benchmarks that would fail any retriever still acting like a substring-plus-rerank.

3. **Claims substrate becoming noisy and unusable.**
   Thin claim blobs make contradiction/gap/timeline synthesis degenerate into LLM prose. Mitigated by the expanded schema (`rhetoricalRole`, `facet`, `polarity`, `stance`, `sectionPath`, `citationAnchors`, `evidenceType`) and the claims judged set that scores extraction quality directly.

4. **Diversification treated as polish.**
   Pure relevance ranking over a citation graph collapses on hub papers ([Abdollahpouri et al. 2021](https://link.springer.com/article/10.1007/s10791-021-09399-z)). Mitigated by Frozen Decision 10 making the diversification stage obligatory, by Workstream E owning a shared implementation, and by the hub-seed case-specific gates on the judged set.

4a. **Bias toward small explainable rerankers.**
   The plan earlier leaned on small linear/logistic rerankers as the default. That is an engineering-local bias, not a quality bias — if an LLM or cross-encoder reranker materially improves judged quality at acceptable latency and cost, that wins. Mitigated by Frozen Decision 15 and by judged-suite-driven reranker selection in D1 / D2 / D3.

4b. **Single-representation overreach.**
   Reusing one paper embedding across Related / Search / Recommended quietly re-conflates three different retrieval tasks. Mitigated by Frozen Decision 16 permitting task-specific encoders / heads / ANN indexes when the judged suite shows they help.

4c. **Contradiction false positives across mismatched experimental setups.**
   "X improves Y on MNLI" paired with "X does not improve Y on SST-2" would be a false contradiction. Mitigated by the `evaluationContext` schema and by Workstream B's rule that contradiction candidates require aligned `task` + `dataset` + `metric`.

4d. **Judged benchmark becoming a target.**
   Engineers tuning against a visible judged set produces fit-to-benchmark gains without real-world quality. Mitigated by the dev / holdout split, the holdout-only merge floors, reviewer-owned holdout authorship, the annotation guidelines, adjudication, and `check-holdout-leak.mjs`.

4e. **"Real author index" hand-wave turning into a data-model debt.**
   Substring-blob matching on `Paper.authors` cannot be fixed with ranking alone. Mitigated by the Author Index section freezing a normalized `Author` + `PaperAuthor` schema with an idempotent backfill and PR 7 retiring the JSON-blob search path.

4f. **Author name-collision poisoning ranking features.**
   `Author.id` equality in this tranche means normalized-name equality, not person identity. Treating it as identity would make two unrelated "J. Smith" papers look like same-author collaborators and corrupt relatedness and recommendations. Mitigated by the Author Index lexical-vs-identity rule, the two separate reranker features (`lexical author overlap` and `identity-backed author overlap`), and the `check-author-identity-usage.mjs` guardrail.

4g. **Holdout benchmark secrecy being performative instead of structural.**
   A committed holdout file in a shared repo is visible by definition; a leak-check script cannot fix that. Mitigated by the rule that holdout never enters the implementation repo — it lives in a separate private store — and by the reviewer-scoped CI job being the only place `--split holdout` runs.

4h. **Reranker latency/cost budgets being aspirational.**
   "Use the better model within budget" is only an execution rule if the budget is numeric and committed. Mitigated by Frozen Decision 15's frozen per-task budgets and `benchmark/budgets.json`.

4i. **Claims evaluator drifting with the extractor.**
   If the matcher's text-similarity scorer changes, claim F1 moves without the extractor changing. Mitigated by the versioned `scripts/benchmark/claim-matcher.ts` + `benchmark/claim-matcher-config.json` pair, the floor-recalibration policy on matcher-version bumps, and compare-script refusal to diff cross-version runs.

5. **Overloading the tranche with section-aware ambitions.**
   This plan must stay on claims/retrieval/chat/search/recommendations, not GROBID section experiments.

6. **Paper chat convergence drifting into "build a second research agent."**
   The paper answer engine must stay scoped to paper analysis and typed artifacts.

7. **Search work becoming a UI task instead of a retrieval task.**
   The deliverable is better retrieval and ranking, not a prettier search modal.

8. **Recommendation improvements remaining heuristic-only.**
   The engine must consume stronger seeds (claim facets, chat engagement, relation history) and stronger visibility/search truth, not just more prompt text.

## Readiness Gate

This execution plan is ready to start when all of the following are true:

1. `now` tranche remains green on `main`
2. this doc is reviewed and accepted as the `next` execution sequence
3. `PaperClaimRun` / `PaperClaim` / `ConversationArtifact` schema direction is accepted, including the controlled-enum fields (`rhetoricalRole`, `facet`, `polarity`, `evidenceType`), the `evaluationContext` structure (`task`, `dataset`, `metric`, `comparator`, `setting`, `split`), and the `sectionPath` normalization table
4. the three-task split (Related / Search / Recommended) and the multi-stage retrieval contract (Frozen Decisions 7-10) are accepted
5. the reranker-family-by-judged-benchmark rule (Frozen Decision 15) and the task-specific-representation permission (Frozen Decision 16) are accepted
6. the Author Index section — normalized `Author` + `PaperAuthor` with idempotent backfill — is accepted as the author-retrieval substrate for PR 7
7. the judged-benchmark suite with dev (committed in the implementation repo) and holdout (stored outside the implementation repo via the primary or secondary mechanism described in the Judged-sets section), annotation guidelines (`benchmark/judged/GUIDELINES.md`), adjudication process, and committed holdout metric floors (`benchmark/floors.json`) are accepted as blocking evidence for PRs 6-9
8. the holdout storage mechanism is decided (separate private repo or reviewer-held artifact store + secret), and the reviewer-scoped CI job that runs `--split holdout` is configured with the required env/secret
9. per-task latency / cost / freshness budgets (`benchmark/budgets.json`) are accepted; any budget revision requires judged evidence
10. the initial seed/query/profile authoring for dev sets, and the reviewer-owned holdout authorship, are both scheduled (who writes, who adjudicates, by when)
11. the claim matcher version contract (`scripts/benchmark/claim-matcher.ts`, `benchmark/claim-matcher-config.json`) is accepted, and the floor-recalibration policy on matcher-version bumps is accepted

## Success Criteria

- paper claims exist as first-class paper-scoped rows with controlled rhetorical role, facet, polarity, stance, normalized section path, **and an `evaluationContext` that makes contradiction synthesis honest**
- gap/timeline/compare operate over typed claim structure, not free-form text blobs
- contradiction candidates require aligned `task` + `dataset` + `metric`; no contradiction ships without explicit alignment evidence
- paper chat uses a shared retrieval/analysis backend
- paper chat can emit typed artifacts
- Related(seed), Search(query), and Recommended(profile) are **separate services with separate judged benchmarks, separate reranker choices, and separate representation decisions when the judged suite warrants it**
- **hub-paper seeds (e.g. "Attention Is All You Need") pass the holdout ILS / subtopic-coverage gate**, not just the dev gate
- every reranker choice is recorded alongside the judged artifact that justified it, with latency and cost measurements within the committed per-task budget
- author retrieval is served by the normalized `Author` / `PaperAuthor` join tables; no search-path code reads `Paper.authors` as a JSON blob; no ranking path treats `Author.id` equality as person identity without ORCID / Semantic Scholar backing
- PR 6 / 7 / 8 clear their committed **dev** floors; PR 9 clears the committed **holdout** floors evaluated by the reviewer-scoped CI job. The holdout set never enters the implementation repo.
- the claim matcher is a versioned, frozen artifact; scored runs are cross-version-compare-proof; matcher changes come with rebaselined floors in the same PR
- recommendations/latest consume better search, claim, and visibility truth, with measurable novelty and diversity gains over the current heuristic baseline
