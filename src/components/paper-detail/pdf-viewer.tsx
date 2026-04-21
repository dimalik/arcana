"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  ExternalLink,
  ZoomIn,
  ZoomOut,
  Type,
  BoxSelect,
  Search,
  Copy,
  X,
} from "lucide-react";

interface PdfViewerProps {
  paperId: string;
  showOpenInNewTab?: boolean;
  /** Increment to trigger a fit-to-width recalculation */
  fitSignal?: number;
  targetPage?: number | null;
  targetPageSignal?: number;
}

type SelectMode = "text" | "area";

type PdfPage = {
  getViewport: (opts: {
    scale: number;
  }) => { width: number; height: number; transform: number[] };
  render: (opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: unknown;
  }) => { promise: Promise<void> };
  getTextContent: () => Promise<{
    items: Array<{
      str: string;
      transform: number[];
      width: number;
      fontName: string;
    }>;
    styles: Record<string, { fontFamily?: string }>;
  }>;
};

type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfjsLib = any;

/** Load pdfjs-dist from /public via runtime import to bypass bundler entirely */
async function loadPdfjsLib(): Promise<PdfjsLib> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__pdfjsLib) return w.__pdfjsLib;

  // Use Function constructor so the import() is invisible to static analysis
  // by webpack/turbopack — they cannot resolve or bundle this
  const dynamicImport = new Function("url", "return import(url)");
  const lib = await dynamicImport("/pdfjs/pdf.min.mjs");
  lib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  w.__pdfjsLib = lib;
  return lib;
}

// ── Area selection popup ──────────────────────────────────────────

interface AreaPopupState {
  text: string;
  source: "text-layer" | "ocr" | "vision";
  x: number;
  y: number;
  loading: boolean;
}

