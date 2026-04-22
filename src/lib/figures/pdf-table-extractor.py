#!/usr/bin/env python3
"""
Extract structured tables from a PDF using Camelot's lattice parser with
a post-split heuristic for academic tables whose rows aren't separated by
drawn lines. Labels are resolved via PyMuPDF text-window search.

Usage:
    python3 pdf-table-extractor.py <pdf_path> [--max-pages N]

Outputs JSON to stdout:
    {
      "tables": [
        {
          "page": int (1-indexed),
          "bbox": [x0, y0, x1, y1],
          "label": "Table 1" | null,
          "html": "<table>...</table>",
          "rowCount": int,
          "colCount": int
        }
      ]
    }

Quality filter: accuracy >= 80 AND whitespace <= 50 AND shape >= 2x2 after
row-splitting. Bad detections are dropped so the pipeline falls back to
screenshots (pdf_render_crop) rather than showing broken HTML.
"""
import argparse
import contextlib
import html as html_lib
import io
import json
import os
import re
import sys
import warnings

import fitz  # PyMuPDF (for label resolution only)

# Camelot pulls in pypdf/cryptography which emit CryptographyDeprecationWarning.
# Suppress so stderr stays clean for legitimate extraction failures.
warnings.filterwarnings("ignore")
# Redirect stdout during import to suppress PyMuPDF's advisory banner.
with contextlib.redirect_stdout(io.StringIO()):
    import camelot


LABEL_PATTERN = re.compile(
    r"^\s*Table\s+(\d+[A-Za-z]?)\s*[:.—–-]",
    re.IGNORECASE | re.MULTILINE,
)

# Quality gates for a camelot table to be emitted.
MIN_ACCURACY = 80.0
MAX_WHITESPACE = 50.0
MIN_ROWS_AFTER_SPLIT = 2
MIN_COLS = 2


def cell_to_html(cell):
    if cell is None:
        return ""
    return html_lib.escape(str(cell).strip(), quote=False)


def rows_to_html(rows):
    if not rows:
        return "<table></table>"
    header = rows[0]
    body = rows[1:]
    parts = ["<table>"]
    parts.append("<thead><tr>")
    for cell in header:
        parts.append(f"<th>{cell_to_html(cell)}</th>")
    parts.append("</tr></thead>")
    if body:
        parts.append("<tbody>")
        for row in body:
            parts.append("<tr>")
            for cell in row:
                parts.append(f"<td>{cell_to_html(cell)}</td>")
            parts.append("</tr>")
        parts.append("</tbody>")
    parts.append("</table>")
    return "".join(parts)


def split_aligned_merged_rows(df):
    """Split rows whose cells are \\n-separated and line counts align.

    Academic tables often lack drawn row separators — Camelot's lattice parser
    captures them as a single row with \\n-separated cell contents. When the
    line counts match across cells (or a cell has a single line acting as a
    merged cell), we can recover the true rows.
    """
    out_rows = []
    for _, row in df.iterrows():
        cells = [str(c) if c == c else "" for c in row]
        splits = [c.split("\n") for c in cells]
        max_lines = max(len(s) for s in splits)
        if max_lines == 1:
            out_rows.append(cells)
            continue
        # Only split when every cell is either 1-line (merged-style) or exactly max_lines.
        if all(len(s) == 1 or len(s) == max_lines for s in splits):
            for i in range(max_lines):
                out_rows.append(
                    [s[i] if len(s) == max_lines else s[0] for s in splits]
                )
        else:
            # Inconsistent line counts — can't safely split.
            out_rows.append(cells)
    return out_rows


def find_label(page, bbox):
    x0, y0, x1, y1 = bbox
    window_top = max(0, y0 - 80)
    search_rect = fitz.Rect(0, window_top, page.rect.width, y0)
    text_above = page.get_textbox(search_rect) or ""
    m = LABEL_PATTERN.search(text_above)
    if m:
        return f"Table {m.group(1)}"
    window_bottom = min(page.rect.height, y1 + 80)
    search_rect = fitz.Rect(0, y1, page.rect.width, window_bottom)
    text_below = page.get_textbox(search_rect) or ""
    m = LABEL_PATTERN.search(text_below)
    if m:
        return f"Table {m.group(1)}"
    return None


