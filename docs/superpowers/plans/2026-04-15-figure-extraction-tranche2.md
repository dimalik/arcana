# Tranche 2: Safe Table Previews + HTML Table Rendering

**Date:** 2026-04-15
**Status:** Complete
**Depends on:** Tranche 1 (`d8325b5`, `b39a9ad`, `8610e01`)
**Spec:** `docs/superpowers/specs/2026-04-15-figure-extraction-pipeline.md`
**Status note:** `docs/superpowers/notes/2026-04-15-figure-extraction-status.md`

## Context

Tranche 1 fixed recall and observability. It did **not** fully fix preview correctness for tables.

The current failure mode is worse than "no preview":
- some canonical `table` rows carry structured HTML content from `arxiv_html`
- the merge then grafts a nearby `pdf_embedded` image as the preview
- on pages that contain multi-panel figure grids near a table caption, that image is actually a figure, not a table

ConfPO Tables 1, 4, and 5 are the concrete example. The row is semantically a table. The preview image is semantically a figure. That is a correctness bug.

There is also a separate UX gap:
- many structured tables have no preview image at all
- the product has the real data (`description` / table HTML), but no visual preview

This tranche fixes those in order:
1. make semantically wrong table previews impossible
2. add a legitimate preview path for structured HTML tables

**Out of scope for this tranche:**
- Playwright container rendering for composed figures
- PDF crop scoring improvements
- LaTeXML math cleanup / plain-text normalization
- `description` schema split into `structuredContent`

---

## Invariants

1. `sourceMethod` is the provenance of the canonical content row.
2. `imagePath` may be enrichment; its provenance must be tracked separately.
3. `imageSourceMethod` is null if and only if `imagePath` is null.
4. When a row has an image from its own source, `imageSourceMethod = sourceMethod`.
5. When a canonical row borrows an image from another source, `imageSourceMethod` records the borrowed source.
6. For structured tables, **no preview is better than a wrong preview**.
7. A canonical table with structured HTML must never show a `pdf_embedded` or `pdf_render_crop` preview in tranche 2.
8. HTML-rendered table previews are presentation artifacts, not source-of-truth content.
9. HTML table preview rendering is post-extraction enrichment, not part of the transactional extraction contract.

---

## Task A: Safe table previews + image provenance

### Problem

`source-merger.ts` currently lets a structured-content table row graft the "best available image" from any lower-priority alternate. That is too permissive for tables.

We need two changes:
- separate canonical-content provenance from image provenance
- block unsafe PDF preview grafting onto structured tables

### Schema change

Add `imageSourceMethod String?` to `PaperFigure`.

Meaning:
- `null` when `imagePath` is null
- same as `sourceMethod` when the row's own source provided the image
- a different value when the canonical row borrows an image from another source

This is a nullable additive migration.

`imageSourceMethod` should also live on `MergeableFigure` / `MergedFigure`, not just the DB row. The merger is the single owner of both:
- which image, if any, is attached to the canonical row
- where that image came from

Persisted-field rule:
- every row with `imagePath != null` must have `imageSourceMethod != null`
- raw rows and alternates default to `imageSourceMethod = sourceMethod`
- canonical rows may override that when the merger grafts an image from another source

### Merge rule change

For canonical rows of `type = "table"`:
- if the canonical member has structured HTML (`description.length > 100`) and no image
- do **not** graft `pdf_embedded` or `pdf_render_crop` images from alternates
- leave `imagePath = null`
- leave `imageSourceMethod = null`
- set `gapReason = "structured_content_no_preview"`

Allowed image cases for structured tables in tranche 2:
- the canonical member already has its own image
- a future HTML-table renderer produces one

Not allowed in tranche 2:
- borrowing a PDF image simply because it is near the caption

Figure behavior stays unchanged.

