"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Brain, Flame, Lightbulb } from "lucide-react";
import { ReviewSession } from "./review-session";

interface Stats {
  totalInsights: number;
  totalRooms: number;
  dueCount: number;
  streak: number;
}

export function DailyDigest() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const fetchStats = () => {
    fetch("/api/mind-palace/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  };

  useEffect(() => {
    fetchStats();
  }, []);

  // Hide if no insights exist
  if (!stats || stats.totalInsights === 0) return null;

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                <Brain className="h-4 w-4 text-primary" />
              </div>
              <div>
                <h3 className="text-sm font-medium">Mind Palace</h3>
                <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                  <span className="flex items-center gap-1">
                    <Lightbulb className="h-3 w-3" />
                    {stats.totalInsights} insights
                  </span>
                  {stats.streak > 0 && (
                    <span className="flex items-center gap-1">
                      <Flame className="h-3 w-3 text-orange-500" />
                      {stats.streak}d streak
                    </span>
                  )}
                </div>
              </div>
            </div>
            {stats.dueCount > 0 ? (
              <Button size="sm" onClick={() => setReviewOpen(true)}>
                Review {stats.dueCount}
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">All caught up</span>
            )}
          </div>
        </CardContent>
      </Card>

      <ReviewSession
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        onComplete={fetchStats}
      />
    </>
  );
}
