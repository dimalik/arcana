"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Brain, Lightbulb } from "lucide-react";
import Link from "next/link";

interface Stats {
  totalInsights: number;
  totalRooms: number;
}

export function DailyDigest() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch("/api/mind-palace/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  // Hide if no insights exist
  if (!stats || stats.totalInsights === 0) return null;

  return (
    <Link href="/mind-palace">
      <Card className="hover:bg-accent/30 transition-colors">
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                <Brain className="h-4 w-4 text-primary" />
              </div>
              <div>
                <h3 className="text-sm font-medium">Insights</h3>
                <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                  <span className="flex items-center gap-1">
                    <Lightbulb className="h-3 w-3" />
                    {stats.totalInsights} insights across {stats.totalRooms} rooms
                  </span>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
