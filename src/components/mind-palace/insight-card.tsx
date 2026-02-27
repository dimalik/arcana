"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FileText, Clock, Pencil, Check, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface InsightCardProps {
  insight: {
    id: string;
    learning: string;
    significance: string;
    applications?: string | null;
    userNotes?: string | null;
    nextReviewAt: string;
    interval: number;
    repetitions: number;
    paper: { id: string; title: string };
    room?: { id: string; name: string; color: string };
  };
  showRoom?: boolean;
  onReview?: (insightId: string, rating: number) => void;
  onDelete?: (insightId: string) => void;
  onUpdate?: () => void;
}

const RATING_LABELS = [
  { value: 1, label: "Forgot", color: "text-red-500" },
  { value: 2, label: "Hard", color: "text-orange-500" },
  { value: 3, label: "OK", color: "text-yellow-500" },
  { value: 4, label: "Good", color: "text-green-500" },
  { value: 5, label: "Easy", color: "text-emerald-600" },
];

function formatNextReview(date: string): string {
  const diff = new Date(date).getTime() - Date.now();
  if (diff <= 0) return "Due now";
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  if (days === 1) return "Due tomorrow";
  return `Due in ${days}d`;
}

export function InsightCard({
  insight,
  showRoom,
  onReview,
  onDelete,
  onUpdate,
}: InsightCardProps) {
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState(insight.userNotes || "");
  const isDue = new Date(insight.nextReviewAt) <= new Date();

  const saveNotes = async () => {
    const res = await fetch(`/api/mind-palace/insights/${insight.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userNotes: notes || null }),
    });
    if (res.ok) {
      setEditingNotes(false);
      onUpdate?.();
    } else {
      toast.error("Failed to save notes");
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this insight?")) return;
    const res = await fetch(`/api/mind-palace/insights/${insight.id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      onDelete?.(insight.id);
    } else {
      toast.error("Failed to delete");
    }
  };

  return (
    <Card className={isDue ? "border-primary/30" : ""}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="font-medium text-sm leading-relaxed">{insight.learning}</p>
          <div className="flex items-center gap-1 shrink-0">
            <Badge variant={isDue ? "default" : "secondary"} className="text-xs">
              <Clock className="h-3 w-3 mr-1" />
              {formatNextReview(insight.nextReviewAt)}
            </Badge>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{insight.significance}</p>

        {insight.applications && (
          <p className="text-sm text-muted-foreground italic">
            {insight.applications}
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Link
            href={`/papers/${insight.paper.id}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
          >
            <FileText className="h-3 w-3" />
            <span className="truncate max-w-[200px]">{insight.paper.title}</span>
          </Link>
          {showRoom && insight.room && (
            <Link
              href={`/mind-palace/${insight.room.id}`}
              className="inline-flex items-center gap-1 text-xs"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: insight.room.color }}
              />
              {insight.room.name}
            </Link>
          )}
        </div>

        {/* User notes */}
        {editingNotes ? (
          <div className="space-y-1">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Add your notes..."
              className="text-sm"
            />
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={saveNotes}>
                <Check className="h-3 w-3 mr-1" /> Save
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingNotes(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : insight.userNotes ? (
          <div
            className="text-xs bg-muted/50 rounded px-2 py-1.5 cursor-pointer hover:bg-muted"
            onClick={() => setEditingNotes(true)}
          >
            {insight.userNotes}
          </div>
        ) : null}

        {/* Actions row */}
        <div className="flex items-center justify-between pt-1">
          <div className="flex gap-1">
            {onReview && isDue && RATING_LABELS.map((r) => (
              <Button
                key={r.value}
                size="sm"
                variant="outline"
                className={`h-7 text-xs px-2 ${r.color}`}
                onClick={() => onReview(insight.id, r.value)}
              >
                {r.label}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => setEditingNotes(true)}
            >
              <Pencil className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
              onClick={handleDelete}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
