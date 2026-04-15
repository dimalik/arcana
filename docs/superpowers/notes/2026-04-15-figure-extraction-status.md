# Figure Extraction Pipeline — Status & Plan

**Date:** 2026-04-15
**Commits:** `e36fa54`, `ee0eca9`, `e329015`, `532ecf4`

---

## Current State

The pipeline works. It's not done. Here's an honest assessment.

### What Works

**arXiv HTML figures** are the primary extraction path and produce good results. For papers with working arXiv HTML, the actual author-uploaded images are downloaded at high confidence. Tested on 5 papers — ConfPO (12 figures), Zero-Shot Data Gen (6 figures), Speculative Decoding (2 figures) all extracted correctly from HTML.

**arXiv HTML tables** (standard `<table>` elements) are captured as structured HTML content. The table-aware merge correctly makes the structured-content row canonical over any PDF crop. Tables 5-8 in Zero-Shot Data Gen and all 7 tables in Speculative Decoding come through with full HTML markup.

**PDF embedded images** work well when figures are stored as image objects in the PDF (not vector graphics). Medium confidence, correctly matched to captions by Y-proximity.

**Preview suppression** eliminates the worst failure mode: when arXiv HTML covers a figure, the pipeline no longer generates a bad PDF crop that pollutes the results. ConfPO went from 8 ugly crop files to 0.

**Transactional DB persistence** — the entire reconcile (upserts, label drift, stale demotion) runs in a single Prisma transaction. Reruns are idempotent. Failed runs roll back DB state cleanly. Note: source extractors still write image files to disk before the transaction, so a failed run can leave orphaned files on disk. Atomicity is DB-only, not end-to-end.

### What Doesn't Work

**LaTeXML tables** (the `ltx_tabular` pattern) are not captured. arXiv HTML renders many tables as nested `<span class="ltx_tabular">` instead of `<table>`. These fall through to PDF crop, which produces bad results. This is the primary failure for Zero-Shot Data Gen (Tables 1-4 are all `ltx_tabular`).

**PDF render+crop for tables** is still bad. When tables fall through to the PDF path (no HTML coverage), the content-region detection produces crops that are either body text, truncated, or include surrounding paragraphs. Tables 1-4 in Zero-Shot Data Gen demonstrate this.

**Composed figures / subfigures** — when arXiv HTML nests a figure as multiple child assets (image + legend + subpanels), the parser downloads the first `<img>` child, which can be a legend strip instead of the composed figure. GRPO html-1.png is an example.

**Broken arXiv HTML** — GRPO's arXiv HTML shows a compilation failure banner. The pipeline still extracts what it can (2 of 7+ figures) but misses most content. No detection of broken HTML.

### Per-Paper Results (5 test papers, snapshot from 2026-04-15 spot-check run)

| Paper | Figures | Tables | Figure Quality | Table Quality |
|-------|---------|--------|---------------|---------------|
| ConfPO | 12 HTML (good) | 7 HTML (4 structured-only, 3 with PDF preview) | Good | Good — structured content canonical |
| Speculative Decoding | 2 HTML (good) | 7 HTML (all structured) | Good | Good |
| Zero-Shot Data Gen | 6 HTML (good) | **4 PDF crop (bad)** + 4 HTML structured | Good | **Bad** — Tables 1-4 use `ltx_tabular`, not `<table>` |
| GRPO | 2 HTML (1 is legend strip) + 5 PDF | 2 PDF crop | Mixed — html-1 is bad | Bad — crops are body text |
| STAGE | 22 HTML + 135 embedded | 9 HTML (structured) | Good | Good — structured content |

---

## Architecture

```
Paper (with arXivId/DOI/PDF) 
  → Source 1: PMC/JATS (DOI → PMCID → tar.gz → JATS XML → figure files)
  → Source 2: arXiv HTML (arXivId → HTML page → <figure> elements + <table> elements)
  → Source 3: Publisher HTML (DOI → publisher page → allowlisted parsers)
  → Source 4: PDF fallback (caption detection → embedded images → render+crop)
       ↓ skips render+crop for labels already covered by sources 1-3
  → Merge (field-level: best caption + best image + structured content)
  → Transaction (upsert all, demote stale, label-drift handling)
  → DB (PaperFigure with isPrimaryExtraction, confidence, sourceMethod)
```

Key design decisions:
- **Source extractors write files only**, not DB rows. All PaperFigure DB persistence is in the transaction. Filesystem writes (image files) happen before the transaction and are not rolled back on failure.
- **Tables are first-class**: structured content wins as canonical; crop images are previews only.
- **Covered labels skip crop**: if arXiv HTML or PMC already has a figure, PDF render+crop is suppressed entirely.
- **Merge is field-level**: canonical row gets best caption from highest-priority source, best image from wherever, structured content from wherever.

---

