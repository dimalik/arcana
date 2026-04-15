# Figure Extraction Pipeline — Implementation Notes

**Date:** 2026-04-15
**Spec:** `docs/superpowers/specs/2026-04-15-figure-extraction-pipeline.md`
**Plan:** `docs/superpowers/plans/2026-04-15-figure-extraction-track-a.md`

---

## What Was Implemented

### Phase 1: Identity Hardening

**Files modified:**
- `src/app/api/papers/[id]/refetch-metadata/route.ts`
- `src/lib/import/semantic-scholar.ts`

**Changes:**
1. `searchByTitle()` now filters results through `isFigureOrSupplementDoi()` before returning. Previously the filter only applied in `searchAllSources()` (multi-result search), not the single-result `searchByTitle()` used by refetch-metadata.
2. refetch-metadata route now double-checks both the figure-DOI filter AND title similarity (threshold 0.6) before accepting a result. Rejects with a logged warning if either check fails.

**Design decision:** The 0.6 similarity threshold is deliberately lower than the 0.7 used in `pickBest()` to avoid false rejections on papers with unusual formatting. The route logs the similarity score for audit.

### Phase 4: arXiv HTML Figure Extraction (Provenance Enhancement)

**File modified:** `src/lib/import/figure-downloader.ts`

**Changes:**
1. `sourceMethod` is now `"arxiv_html"` or `"publisher_html"` instead of the generic `"html_download"`.
2. Each figure gets a `figureLabel` parsed from its caption (e.g., "Figure 3", "Table 1") via a new `parseFigureLabel()` helper, falling back to `html-fig-{i}` if no label found.
3. `assetHash` (SHA-256) computed for every downloaded image.
4. `confidence` set to `"high"` for arXiv HTML, `"medium"` for publisher HTML.
5. `captionSource` is now `"html_figcaption"` (specific) instead of the vague `"html"`.
6. Return type changed from `{ downloaded: number }` to `FigureDownloadResult` with `source` and `sourceUrl` fields. Backward-compatible (existing callers only use `.downloaded`).

**Design decision:** The arXiv HTML source is tried first (most reliable), publisher HTML only tried if no arXiv figures found. This matches the spec's priority ordering and avoids wasting time on Cloudflare-blocked publisher pages when arXiv HTML is available.

### Phase 3: PMC/JATS Figure Extraction

**New file:** `src/lib/figures/pmc-jats-extractor.ts`

**Architecture:**
1. Resolves DOI → PMCID via Europe PMC API
2. Gets OA package FTP URL from NCBI's oa.fcgi
3. Downloads and decompresses tar.gz
4. Parses tar entries (reuses the same manual tar parser from pdf-finder.ts)
5. Finds JATS XML (.nxml or .xml) in the package
6. Parses `<fig>` and `<table-wrap>` elements for labels, captions, and `<graphic>` references
7. Matches graphic references to image files in the tar (handles stem-only references, various extensions)
8. Converts TIFF images to PNG via PIL (common in biomedical literature)
9. Computes assetHash and saves with `sourceMethod: "pmc_jats"`, `confidence: "high"`

**Design decisions:**
- JATS parsing uses regex over the XML string rather than a full XML parser. This is pragmatic — JATS is well-structured enough that regex works reliably for the specific elements we need (`<fig>`, `<label>`, `<caption>`, `<graphic>`), and avoids adding an XML parser dependency.
- TIFF conversion uses PIL via Python subprocess. PMC packages commonly contain TIFF images which browsers can't display. Converting to PNG at extraction time avoids downstream rendering issues.
- The graphic href matching is fuzzy: tries exact match, then stem+extension permutations, then substring match. JATS references often omit the file extension.

### Phase 3b: Publisher HTML Allowlist

**New file:** `src/lib/figures/publisher-parsers.ts`

