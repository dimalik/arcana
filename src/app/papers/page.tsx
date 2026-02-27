"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, FileText } from "lucide-react";
import { toast } from "sonner";
import { PaperCard, PaperCardData } from "@/components/paper-card";

export default function PapersPage() {
  const [papers, setPapers] = useState<PaperCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [yearFilter, setYearFilter] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchPapers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (yearFilter) params.set("year", yearFilter);
    params.set("page", page.toString());

    const res = await fetch(`/api/papers?${params}`);
    const data = await res.json();
    setPapers(data.papers);
    setTotalPages(data.totalPages);
    setLoading(false);
  }, [search, yearFilter, page]);

  useEffect(() => {
    fetchPapers();
  }, [fetchPapers]);

  const handleLikeToggle = async (id: string) => {
    const res = await fetch(`/api/papers/${id}/like`, { method: "PATCH" });
    if (res.ok) {
      const { isLiked } = await res.json();
      setPapers((prev) =>
        prev.map((p) => (p.id === id ? { ...p, isLiked } : p))
      );
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this paper?")) return;
    await fetch(`/api/papers/${id}`, { method: "DELETE" });
    toast.success("Paper deleted");
    fetchPapers();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Papers</h2>
        <p className="text-muted-foreground">
          Browse and manage your research papers.
        </p>
      </div>

      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search papers..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-10"
          />
        </div>
        <Select
          value={yearFilter}
          onValueChange={(v) => {
            setYearFilter(v === "all" ? "" : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Year" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Years</SelectItem>
            {Array.from({ length: 30 }, (_, i) => 2026 - i).map((y) => (
              <SelectItem key={y} value={y.toString()}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="mb-2 h-5 w-3/4" />
                <Skeleton className="mb-2 h-4 w-1/2" />
                <Skeleton className="h-4 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : papers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12">
            <FileText className="h-12 w-12 text-muted-foreground" />
            <p className="text-muted-foreground">No papers found</p>
            <Link href="/upload">
              <Button>Upload a Paper</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {papers.map((paper) => (
            <PaperCard
              key={paper.id}
              paper={paper}
              onLikeToggle={handleLikeToggle}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <Button
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span className="flex items-center px-4 text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
