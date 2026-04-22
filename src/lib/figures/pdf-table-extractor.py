#!/usr/bin/env python3
"""
Extract structured tables from a PDF using PyMuPDF's find_tables().

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
"""
import argparse
import html as html_lib
import json
import re
import sys

import fitz  # PyMuPDF


LABEL_PATTERN = re.compile(r"Table\s+(\d+[A-Za-z]?)", re.IGNORECASE)


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


def find_label(page, bbox):
    x0, y0, x1, y1 = bbox
    # Look up to 80pt above the table for a "Table N" caption.
    window_top = max(0, y0 - 80)
    search_rect = fitz.Rect(0, window_top, page.rect.width, y0)
    text_above = page.get_textbox(search_rect) or ""
    m = LABEL_PATTERN.search(text_above)
    if m:
        return f"Table {m.group(1)}"
    # Fallback: look up to 80pt below the table.
    window_bottom = min(page.rect.height, y1 + 80)
    search_rect = fitz.Rect(0, y1, page.rect.width, window_bottom)
    text_below = page.get_textbox(search_rect) or ""
    m = LABEL_PATTERN.search(text_below)
    if m:
        return f"Table {m.group(1)}"
    return None


def extract_tables(pdf_path, max_pages):
    out = []
    with fitz.open(pdf_path) as doc:
        limit = min(doc.page_count, max_pages)
        for page_index in range(limit):
            page = doc[page_index]
            try:
                finder = page.find_tables()
            except Exception as exc:
                print(f"[pdf-table] find_tables failed on page {page_index + 1}: {exc}", file=sys.stderr)
                continue
            for table in finder.tables:
                try:
                    rows = table.extract()
                except Exception as exc:
                    print(f"[pdf-table] extract failed on page {page_index + 1}: {exc}", file=sys.stderr)
                    continue
                if not rows or len(rows) < 2 or len(rows[0]) < 2:
                    continue
                bbox = tuple(float(x) for x in table.bbox)
                out.append({
                    "page": page_index + 1,
                    "bbox": list(bbox),
                    "label": find_label(page, bbox),
                    "html": rows_to_html(rows),
                    "rowCount": len(rows),
                    "colCount": len(rows[0]),
                })
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf_path")
    parser.add_argument("--max-pages", type=int, default=50)
    args = parser.parse_args()

    try:
        tables = extract_tables(args.pdf_path, args.max_pages)
    except Exception as exc:
        print(json.dumps({"error": str(exc), "tables": []}))
        return 1
    print(json.dumps({"tables": tables}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
