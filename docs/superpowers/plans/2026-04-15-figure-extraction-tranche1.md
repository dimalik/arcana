# Tranche 1: ltx_tabular + Gap Reasons + Acceptance Runner

**Date:** 2026-04-15
**Status:** Complete
**Depends on:** Figure extraction checkpoint (`e36fa54`..`0bb3eb1`)
**Spec:** `docs/superpowers/specs/2026-04-15-figure-extraction-pipeline.md`

## Context

The figure extraction pipeline produces good results for arXiv HTML figures but has three gaps: (1) arXiv LaTeXML tables (`ltx_tabular` spans) are missed and fall through to bad PDF crops, (2) when a canonical row has no image, there's no product-facing reason why, and (3) quality is assessed by manual spot-checking with no systematic measurement.

---

## Task A: Capture `ltx_tabular` tables

### Code change

**File:** `src/lib/import/figure-downloader.ts`

In `extractFiguresFromHtml()`, after the existing `<table>` check (line 287), add a check for `ltx_tabular`. The markup uses deeply nested `<span>` tags (100+) so a closing-tag regex is infeasible. Approach: if no `<table>` and no `<img>` but `ltx_tabular` is present in the figure block, strip the `<figcaption>` and use the remaining block as `tableHtml`.

**This is a pragmatic parser, not a principled HTML normalizer.** The stripped block may include footnotes, wrappers, anchors, and LaTeXML scaffolding around the actual table data. Acceptable for tranche 1; a proper ltx_tabular-to-HTML-table converter is future work.

**Changes (~15 lines):**
- Add an `else if` branch after the `<table>` match block
- Check whether the figure block HTML contains a descendant element whose `class` includes `ltx_tabular` (the marker is on nested spans inside the `<figure>`, not on the block element itself; match tolerant of multiple classes, e.g. `class="ltx_tabular ltx_align_middle"`)
- Strip figcaption, push remaining content as `{ type: "table", tableHtml }`
- Sanity check: `tableHtml.length > 50`

### Testability

`extractFiguresFromHtml` is currently private. Export it as a named export from `figure-downloader.ts`.

**New file:** `src/lib/import/__tests__/figure-downloader.test.ts`

**Tests (inline HTML, no HTTP):**
1. Standard `<table>` in `<figure>` block → returns `{ type: "table", tableHtml, figureLabel }` (regression)
2. `ltx_tabular` in `<figure>` block → returns `{ type: "table", tableHtml, figureLabel }` (new path)
3. Both verify: extracted label matches caption, `tableHtml` contains expected content, `url` is empty

### Files changed

- `src/lib/import/figure-downloader.ts` — export parser, add ltx_tabular branch
- `src/lib/import/__tests__/figure-downloader.test.ts` — new test file

### Verify

Run on Zero-Shot Data Gen (`0058726e`). Tables 1-4 should become `arxiv_html | high` with structured content. Tables 5-8 (standard `<table>`) unaffected. Run all 5 arXiv papers for regressions.

---

## Task B: Gap reasons (product-facing)

### Invariant

`gapReason` is set **only** on canonical rows (`isPrimaryExtraction: true`) where `imagePath` is null. It explains why the user sees no image for this figure/table. It is not a debug/suppression log for internal pipeline decisions.

Alternates do not get `gapReason`.

### Taxonomy

| Reason | When | User meaning |
|--------|------|-------------|
| `structured_content_no_preview` | Canonical has HTML content (`description`) but no image | "We have the table data, just no screenshot" |
| `no_image_candidate` | Caption found but no image recovered from any source | "We know this figure exists but couldn't recover the image" |
| `crop_failed` | Render+crop was attempted but errored | "Image recovery was attempted and failed" |
| `crop_rejected` | Crop was produced but failed quality gate | "Image was recovered but too low quality to show" |

### Ownership: the merger owns gapReason

The merger is the single owner of `gapReason` assignment. It already decides the canonical row and does image grafting — `gapReason` is a direct consequence of that decision.