function AreaSelectionPopup({
  state,
  onTextChange,
  onSearch,
  onCopy,
  onCancel,
}: {
  state: AreaPopupState;
  onTextChange: (text: string) => void;
  onSearch: () => void;
  onCopy: () => void;
  onCancel: () => void;
}) {
  const sourceLabels: Record<string, string> = {
    "text-layer": "Text layer",
    ocr: "OCR",
    vision: "Vision LLM",
  };

  return (
    <div
      className="fixed z-[70] animate-in fade-in zoom-in-95 duration-100"
      style={{
        left: `${state.x}px`,
        top: `${state.y}px`,
        transform: "translate(-50%, 8px)",
      }}
    >
      <div className="w-[320px] rounded-lg bg-popover border shadow-lg overflow-hidden">
        <div className="px-3 py-2 border-b bg-muted/30 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            Extracted text
          </span>
          <div className="flex items-center gap-1.5">
            {!state.loading && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {sourceLabels[state.source]}
              </span>
            )}
            <button
              onClick={onCancel}
              className="h-5 w-5 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>

        <div className="p-2">
          {state.loading ? (
            <div className="flex items-center justify-center py-4 gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Extracting text...
            </div>
          ) : (
            <textarea
              value={state.text}
              onChange={(e) => onTextChange(e.target.value)}
              className="w-full h-20 text-xs bg-muted/30 rounded-md border p-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="No text extracted"
            />
          )}
        </div>

        {!state.loading && (
          <div className="px-2 pb-2 flex gap-1">
            <button
              onClick={onSearch}
              disabled={!state.text.trim()}
              className="flex-1 flex items-center justify-center gap-1 text-[11px] font-medium px-2 py-1.5 rounded-md bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-50"
            >
              <Search className="h-3 w-3" />
              Search as reference
            </button>
            <button
              onClick={onCopy}
              disabled={!state.text.trim()}
              className="flex items-center gap-1 text-[11px] font-medium px-2 py-1.5 rounded-md bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
            >
              <Copy className="h-3 w-3" />
              Copy
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────

export function PdfViewer({
  paperId,
  showOpenInNewTab,
  fitSignal,
  targetPage,
  targetPageSignal,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesScrollRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState<number | null>(null);
  const pdfDocRef = useRef<PdfDoc | null>(null);
  const basePageWidthRef = useRef<number>(0);
  const router = useRouter();

  // Mode toggle
  const [mode, setMode] = useState<SelectMode>("text");

  // Area selection state
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const selectionRectRef = useRef<HTMLDivElement | null>(null);
  const [areaPopup, setAreaPopup] = useState<AreaPopupState | null>(null);

  const renderAllPages = useCallback(
    async (doc: PdfDoc, renderScale: number) => {
      const container = containerRef.current;
      if (!container) return;

      const pagesContainer = container.querySelector("[data-pdf-pages]");
      if (!pagesContainer) return;
      pagesContainer.innerHTML = "";

      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: renderScale });

        const wrapper = document.createElement("div");
        wrapper.className = "relative mb-2 shadow-sm mx-auto";
        wrapper.style.width = `${viewport.width}px`;
        wrapper.style.height = `${viewport.height}px`;
        wrapper.setAttribute("data-page-wrapper", String(i));

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.setAttribute("data-page-canvas", String(i));
        const ctx = canvas.getContext("2d");
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport }).promise;
        }
        wrapper.appendChild(canvas);

        // Text layer for selection
        const textLayerDiv = document.createElement("div");
        textLayerDiv.style.cssText =
          "position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;opacity:0.25;line-height:1;";
        textLayerDiv.setAttribute("data-text-layer", String(i));
        wrapper.appendChild(textLayerDiv);

        try {
          const textContent = await page.getTextContent();
          for (const item of textContent.items) {
            if (!item.str) continue;
            const tx = viewport.transform
              ? matMul(viewport.transform, item.transform)
              : item.transform;

            const fontHeight = Math.hypot(tx[2], tx[3]);
            if (fontHeight < 1) continue;

            const span = document.createElement("span");
            span.textContent = item.str;
            span.style.cssText = `position:absolute;white-space:pre;color:transparent;font-size:${fontHeight}px;font-family:${textContent.styles[item.fontName]?.fontFamily || "sans-serif"};left:${tx[4]}px;top:${tx[5] - fontHeight}px;`;
            textLayerDiv.appendChild(span);
          }
        } catch {
          // text layer is optional
        }

        pagesContainer.appendChild(wrapper);
      }
    },
    []
  );

  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      try {
        setLoading(true);
        setError(null);

        const pdfjsLib = await loadPdfjsLib();

        const doc = await pdfjsLib.getDocument(`/api/papers/${paperId}/file`)
          .promise;
        if (cancelled) return;

        pdfDocRef.current = doc as PdfDoc;
        setNumPages(doc.numPages);

        const firstPage = await (doc as PdfDoc).getPage(1);
        const unitViewport = firstPage.getViewport({ scale: 1 });
        basePageWidthRef.current = unitViewport.width;

        const scrollEl = pagesScrollRef.current;
        const availableWidth = scrollEl
          ? scrollEl.clientWidth - 32
          : 600;
        const fitScale = availableWidth / unitViewport.width;

        setScale(fitScale);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load PDF:", err);
        setError("Failed to load PDF");
        setLoading(false);
      }
    }

    loadPdf();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId]);

  useEffect(() => {
    if (pdfDocRef.current && scale !== null) {
      renderAllPages(pdfDocRef.current, scale).then(() => setLoading(false));
    }
  }, [scale, renderAllPages]);

  useEffect(() => {
    if (loading || !targetPage || targetPage < 1) return;
    const container = containerRef.current;
    if (!container) return;

    const timer = window.setTimeout(() => {
      const pageWrapper = container.querySelector<HTMLElement>(
        `[data-page-wrapper="${targetPage}"]`,
      );
      if (!pageWrapper) return;

      pageWrapper.scrollIntoView({ behavior: "smooth", block: "start" });
      pageWrapper.style.boxShadow = "0 0 0 2px color-mix(in srgb, var(--primary) 55%, transparent)";
      pageWrapper.style.borderRadius = "10px";
      window.setTimeout(() => {
        pageWrapper.style.boxShadow = "";
      }, 1800);
    }, 100);

    return () => window.clearTimeout(timer);
  }, [loading, targetPage, targetPageSignal]);

  // Recompute fit-to-width when layout changes
  useEffect(() => {
    if (!basePageWidthRef.current || fitSignal === undefined) return;
    const timer = setTimeout(() => {
      const el = containerRef.current;
      if (!el || !basePageWidthRef.current) return;
      const availableWidth = el.clientWidth - 32;
      const fitScale = availableWidth / basePageWidthRef.current;
      setScale(fitScale);
    }, 250);
    return () => clearTimeout(timer);
  }, [fitSignal]);

  const handleZoomIn = () => setScale((s) => Math.min(3, (s ?? 1) + 0.2));
  const handleZoomOut = () => setScale((s) => Math.max(0.5, (s ?? 1) - 0.2));

  // Toggle text layer pointer events based on mode
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const textLayers = container.querySelectorAll("[data-text-layer]");
    textLayers.forEach((el) => {
      (el as HTMLElement).style.pointerEvents =
        mode === "text" ? "auto" : "none";
    });
  }, [mode, loading]);

  // ── Area selection handlers ───────────────────────────────────

  const extractTextFromRect = useCallback(
    async (
      rect: DOMRect,
      _scrollContainer: HTMLElement
    ): Promise<{ text: string; source: "text-layer" | "ocr" | "vision" }> => {
      const container = containerRef.current;
      if (!container)
        return { text: "", source: "text-layer" };

      // 1. Try text layer spans first
      const textLayers = container.querySelectorAll("[data-text-layer]");
      const collected: { text: string; top: number; left: number }[] = [];

      textLayers.forEach((layer) => {
        const spans = layer.querySelectorAll("span");
        spans.forEach((span) => {
          const spanRect = span.getBoundingClientRect();
          // Check if span intersects with selection rect
          if (
            spanRect.right > rect.left &&
            spanRect.left < rect.right &&
            spanRect.bottom > rect.top &&
            spanRect.top < rect.bottom
          ) {
            collected.push({
              text: span.textContent || "",
              top: spanRect.top,
              left: spanRect.left,
            });
          }
        });
      });

      if (collected.length > 0) {
        // Sort in reading order: top to bottom, left to right
        collected.sort((a, b) => {
          const rowDiff = Math.abs(a.top - b.top);
          if (rowDiff < 5) return a.left - b.left;
          return a.top - b.top;
        });
        const text = collected.map((c) => c.text).join(" ").trim();
        if (text.length > 0) {
          return { text, source: "text-layer" as const };
        }
      }

      // 2. Try Tesseract.js OCR
      try {
        const canvasEl = getCanvasForRect(container, rect);
        if (canvasEl) {
          const croppedDataUrl = cropCanvas(canvasEl, rect);
          if (croppedDataUrl) {
            const ocrText = await runTesseractOCR(croppedDataUrl);
            if (ocrText && ocrText.trim().length > 3) {
              return { text: ocrText.trim(), source: "ocr" as const };
            }
          }
        }
      } catch (e) {
        console.warn("Tesseract OCR failed:", e);
      }

      // 3. Fall back to Vision LLM
      try {
        const canvasEl = getCanvasForRect(container, rect);
        if (canvasEl) {
          const croppedDataUrl = cropCanvas(canvasEl, rect);
          if (croppedDataUrl) {
            const res = await fetch("/api/ocr", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ image: croppedDataUrl }),
            });
            if (res.ok) {
              const { text } = await res.json();
              if (text && text.trim().length > 0) {
                return { text: text.trim(), source: "vision" as const };
              }
            }
          }
        }
      } catch (e) {
        console.warn("Vision LLM OCR failed:", e);
      }

      return { text: "", source: "text-layer" as const };
    },
    []
  );

  const handleAreaMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (mode !== "area") return;
      // Only handle left click
      if (e.button !== 0) return;

      setAreaPopup(null);
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, y: e.clientY };

      // Create selection rectangle
      const rect = document.createElement("div");
      rect.className = "fixed pointer-events-none z-[65]";
      rect.style.cssText =
        "border: 2px dashed rgb(59 130 246 / 0.7); background: rgb(59 130 246 / 0.1); border-radius: 2px;";
      rect.style.left = `${e.clientX}px`;
      rect.style.top = `${e.clientY}px`;
      rect.style.width = "0px";
      rect.style.height = "0px";
      document.body.appendChild(rect);
      selectionRectRef.current = rect;
    },
    [mode]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const start = dragStartRef.current;
      const rect = selectionRectRef.current;
      if (!start || !rect) return;

      const left = Math.min(start.x, e.clientX);
      const top = Math.min(start.y, e.clientY);
      const width = Math.abs(e.clientX - start.x);
      const height = Math.abs(e.clientY - start.y);

      rect.style.left = `${left}px`;
      rect.style.top = `${top}px`;
      rect.style.width = `${width}px`;
      rect.style.height = `${height}px`;
    };

    const handleMouseUp = async (e: MouseEvent) => {
      setIsDragging(false);
      const start = dragStartRef.current;
      const rectEl = selectionRectRef.current;
      if (!start || !rectEl) return;

      const selRect = rectEl.getBoundingClientRect();
      rectEl.remove();
      selectionRectRef.current = null;
      dragStartRef.current = null;

      // Ignore tiny drags (accidental clicks)
      if (selRect.width < 10 || selRect.height < 10) return;

      const scrollContainer = pagesScrollRef.current;
      if (!scrollContainer) return;

      // Show popup with loading
      setAreaPopup({
        text: "",
        source: "text-layer",
        x: selRect.left + selRect.width / 2,
        y: selRect.bottom,
        loading: true,
      });

      const result = await extractTextFromRect(selRect, scrollContainer);

      setAreaPopup({
        text: result.text,
        source: result.source,
        x: selRect.left + selRect.width / 2,
        y: selRect.bottom,
        loading: false,
      });
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, extractTextFromRect]);

  // Clean up selection rect on mode change
  useEffect(() => {
    setAreaPopup(null);
    if (selectionRectRef.current) {
      selectionRectRef.current.remove();
      selectionRectRef.current = null;
    }
  }, [mode]);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full flex-col bg-muted/30"
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b bg-card px-2 py-1 shrink-0">
        <button
          onClick={handleZoomOut}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs text-muted-foreground w-12 text-center">
          {scale !== null ? `${Math.round(scale * 100)}%` : "—"}
        </span>
        <button
          onClick={handleZoomIn}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Zoom in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        {numPages > 0 && (
          <span className="text-xs text-muted-foreground ml-1">
            {numPages} page{numPages !== 1 ? "s" : ""}
          </span>
        )}

        {/* Mode toggle */}
        <div className="ml-2 flex items-center rounded-md border bg-muted/50 p-0.5">
          <button
            onClick={() => setMode("text")}
            className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors ${
              mode === "text"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Text selection mode"
          >
            <Type className="h-3 w-3" />
            Text
          </button>
          <button
            onClick={() => setMode("area")}
            className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors ${
              mode === "area"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Area selection mode"
          >
            <BoxSelect className="h-3 w-3" />
            Area
          </button>
        </div>

        <div className="flex-1" />
        {showOpenInNewTab && (
          <a
            href={`/api/papers/${paperId}/file`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            Open in new tab
          </a>
        )}
      </div>

      {/* Pages */}
      <div
        ref={pagesScrollRef}
        className={`flex-1 overflow-auto p-4 ${mode === "area" ? "cursor-crosshair" : ""}`}
        onMouseDown={handleAreaMouseDown}
      >
        {loading && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {error}
          </div>
        )}
        <div data-pdf-pages="" className="flex flex-col items-center gap-2" />
      </div>

      {/* Area selection popup */}
      {areaPopup && (
        <AreaSelectionPopup
          state={areaPopup}
          onTextChange={(text) =>
            setAreaPopup((prev) => (prev ? { ...prev, text } : null))
          }
          onSearch={() => {
            if (areaPopup.text.trim()) {
              router.push(
                `/search?q=${encodeURIComponent(areaPopup.text.trim())}`
              );
            }
          }}
          onCopy={() => {
            navigator.clipboard.writeText(areaPopup.text);
            setAreaPopup(null);
          }}
          onCancel={() => setAreaPopup(null)}
        />
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function matMul(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** Find the canvas element that best covers the given client rect */
function getCanvasForRect(
  container: HTMLElement,
  rect: DOMRect
): HTMLCanvasElement | null {
  const canvases = Array.from(container.querySelectorAll("canvas[data-page-canvas]"));
  for (const c of canvases) {
    const cRect = c.getBoundingClientRect();
    // Check if this canvas overlaps the selection
    if (
      cRect.right > rect.left &&
      cRect.left < rect.right &&
      cRect.bottom > rect.top &&
      cRect.top < rect.bottom
    ) {
      return c as HTMLCanvasElement;
    }
  }
  return null;
}

/** Crop a canvas to a specific client rect and return a base64 data URL */
function cropCanvas(canvas: HTMLCanvasElement, clientRect: DOMRect): string | null {
  const canvasRect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / canvasRect.width;
  const scaleY = canvas.height / canvasRect.height;

  const sx = Math.max(0, (clientRect.left - canvasRect.left) * scaleX);
  const sy = Math.max(0, (clientRect.top - canvasRect.top) * scaleY);
  const sw = Math.min(canvas.width - sx, clientRect.width * scaleX);
  const sh = Math.min(canvas.height - sy, clientRect.height * scaleY);

  if (sw <= 0 || sh <= 0) return null;

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = sw;
  cropCanvas.height = sh;
  const ctx = cropCanvas.getContext("2d");
  if (!ctx) return null;

  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return cropCanvas.toDataURL("image/png");
}

/** Run Tesseract.js OCR on a base64 image */
async function runTesseractOCR(imageDataUrl: string): Promise<string> {
  // Dynamic import to keep tesseract.js out of the initial bundle
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(imageDataUrl);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
