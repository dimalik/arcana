# Figure Extraction Pipeline

**Date:** 2026-04-15
**Status:** Draft
**Goal:** Recover figure artifacts with captions and provenance at known quality.

## Reframe

This is not "extract figures from PDFs." This is "recover figure artifacts with captions and provenance at known quality." Every figure record must carry provenance, confidence, and source method. Outputs without provenance are operationally untrustworthy.

## Current State

The codebase has two figure paths today:

1. **`src/lib/import/figure-downloader.ts`** — arXiv HTML scraping + publisher HTML scraping. Gets real figures from `<figure>` elements with `<figcaption>`. Best existing path. Limited to papers with arXiv HTML or scrapeable publisher pages.

2. **`src/lib/pdf/figure-extractor.ts`** — PDF page render + vision LLM. Saves whole pages (not figures). Expensive. Lossy. Last-resort repair tool, not a pipeline.

3. **`src/lib/import/pdf-finder.ts:228`** — PMC OA package resolution. Downloads tar.gz with actual paper assets. Most principled journal path.

4. **`prisma/schema.prisma:420` (PaperFigure)** — Too thin. No provenance, no extraction method, no confidence, no asset hash, no bbox.

5. **`src/lib/import/semantic-scholar.ts:47`** — Figure/supplement DOI filter exists but is not applied in the `refetch-metadata` path. Identity quality is not hardened.

---

## Phase 0: Contract and Benchmark

### Data contract

### Design decisions

**Extraction target:** The exact PDF in `filePath`. Not the canonical paper across identifiers. If the user has arXiv v1, figures must match v1, not the published journal version. External sources (arXiv HTML, PMC/JATS) are trusted only when version-matched against the stored artifact (see Version Fidelity below).

**Subfigures:** Each subfigure (Figure 1a, 1b, 1c) is a separate record with its own image, caption, and `figureLabel`. A `parentFigureId` field groups them under the parent figure. Subfigures count separately in recall metrics.

**Scope (v1):** Figures and tables. Not equations (inline content, not standalone visual artifacts). The benchmark measures figure recall and table recall separately.

### Schema

```prisma
model PaperFigure {
  id                  String   @id @default(uuid())
  paperId             String
  figureLabel         String?  // "Figure 3", "Table 2", "Fig. 1a"
  captionText         String?  // Author-written caption
  captionSource       String   // "latex" | "html_figcaption" | "jats" | "pdf_ocr" | "llm_generated" | "none"
  description         String?  // LLM-generated description (Phase 7 only)
  sourceMethod        String   // "pmc_jats" | "arxiv_html" | "publisher_html" | "arxiv_source" | "pdf_embedded" | "pdf_structural" | "pdf_render_crop" | "vision_llm"
  sourceUrl           String?  // Where the figure was fetched from
  sourceVersion       String?  // Version of the external source: arXiv version (v1, v2), PMC revision, etc.
  confidence          String   @default("high") // "high" | "medium" | "low"
  imagePath           String?  // Path to extracted image file. Null for gap placeholders (caption found, figure not recovered).
  assetHash           String?  // SHA-256 of the image bytes — dedup and change detection. Null for gap placeholders.
  pdfPage             Int?     // Matched page in the stored PDF (1-indexed). Set for all sources after merge step — even HTML figures get matched back to their PDF page when possible.
  sourcePage          Int?     // Page in the source (e.g., page N in arXiv HTML rendering). Null when source is not paginated.
  figureIndex         Int      @default(0) // Sequential index within this source method for this paper
  bbox                String?  // JSON: { x, y, width, height } in PDF points, null for non-PDF sources
  type                String   @default("figure") // "figure" | "table"
  parentFigureId      String?  // For subfigures: links to the parent figure record
  isPrimaryExtraction Boolean  @default(true) // false = re-extraction or repair
  width               Int?
  height              Int?
  createdAt           DateTime @default(now())

  paper         Paper        @relation(fields: [paperId], references: [id], onDelete: Cascade)
  parent        PaperFigure? @relation("SubFigures", fields: [parentFigureId], references: [id])
  subfigures    PaperFigure[] @relation("SubFigures")

  // Dedup for extracted figures: same paper + same method + same content = same figure.
  // For gap placeholders (assetHash null), dedup by figureLabel instead.
  @@unique([paperId, sourceMethod, assetHash])
  @@unique([paperId, sourceMethod, figureLabel])
  @@index([paperId])
  @@index([assetHash])
}
```

