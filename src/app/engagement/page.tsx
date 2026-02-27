"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Heart,
  Flame,
  Eye,
  FileText,
  MessageSquare,
  Highlighter,
  Network,
  Compass,
  Download,
} from "lucide-react";

interface TopPaper {
  id: string;
  title: string;
  isLiked: boolean;
  engagementScore: number;
  authors: string | null;
  year: number | null;
}

interface LikedPaper {
  id: string;
  title: string;
  engagementScore: number;
  authors: string | null;
  year: number | null;
}

interface RecentEvent {
  id: string;
  event: string;
  createdAt: string;
  paper: { id: string; title: string };
}

interface EventCount {
  event: string;
  count: number;
}

const EVENT_ICONS: Record<string, typeof Eye> = {
  view: Eye,
  pdf_open: FileText,
  chat: MessageSquare,
  annotate: Highlighter,
  concept_explore: Network,
  discovery_seed: Compass,
  import: Download,
};

const EVENT_LABELS: Record<string, string> = {
  view: "Views",
  pdf_open: "PDF Opens",
  chat: "Chat Messages",
  annotate: "Annotations",
  concept_explore: "Concepts Explored",
  discovery_seed: "Discovery Seeds",
  import: "Imports",
};

const HEAT_COLORS = [
  "bg-muted",
  "bg-blue-100 dark:bg-blue-950",
  "bg-yellow-100 dark:bg-yellow-950",
  "bg-orange-100 dark:bg-orange-950",
  "bg-red-100 dark:bg-red-950",
];

const HEAT_TEXT = [
  "text-muted-foreground",
  "text-blue-600 dark:text-blue-400",
  "text-yellow-600 dark:text-yellow-400",
  "text-orange-600 dark:text-orange-400",
  "text-red-600 dark:text-red-400",
];

function getHeatLevel(score: number): number {
  if (score <= 0) return 0;
  if (score < 2) return 1;
  if (score < 5) return 2;
  if (score < 12) return 3;
  return 4;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function EngagementPage() {
  const [data, setData] = useState<{
    topPapers: TopPaper[];
    likedPapers: LikedPaper[];
    recentEvents: RecentEvent[];
    eventCounts: EventCount[];
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/engagement")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Engagement</h2>
          <p className="text-muted-foreground">
            Track your research activity and interests.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-16 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const totalEvents = data.eventCounts.reduce((s, e) => s + e.count, 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Engagement</h2>
        <p className="text-muted-foreground">
          Track your research activity and interests.
        </p>
      </div>

      {/* Event count cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Total Events
              </span>
              <Flame className="h-4 w-4 text-orange-500" />
            </div>
            <p className="mt-1 text-2xl font-bold">{totalEvents}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Liked Papers
              </span>
              <Heart className="h-4 w-4 text-red-500" />
            </div>
            <p className="mt-1 text-2xl font-bold">
              {data.likedPapers.length}
            </p>
          </CardContent>
        </Card>
        {data.eventCounts
          .sort((a, b) => b.count - a.count)
          .slice(0, 2)
          .map((ec) => {
            const Icon = EVENT_ICONS[ec.event] || Eye;
            return (
              <Card key={ec.event}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      {EVENT_LABELS[ec.event] || ec.event}
                    </span>
                    <Icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <p className="mt-1 text-2xl font-bold">{ec.count}</p>
                </CardContent>
              </Card>
            );
          })}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Most engaged papers */}
        <div>
          <h3 className="mb-3 text-lg font-semibold">Most Engaged</h3>
          {data.topPapers.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No engagement data yet. Start exploring papers!
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {data.topPapers.map((paper) => {
                const heat = getHeatLevel(paper.engagementScore);
                return (
                  <Link key={paper.id} href={`/papers/${paper.id}`}>
                    <Card className="transition-colors hover:bg-accent/50">
                      <CardContent className="flex items-center gap-3 p-3">
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${HEAT_COLORS[heat]}`}
                        >
                          <Flame
                            className={`h-4 w-4 ${HEAT_TEXT[heat]}`}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {paper.title}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Score: {paper.engagementScore.toFixed(1)}
                            {paper.year ? ` · ${paper.year}` : ""}
                          </p>
                        </div>
                        {paper.isLiked && (
                          <Heart className="h-4 w-4 shrink-0 fill-red-500 text-red-500" />
                        )}
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Liked papers */}
        <div>
          <h3 className="mb-3 text-lg font-semibold">Liked Papers</h3>
          {data.likedPapers.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No liked papers yet. Click the heart on papers you find interesting!
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {data.likedPapers.map((paper) => (
                <Link key={paper.id} href={`/papers/${paper.id}`}>
                  <Card className="transition-colors hover:bg-accent/50">
                    <CardContent className="flex items-center gap-3 p-3">
                      <Heart className="h-4 w-4 shrink-0 fill-red-500 text-red-500" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {paper.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {paper.year ? `${paper.year}` : ""}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent activity */}
      <div>
        <h3 className="mb-3 text-lg font-semibold">Recent Activity</h3>
        {data.recentEvents.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No activity yet.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="divide-y p-0">
              {data.recentEvents.map((event) => {
                const Icon = EVENT_ICONS[event.event] || Eye;
                return (
                  <Link
                    key={event.id}
                    href={`/papers/${event.paper.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <span className="text-sm">
                        {EVENT_LABELS[event.event] || event.event}
                      </span>
                      <span className="mx-1.5 text-muted-foreground">·</span>
                      <span className="text-sm text-muted-foreground truncate">
                        {event.paper.title}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {timeAgo(event.createdAt)}
                    </span>
                  </Link>
                );
              })}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
