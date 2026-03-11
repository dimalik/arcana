"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";

interface Tag {
  id: string;
  name: string;
  color: string;
  score?: number;
  cluster?: { id: string; name: string; color: string } | null;
}

interface TagPickerProps {
  paperId: string;
  currentTags: Tag[];
  onUpdate: () => void;
}

export function TagPicker({ paperId, currentTags, onUpdate }: TagPickerProps) {
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/tags")
      .then((r) => r.json())
      .then(setAllTags);
  }, []);

  const addTag = async (tagId: string) => {
    await fetch(`/api/papers/${paperId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagId }),
    });
    onUpdate();
  };

  const removeTag = async (tagId: string) => {
    await fetch(`/api/papers/${paperId}/tags?tagId=${tagId}`, {
      method: "DELETE",
    });
    onUpdate();
  };

  const createAndAddTag = async () => {
    if (!newTagName.trim()) return;
    const colors = [
      "#EF4444",
      "#F59E0B",
      "#10B981",
      "#3B82F6",
      "#8B5CF6",
      "#EC4899",
      "#06B6D4",
    ];
    const color = colors[Math.floor(Math.random() * colors.length)];

    const res = await fetch("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newTagName.trim(), color }),
    });

    if (res.ok) {
      const tag = await res.json();
      setAllTags([...allTags, tag]);
      await addTag(tag.id);
      setNewTagName("");
      toast.success(`Tag "${tag.name}" created`);
    }
  };

  const availableTags = allTags.filter(
    (t) => !currentTags.some((ct) => ct.id === t.id)
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {currentTags.map((tag) => (
          <Badge
            key={tag.id}
            variant="secondary"
            className="gap-1"
            style={{
              backgroundColor: tag.color + "20",
              color: tag.color,
            }}
          >
            {tag.name}
            <button
              onClick={() => removeTag(tag.id)}
              className="ml-1 hover:opacity-70"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <Plus className="mr-1 h-3 w-3" />
            Add Tag
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="start">
          <div className="space-y-2">
            {availableTags.length > 0 && (() => {
              // Group by cluster
              const byCluster = new Map<string, Tag[]>();
              const unclustered: Tag[] = [];
              for (const tag of availableTags) {
                if (tag.cluster) {
                  const key = tag.cluster.name;
                  if (!byCluster.has(key)) byCluster.set(key, []);
                  byCluster.get(key)!.push(tag);
                } else {
                  unclustered.push(tag);
                }
              }
              const groups = Array.from(byCluster.entries());
              return (
                <div className="space-y-2 max-h-[200px] overflow-auto">
                  {groups.map(([clusterName, tags]) => (
                    <div key={clusterName}>
                      <span className="text-[10px] font-medium uppercase text-muted-foreground">{clusterName}</span>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {tags.sort((a: Tag, b: Tag) => (b.score ?? 0) - (a.score ?? 0)).map((tag: Tag) => (
                          <button
                            key={tag.id}
                            onClick={() => { addTag(tag.id); setOpen(false); }}
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80"
                            style={{ backgroundColor: tag.color + "20", color: tag.color }}
                          >
                            {tag.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {unclustered.length > 0 && (
                    <div>
                      {groups.length > 0 && (
                        <span className="text-[10px] font-medium uppercase text-muted-foreground">Other</span>
                      )}
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {unclustered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((tag) => (
                          <button
                            key={tag.id}
                            onClick={() => { addTag(tag.id); setOpen(false); }}
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80"
                            style={{ backgroundColor: tag.color + "20", color: tag.color }}
                          >
                            {tag.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="flex gap-2">
              <Input
                placeholder="New tag..."
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createAndAddTag()}
                className="h-8 text-sm"
              />
              <Button size="sm" className="h-8" onClick={createAndAddTag}>
                Add
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
