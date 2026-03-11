"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Loader2,
  Upload,
  FileText,
  Download,
  Globe,
  BookOpen,
} from "lucide-react";
import { toast } from "sonner";

interface AddPaperDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: "pdf" | "arxiv" | "anthology" | "url";
}

export function AddPaperDialog({ open, onOpenChange, defaultTab = "pdf" }: AddPaperDialogProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  // PDF upload state
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // arXiv state
  const [arxivInput, setArxivInput] = useState("");

  // URL state
  const [urlInput, setUrlInput] = useState("");

  // ACL Anthology state
  const [anthologyInput, setAnthologyInput] = useState("");

  const closeAndNavigate = (paperId: string) => {
    onOpenChange(false);
    window.dispatchEvent(new Event("paper-imported"));
    router.push(`/papers/${paperId}`);
  };

  // ── PDF Upload handlers ──────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file?.type === "application/pdf") {
      setSelectedFile(file);
    } else {
      toast.error("Only PDF files are supported");
    }
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) setSelectedFile(file);
    },
    []
  );

  const handleUpload = async () => {
    if (!selectedFile) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.paper) {
          toast.info("Paper already exists");
          closeAndNavigate(data.paper.id);
          return;
        }
        throw new Error(data.error || "Upload failed");
      }
      toast.success("Paper uploaded successfully");
      closeAndNavigate(data.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload paper");
    } finally {
      setLoading(false);
    }
  };

  // ── arXiv import handler ─────────────────────────────────────

  const handleArxivImport = async () => {
    if (!arxivInput.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/papers/import/arxiv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: arxivInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.paper) {
          toast.info("Paper already exists");
          closeAndNavigate(data.paper.id);
          return;
        }
        throw new Error(data.error || "Import failed");
      }
      toast.success("Paper imported from arXiv");
      closeAndNavigate(data.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to import");
    } finally {
      setLoading(false);
    }
  };

  // ── URL import handler ───────────────────────────────────────

  const handleUrlImport = async () => {
    if (!urlInput.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/papers/import/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.paper) {
          toast.info("Paper already exists");
          closeAndNavigate(data.paper.id);
          return;
        }
        throw new Error(data.error || "Import failed");
      }
      toast.success("Content imported from URL");
      closeAndNavigate(data.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to import");
    } finally {
      setLoading(false);
    }
  };

  // ── ACL Anthology import handler ─────────────────────────────

  const handleAnthologyImport = async () => {
    if (!anthologyInput.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/papers/import/anthology", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: anthologyInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.paper) {
          toast.info("Paper already exists");
          closeAndNavigate(data.paper.id);
          return;
        }
        throw new Error(data.error || "Import failed");
      }
      toast.success("Paper imported from ACL Anthology");
      closeAndNavigate(data.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to import");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add Paper</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue={defaultTab} className="mt-2">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="pdf">
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              PDF
            </TabsTrigger>
            <TabsTrigger value="arxiv">
              <Download className="mr-1.5 h-3.5 w-3.5" />
              arXiv
            </TabsTrigger>
            <TabsTrigger value="anthology">
              <BookOpen className="mr-1.5 h-3.5 w-3.5" />
              ACL
            </TabsTrigger>
            <TabsTrigger value="url">
              <Globe className="mr-1.5 h-3.5 w-3.5" />
              URL
            </TabsTrigger>
          </TabsList>

          {/* PDF Upload */}
          <TabsContent value="pdf" className="pt-4">
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
                isDragging
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-primary/50"
              }`}
            >
              {selectedFile ? (
                <div className="flex flex-col items-center gap-3">
                  <FileText className="h-8 w-8 text-primary" />
                  <div className="text-center">
                    <p className="font-medium text-sm">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleUpload} disabled={loading}>
                      {loading && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                      {loading ? "Uploading..." : "Upload"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setSelectedFile(null)} disabled={loading}>
                      Clear
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Upload className="h-8 w-8 text-muted-foreground" />
                  <div className="text-center">
                    <p className="font-medium text-sm">Drag and drop your PDF here</p>
                    <p className="text-xs text-muted-foreground">or click to browse</p>
                  </div>
                  <label>
                    <Button size="sm" variant="outline" asChild>
                      <span>Browse Files</span>
                    </Button>
                    <input
                      type="file"
                      accept=".pdf,application/pdf"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                  </label>
                </div>
              )}
            </div>
          </TabsContent>

          {/* arXiv */}
          <TabsContent value="arxiv" className="space-y-4 pt-4">
            <div>
              <Label>arXiv ID or URL</Label>
              <Input
                placeholder="e.g., 2301.12345 or https://arxiv.org/abs/2301.12345"
                value={arxivInput}
                onChange={(e) => setArxivInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleArxivImport()}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                The PDF will be automatically downloaded.
              </p>
            </div>
            <Button size="sm" onClick={handleArxivImport} disabled={loading}>
              {loading && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Import from arXiv
            </Button>
          </TabsContent>

          {/* ACL Anthology */}
          <TabsContent value="anthology" className="space-y-4 pt-4">
            <div>
              <Label>ACL Anthology ID or URL</Label>
              <Input
                placeholder="e.g., P19-3019 or https://aclanthology.org/2023.acl-long.1/"
                value={anthologyInput}
                onChange={(e) => setAnthologyInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAnthologyImport()}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Accepts ACL Anthology IDs or full URLs. PDF and metadata are fetched automatically.
              </p>
            </div>
            <Button size="sm" onClick={handleAnthologyImport} disabled={loading}>
              {loading && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Import from ACL Anthology
            </Button>
          </TabsContent>

          {/* URL */}
          <TabsContent value="url" className="space-y-4 pt-4">
            <div>
              <Label>URL</Label>
              <Input
                placeholder="https://doi.org/10.1073/pnas... or any URL"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleUrlImport()}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Paste a DOI link, publisher URL, or any web page.
              </p>
            </div>
            <Button size="sm" onClick={handleUrlImport} disabled={loading}>
              {loading && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Import from URL
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
