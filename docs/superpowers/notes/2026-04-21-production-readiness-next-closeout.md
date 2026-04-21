# Production Readiness Next Closeout

Date: 2026-04-21

This tranche is closed locally without forcing the remaining draft benchmark work.

## Closed

- `related papers`
  - live path stays on `feature_v1`
  - stronger LLM/open-model rerankers looked directionally better in some cases but were too slow for interactive use
  - external-model follow-up is parked in [2026-04-21-external-related-rerank-followup.md](./2026-04-21-external-related-rerank-followup.md)
  - latest dev evidence is in `benchmark/scored/related-papers.dev.scored.json`

- `search`
  - dev judged artifact refreshed against the populated DB
  - current metrics:
    - `nDCG@10 = 0.879607`
    - `MRR@10 = 1.0`
    - `Recall@20 = 0.888889`
    - `p95 latency = 170.152ms`

- `recommendations`
  - dev judged set is ready
  - offline/local-only benchmark mode exists and is committed
  - the offline local-only baseline is not a ship signal; it only closes the local benchmarking seam

## Deferred

- `claims`
  - moved back to backlog
  - `benchmark/judged/claims.dev.judged.json` remains draft and unlabeled
  - `benchmark/judged/claims.dev.agreement.json` remains draft with no adjudication
  - this is intentionally not a blocker for closing the current tranche

## Move-On Criteria

This tranche is considered closed enough to move on when all of the following remain true:

- live related papers stays on the fast `feature_v1` default
- search evidence stays green
- recommendations keeps the local/offline benchmark seam without pretending the offline score is production-ready
- claims stays explicitly deferred until real labeling work is rescheduled

## Next

Do not reopen claims benchmark work inside this tranche.

When claims returns from backlog, restart with:

1. real dev labels
2. agreement artifact
3. adjudication
4. only then scored claims evidence
