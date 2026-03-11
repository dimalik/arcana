"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileText, Check, MoreVertical, Trash2 } from "lucide-react";
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
    easeFactor?: number;
    source?: string;
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

function StrengthMeter({
  repetitions,
  easeFactor,
}: {
  repetitions: number;
  easeFactor?: number;
}) {
  // Determine how many bars to fill (0-4) based on SM-2 state
  let filledBars = 0;
  if (repetitions >= 1) filledBars = 1;
  if (repetitions >= 2) filledBars = 2;
  if (repetitions >= 3 && (easeFactor ?? 2.5) >= 2.2) filledBars = 3;
  if (repetitions >= 3 && (easeFactor ?? 2.5) >= 2.5) filledBars = 4;

  const barColors = [
    "bg-orange-500",
    "bg-yellow-500",
    "bg-green-500",
    "bg-emerald-500",
  ];
  const heights = [8, 10, 12, 14];

  return (
    <div className="flex items-end gap-[2px]" title={`${filledBars}/4 strength`}>
      {heights.map((h, i) => (
        <div
          key={i}
          className={`w-[3px] rounded-sm transition-colors ${
            i < filledBars ? barColors[i] : "bg-muted-foreground/20"
          }`}
          style={{ height: `${h}px` }}
        />
      ))}
    </div>
  );
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
      <CardContent className="p-4 space-y-3">
        {/* Header: strength meter · paper · room · overflow */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <StrengthMeter
            repetitions={insight.repetitions}
            easeFactor={insight.easeFactor}
          />
          <span className="text-muted-foreground/40">·</span>
          <Link
            href={`/papers/${insight.paper.id}`}
            className="inline-flex items-center gap-1 hover:text-primary truncate max-w-[200px]"
          >
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate">{insight.paper.title}</span>
          </Link>
          {showRoom && insight.room && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <Link
                href={`/mind-palace/${insight.room.id}`}
                className="inline-flex items-center gap-1 shrink-0"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: insight.room.color }}
                />
                {insight.room.name}
              </Link>
            </>
          )}
          {insight.source && insight.source !== "manual" && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                insight.source === "research"
                  ? "bg-amber-500/10 text-amber-600"
                  : "bg-blue-500/10 text-blue-600"
              }`}>
                {insight.source === "research" ? "Research" : "Auto"}
              </span>
            </>
          )}
          <div className="flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                <MoreVertical className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem
                onClick={handleDelete}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* WHAT I LEARNED */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-0.5">
            What I learned
          </p>
          <p className="text-sm leading-relaxed">{insight.learning}</p>
        </div>

        {/* WHY IT MATTERS */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-0.5">
            Why it matters
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {insight.significance}
          </p>
        </div>

        {/* HOW TO APPLY (optional) */}
        {insight.applications && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-0.5">
              How to apply
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {insight.applications}
            </p>
          </div>
        )}

        {/* User notes — always visible, clickable to edit */}
        {editingNotes ? (
          <div className="space-y-1">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Add your notes..."
              className="text-sm"
              autoFocus
            />
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={saveNotes}
              >
                <Check className="h-3 w-3 mr-1" /> Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => {
                  setEditingNotes(false);
                  setNotes(insight.userNotes || "");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="rounded border border-dashed border-muted-foreground/20 px-2.5 py-1.5 text-xs text-muted-foreground cursor-pointer hover:border-muted-foreground/40 hover:bg-muted/30 transition-colors"
            onClick={() => setEditingNotes(true)}
          >
            {insight.userNotes || "Add your notes..."}
          </div>
        )}

        {/* Rating buttons (only when due) */}
        {onReview && isDue && (
          <div className="flex gap-1 pt-0.5">
            {RATING_LABELS.map((r) => (
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
        )}
      </CardContent>
    </Card>
  );
}