### Files

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `imageSourceMethod String?` to `PaperFigure` |
| `src/lib/figures/source-merger.ts` | Add `imageSourceMethod` to `MergeableFigure` / merge output. Set it on all canonical rows with images. For structured canonical tables, refuse `pdf_embedded` / `pdf_render_crop` image grafting. |
| `src/lib/figures/extract-all-figures.ts` | Thread `imageSourceMethod` through persistence fields. Default alternates/raw rows with images to `sourceMethod` if not explicitly set. |
| Migration | `npx prisma migrate dev --name add_image_source_method` |

### Verify

- ConfPO Tables 1, 4, 5 become canonical `arxiv_html` table rows with:
  - `imagePath = null`
  - `imageSourceMethod = null`
  - `gapReason = "structured_content_no_preview"`
- No canonical structured table row has `imageSourceMethod IN ("pdf_embedded", "pdf_render_crop")`.
- Figure recall does not regress on the current 5-paper acceptance set.

Suggested query:

```sql
SELECT figureLabel, sourceMethod, imageSourceMethod, gapReason
FROM PaperFigure
WHERE isPrimaryExtraction = 1
  AND type = 'table'
  AND description IS NOT NULL
  AND length(description) > 100
  AND imageSourceMethod IN ('pdf_embedded', 'pdf_render_crop');
```

Expected result: zero rows.

---

## Task B: Acceptance runner — preview provenance, not just presence

### Problem

The current acceptance runner can assert:
- label recall
- primary source method
- whether an image exists
- gap reason

It cannot assert whether an image came from a semantically valid source.

That is exactly why the ConfPO table bug slipped through.

### Runner change

Extend `labelExpectations` with optional `expectedImageSourceMethod`.

Example:

```json
{
  "Table 1": {
    "expectsImage": true,
    "expectedImageSourceMethod": "html_table_render"
  }
}
```

Task B is intentionally two-phase:

1. **After Task A**
Use fixture expectations that lock the safety state:
- ConfPO Tables 1, 4, 5 → `expectsImage: false`
- Zero-Shot structured tables without previews → `expectsImage: false`

2. **After Task C**
Promote those expectations to:
- `expectsImage: true`
- `expectedImageSourceMethod: "html_table_render"`

This keeps the harness honest at both checkpoints instead of letting the bad-preview bug reappear between tasks.

### Files

| File | Change |
|------|--------|
| `scripts/figure-acceptance.ts` | Support `expectedImageSourceMethod` in `labelExpectations`; report provenance violations. |
| `scripts/figure-acceptance.json` | Add preview-provenance expectations for ConfPO, Zero-Shot, and other structured-table cases. |

### Verify

- After Task A: acceptance passes with no-image expectations for the affected structured tables.
- After Task C: acceptance passes with `expectedImageSourceMethod = "html_table_render"` on those same labels.
- Runner exits non-zero if a canonical structured table regresses to `pdf_embedded` / `pdf_render_crop`.

---

## Task C: Render structured HTML tables to preview images

### Goal

Close the UX gap left by Task A without reintroducing semantic mismatch.

The preview should come from the structured HTML table itself, not from the PDF fallback.

### Design

Create a table-preview renderer that:
- takes structured table HTML (`description`)
- wraps it in a minimal local HTML template with print-friendly CSS
- screenshots just the table container
- writes a PNG preview under the paper's figure output directory

Recommended implementation: Playwright.

Why Playwright here:
- it already fits the later composed-figure roadmap
- it renders complex HTML/CSS more faithfully than ad hoc HTML-to-image hacks
- it can handle wide tables with overflow and math-heavy markup better than string stripping

### Execution model

This runs as a **post-pass over DB rows after extraction commits**, not inside the extraction transaction.

Why:
- preview rendering is presentation enrichment, not core extraction
- Playwright startup cost should not bloat the transactional extraction path
- extraction should stay fast and DB-atomic even if preview rendering is slow or flaky

Concretely:
- `extractAllFigures` finishes and commits canonical rows first
- `extractAllFigures` then calls the post-pass helper as a best-effort follow-up step
- the post-pass queries canonical rows with `gapReason = "structured_content_no_preview"`
- the renderer writes preview files and updates only those rows it successfully renders

