"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FolderTree, Plus, Trash2, ChevronRight } from "lucide-react";
import { toast } from "sonner";

interface Collection {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  _count: { papers: number; children: number };
  children: Collection[];
}

export default function CollectionsPage() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const fetchCollections = async () => {
    const res = await fetch("/api/collections");
    setCollections(await res.json());
  };

  useEffect(() => {
    fetchCollections();
  }, []);

  const createCollection = async (parentId?: string) => {
    if (!newName.trim()) return;
    const res = await fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName.trim(),
        description: newDesc.trim() || undefined,
        parentId,
      }),
    });
    if (res.ok) {
      toast.success("Collection created");
      setNewName("");
      setNewDesc("");
      fetchCollections();
    }
  };

  const deleteCollection = async (id: string) => {
    if (!confirm("Delete this collection?")) return;
    await fetch(`/api/collections/${id}`, { method: "DELETE" });
    toast.success("Collection deleted");
    fetchCollections();
  };

  const rootCollections = collections.filter((c) => !c.parentId);

  const renderCollection = (col: Collection, depth = 0) => (
    <div key={col.id} style={{ marginLeft: depth * 24 }}>
      <div className="flex items-center justify-between rounded-md border p-3 mb-2">
        <Link
          href={`/collections/${col.id}`}
          className="flex items-center gap-2 hover:underline"
        >
          <FolderTree className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{col.name}</span>
          <span className="text-sm text-muted-foreground">
            ({col._count.papers} papers)
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => deleteCollection(col.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {col.children?.map((child) => renderCollection(child, depth + 1))}
    </div>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Collections</h2>
        <p className="text-muted-foreground">
          Organize papers into collections and sub-collections.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create Collection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder="Collection name..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Textarea
            placeholder="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            rows={2}
          />
          <Button onClick={() => createCollection()}>
            <Plus className="mr-1 h-4 w-4" />
            Create
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Collections</CardTitle>
        </CardHeader>
        <CardContent>
          {rootCollections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No collections yet.
            </p>
          ) : (
            <div>{rootCollections.map((c) => renderCollection(c))}</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
