# Judged Benchmark Guidelines

## Relevance scale

- `0`: not relevant
- `1`: relevant
- `2`: highly relevant

## Related papers

- label subtopics explicitly
- hub seeds should surface multiple subtopics, not one clique
- niche seeds should still recover true neighbors

## Search

- DOI, arXiv, and full-title queries expect exact top-rank resolution
- author queries judge author-intent relevance, not just title overlap
- concept queries judge topical usefulness, not lexical coincidence

## Recommendations

- novelty rewards useful papers not already saturated in the user library
- redundancy hurts both novelty and diversity
- subtopic annotations should distinguish materially different communities

## Claims

- label claims at the smallest coherent proposition span
- capture rhetorical role, facet, polarity, and evaluation context when present
- use adjudication when annotators disagree by one relevance bucket or on any structured field