Key changes from previous schema:
- **Uniqueness on `[paperId, sourceMethod, assetHash]`** not `[paperId, page, figureIndex]`. Page is null for HTML sources, and multiple extraction methods can coexist for the same paper. Asset hash is the dedup key.
- **`sourceVersion`** — tracks which version of the external source was used (arXiv v1 vs v2, PMC revision). Required for version fidelity.
- **`parentFigureId`** — subfigure grouping.
- **`type`** — only "figure" | "table" in v1. Equations removed.
- **`pdf_render_crop`** added as a source method — for the "caption found, no embedded image, render and crop the region" case.

Key additions over current schema:
- `sourceMethod` — how the figure was obtained
- `captionSource` — where the caption came from
- `confidence` — high/medium/low based on source method
- `assetHash` — SHA-256 for dedup
- `bbox` — crop coordinates for PDF sources
- `figureLabel` — the label from the paper ("Figure 3")
- `isPrimaryExtraction` — distinguishes first extraction from repairs

### Confidence mapping

| Source method | Default confidence | Rationale |
|--------------|-------------------|-----------|
| `pmc_jats` | high | Structured XML with explicit figure elements |
| `arxiv_html` | high | Publisher-rendered HTML with `<figure>` tags |
| `arxiv_source` | high | Author's original image files |
| `publisher_html` | medium | Allowlisted parsers, but HTML varies |
| `pdf_embedded` | medium | Actual image objects, but may be sub-elements |
| `pdf_structural` | low | Caption detection + region association heuristic |
| `pdf_render_crop` | low | Caption found, no embedded image — page rendered and cropped. Covers vector plots/diagrams. |
| `vision_llm` | low | LLM-based, expensive, non-deterministic |

### Benchmark

Build a 100-paper evaluation set before any rollout. The **gold standard is the stored PDF** — a human annotator counts the figures and tables in each PDF and records their labels and captions.

| Category | Count | Purpose |
|----------|-------|---------|
| arXiv-native (recent, has HTML) | 30 | Primary extraction path |
| arXiv-native (old, no HTML) | 10 | PDF fallback only (source bundle is post-v1) |
| PMC OA (journal with JATS) | 20 | Structured extraction |
| Publisher HTML (known domains) | 15 | Allowlist testing |
| PDF-only (no external source) | 15 | Fallback path |
| Edge cases (scanned, old format) | 10 | Robustness |

**Gold standard definition:**
- Reference artifact: the exact PDF in `filePath`
- Count: every `Figure N` and `Table N` in the PDF counts. Subfigures (1a, 1b) count separately.
- Equations do NOT count (out of scope for v1)
- Supplementary figures count only if they appear in the stored PDF (not in a separate supplement file)

**Metrics per source type:**
- **Figure recall**: of the gold-standard figures, how many were extracted? Measured separately for figures and tables.
- **Caption match rate**: of extracted figures, how many have the correct caption from the paper? A caption is correct if it matches the gold standard caption text (fuzzy match, ignoring whitespace/formatting).
- **False positive rate**: extracted "figures" that are not actual figures (decorative images, logos, page elements, sub-elements of larger figures).
- **Version fidelity**: for external sources, how many extracted figures match the stored PDF? (A figure from arXiv HTML v2 that doesn't exist in the user's v1 PDF is a version mismatch.)
- **Cost**: LLM calls, API calls, bandwidth per paper.

**Acceptance gates (per bucket — not aggregate):**

Each benchmark bucket must independently pass its threshold. Strong arXiv/PMC numbers cannot hide a broken PDF-only path.