Invocation path for tranche 2:
- default path: `extractAllFigures` calls the post-pass helper after the transaction commits
- backfill/manual path: `scripts/render-table-previews.ts` runs the same helper for one paper or many

Failure policy:
- post-pass rendering errors are logged and do not fail extraction
- extraction remains DB-atomic for canonical rows even if preview rendering fails later

### Render policy

Run the post-pass renderer only for canonical rows where:
- `type = "table"`
- `description` exists and is substantial
- `imagePath` is null
- `gapReason = "structured_content_no_preview"`

On success:
- set `imagePath`
- set `assetHash`
- set `width` / `height`
- set `imageSourceMethod = "html_table_render"`
- clear `gapReason`

On failure:
- leave the row untouched
- keep `gapReason = "structured_content_no_preview"`

Do not:
- create alternates just for the rendered preview
- change `sourceMethod` away from the canonical content source
- rewrite or strip the raw HTML in this tranche
- move this work into the extraction transaction

### Files

| File | Change |
|------|--------|
| `src/lib/figures/html-table-preview-renderer.ts` | New helper: render structured table HTML to PNG preview |
| `src/lib/figures/render-missing-table-previews.ts` | New post-pass: find canonical structured tables with no preview, render them, persist preview fields |
| `src/lib/figures/extract-all-figures.ts` | Invoke the post-pass helper after a successful reconcile transaction; catch/log preview-render failures without failing extraction |
| `scripts/render-table-previews.ts` | CLI entry point for the post-pass |
| `scripts/figure-acceptance.json` | Update affected tables from `expectsImage: false` to `expectsImage: true, expectedImageSourceMethod: "html_table_render"` |

### Verify

- ConfPO Tables 1, 4, 5 have:
  - `sourceMethod = "arxiv_html"`
  - `imageSourceMethod = "html_table_render"`
  - non-null `imagePath`
  - `gapReason = null`
- Zero-Shot `ltx_tabular` tables render previews from HTML, not PDF.
- No canonical structured table row uses `pdf_embedded` or `pdf_render_crop` as `imageSourceMethod`.
- Acceptance runner passes on the 5-paper set.

---

## Explicit Deferrals

### Playwright container rendering for composed figures

Still the right next figure-quality fix. Not part of this tranche. Table preview correctness is the higher-priority product problem.

### LaTeXML math cleanup

Keep raw structured HTML as the source of truth. Do not attempt to flatten or sanitize math into user-facing plain text in this tranche. Rendering the table is enough for now.

### `description` schema split

Still valid technical debt. Do not mix it into this tranche. The preview bug is independent of the storage-model cleanup.

---

## Execution order

1. Backup DB
2. Task A: `imageSourceMethod` + safe table-preview merge semantics → verify → commit
3. Task B: acceptance-runner provenance support + fixture expectations for the safety checkpoint → verify → commit
4. Task C: HTML table preview renderer post-pass + fixture promotion to `html_table_render` expectations → verify → commit
5. Update status note with post-tranche results

---

## Success criteria

- Zero canonical structured tables have `imageSourceMethod = "pdf_embedded"` or `"pdf_render_crop"`.
- ConfPO Tables 1, 4, 5 are never shown with mismatched PDF figure-grid previews.
- Structured tables either:
  - show no preview honestly, or
  - show an HTML-rendered preview with `imageSourceMethod = "html_table_render"`.
- Current figure/table recall on the 5-paper acceptance set does not regress.
- The acceptance runner can fail on wrong preview provenance, not just missing labels.

---

## Implementation Review Notes

Plan is ready to implement. Both open questions from the previous round are resolved in the invariants and task descriptions. No remaining ambiguities.

One minor implementation note: the post-pass renderer in Task C needs to update `imageSourceMethod`, `imagePath`, `assetHash`, `width`, `height`, and clear `gapReason` — that's 6 fields on an existing row. Since this happens outside the transaction, it should be a simple `prisma.paperFigure.update()` per row, not a batch upsert. If the update fails for one table, the others should still proceed (best-effort, not all-or-nothing).