To distinguish `crop_failed` from `crop_rejected` from `no_image_candidate`, the merger needs to know what happened at extraction time. The PDF pipeline adds a `cropOutcome` field to its output records:

- `"success"` — crop produced and passed quality gate
- `"rejected"` — crop produced but failed quality gate (too thin/narrow/extreme)
- `"failed"` — render+crop errored (pdftoppm/PIL failure)

`cropOutcome` is added to `MergeableFigure` so it flows through `toMergeable` into the merge. The merger consumes it when assigning `gapReason` on canonical rows with no image:

```
if isPrimary and imagePath is null:
  if description has substantial content → "structured_content_no_preview"
  else if cropOutcome == "failed" → "crop_failed"
  else if cropOutcome == "rejected" → "crop_rejected"
  else → "no_image_candidate"
```

`cropOutcome` is transient — it flows through the merge but is **not** persisted to the DB. Only `gapReason` is persisted.

The orchestrator's role is purely mechanical: it adds `cropOutcome` to `toMergeable` and adds `gapReason` to the `fields` object for the DB upsert. It does not interpret either field.

### Schema change

Add `gapReason String?` to PaperFigure. Nullable, additive.

### Files (5)

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `gapReason String?` to PaperFigure |
| `src/lib/figures/source-merger.ts` | Add `cropOutcome` + `gapReason` to `MergeableFigure`. In canonical row builder: assign `gapReason` when `isPrimary && !imagePath`. Propagate `gapReason: null` on alternates. |
| `src/lib/figures/extract-all-figures.ts` | Add `cropOutcome` and `gapReason` to `toMergeable` input/output. Add `gapReason` to `fields` object (DB upsert). Do not add `cropOutcome` to `fields`. |
| `src/lib/figures/pdf-figure-pipeline.ts` | Add `cropOutcome` to `ExtractedFigure`. Set `"success"`, `"rejected"`, or `"failed"` at each outcome point. Set `null` on embedded image matches. |
| Migration | Backup + `npx prisma migrate dev --name add_gap_reason` |

**Pre-flight:** `./scripts/backup-db.sh pre-gap-reason`. Inspect generated SQL — confirm ALTER TABLE, not DROP+CREATE.

### Verify

- Extract Zero-Shot Data Gen. Tables with HTML but no image → `gapReason: "structured_content_no_preview"`.
- Extract a PDF-only paper. Gap placeholders → `"no_image_candidate"`, `"crop_failed"`, or `"crop_rejected"`.
- `SELECT gapReason, COUNT(*) FROM PaperFigure WHERE gapReason IS NOT NULL GROUP BY gapReason`
- Confirm: no alternate rows have `gapReason` set.
- Confirm: no rows with `imagePath IS NOT NULL` have `gapReason` set.

---

## Shared utility: label normalization

**New file:** `src/lib/figures/label-utils.ts`

Move `normalizeLabel` from `source-merger.ts` into a standalone utility module. Both the merger and the acceptance runner import from here.

```typescript
// src/lib/figures/label-utils.ts
export function normalizeLabel(label: string | null): string | null { ... }
```

Update `source-merger.ts` to import from `label-utils.ts` instead of defining it locally.

This is a prerequisite for Task C but can be done as part of Task A or Task B since it's a pure refactor.

---

## Task C: Acceptance runner

**Not a benchmark.** A smoke-level acceptance harness that checks label-level recall, not just counts. The name is "acceptance runner" until it has gold-standard annotations with human-verified bounding boxes.

### New files (2)

1. `scripts/figure-acceptance.json` — fixture
2. `scripts/figure-acceptance.ts` — runner

### Fixture structure