| Bucket | Figure recall | Caption match | False positive | 
|--------|-------------|---------------|----------------|
| arXiv HTML (recent) | ≥ 90% | ≥ 85% | ≤ 5% |
| arXiv HTML (old) | ≥ 70% | ≥ 60% | ≤ 10% |
| PMC/JATS | ≥ 90% | ≥ 90% | ≤ 5% |
| Publisher HTML | ≥ 75% | ≥ 70% | ≤ 10% |
| PDF-only | ≥ 60% | ≥ 50% | ≤ 15% |
| Edge cases | ≥ 40% | ≥ 30% | ≤ 20% |

Version mismatch rate ≤ 5% for all external sources.

**Sequencing:** Identity hardening (Phase 1) is a prerequisite only for external-source extraction (arXiv HTML, PMC/JATS, publisher HTML). PDF-local extraction (caption detection, embedded images, render+crop) does NOT depend on recovered DOI/arXiv metadata and can proceed in parallel with Phase 1. The identity gate blocks external sources, not PDF fallback.

---

## Phase 1: Identity Hardening

### Problem

`refetch-metadata` uses `searchByTitle` which can assign figure/supplement DOIs to paper records. The `isFigureOrSupplementDoi` filter exists in `semantic-scholar.ts:47` but is not applied in the `refetch-metadata` route.

### Fix

1. Apply `isFigureOrSupplementDoi` filter in `refetch-metadata` before accepting a result.
2. Add a second-pass identity check: if the matched DOI resolves to a title that is significantly different from the paper's title, reject it.
3. For arXiv ID recovery: prefer matching via arXiv API search (exact title + author match) over OpenAlex/S2 title search which can return figure DOIs.

### Acceptance gate

Run identity recovery on the 100-paper benchmark. Measure:
- Correct match rate
- Figure/supplement DOI false positives (must be zero)
- Wrong-paper matches (must be near-zero)

Do not start **external-source** figure extraction (arXiv HTML, PMC/JATS, publisher HTML) until this gate passes. PDF-local extraction can proceed independently.

---

## Version Fidelity

> The extraction target is the exact PDF the user has, not the canonical work across identifiers.

External sources (arXiv HTML, PMC/JATS, publisher HTML) may correspond to a different version of the paper than the stored PDF. A v1 preprint on arXiv may have different figures than the published journal version.

**Rule:** Before trusting an external source's figures, verify version alignment:

1. **arXiv HTML**: Check the arXiv version number. If the stored PDF was downloaded from arXiv, the version is often in the filename or metadata. If the HTML corresponds to a different version, log a mismatch and use the HTML figures only if the figure count and labels roughly match the PDF (sanity check).

2. **PMC/JATS**: The published version may differ from the preprint. Cross-check figure count against the PDF. If the PDF has 8 figures but JATS has 6, the version diverged — use JATS for what matches, fall through to PDF for the rest.

3. **Publisher HTML**: Same as PMC — verify figure labels exist in the stored PDF before accepting.

Version mismatches are recorded on the figure record via `sourceVersion` and flagged in confidence:
- Version-matched external source: `confidence: "high"`
- External source, version uncertain: `confidence: "medium"`
- External source, known version mismatch: `confidence: "low"` + `isPrimaryExtraction: false`

## Phase 2: Provenance-First Extraction

### Source ranking (quality priority, not short-circuit)

1. **PMC/JATS** — structured OA packages with explicit figure elements
2. **arXiv HTML** — already implemented in `figure-downloader.ts`
3. **Known publisher adapters** — narrow allowlist with explicit parsers
4. **PDF structural extraction** — caption detection + region association
5. **PDF embedded images** — PyMuPDF image objects, cross-referenced with captions
6. **PDF render + crop** — for "caption found, no embedded image" (vector plots/diagrams)
7. **Vision LLM** — last-resort repair only

**Sources are NOT short-circuited.** A higher-priority source succeeding does not skip lower sources. Instead:

