#!/usr/bin/env python3
"""
Extract embedded images from a PDF using PyMuPDF.
Outputs JSON to stdout for consumption by the TypeScript pipeline.

Usage: python3 pdf-image-extractor.py <pdf_path> --out-dir <dir> [--min-width 200] [--min-height 200] [--min-bytes 10000] [--max-pages 50]
"""
import json
import hashlib
import os
import sys
import argparse

import fitz


def extract_images(pdf_path, out_dir, min_width=200, min_height=200, min_bytes=10000, max_pages=50):
    doc = fitz.open(pdf_path)
    results = []
    seen_hashes = set()

    for page_num in range(min(len(doc), max_pages)):
        page = doc[page_num]
        page_width = page.rect.width
        page_height = page.rect.height

        for img_idx, img in enumerate(page.get_images(full=True)):
            xref = img[0]
            try:
                pix = fitz.Pixmap(doc, xref)
            except Exception:
                continue

            if pix.n > 4:
                pix = fitz.Pixmap(fitz.csRGB, pix)

            w, h = pix.width, pix.height
            if w < min_width or h < min_height:
                continue

            # Get placement rect for full-page filtering AND Y position
            y_ratio = 0.5  # default: middle of page
            if page_width > 0 and page_height > 0:
                try:
                    rects = page.get_image_rects(xref)
                    if rects:
                        r = rects[0]
                        rw = r.width / page_width
                        rh = r.height / page_height
                        if rw > 0.95 and rh > 0.95:
                            continue
                        # Y position: use center of placement rect
                        y_ratio = ((r.y0 + r.y1) / 2) / page_height
                except Exception:
                    pass

            img_bytes = pix.tobytes("png")
            if len(img_bytes) < min_bytes:
                continue

            asset_hash = hashlib.sha256(img_bytes).hexdigest()
            if asset_hash in seen_hashes:
                continue
            seen_hashes.add(asset_hash)

            filename = f"p{page_num + 1}-img{len(results) + 1}.png"
            filepath = os.path.join(out_dir, filename)
            with open(filepath, "wb") as f:
                f.write(img_bytes)

            results.append({
                "page": page_num + 1,
                "imageIndex": img_idx,
                "width": w,
                "height": h,
                "bytes": len(img_bytes),
                "assetHash": asset_hash,
                "filename": filename,
                "filepath": filepath,
                "yRatio": round(y_ratio, 4),
            })

    doc.close()
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf_path")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--min-width", type=int, default=200)
    parser.add_argument("--min-height", type=int, default=200)
    parser.add_argument("--min-bytes", type=int, default=10000)
    parser.add_argument("--max-pages", type=int, default=50)
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    results = extract_images(
        args.pdf_path, args.out_dir,
        min_width=args.min_width, min_height=args.min_height,
        min_bytes=args.min_bytes, max_pages=args.max_pages,
    )
    json.dump(results, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
