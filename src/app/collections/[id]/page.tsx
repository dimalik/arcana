"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, FolderTree, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface Tag {
  id: string;
  name: string;
  color: string;
}

interface Paper {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  tags: { tag: Tag }[];
}

interface Collection {
  id: string;
  name: string;
  description: string | null;
  papers: { paper: Paper }[];
  children: { id: string; name: string; _count: { papers: number } }[];
}

export default function CollectionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [collection, setCollection] = useState<Collection | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchCollection = async () => {
    const res = await fetch(`/api/collections/${id}`);
    if (!res.ok) {
      router.push("/collections");
      return;
    }
    setCollection(await res.json());
    setLoading(false);
  };

  useEffect(() => {
    fetchCollection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const removePaper = async (paperId: string) => {
    await fetch(`/api/collections/${id}/papers?paperId=${paperId}`, {
      method: "DELETE",
    });
    toast.success("Paper removed from collection");
    fetchCollection();
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!collection) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            {collection.name}
          </h2>
          {collection.description && (
            <p className="text-muted-foreground">{collection.description}</p>
          )}
        </div>
      </div>

      {collection.children.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Sub-Collections</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {collection.children.map((child) => (
              <Link
                key={child.id}
                href={`/collections/${child.id}`}
                className="flex items-center gap-2 rounded-md border p-3 hover:bg-accent"
              >
                <FolderTree className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{child.name}</span>
                <span className="text-sm text-muted-foreground">
                  ({child._count.papers} papers)
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Papers ({collection.papers.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {collection.papers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No papers in this collection yet.
            </p>
          ) : (
            <div className="space-y-2">
              {collection.papers.map(({ paper }) => (
                <div
                  key={paper.id}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <Link
                    href={`/papers/${paper.id}`}
                    className="flex-1 hover:underline"
                  >
                    <p className="font-medium">{paper.title}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {paper.authors && (
                        <span className="text-sm text-muted-foreground">
                          {JSON.parse(paper.authors).join(", ")}
                        </span>
                      )}
                      {paper.year && (
                        <Badge variant="outline">{paper.year}</Badge>
                      )}
                    </div>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removePaper(paper.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
