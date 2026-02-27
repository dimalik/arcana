"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Download, Globe } from "lucide-react";
import { toast } from "sonner";

export default function ImportPage() {
  const router = useRouter();
  const [arxivInput, setArxivInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [loading, setLoading] = useState(false);

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
          toast.info("Paper already exists — redirecting to it");
          setTimeout(() => router.push(`/papers/${data.paper.id}`), 1500);
          return;
        }
        throw new Error(data.error || "Import failed");
      }

      toast.success("Paper imported from arXiv");
      router.push(`/papers/${data.id}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to import"
      );
    } finally {
      setLoading(false);
    }
  };

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
          toast.info("Paper already exists — redirecting to it");
          setTimeout(() => router.push(`/papers/${data.paper.id}`), 1500);
          return;
        }
        throw new Error(data.error || "Import failed");
      }

      toast.success("Content imported from URL");
      router.push(`/papers/${data.id}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to import"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Import Paper</h2>
        <p className="text-muted-foreground">
          Import papers from arXiv or any URL.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <Tabs defaultValue="arxiv">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="arxiv">
                <Download className="mr-2 h-4 w-4" />
                arXiv
              </TabsTrigger>
              <TabsTrigger value="url">
                <Globe className="mr-2 h-4 w-4" />
                URL
              </TabsTrigger>
            </TabsList>

            <TabsContent value="arxiv" className="space-y-4 pt-4">
              <div>
                <Label>arXiv ID or URL</Label>
                <Input
                  placeholder="e.g., 2301.12345 or https://arxiv.org/abs/2301.12345"
                  value={arxivInput}
                  onChange={(e) => setArxivInput(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && handleArxivImport()
                  }
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Enter an arXiv paper ID or full URL. The PDF will be
                  automatically downloaded.
                </p>
              </div>
              <Button onClick={handleArxivImport} disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import from arXiv
              </Button>
            </TabsContent>

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
                  Paste a DOI link, publisher URL (PNAS, Nature, Science...),
                  or any web page.
                </p>
              </div>
              <Button onClick={handleUrlImport} disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import from URL
              </Button>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
