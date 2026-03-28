"use client";

import { useState, useEffect, useCallback } from "react";
import { Image, X, Download, RefreshCw, Loader2, Maximize2 } from "lucide-react";

interface FigureFile {
  name: string;
  path: string;
  size: number;
  modified: string;
}

export function FiguresPanel({ projectId }: { projectId: string }) {
  const [figures, setFigures] = useState<FigureFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFigure, setSelectedFigure] = useState<string | null>(null);

  const fetchFigures = useCallback(() => {
    setLoading(true);
    fetch(`/api/research/${projectId}/files`)
      .then((r) => r.json())
      .then((data) => {
        const allFiles: FigureFile[] = [];
        const walk = (files: { name: string; path: string; size: number; modified: string; isDir: boolean; children?: unknown[] }[]) => {
          for (const f of files) {
            if (f.isDir && f.children) {
              walk(f.children as typeof files);
            } else if (/\.(png|jpg|jpeg|svg|gif|pdf)$/i.test(f.name) && !f.path.includes(".venv")) {
              allFiles.push({ name: f.name, path: f.path, size: f.size, modified: f.modified });
            }
          }
        };
        if (data.files) walk(data.files);
        // Sort by modified date, newest first
        allFiles.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
        setFigures(allFiles);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    fetchFigures();
    // Poll every 30s for new figures
    const interval = setInterval(fetchFigures, 30_000);
    return () => clearInterval(interval);
  }, [fetchFigures]);

  if (loading && figures.length === 0) {
    return (
      <div className="flex items-center gap-2 py-4 text-muted-foreground/30 text-xs justify-center">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading figures...
      </div>
    );
  }

  if (figures.length === 0) {
    return (
      <div className="text-center py-4 text-[10px] text-muted-foreground/30">
        No figures yet. Use dispatch_visualizer after experiments complete.
      </div>
    );
  }

  const imgUrl = (filePath: string) => `/api/research/${projectId}/files/download?path=${encodeURIComponent(filePath)}`;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Image className="h-3.5 w-3.5 text-muted-foreground/40" />
          <span className="text-xs font-medium">Figures ({figures.length})</span>
        </div>
        <button onClick={fetchFigures} className="text-muted-foreground/30 hover:text-muted-foreground transition-colors">
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {/* Grid of thumbnails */}
      <div className="grid grid-cols-2 gap-2">
        {figures.map((fig) => (
          <button
            key={fig.path}
            onClick={() => setSelectedFigure(fig.path)}
            className="group relative rounded-md border border-border/40 overflow-hidden hover:border-foreground/20 transition-colors bg-muted/10"
          >
            {fig.name.endsWith(".pdf") ? (
              <div className="aspect-[4/3] flex items-center justify-center text-muted-foreground/20">
                <span className="text-xs">PDF</span>
              </div>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={imgUrl(fig.path)}
                alt={fig.name}
                className="aspect-[4/3] object-contain w-full bg-white"
                loading="lazy"
              />
            )}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
              <Maximize2 className="h-4 w-4 text-white opacity-0 group-hover:opacity-70 transition-opacity" />
            </div>
            <div className="px-1.5 py-1 bg-background/80 backdrop-blur-sm">
              <p className="text-[9px] text-muted-foreground/60 truncate">{fig.name}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Lightbox */}
      {selectedFigure && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 animate-in fade-in-0 duration-150"
          onClick={() => setSelectedFigure(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <div className="absolute -top-10 right-0 flex gap-2">
              <a
                href={imgUrl(selectedFigure)}
                download
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
              >
                <Download className="h-4 w-4" />
              </a>
              <button
                onClick={() => setSelectedFigure(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {selectedFigure.endsWith(".pdf") ? (
              <iframe src={imgUrl(selectedFigure)} className="w-[80vw] h-[80vh] rounded-lg" />
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={imgUrl(selectedFigure)}
                alt={figures.find((f) => f.path === selectedFigure)?.name || ""}
                className="max-w-full max-h-[85vh] object-contain rounded-lg bg-white"
              />
            )}
            <p className="text-center text-xs text-white/50 mt-2">
              {figures.find((f) => f.path === selectedFigure)?.name}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
