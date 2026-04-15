#!/bin/bash
# Extract page images from PDFs using pdftoppm (poppler).
# NO LLM calls. NO DB writes. Just renders pages to PNGs for inspection.
#
# Output: prisma/backups/figure-preview/<paper-id-prefix>/page-N.png
#
# Usage:
#   ./scripts/extract-all-figures.sh          # 5 papers, 10 pages
#   ./scripts/extract-all-figures.sh 20       # 20 papers
#   ./scripts/extract-all-figures.sh 20 5     # 20 papers, max 5 pages

set -euo pipefail

LIMIT="${1:-5}"
MAX_PAGES="${2:-10}"
OUT_DIR="prisma/backups/figure-preview"
DB="prisma/dev.db"

echo "Extracting page images: $LIMIT papers, max $MAX_PAGES pages each"
echo "Output: $OUT_DIR/"
echo ""

mkdir -p "$OUT_DIR"

# Get paper IDs and file paths
PAPERS=$(sqlite3 "$DB" "
  SELECT id, filePath FROM Paper
  WHERE filePath IS NOT NULL AND filePath != ''
  LIMIT $LIMIT;
")

COUNT=0
TOTAL_PAGES=0
TOTAL=$(echo "$PAPERS" | grep -c . || true)

while IFS='|' read -r ID FILEPATH; do
  COUNT=$((COUNT + 1))
  PREFIX="${ID:0:12}"
  PAPER_DIR="$OUT_DIR/$PREFIX"
  mkdir -p "$PAPER_DIR"

  PDF_PATH="$FILEPATH"
  if [ ! -f "$PDF_PATH" ]; then
    printf "[%d/%d] %s... MISSING\n" "$COUNT" "$TOTAL" "$PREFIX"
    continue
  fi

  FILESIZE=$(stat -f%z "$PDF_PATH" 2>/dev/null || stat -c%s "$PDF_PATH" 2>/dev/null || echo "0")
  if [ "$FILESIZE" -lt 100 ]; then
    printf "[%d/%d] %s... EMPTY\n" "$COUNT" "$TOTAL" "$PREFIX"
    continue
  fi

  printf "[%d/%d] %s... " "$COUNT" "$TOTAL" "$PREFIX"

  # Render pages with pdftoppm (150 DPI, PNG)
  pdftoppm -png -r 150 -l "$MAX_PAGES" "$PDF_PATH" "$PAPER_DIR/page" 2>/dev/null

  PAGES=$(ls "$PAPER_DIR"/page-*.png 2>/dev/null | wc -l | tr -d ' ')
  TOTAL_PAGES=$((TOTAL_PAGES + PAGES))
  echo "$PAGES pages"

done <<< "$PAPERS"

echo ""
echo "Done: $TOTAL_PAGES page images from $COUNT papers"
echo "Inspect: open $OUT_DIR/"
du -sh "$OUT_DIR"