**Supported publishers:**
1. **PLoS** (`journals.plos.org`) — `<figure>` with `<figcaption>`
2. **Nature** (`nature.com`) — `<figure>` with `<figcaption>` or `<div class="c-article-figure-description">`
3. **MDPI** (`mdpi.com`) — `<figure class="html-fig">` or `<div class="html-fig_wrap">`
4. **Science/AAAS** (`science.org`) — `<figure class="fig">`

**Design decisions:**
- Each parser is a simple object with `matches(url)` and `parse(html, baseUrl)` methods. Adding a new publisher is just adding a new object to the `PUBLISHER_PARSERS` array.
- We don't attempt generic publisher scraping. URLs not matching any allowlisted publisher fall through to the generic `<figure>` parser in figure-downloader.ts, and then to PDF fallback.
- The parser registry is intentionally NOT extensible at runtime — publisher structures change, and untested parsers are worse than no parser (they produce false positives).

### Source Merge Pipeline

**New file:** `src/lib/figures/source-merger.ts`

**Merge strategy:**
1. All figures from all sources are flattened and sorted by source priority (PMC > arXiv > publisher > PDF embedded > render_crop > structural)
2. Figures are grouped by normalized label (`normalizeLabel`: "Figure 1" = "Fig. 1" = "Fig 1" → "figure_1")
3. Secondary grouping by assetHash for exact image dedup
4. Highest-priority source wins for canonical record (`isPrimaryExtraction: true`)
5. If canonical has no image but a lower-priority source does, the lower source upgrades to primary (keeps the better caption from the higher source)

**Design decision:** The merge is in-memory over the flat result arrays, not a database query. This avoids N+1 queries and lets us do the merge logic as a pure function. DB writes happen after merge.

### Unified Extraction Orchestrator

**New file:** `src/lib/figures/extract-all-figures.ts`

**Architecture:**
- Single entry point: `extractAllFigures(paperId, opts?)` 
- Runs sources in priority order: PMC/JATS → arXiv HTML → Publisher HTML → PDF fallback
- All applicable sources run independently (no short-circuiting)
- After all sources, the merge pipeline determines isPrimaryExtraction for each row
- The orchestrator then upserts ALL merged figures (from every source) to reconcile DB state
- Figures with null labels get synthetic labels (`uncaptioned-p{page}-{i}`) to ensure persistence
- Returns an `ExtractionReport` with per-source stats; report counts reflect canonical (primary) set only

**API route update:**
- POST now calls `extractAllFigures` instead of the old vision-LLM `extractFigures`
- GET now returns only `isPrimaryExtraction=true` rows by default; pass `?all=true` for raw rows
- The old `figure-extractor.ts` is kept but no longer the default path

### PDF Fallback Improvements (Track A, previously implemented)

**Files modified:**
- `src/lib/figures/pdf-crop-renderer.ts` — Now actually crops figures using PIL instead of saving full pages. Uses caption Y position from PyMuPDF layout data. Supports neighbor-bounded crops for tighter regions on dense pages. Cleans up full-page renders.
- `src/lib/figures/pdf-image-extractor.py` — Fixed full-page filter bug (pixel vs point units). Now uses `page.get_image_rects(xref)` for correct comparison. Also returns `yRatio` for each image (center of placement rect) for position-based matching.
- `src/lib/figures/pdf-figure-pipeline.ts` — Caption-to-image matching now uses Y-proximity (sorts candidates by distance to caption Y) instead of page-order `[0]`. Also passes correct `caption.yRatio`, `caption.type`, and neighbor Y ratios.

### Post-Review Fixes (2026-04-15)

Four issues identified during code review, all fixed:

1. **Merge not persisted** — The merger returned only canonical rows and the orchestrator only wrote PDF-derived ones. Fixed: merger now returns ALL rows with isPrimaryExtraction set; orchestrator upserts every merged row and reconciles isPrimaryExtraction on existing DB rows. GET filters by isPrimaryExtraction=true.

