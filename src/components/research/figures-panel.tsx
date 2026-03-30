"use client";

import { useState, useEffect, useCallback } from "react";
import { Image, X, Download, RefreshCw, Loader2, ChevronLeft, ChevronRight } from "lucide-react";

interface CaptionedFigure {
  id: string;
  filename: string;
  path: string;
  caption: string;
  experiment: string | null;
  keyTakeaway: string | null;
}

interface RawFigureFile {
  name: string;
  path: string;
  size: number;
  modified: string;
}

export function FiguresPanel({ projectId }: { projectId: string }) {
  const [captionedFigures, setCaptionedFigures] = useState<CaptionedFigure[]>([]);
  const [rawFigures, setRawFigures] = useState<RawFigureFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [showGallery, setShowGallery] = useState(false);

  // Fetch captioned figures from DB
  const fetchCaptioned = useCallback(() => {
    fetch(`/api/research/${projectId}/figures`)
      .then(r => r.json())
      .then(data => { if (data.figures) setCaptionedFigures(data.figures); })
      .catch(() => {});
  }, [projectId]);

  // Fetch raw files for image URLs (captioned figures don't have the file listing path)
  const fetchRaw = useCallback(() => {
    setLoading(true);
    fetch(`/api/research/${projectId}/files`)
      .then(r => r.json())
      .then(data => {
        const allFiles: RawFigureFile[] = [];
        const walk = (files: { name: string; path: string; size: number; modified: string; isDir: boolean; children?: unknown[] }[]) => {
          for (const f of files) {
            if (f.isDir && f.children) walk(f.children as typeof files);
            else if (/\.(png|jpg|jpeg|svg|gif)$/i.test(f.name) && !f.path.includes(".venv")) {
              allFiles.push({ name: f.name, path: f.path, size: f.size, modified: f.modified });
            }
          }
        };
        if (data.files) walk(data.files);
        allFiles.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
        setRawFigures(allFiles);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    fetchCaptioned();
    fetchRaw();
    const interval = setInterval(() => { fetchCaptioned(); fetchRaw(); }, 30_000);
    return () => clearInterval(interval);
  }, [fetchCaptioned, fetchRaw]);

  const imgUrl = (filePath: string) => `/api/research/${projectId}/files/download?path=${encodeURIComponent(filePath)}`;

  // Merge: prefer captioned data, fall back to raw file info
  const allImages = rawFigures.map(raw => {
    const captioned = captionedFigures.find(c => c.filename === raw.name);
    return {
      name: raw.name,
      path: raw.path,
      caption: captioned?.caption || null,
      experiment: captioned?.experiment || null,
      keyTakeaway: captioned?.keyTakeaway || null,
    };
  });

  if (loading && allImages.length === 0) {
    return (
      <div className="flex items-center gap-2 py-4 text-muted-foreground/30 text-xs justify-center">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading figures...
      </div>
    );
  }

  if (allImages.length === 0) {
    return (
      <div className="text-center py-3 text-[11px] text-muted-foreground/30">
        No figures yet.
      </div>
    );
  }

  const recent = allImages.slice(0, 3);

  // Human-readable label from filename
  const labelFromName = (name: string) =>
    name
      .replace(/\.(png|jpg|jpeg|svg|gif)$/i, "")
      .replace(/^fig_?\d*_?/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c: string) => c.toUpperCase())
      .trim() || name;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Image className="h-3.5 w-3.5 text-muted-foreground/40" />
          <span className="text-xs font-medium">Figures ({allImages.length})</span>
        </div>
        <button onClick={() => { fetchCaptioned(); fetchRaw(); }} className="text-muted-foreground/30 hover:text-muted-foreground transition-colors">
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {/* Latest 3 figures with captions */}
      <div className="space-y-2">
        {recent.map((fig, idx) => (
          <button
            key={fig.path}
            onClick={() => setSelectedIndex(idx)}
            className="group w-full text-left rounded-md border border-border/40 overflow-hidden hover:border-foreground/20 transition-colors"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imgUrl(fig.path)} alt={fig.name} className="w-full object-contain bg-white" loading="lazy" />
            <div className="px-2 py-1.5 bg-muted/30 space-y-0.5">
              <p className="text-[11px] font-medium text-foreground/80 leading-snug">
                {fig.keyTakeaway || labelFromName(fig.name)}
              </p>
              {fig.caption && (
                <p className="text-[11px] text-muted-foreground/60 leading-snug line-clamp-2">{fig.caption}</p>
              )}
              {fig.experiment && (
                <p className="text-[11px] text-muted-foreground/40 font-mono">{fig.experiment}</p>
              )}
            </div>
          </button>
        ))}
        {allImages.length > 3 && (
          <button
            onClick={() => setShowGallery(true)}
            className="w-full text-center text-[11px] text-primary hover:text-primary/80 transition-colors py-1.5 rounded-md hover:bg-muted/50"
          >
            View all {allImages.length} figures
          </button>
        )}
      </div>

      {/* Lightbox with navigation and caption */}
      {selectedIndex !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center animate-in fade-in-0 duration-150"
          onClick={() => setSelectedIndex(null)}
        >
          <div className="relative max-w-[85vw] max-h-[90vh] flex flex-col items-center" onClick={e => e.stopPropagation()}>
            {/* Controls */}
            <div className="absolute -top-10 right-0 flex gap-2">
              <a href={imgUrl(allImages[selectedIndex].path)} download className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors">
                <Download className="h-4 w-4" />
              </a>
              <button onClick={() => setSelectedIndex(null)} className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Navigation arrows */}
            {selectedIndex > 0 && (
              <button onClick={(e) => { e.stopPropagation(); setSelectedIndex(selectedIndex - 1); }} className="absolute left-[-3rem] top-1/2 -translate-y-1/2 h-10 w-10 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors">
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            {selectedIndex < allImages.length - 1 && (
              <button onClick={(e) => { e.stopPropagation(); setSelectedIndex(selectedIndex + 1); }} className="absolute right-[-3rem] top-1/2 -translate-y-1/2 h-10 w-10 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors">
                <ChevronRight className="h-5 w-5" />
              </button>
            )}

            {/* Image */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imgUrl(allImages[selectedIndex].path)}
              alt={allImages[selectedIndex].name}
              className="max-w-full max-h-[75vh] object-contain rounded-lg bg-white"
            />

            {/* Caption panel */}
            <div className="mt-3 max-w-2xl text-center">
              <p className="text-sm font-medium text-white">
                {allImages[selectedIndex].keyTakeaway || labelFromName(allImages[selectedIndex].name)}
              </p>
              {allImages[selectedIndex].caption && (
                <p className="text-xs text-white/60 mt-1 leading-relaxed">
                  {allImages[selectedIndex].caption}
                </p>
              )}
              <p className="text-xs text-white/30 mt-1 font-mono">
                {allImages[selectedIndex].name}
                {allImages[selectedIndex].experiment && ` · ${allImages[selectedIndex].experiment}`}
                {` · ${selectedIndex + 1}/${allImages.length}`}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Full gallery modal */}
      {showGallery && (
        <div
          className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm overflow-y-auto animate-in fade-in-0 duration-150"
          onClick={() => setShowGallery(false)}
        >
          <div className="max-w-6xl mx-auto py-8 px-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">All Figures ({allImages.length})</h2>
              <button onClick={() => setShowGallery(false)} className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-muted transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Group by experiment */}
            {(() => {
              const groups = new Map<string, typeof allImages>();
              for (const fig of allImages) {
                const expMatch = fig.name.match(/(?:fig_?|exp_?)(\d{2,3})/i);
                const key = fig.experiment || (expMatch ? `Experiment ${parseInt(expMatch[1])}` : "Summary");
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key)!.push(fig);
              }
              const sorted = Array.from(groups.entries()).sort((a, b) => {
                if (a[0] === "Summary") return 1;
                if (b[0] === "Summary") return -1;
                return a[0].localeCompare(b[0], undefined, { numeric: true });
              });

              return sorted.map(([groupName, figs]) => (
                <div key={groupName} className="mb-8">
                  <h3 className="text-sm font-medium text-muted-foreground mb-3">{groupName}</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {figs.map(fig => {
                      const globalIdx = allImages.indexOf(fig);
                      return (
                        <button
                          key={fig.path}
                          onClick={() => { setShowGallery(false); setSelectedIndex(globalIdx); }}
                          className="group rounded-lg border border-border/50 overflow-hidden hover:border-foreground/20 transition-colors bg-white text-left"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={imgUrl(fig.path)} alt={fig.name} className="w-full object-contain bg-white" loading="lazy" />
                          <div className="px-3 py-2 bg-background border-t border-border/30 space-y-0.5">
                            <p className="text-xs font-medium text-foreground/80 leading-snug">
                              {fig.keyTakeaway || labelFromName(fig.name)}
                            </p>
                            {fig.caption && (
                              <p className="text-[11px] text-muted-foreground/60 leading-snug line-clamp-2">{fig.caption}</p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ));
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
