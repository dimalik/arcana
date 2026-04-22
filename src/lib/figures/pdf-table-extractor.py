#!/usr/bin/env python3
"""
Extract structured tables from a PDF using Microsoft's Table Transformer
(detection + structure recognition) with PyMuPDF text extraction for cell
content and label attribution.

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

Design:
  1. Detection model finds table bboxes on each page image (DPI=200).
  2. Structure recognition model segments each crop into rows/columns and
     emits "table spanning cell" boxes for rowspan markers.
  3. Text comes from PyMuPDF word-level extraction, bucketed into cells by
     word-center coordinates (avoids baseline overflow between rows).
  4. Spanning-cell text is propagated into every row/col it covers so each
     row is self-contained (preserves grouping labels like "Llama-3-8B").
  5. Content filter rejects text-heavy detections (references, rebuttals,
     forms) that TATR over-eagerly classifies as tables: cells in a real
     data table are short labels/numbers, not sentences.
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

# Silence third-party noise so stdout stays JSON-only.
warnings.filterwarnings("ignore")
os.environ["TRANSFORMERS_NO_ADVISORY_WARNINGS"] = "1"

import fitz  # PyMuPDF


# --- Configuration ---
DPI = 200
DET_THRESHOLD = 0.85        # table detection confidence (TATR is generous)
STR_THRESHOLD = 0.55        # structure element confidence
MAX_CELL_MEAN_LEN = 28      # drop tables with prose-like cells
MAX_CELL_MAX_LEN = 120
MIN_COLS = 2
MIN_ROWS = 2
STR_INPUT_SIZE = {"shortest_edge": 800, "longest_edge": 1333}

LABEL_PATTERN = re.compile(
    r"^\s*Table\s+(\d+[A-Za-z]?)\s*[:.—–-]",
    re.IGNORECASE | re.MULTILINE,
)

DET_MODEL_ID = "microsoft/table-transformer-detection"
STR_MODEL_ID = "microsoft/table-transformer-structure-recognition-v1.1-all"


def _load_models():
    # Suppress HF's advisory banner printed to stdout on import.
    with contextlib.redirect_stdout(io.StringIO()):
        import torch  # noqa: E402
        from transformers import AutoImageProcessor, TableTransformerForObjectDetection  # noqa: E402
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    det_proc = AutoImageProcessor.from_pretrained(DET_MODEL_ID)
    det_model = TableTransformerForObjectDetection.from_pretrained(DET_MODEL_ID).to(device)
    str_proc = AutoImageProcessor.from_pretrained(STR_MODEL_ID, size=STR_INPUT_SIZE)
    str_model = TableTransformerForObjectDetection.from_pretrained(STR_MODEL_ID).to(device)
    return torch, device, det_proc, det_model, str_proc, str_model


def _cell_to_html(text):
    return html_lib.escape((text or "").strip(), quote=False)


def _text_in_rect(words, rect):
    """Collect words whose bbox center lies inside rect; return reading-order text."""
    inside = []
    for w in words:
        wx0, wy0, wx1, wy1, word = w[0], w[1], w[2], w[3], w[4]
        cx, cy = (wx0 + wx1) / 2, (wy0 + wy1) / 2
        if rect.x0 <= cx <= rect.x1 and rect.y0 <= cy <= rect.y1:
            inside.append((wy0, wx0, word))
    if not inside:
        return ""
    inside.sort(key=lambda t: t[0])
    lines = [[inside[0]]]
    for w in inside[1:]:
        if abs(w[0] - lines[-1][-1][0]) < 3:
            lines[-1].append(w)
        else:
            lines.append([w])
    out_parts = []
    for line in lines:
        line.sort(key=lambda t: t[1])
        out_parts.append(" ".join(w[2] for w in line))
    return " ".join(out_parts)


def _midpoint_bounds(items, axis):
    """Tighten overlapping row/column bboxes by snapping edges to neighbor midpoints."""
    lo, hi = axis, axis + 2
    adj = []
    for i, it in enumerate(items):
        top = it[lo] if i == 0 else (items[i - 1][hi] + it[lo]) / 2
        bot = it[hi] if i == len(items) - 1 else (it[hi] + items[i + 1][lo]) / 2
        new = list(it)
        new[lo], new[hi] = top, bot
        adj.append(new)
    return adj


def _find_label(page, pdf_bbox):
    """Look above then below the table for a 'Table N:' caption."""
    x0, y0, x1, y1 = pdf_bbox
    window_top = max(0, y0 - 80)
    rect = fitz.Rect(0, window_top, page.rect.width, y0)
    text = page.get_textbox(rect) or ""
    m = LABEL_PATTERN.search(text)
    if m:
        return f"Table {m.group(1)}"
    window_bottom = min(page.rect.height, y1 + 80)
    rect = fitz.Rect(0, y1, page.rect.width, window_bottom)
    text = page.get_textbox(rect) or ""
    m = LABEL_PATTERN.search(text)
    if m:
        return f"Table {m.group(1)}"
    return None


def _content_quality(row_cells):
    """Mean/max non-empty cell length across all rows; used to reject prose."""
    lengths = [len(c) for row in row_cells for c in row if c]
    if not lengths:
        return 0.0, 0
    return sum(lengths) / len(lengths), max(lengths)


def _build_html(row_cells, header_row_idx):
    parts = ["<table>"]
    if header_row_idx is not None:
        parts.append("<thead>")
        parts.append("<tr>")
        for c in row_cells[header_row_idx]:
            parts.append(f"<th>{_cell_to_html(c)}</th>")
        parts.append("</tr>")
        parts.append("</thead>")
    parts.append("<tbody>")
    for i, row in enumerate(row_cells):
        if i == header_row_idx:
            continue
        parts.append("<tr>")
        for c in row:
            parts.append(f"<td>{_cell_to_html(c)}</td>")
        parts.append("</tr>")
    parts.append("</tbody>")
    parts.append("</table>")
    return "".join(parts)


def extract_tables(pdf_path, max_pages):
    """Main entry point. Returns a list of table dicts."""
    # Lazy-load: keep the camelot-less cold-start cheap for test stubs.
    import torch
    from pdf2image import convert_from_path
    _, device, det_proc, det_model, str_proc, str_model = _load_models()
    id2label = str_model.config.id2label

    doc = fitz.open(pdf_path)
    limit = min(doc.page_count, max_pages)
    scale = DPI / 72.0
    out = []

    for page_num in range(1, limit + 1):
        try:
            images = convert_from_path(pdf_path, dpi=DPI, first_page=page_num, last_page=page_num)
        except Exception as exc:
            print(f"[pdf-table] render p{page_num} failed: {exc}", file=sys.stderr)
            continue
        img = images[0]
        page = doc[page_num - 1]
        words = page.get_text("words")

        # Detection
        try:
            inp = det_proc(images=img, return_tensors="pt").to(device)
            with torch.no_grad():
                det_out = det_model(**inp)
            ts = torch.tensor([img.size[::-1]]).to(device)
            det = det_proc.post_process_object_detection(det_out, threshold=DET_THRESHOLD, target_sizes=ts)[0]
        except Exception as exc:
            print(f"[pdf-table] detection p{page_num} failed: {exc}", file=sys.stderr)
            continue

        for ti, box in enumerate(det["boxes"]):
            tx0, ty0, tx1, ty1 = [int(v) for v in box.tolist()]
            pad = 10
            crop_box = (max(0, tx0 - pad), max(0, ty0 - pad), tx1 + pad, ty1 + pad)
            crop = img.crop(crop_box)

            # Structure recognition
            try:
                inp = str_proc(images=crop, return_tensors="pt").to(device)
                with torch.no_grad():
                    str_out = str_model(**inp)
                ts = torch.tensor([crop.size[::-1]]).to(device)
                res = str_proc.post_process_object_detection(str_out, threshold=STR_THRESHOLD, target_sizes=ts)[0]
            except Exception as exc:
                print(f"[pdf-table] structure p{page_num}.{ti} failed: {exc}", file=sys.stderr)
                continue

            rows, cols, proj_headers, col_headers, spanning = [], [], [], [], []
            for lbl, bx in zip(res["labels"], res["boxes"]):
                L = id2label[int(lbl)]
                b = [float(v) for v in bx.tolist()]
                if L == "table row":
                    rows.append(b)
                elif L == "table column":
                    cols.append(b)
                elif L == "table projected row header":
                    proj_headers.append(b)
                elif L == "table column header":
                    col_headers.append(b)
                elif L == "table spanning cell":
                    spanning.append(b)

            if len(rows) < MIN_ROWS or len(cols) < MIN_COLS:
                continue

            rows.sort(key=lambda x: x[1])
            cols.sort(key=lambda x: x[0])
            rows = _midpoint_bounds(rows, axis=1)
            cols = _midpoint_bounds(cols, axis=0)

            cx, cy = crop_box[0], crop_box[1]

            def img_to_pdf(x0, y0, x1, y1):
                return fitz.Rect(x0 / scale, y0 / scale, x1 / scale, y1 / scale)

            # Resolve spanning cells into a (row_idx, col_idx) -> text map
            span_text = {}
            for sp in spanning:
                sp_cols = [ci for ci, col in enumerate(cols)
                           if (min(sp[2], col[2]) - max(sp[0], col[0])) > 0.4 * (col[2] - col[0])]
                sp_rows = [ri for ri, row in enumerate(rows)
                           if (min(sp[3], row[3]) - max(sp[1], row[1])) > 0.4 * (row[3] - row[1])]
                if not sp_cols or len(sp_rows) < 2:
                    continue  # only multi-row spans matter for this pass
                sp_rect = img_to_pdf(sp[0] + cx, sp[1] + cy, sp[2] + cx, sp[3] + cy)
                sp_t = _text_in_rect(words, sp_rect).strip()
                if not sp_t:
                    continue
                for ri in sp_rows:
                    for ci in sp_cols:
                        span_text[(ri, ci)] = sp_t

            # Build row-major cell grid
            row_cells = []
            for ri, row in enumerate(rows):
                # Is this a projected row header (full-width section label)?
                is_proj = False
                ry0, ry1 = row[1], row[3]
                for ph in proj_headers:
                    if (min(ry1, ph[3]) - max(ry0, ph[1])) > 0.5 * (ry1 - ry0):
                        is_proj = True
                        break
                if is_proj:
                    rx0, rx1 = min(c[0] for c in cols), max(c[2] for c in cols)
                    rect = img_to_pdf(rx0 + cx, row[1] + cy, rx1 + cx, row[3] + cy)
                    text = _text_in_rect(words, rect).strip()
                    # Represent projected headers as a repeated cell across columns
                    row_cells.append([text] + [""] * (len(cols) - 1))
                else:
                    row = row  # keep name
                    cells_this_row = []
                    for ci, col in enumerate(cols):
                        ix0 = max(row[0], col[0]) + cx
                        iy0 = max(row[1], col[1]) + cy
                        ix1 = min(row[2], col[2]) + cx
                        iy1 = min(row[3], col[3]) + cy
                        rect = img_to_pdf(ix0, iy0, ix1, iy1)
                        text = _text_in_rect(words, rect).strip()
                        sp = span_text.get((ri, ci))
                        if sp and len(sp) > len(text):
                            text = sp
                        cells_this_row.append(text)
                    row_cells.append(cells_this_row)

            # Content filter — reject text-heavy detections
            mean_len, max_len = _content_quality(row_cells)
            if mean_len > MAX_CELL_MEAN_LEN or max_len > MAX_CELL_MAX_LEN:
                continue
            if all(not c for row in row_cells for c in row):
                continue

            # Pick header row — first row above column header detection, else row 0
            header_row_idx = None
            if col_headers:
                ch = col_headers[0]
                for ri, row in enumerate(rows):
                    if row[1] < ch[3] - 5:
                        header_row_idx = ri
                        break

            html = _build_html(row_cells, header_row_idx)

            # Full table bbox in PDF points
            tbbox = img_to_pdf(tx0, ty0, tx1, ty1)
            label = _find_label(page, (tbbox.x0, tbbox.y0, tbbox.x1, tbbox.y1))

            out.append({
                "page": page_num,
                "bbox": [tbbox.x0, tbbox.y0, tbbox.x1, tbbox.y1],
                "label": label,
                "html": html,
                "rowCount": len(rows),
                "colCount": len(cols),
            })

    # Dedup labels across the paper (DB enforces uniqueness); keep the largest.
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
