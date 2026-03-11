"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ArrowLeft, Pencil, Trash2, Brain } from "lucide-react";
import { toast } from "sonner";
import { InsightCard } from "@/components/mind-palace/insight-card";
import { ReviewSession } from "@/components/mind-palace/review-session";

interface Room {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string;
  insights: Insight[];
}

interface Insight {
  id: string;
  learning: string;
  significance: string;
  applications: string | null;
  userNotes: string | null;
  nextReviewAt: string;
  interval: number;
  repetitions: number;
  easeFactor: number;
  paper: { id: string; title: string };
}

export default function RoomDetailPage() {
  const router = useRouter();
  const params = useParams();
  const roomId = params.roomId as string;
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  const fetchRoom = async () => {
    const res = await fetch(`/api/mind-palace/rooms/${roomId}`);
    if (!res.ok) {
      toast.error("Room not found");
      router.push("/mind-palace");
      return;
    }
    const data = await res.json();
    setRoom(data);
    setEditName(data.name);
    setLoading(false);
  };

  useEffect(() => {
    fetchRoom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const handleSave = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    const res = await fetch(`/api/mind-palace/rooms/${roomId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName.trim() }),
    });
    if (res.ok) {
      toast.success("Room updated");
      setEditOpen(false);
      fetchRoom();
    } else {
      toast.error("Failed to update room");
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm("Delete this room and all its insights?")) return;
    const res = await fetch(`/api/mind-palace/rooms/${roomId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      toast.success("Room deleted");
      router.push("/mind-palace");
    } else {
      toast.error("Failed to delete room");
    }
  };

  const handleReview = async (insightId: string, rating: number) => {
    const res = await fetch(`/api/mind-palace/review/${insightId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating }),
    });
    if (res.ok) {
      toast.success("Review recorded");
      fetchRoom();
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!room) return null;

  const dueCount = room.insights.filter(
    (i) => new Date(i.nextReviewAt) <= new Date()
  ).length;

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => router.push("/mind-palace")}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-accent text-muted-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Back to Mind Palace</TooltipContent>
          </Tooltip>

          <div
            className="h-3 w-3 rounded-full shrink-0"
            style={{ backgroundColor: room.color }}
          />
          <h2 className="text-xl font-bold tracking-tight">{room.name}</h2>
          <Badge variant="secondary" className="text-xs">
            {room.insights.length} insight{room.insights.length !== 1 ? "s" : ""}
          </Badge>
          {dueCount > 0 && (
            <Button size="sm" variant="outline" onClick={() => setReviewOpen(true)}>
              Review {dueCount} due
            </Button>
          )}

          <div className="flex-1" />

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setEditOpen(true)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent text-muted-foreground"
              >
                <Pencil className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Edit room</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleDelete}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Delete room</TooltipContent>
          </Tooltip>
        </div>

        {room.description && (
          <p className="text-sm text-muted-foreground">{room.description}</p>
        )}

        {/* Insights */}
        {room.insights.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 p-12">
              <Brain className="h-12 w-12 text-muted-foreground" />
              <p className="text-muted-foreground">
                No insights in this room yet.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {room.insights.map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                onReview={handleReview}
                onDelete={() => fetchRoom()}
                onUpdate={fetchRoom}
              />
            ))}
          </div>
        )}

        {/* Edit dialog */}
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Edit Room</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Room name..."
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                }}
              />
              <Button
                onClick={handleSave}
                disabled={saving || !editName.trim()}
                className="w-full"
              >
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <ReviewSession
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          onComplete={fetchRoom}
        />
      </div>
    </TooltipProvider>
  );
}
