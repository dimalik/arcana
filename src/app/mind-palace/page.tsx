"use client";

import { useEffect, useState } from "react";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Brain, Lightbulb, Flame, Clock, Plus } from "lucide-react";
import { toast } from "sonner";
import { RoomCard } from "@/components/mind-palace/room-card";
import { InsightCard } from "@/components/mind-palace/insight-card";
import { ReviewSession } from "@/components/mind-palace/review-session";

interface Room {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string;
  _count: { insights: number };
}

interface Stats {
  totalInsights: number;
  totalRooms: number;
  dueCount: number;
  streak: number;
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
  room: { id: string; name: string; color: string; icon: string };
}

export default function MindPalacePage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentInsights, setRecentInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [creating, setCreating] = useState(false);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [roomsRes, statsRes, insightsRes] = await Promise.all([
        fetch("/api/mind-palace/rooms"),
        fetch("/api/mind-palace/stats"),
        fetch("/api/mind-palace/insights"),
      ]);
      const [roomsData, statsData, insightsData] = await Promise.all([
        roomsRes.json(),
        statsRes.json(),
        insightsRes.json(),
      ]);
      setRooms(roomsData);
      setStats(statsData);
      setRecentInsights(insightsData.slice(0, 5));
    } catch {
      toast.error("Failed to load Mind Palace data");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const createRoom = async () => {
    if (!newRoomName.trim()) return;
    setCreating(true);
    const res = await fetch("/api/mind-palace/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newRoomName.trim() }),
    });
    if (res.ok) {
      toast.success("Room created");
      setNewRoomName("");
      setNewRoomOpen(false);
      fetchAll();
    } else {
      const data = await res.json();
      toast.error(data.error || "Failed to create room");
    }
    setCreating(false);
  };

  const handleReview = async (insightId: string, rating: number) => {
    const res = await fetch(`/api/mind-palace/review/${insightId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating }),
    });
    if (res.ok) {
      toast.success("Review recorded");
      fetchAll();
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Mind Palace</h2>
          <p className="text-muted-foreground">
            Your knowledge synthesis and review system.
          </p>
        </div>
        {stats && stats.dueCount > 0 && (
          <Button onClick={() => setReviewOpen(true)}>
            <Clock className="h-4 w-4 mr-2" />
            Review {stats.dueCount} due
          </Button>
        )}
      </div>

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Lightbulb className="h-5 w-5 text-amber-500" />
              <div>
                <p className="text-2xl font-bold">{stats.totalInsights}</p>
                <p className="text-xs text-muted-foreground">Insights</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Brain className="h-5 w-5 text-indigo-500" />
              <div>
                <p className="text-2xl font-bold">{stats.totalRooms}</p>
                <p className="text-xs text-muted-foreground">Rooms</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Clock className="h-5 w-5 text-blue-500" />
              <div>
                <p className="text-2xl font-bold">{stats.dueCount}</p>
                <p className="text-xs text-muted-foreground">Due for Review</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Flame className="h-5 w-5 text-orange-500" />
              <div>
                <p className="text-2xl font-bold">{stats.streak}</p>
                <p className="text-xs text-muted-foreground">Day Streak</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Rooms grid */}
      <div>
        <h3 className="text-lg font-semibold mb-3">Rooms</h3>
        {rooms.length === 0 && !loading ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 p-12">
              <Brain className="h-12 w-12 text-muted-foreground" />
              <p className="text-muted-foreground text-center">
                No rooms yet. Distill insights from papers to auto-create rooms, or create one manually.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {rooms.map((room) => (
              <RoomCard key={room.id} room={room} />
            ))}
            <Dialog open={newRoomOpen} onOpenChange={setNewRoomOpen}>
              <DialogTrigger asChild>
                <Card className="cursor-pointer border-dashed hover:border-primary/50 transition-colors">
                  <CardContent className="p-4 flex items-center justify-center gap-2 text-muted-foreground">
                    <Plus className="h-4 w-4" />
                    <span className="text-sm">New Room</span>
                  </CardContent>
                </Card>
              </DialogTrigger>
              <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                  <DialogTitle>Create Room</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <Input
                    placeholder="Room name..."
                    value={newRoomName}
                    onChange={(e) => setNewRoomName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createRoom();
                    }}
                  />
                  <Button
                    onClick={createRoom}
                    disabled={creating || !newRoomName.trim()}
                    className="w-full"
                  >
                    {creating ? "Creating..." : "Create"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>

      {/* Recent insights */}
      {recentInsights.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Recent Insights</h3>
          <div className="space-y-3">
            {recentInsights.map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                showRoom
                onReview={handleReview}
                onDelete={() => fetchAll()}
                onUpdate={fetchAll}
              />
            ))}
          </div>
        </div>
      )}

      <ReviewSession
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        onComplete={fetchAll}
      />
    </div>
  );
}