- All applicable sources run independently.
- Results are **merged by figure identity** (matched by `figureLabel` or `assetHash`).
- When multiple sources produce the same figure, the highest-priority source wins for the canonical record, but lower-priority results are kept as `isPrimaryExtraction: false` for validation.
- When a lower-priority source finds figures that a higher-priority source missed (supplements, subfigures, HTML-omitted figures), those are added as new records.

This prevents the "arXiv HTML found 5 of 8 figures, skipped the rest" failure mode that the current `figure-downloader.ts` has.

### Extraction flow

```
For each paper:
  1. Collect applicable sources based on identity (DOI → PMC/JATS + publisher; arXiv ID → arXiv HTML)
  2. Run applicable sources in priority order
  3. After each source, compute figure identity (label + hash)
  4. After PDF extraction, merge: match external figures to PDF pages/positions where possible
  5. Any figure from any source that doesn't match an existing record gets added
  6. Final pass: flag unmatched captions (found in PDF text but no associated figure) as extraction gaps
```

---

## Phase 3: Journal Path (PMC + Allowlisted Publishers)

### PMC/JATS

The repo has PMC OA package resolution at `pdf-finder.ts:228`. Extend this to also extract figures from the OA package:

- PMC OA tar.gz contains the paper's assets (PDF + figure files)
- JATS XML in the package has `<fig>` elements with `<label>`, `<caption>`, and `<graphic>` references
- Extract the image files referenced by `<graphic>` and pair with their JATS captions

This is the most principled journal path — structured, reliable, author-verified.

### Publisher HTML allowlist

Support a narrow set of publishers with explicit parsers and tests:

| Publisher | Domain pattern | Strategy |
|-----------|---------------|----------|
| PLoS | `journals.plos.org` | `<figure>` elements with `<figcaption>` |
| Nature | `nature.com` | `<figure>` with `data-test="figure"` |
| Science | `science.org` | `<figure>` with `class="fig"` |
| ACL Anthology | `aclanthology.org` | PDF-only (no HTML figures) |
| MDPI | `mdpi.com` | `<figure>` with structured captions |

Everything not on the allowlist falls through to PDF extraction. No generic scraping.

---

## Phase 4: arXiv HTML (Already Implemented)

`figure-downloader.ts:115` already handles this:
1. Fetch `https://arxiv.org/html/{arxiv_id}`
2. Parse `<figure>` elements
3. Download `<img>` assets
4. Extract `<figcaption>` text

Improvements needed:
- Add `sourceMethod: "arxiv_html"` to records
- Add `figureLabel` extraction (parse "Figure N" from caption)
- Add `assetHash` computation on download
- Handle cases where arXiv HTML is not available (older papers pre-2023)

For older papers without HTML: defer to Phase 5 (arXiv source bundle) or PDF fallback.

---

## Phase 5: arXiv Source Bundle (Targeted Upgrade)

Not for v1. Add only for cases where arXiv HTML is missing or clearly incomplete.

When implemented:
- Download source from `https://arxiv.org/e-print/{arxiv_id}`
- Decompress tar.gz
- Find .tex files
- Parse `\begin{figure}...\end{figure}` environments using a proper TeX-aware parser (not regex)
- Resolve `\includegraphics{path}` to actual image files in the bundle
- Handle: `figure*`, `subfigure`, `\input`, relative paths, EPS/PDF→PNG conversion
- Extract `\caption{text}` and `\label{fig:name}`

This is expensive to build correctly. Defer until v1 extraction paths are measured and stable.

---

## Phase 6: PDF Fallback

Three-part approach. Parts run in sequence and produce complementary signals.

### Part 1: Caption detection

- Scan PDF text for patterns: "Figure N:", "Fig. N.", "Table N:", etc.
- Use text position (via PyMuPDF `page.get_text("dict")`) to identify the page and approximate vertical position of each caption
- Output: list of `{ page, y_position, label, caption_text }` — the "demand signal" (we know N figures exist and where their captions are)

### Part 2: Embedded image extraction (PyMuPDF)