2. **Publisher HTML short-circuited** — `!paper.arxivId` guard prevented publisher extraction for papers with both DOI and arXivId. Fixed: removed the guard. All applicable sources run independently per spec.

3. **Page-order matching** — Caption-to-image matching used `pageImages[0]` (first unmatched image on page). Fixed: image extractor now returns `yRatio` from placement rects; pipeline sorts candidates by Y-proximity to caption before picking.

4. **Uncaptioned images dropped** — Null-label figures were skipped during DB write. Fixed: synthetic label `uncaptioned-p{page}-{i}` ensures all figures persist.

### Second Review Fixes (2026-04-15)

Three issues identified during second review, all fixed:

5. **Stale rows never cleaned** — Reruns left old rows as isPrimaryExtraction=true. Fixed: after upserting all merged rows, the orchestrator queries existing rows and demotes (sets isPrimaryExtraction=false) any that weren't part of the current merge. History is preserved, but GET only returns current extraction state. Verified with a two-run test: run 1 (5 pages) → 2 primary; run 2 (2 pages) → 1 primary, 1 demoted.

6. **Canonical row loses metadata from better sources** — When a lower-priority source had the image, the code switched canonical wholesale, losing the caption from the higher-priority source. Fixed: the merger now does field-level merge — caption from the highest-priority source that has one, image from the highest-priority source that has one, confidence from the image source. The canonical row is a composite, not a wholesale copy of any single source row.

7. **Caption direction ignored in matching** — Absolute Y-distance allowed images on the wrong side of a caption to win (e.g., an image below a figure caption, when figures have captions below). Fixed: matching now uses directional sort — for figures, prefer images above the caption; for tables, prefer images below. Falls back to absolute distance only when no image is on the correct side.

---

## What Was NOT Implemented

1. **Benchmark tooling** (Phase 0) — The 100-paper evaluation set and scoring scripts. Blocked on needing papers with arXivId/DOI for external source testing. Currently all 2424 papers are PDF-only (recovered from uploads, no identity enrichment). Should build benchmark after a batch refetch-metadata run recovers identities.

2. **arXiv Source Bundle parsing** (Phase 5) — Explicitly deferred to post-v1 per spec. Too expensive to build correctly (needs TeX-aware parser, EPS/PDF→PNG conversion, `\input` resolution).

3. **Vision LLM repair** (Phase 7) — Deferred. The old `figure-extractor.ts` still exists as a repair tool, but is no longer the default extraction path.

4. **Batch extraction across all papers** — The orchestrator runs per-paper. A batch script to run extraction on all 2424 papers with rate limiting hasn't been written yet.

5. **Version fidelity checks** — The spec describes version matching (arXiv v1 vs v2, PMC revision). Not implemented. Would require comparing figure counts/labels from external sources against the PDF.

---

## Explicit Caveats (this is a checkpoint, not "done")

### Tables have structured content, but canonical selection is still image-biased

The merger picks the canonical row by finding the first member with an image. For tables, this means the PDF render_crop (which has an image) wins as canonical over the arXiv HTML row (which has structured `<table>` markup but no image). The structured HTML is grafted onto the canonical row via the `description` field, but downstream consumers see a crop image as the primary artifact with some extra HTML hanging off the side.

**The correct product contract for tables**: the canonical artifact should be the structured source row. The preview crop should be attached as enrichment or alternate. This requires table-aware canonical merge semantics — not just "first row with an image wins."

### 70KB of `<table>` markup in `description` is technical debt

Storing raw HTML in a text `description` field works as an interim move but is not a clean schema. A dedicated `structuredContent` + `structuredContentType` field pair would be the principled fix, letting consumers differentiate between LLM-generated descriptions, table HTML, and LaTeX source.

### arXiv HTML figure extraction downloads child `<img>`, not the figure container

