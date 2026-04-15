#!/usr/bin/env python3
"""
Extract actual figures (embedded images) from PDFs using PyMuPDF.

This extracts the image objects embedded in the PDF — the actual figures,
not full page renders. Filters out tiny images (icons, logos) and very
large images (full-page scans).

Output: prisma/backups/figure-preview/<paper-id-prefix>/fig-N.png
No LLM calls. No DB writes. Inspection only.

Usage:
  python3 scripts/extract-figures-preview.py              # 5 papers
  python3 scripts/extract-figures-preview.py --limit 20   # 20 papers
"""
import os
import sys
import sqlite3
import argparse

import fitz  # pymupdf

OUT_DIR = os.path.join("prisma", "backups", "figure-preview")
DB_PATH = os.path.join("prisma", "dev.db")

# Filter: skip images smaller than this (icons, bullets, logos)
MIN_WIDTH = 150
MIN_HEIGHT = 150
# Filter: skip images that are basically full-page scans
MAX_WIDTH_RATIO = 0.95  # relative to page width
MAX_HEIGHT_RATIO = 0.95  # relative to page height
# Skip very small file sizes (likely decorative)
MIN_BYTES = 5000


def extract_figures(pdf_path, out_dir, max_pages=30):
    """Extract embedded images from a PDF, filtering for actual figures."""
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        return 0, str(e)

    os.makedirs(out_dir, exist_ok=True)
    fig_count = 0
    pages_to_check = min(len(doc), max_pages)

    for page_num in range(pages_to_check):
        page = doc[page_num]
        page_width = page.rect.width
        page_height = page.rect.height
        images = page.get_images(full=True)

        for img_idx, img in enumerate(images):
            xref = img[0]
            try:
                pix = fitz.Pixmap(doc, xref)
            except Exception:
                continue

            # Convert CMYK to RGB
            if pix.n > 4:
                pix = fitz.Pixmap(fitz.csRGB, pix)

            w, h = pix.width, pix.height

            # Filter: too small (icons, logos)
            if w < MIN_WIDTH or h < MIN_HEIGHT:
                continue

            # Filter: too close to full page (scanned page, not a figure)
            if page_width > 0 and page_height > 0:
                if w / page_width > MAX_WIDTH_RATIO and h / page_height > MAX_HEIGHT_RATIO:
                    continue

            # Filter: too few bytes (decorative)
            img_bytes = pix.tobytes("png")
            if len(img_bytes) < MIN_BYTES:
                continue

            fig_count += 1
            fig_path = os.path.join(out_dir, f"p{page_num+1}-fig{fig_count}.png")
            with open(fig_path, "wb") as f:
                f.write(img_bytes)

    doc.close()
    return fig_count, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--max-pages", type=int, default=30)
    args = parser.parse_args()

    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id, filePath, title FROM Paper WHERE filePath IS NOT NULL AND filePath != '' LIMIT ?",
        (args.limit,),
    ).fetchall()
    conn.close()

    print(f"Extracting figures from {len(rows)} papers (max {args.max_pages} pages each)")
    print(f"Output: {OUT_DIR}/")
    print(f"Filters: min {MIN_WIDTH}x{MIN_HEIGHT}px, min {MIN_BYTES} bytes, max {MAX_WIDTH_RATIO*100:.0f}% page size")
    print()

    total_figs = 0
    for i, (paper_id, filepath, title) in enumerate(rows):
        prefix = paper_id[:12]
        paper_dir = os.path.join(OUT_DIR, prefix)
        short_title = (title or paper_id)[:50]

        if not os.path.exists(filepath):
            print(f"[{i+1}/{len(rows)}] {short_title}... MISSING")
            continue

        figs, err = extract_figures(filepath, paper_dir, args.max_pages)
        if err:
            print(f"[{i+1}/{len(rows)}] {short_title}... ERROR: {err[:60]}")
        else:
            print(f"[{i+1}/{len(rows)}] {short_title}... {figs} figures")
            total_figs += figs

    print(f"\nDone: {total_figs} figures from {len(rows)} papers")
    print(f"Inspect: open {OUT_DIR}/")


if __name__ == "__main__":
    main()