```json
{
  "papers": [
    {
      "arxivId": "2506.08712",
      "title": "ConfPO",
      "category": "clean_arxiv_html",
      "expectedFigures": ["Figure 1", "Figure 2", "...", "Figure 12"],
      "expectedTables": ["Table 1", "...", "Table 7"],
      "expectedSources": {
        "Figure 1": "arxiv_html",
        "Table 1": "arxiv_html"
      },
      "labelExpectations": {
        "Table 2": { "expectsImage": false, "expectedGapReason": "structured_content_no_preview" },
        "Figure 1": { "expectsImage": true }
      }
    },
    {
      "fileBasename": "publisher-7927473a.pdf",
      "title": "Direct Preference Optimization",
      "category": "pdf_only",
      "expectedFigures": ["Figure 1", "Figure 2", "Figure 3"],
      "expectedTables": ["Table 1", "Table 2"]
    }
  ]
}
```

**Identity:** Papers keyed by `arxivId`, `doi`, or `fileBasename` — stable identifiers that survive DB rebuilds. The runner resolves each to `Paper.id` at runtime via a DB lookup. If the lookup returns 0 rows, the runner fails the paper with "paper not found." If it returns >1 rows, the runner fails the paper with "ambiguous identifier." Both are hard failures — no fallback, no "pick first." This is a fixture authoring error and should be caught immediately.

`fileBasename` is a practical convenience for tranche 1 (filenames include random hashes, unique in practice). If it proves fragile, replace with title-based lookup later. No UUIDs in fixture.

**Labels:** Fixture stores labels in human-readable form ("Figure 1", "Table 3"). The runner normalizes all labels — from `expectedFigures`, `expectedTables`, `expectedSources` keys, and `labelExpectations` keys — at fixture load time using `normalizeLabel` from `label-utils.ts`. Actual DB labels are normalized the same way before comparison. This prevents "Fig. 1" vs "Figure 1" false failures.

**Per-label expectations (optional):** `labelExpectations` lets the fixture assert that specific labels have/don't have images and carry the expected `gapReason`. This validates Task B semantics at label level — a paper can't pass if an expected no-preview table suddenly becomes an image-backed crop or vice versa.

**Categories** for slicing: `clean_arxiv_html`, `broken_arxiv_html`, `ltx_tabular`, `pdf_only`.

### Fixture population

Start with the 5 arXiv papers (labels and sources known from testing). Add more incrementally.

### Data source

The runner queries the DB directly via Prisma, not the figures API. All queries filter `isPrimaryExtraction: true` — only canonical rows are evaluated. This avoids auth/server dependencies and guarantees alternates never inflate unexpected labels or distort source match rates.

### Runner reports

Per-paper:
- Figure recall by label (expected vs found, normalized)
- Table recall by label
- Missing labels (expected but not found)
- Unexpected labels (found but not expected)
- Source match rate (for papers with `expectedSources`)
- Label expectation violations (wrong `expectsImage` or `expectedGapReason`)

Aggregate:
- High-confidence primary count / total primaries
- Primary gaps with gapReason distribution (if `gapReason` column exists)
- Structured-table count
- Low-confidence primary rate

### Runner defaults

**Default mode is report-only** — reads from existing DB state without re-extracting. Non-mutating, fast, safe to run repeatedly.

Mutating modes:
- `--extract`: run extraction for all fixture papers before reporting (writes to DB + disk)
- `--extract --paper <arxivId|doi|basename>`: extract + report single paper

### Runner does not hard-depend on gapReason

Core recall checks work without Task B. `labelExpectations` with `expectedGapReason` are validated only when the `gapReason` column exists in the DB. The runner degrades gracefully.

### Verify

Run `--extract` on the 5 arXiv papers. Confirm expected labels match. Confirm `labelExpectations` violations are flagged. Run default (report-only) and confirm same report without mutations. Confirm exit code is non-zero if a label is missing.

---

## Execution order

1. Backup DB
2. Extract `normalizeLabel` into `src/lib/figures/label-utils.ts`
3. Task A (ltx_tabular + export parser + tests) → verify → commit
4. Populate fixture expectations for 5 known arXiv papers
5. Task B (gapReason — merger owns assignment, cropOutcome transient) → verify → commit
6. Task C (acceptance runner with label-level expectations) → verify → commit