When arXiv nests a figure as multiple assets (image + legend + subpanels + SVG pieces), the current parser downloads the first `<img>` child, which can be a legend strip or subpanel rather than the composed figure. The fix is DOM-container rendering (Playwright screenshot of the `<figure>` element), not downloading the child `<img>`.

---

## Next Priorities (in order)

1. **Table-aware canonical merge** — For `type: "table"`, prefer the structured-content source row as canonical even if it has no image. The crop image becomes the alternate.
2. **DOM/container rendering** — Use Playwright to screenshot arXiv HTML `<figure>` containers instead of downloading child `<img>` elements. Fixes subfigure and legend-only extraction.
3. **Automatic crop rejection** — Before a crop becomes canonical, reject it if: includes too much body text, touches page edges, OCR text density is figure-atypical, foreground occupies too little of the crop.
4. **Column-aware PDF cropping** — Use caption bbox to determine left-column / right-column / full-width, then crop within that region only.
5. **Proper table extraction** — pdfplumber/Camelot-style layout detection for PDF-only tables (no HTML available).

---

## Known Issues and Edge Cases

1. **Two-column PDF layouts** — The crop renderer now uses PyMuPDF text-block layout analysis to find content regions, which is better than the old Y-position heuristic. But it is not column-aware: it treats the page as a single band, which still produces too-wide crops on two-column pages.

2. **Caption regex misses** — `caption-detector.ts` uses a single regex pattern. Misses captions with bold/italic markers, non-English languages, Roman numerals, or line-split captions.

3. **PMC TIFF conversion** — Depends on PIL. Best-effort.

4. **Publisher HTML Cloudflare** — Most publishers blocked. Expected.

5. **`html_download` legacy records** — Old records not re-extracted unless triggered.

6. **Unlabeled HTML assets** — Now demoted to `confidence: "low"` but not fully rejected. Can still appear in `?all=true` results.

---

## File Inventory

### New files
| File | Responsibility |
|------|---------------|
| `src/lib/figures/pmc-jats-extractor.ts` | PMC OA package download + JATS XML parsing + figure extraction |
| `src/lib/figures/publisher-parsers.ts` | Publisher-specific HTML figure parsers (PLoS, Nature, MDPI, Science) |
| `src/lib/figures/source-merger.ts` | Cross-source figure deduplication and priority merge |
| `src/lib/figures/extract-all-figures.ts` | Unified orchestrator: runs all sources, merges, writes to DB |

### Modified files
| File | Changes |
|------|---------|
| `src/lib/import/figure-downloader.ts` | Split sourceMethod, provenance fields, `<base>` tag fix, `<table>` extraction from `<figure>` blocks, quality gate (dimension/aspect/label checks), no DB writes (orchestrator handles) |
| `src/lib/import/semantic-scholar.ts` | Applied isFigureOrSupplementDoi filter in searchByTitle |
| `src/app/api/papers/[id]/refetch-metadata/route.ts` | Added figure-DOI guard + title similarity guard |
| `src/app/api/papers/[id]/figures/route.ts` | POST uses extractAllFigures, returns ok:false/207 on persist errors, GET filters isPrimaryExtraction by default |
| `src/lib/figures/pdf-crop-renderer.ts` | Rewritten: PyMuPDF text-block layout analysis for content-region detection instead of Y-position heuristic |
| `src/lib/figures/pdf-image-extractor.py` | Fixed full-page filter (pixel vs point units), returns yRatio per image |
| `src/lib/figures/pdf-figure-pipeline.ts` | Directional Y-proximity matching, correct yRatio/type passing |
| `src/lib/processing/queue.ts` | Background figure extraction now uses unified orchestrator |
| `src/lib/pdf/figure-extractor.ts` | Marked @deprecated |

### Untouched (still available)
| File | Status |
|------|--------|
| `src/lib/pdf/figure-extractor.ts` | Old vision-LLM approach. Still importable for repair use. Not wired as default. |