def camelot_bbox_to_pdf_bbox(cam_bbox, page_height):
    """Camelot returns bbox in (x0, y0_bottom, x1, y1_bottom) with y-origin at
    bottom-left (PDF convention). PyMuPDF uses y-origin at top-left. Convert
    so find_label can work in the same coordinate system as PyMuPDF's rects.
    """
    x0, y0_bot, x1, y1_bot = cam_bbox
    return (x0, page_height - y1_bot, x1, page_height - y0_bot)


def extract_tables(pdf_path, max_pages):
    out = []
    with fitz.open(pdf_path) as doc:
        limit = min(doc.page_count, max_pages)
        # Parse page-by-page and snapshot (df, report, bbox) immediately:
        # camelot's shared state drifts across subsequent read_pdf calls,
        # so later access to tab.parsing_report can return stale ws/acc.
        snapshots = []
        for page_num in range(1, limit + 1):
            try:
                tabs = camelot.read_pdf(pdf_path, pages=str(page_num), flavor="lattice")
            except Exception as exc:
                print(f"[pdf-table] camelot lattice failed on p{page_num}: {exc}", file=sys.stderr)
                continue
            for t in tabs:
                snapshots.append({
                    "df": t.df.copy(),
                    "report": dict(t.parsing_report or {}),
                    "bbox": tuple(t._bbox),
                })

        for snap in snapshots:
            report = snap["report"]
            # Use dict.get(..., default) instead of `x or default` — avoid the
            # falsy-zero trap: accuracy=0 means total failure (drop), but
            # whitespace=0 means perfect (keep).
            accuracy = float(report.get("accuracy", 0.0))
            whitespace = float(report.get("whitespace", 100.0))
            page_num = int(report.get("page", 0))
            if page_num <= 0 or page_num > limit:
                continue
            if accuracy < MIN_ACCURACY or whitespace > MAX_WHITESPACE:
                continue

            rows = split_aligned_merged_rows(snap["df"])
            if len(rows) < MIN_ROWS_AFTER_SPLIT:
                continue
            if not rows or len(rows[0]) < MIN_COLS:
                continue

            # Any cell still containing '\n' after split indicates we couldn't
            # safely recover rows — skip to avoid shipping broken HTML.
            if any("\n" in c for row in rows for c in row):
                continue

            page = doc[page_num - 1]
            bbox = camelot_bbox_to_pdf_bbox(snap["bbox"], page.rect.height)
            label = find_label(page, bbox)
            out.append({
                "page": page_num,
                "bbox": [float(x) for x in bbox],
                "label": label,
                "html": rows_to_html(rows),
                "rowCount": len(rows),
                "colCount": len(rows[0]),
                "accuracy": accuracy,
                "whitespace": whitespace,
            })

    # De-duplicate labels (DB uniqueness constraint).
    by_label = {}
    for i, tab in enumerate(out):
        if tab["label"] is None:
            continue
        size = tab["rowCount"] * tab["colCount"]
        prev = by_label.get(tab["label"])
        if prev is None or size > prev[1]:
            by_label[tab["label"]] = (i, size)
    keepers = {idx for idx, _ in by_label.values()}
    for i, tab in enumerate(out):
        if tab["label"] is not None and i not in keepers:
            tab["label"] = None
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf_path")
    parser.add_argument("--max-pages", type=int, default=50)
    args = parser.parse_args()

    if not os.path.exists(args.pdf_path):
        print(json.dumps({"error": f"file not found: {args.pdf_path}", "tables": []}))
        return 1

    try:
        tables = extract_tables(args.pdf_path, args.max_pages)
    except Exception as exc:
        print(json.dumps({"error": str(exc), "tables": []}))
        return 1
    print(json.dumps({"tables": tables}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