## Known Corner Cases

**Tables with embedded images that are actually figures**: When a paper uses a `<table>` caption for a multi-panel figure grid (e.g., ConfPO Tables 1, 4, 5), the PDF path matches an embedded image to the table caption by Y-proximity. The result is a "table" row with an image that's actually a figure grid, not a table preview. The structured HTML content (from arXiv) is the real table data; the image is a mismatched figure. This affects caption-to-image matching — the matcher doesn't distinguish figure images from table images on the same page.

**LaTeX math in structured content**: Table 5 in ConfPO stores 264KB of raw LaTeXML math notation. The text extraction (`strip tags → text`) produces unreadable output like `\max\left(0,-\frac{1}{|y_{w}|}...`. A future cleanup step should render or strip math annotations.

---

## Remaining Problems (prioritized)

### ~~P0: LaTeXML table capture~~ — DONE (tranche 1, `d8325b5`)

Fixed. Parser now detects `ltx_tabular` descendant spans inside `<figure>` blocks. Zero-Shot Tables 1-4 moved from `pdf_render_crop|low` to `arxiv_html|high`. STAGE gained 9 additional tables.

### P1: Wire acceptance runner into CI

The acceptance harness exists (`scripts/figure-acceptance.ts`) but runs manually. Wire it into CI so regressions fail fast. Low effort, high safety value.

### P2: Expand fixture with ugly cases

The current fixture is 5 curated arXiv papers. Add genuinely hard cases: PDF-only papers, publisher/PMC papers, papers with complex layouts. This is what turns the smoke harness into real confidence.

### P3: HTML table preview rendering

Tables with structured HTML content but no image have a gap in the UI. Fix: render the `<table>` HTML to a preview image using Playwright or a lightweight HTML-to-image renderer.

**Impact:** Closes the UX gap for ~30% of tables that currently show "no preview."

### P4: Playwright container rendering for composed figures

When arXiv nests a figure as multiple child elements, the parser downloads the wrong asset. Fix: use Playwright to screenshot the entire `<figure>` DOM container.

**Impact:** Fixes the GRPO legend-strip problem and similar subfigure cases.

### P5: Broken arXiv HTML detection

GRPO's HTML has a compilation failure banner. The pipeline doesn't detect this and produces partial results. Fix: check for known failure markers in the HTML before trusting it.

**Impact:** Prevents silent partial extraction for a small % of papers.

### P6: Content-aware crop scoring for PDF fallback papers

For papers that fall back to PDF — both PDF-only (no arXiv ID) and papers with broken/incomplete HTML coverage. Fix: score candidate crop regions by visual density, reject crops that are mostly body text, try multiple crop directions. Only pursue after primary-source coverage is maximized.

### P5: Batch arXiv ID recovery

~2419 of ~2424 papers have no arXiv ID (5 were manually recovered for testing). Most were uploaded from arXiv PDFs. A batch refetch-metadata run would recover IDs and unlock the arXiv HTML path for the bulk of the library.

**Impact:** Transforms the pipeline from "mostly PDF fallback" to "mostly arXiv HTML" across the whole library.

---

## Technical Debt

1. **`description` field overloaded** — stores both LLM-generated descriptions and 70KB table HTML. Needs `structuredContent` + `structuredContentType` fields.
2. **Old figure-extractor.ts** — the vision-LLM approach is marked `@deprecated` but still importable. No live callers, but should be removed or gated.
3. **No benchmark** — extraction quality is assessed by manual spot-checking. The spec describes a 100-paper benchmark with per-bucket acceptance gates. Not built yet.

---

## Files

| File | Role |
|------|------|
| `src/lib/figures/extract-all-figures.ts` | Unified orchestrator — runs all sources, merges, transactional persist |
| `src/lib/figures/source-merger.ts` | Field-level merge with table-aware canonical selection |
| `src/lib/figures/pdf-figure-pipeline.ts` | PDF fallback: caption detection → embedded images → render+crop |
| `src/lib/figures/pdf-crop-renderer.ts` | Column-aware content-region crop via PyMuPDF layout analysis |
| `src/lib/figures/pdf-image-extractor.py` | PyMuPDF embedded image extraction with Y-position |
| `src/lib/figures/caption-detector.ts` | Regex-based Figure/Table/Fig caption detection |
| `src/lib/figures/pmc-jats-extractor.ts` | PMC OA package → JATS XML → figure files |
| `src/lib/figures/publisher-parsers.ts` | Allowlisted publisher HTML parsers (PLoS, Nature, MDPI, Science) |
| `src/lib/import/figure-downloader.ts` | arXiv HTML + publisher HTML figure download with quality gate |
| `src/app/api/papers/[id]/figures/route.ts` | GET (canonical only) + POST (extract all) |
| `scripts/extract-figures.ts` | CLI: extract figures for one/many/all papers |