- Extract embedded image objects from the PDF
- Filter: min 200x200px, min 10KB, exclude full-page scans (>95% page area)
- For each image, record its page and approximate position
- Cross-reference with Part 1 captions by page and vertical proximity
- Matched: `confidence: "medium"`, `sourceMethod: "pdf_embedded"`
- Unmatched image (no nearby caption): `confidence: "low"`
- Unmatched caption (caption found but no embedded image): proceed to Part 3

### Part 3: Render + crop for unmatched captions (vector plots/diagrams)

This handles the case where a caption exists in the PDF text but no embedded image object was found — common for vector-native plots (matplotlib PDF output, TikZ diagrams, line charts drawn in PDF operators).

- For each unmatched caption from Part 1:
  - Render the page to a high-DPI raster (300 DPI via `pdftoppm`)
  - Estimate crop region: from the caption's y-position upward to the previous text block or page top
  - Crop the region from the rendered page
  - Store with `sourceMethod: "pdf_render_crop"`, `confidence: "low"`, `bbox` recording the crop coordinates

This is the lowest-confidence extraction method but captures the large class of vector-native figures that PyMuPDF image extraction misses entirely. Without it, the PDF-only benchmark bucket fails systematically.

### Part 4: Unresolved gaps

After all three parts:
- Captions with matched embedded images → `sourceMethod: "pdf_embedded"`, appropriate confidence
- Captions matched via render+crop → `sourceMethod: "pdf_render_crop"`, `confidence: "low"`
- Captions without any recoverable figure (crop failed or nonsensical) → `sourceMethod: "pdf_structural"`, `imagePath: null`, `confidence: "low"` — gap placeholder for future vision LLM repair
- Figures without matched captions → stored with `captionSource: "none"`, `confidence: "low"`

---

## Phase 7: LLM Description Generation

Only after extraction quality is measured and the benchmark passes.

- LLM descriptions are enrichment, not extraction
- They consume a vetted crop plus caption, not raw page renders
- Batchable at 50% discount via the batch API
- Not in the critical extraction path

---

## Implementation Order

**Parallel track A (no identity dependency):**
1. **Schema update** — extend PaperFigure with new fields (Phase 0)
2. **Benchmark** — build 100-paper evaluation set with gold-standard annotations (Phase 0)
3. **PDF fallback** — three parts: caption detection, embedded image extraction, render+crop for vector figures (Phase 6)
4. **Measure PDF fallback** — run benchmark on PDF-only bucket, report per-bucket metrics

**Parallel track B (requires identity):**
5. **Identity hardening** — fix refetch-metadata figure-DOI filter, recover DOIs/arXiv IDs (Phase 1)
6. **arXiv HTML extraction** — enhance figure-downloader with provenance fields (Phase 4)
7. **PMC/JATS extraction** — extend PMC OA package to extract figures (Phase 3)
8. **Publisher allowlist** — 3-5 publishers with tested parsers (Phase 3)

**After both tracks:**
9. **Source merge pipeline** — match external figures to PDF pages, merge by figure identity
10. **Measure** — run full benchmark across all buckets, report per-bucket metrics
11. **LLM descriptions** — only if benchmark passes (Phase 7)

### Implementation notes

- **SQLite nullable unique constraints:** Before treating the schema as settled, verify that SQLite handles nullable columns in `@@unique([paperId, sourceMethod, assetHash])` correctly. SQLite treats each NULL as distinct for uniqueness, which is the desired behavior here (multiple gap placeholders with `assetHash = null` can coexist if they have different `figureLabel` values, which the second unique constraint handles). Test this during the schema migration step.
- **Benchmark thresholds are provisional.** The per-bucket gates are plausible estimates. Adjust after the first benchmark run produces real numbers.

## What Is NOT In V1

- arXiv source bundle parsing (Phase 5) — too expensive for v1
- Generic publisher scraping — only allowlisted publishers
- Vision LLM as primary extraction — only as repair
- Any rollout without benchmark metrics
