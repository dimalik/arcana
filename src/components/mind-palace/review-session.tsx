"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Eye, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

interface ReviewInsight {
  id: string;
  learning: string;
  significance: string;
  applications?: string | null;
  paper: { id: string; title: string };
  room: { id: string; name: string; color: string };
}

const RATINGS = [
  { value: 1, label: "Forgot", shortcut: "1", color: "bg-red-500 hover:bg-red-600" },
  { value: 2, label: "Hard", shortcut: "2", color: "bg-orange-500 hover:bg-orange-600" },
  { value: 3, label: "OK", shortcut: "3", color: "bg-yellow-500 hover:bg-yellow-600" },
  { value: 4, label: "Good", shortcut: "4", color: "bg-green-500 hover:bg-green-600" },
  { value: 5, label: "Easy", shortcut: "5", color: "bg-emerald-600 hover:bg-emerald-700" },
];

interface ReviewSessionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
}

export function ReviewSession({ open, onOpenChange, onComplete }: ReviewSessionProps) {
  const [insights, setInsights] = useState<ReviewInsight[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    setCurrentIndex(0);
    setRevealed(false);
    setCompleted(0);
    setLoading(true);

    fetch("/api/mind-palace/review")
      .then((r) => r.json())
      .then((data) => {
        setInsights(data);
        setLoading(false);
      })
      .catch(() => {
        toast.error("Failed to load review items");
        setLoading(false);
      });
  }, [open]);

  const submitRating = useCallback(async (rating: number) => {
    const insight = insights[currentIndex];
    if (!insight) return;

    const res = await fetch(`/api/mind-palace/review/${insight.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating }),
    });

    if (!res.ok) {
      toast.error("Failed to submit rating");
      return;
    }

    setCompleted((c) => c + 1);

    if (currentIndex < insights.length - 1) {
      setCurrentIndex((i) => i + 1);
      setRevealed(false);
    } else {
      // All done
      setCurrentIndex(insights.length);
    }
  }, [insights, currentIndex]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!revealed && currentIndex < insights.length) {
          setRevealed(true);
        }
      }
      if (revealed) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 5) {
          submitRating(num);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, revealed, currentIndex, insights.length, submitRating]);

  const isFinished = currentIndex >= insights.length && insights.length > 0;
  const current = insights[currentIndex];
  const progress = insights.length > 0 ? ((completed) / insights.length) * 100 : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Review Session</span>
            {insights.length > 0 && !isFinished && (
              <span className="text-sm font-normal text-muted-foreground">
                {completed + 1} of {insights.length}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Progress bar */}
        {insights.length > 0 && (
          <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {loading ? (
          <div className="py-12 text-center text-muted-foreground">Loading...</div>
        ) : insights.length === 0 ? (
          <div className="py-12 text-center">
            <CheckCircle2 className="h-12 w-12 mx-auto text-green-500 mb-3" />
            <p className="font-medium">All caught up!</p>
            <p className="text-sm text-muted-foreground mt-1">No insights due for review.</p>
          </div>
        ) : isFinished ? (
          <div className="py-12 text-center">
            <CheckCircle2 className="h-12 w-12 mx-auto text-green-500 mb-3" />
            <p className="font-medium">Session complete!</p>
            <p className="text-sm text-muted-foreground mt-1">
              You reviewed {completed} insight{completed !== 1 ? "s" : ""}.
            </p>
            <Button
              className="mt-4"
              onClick={() => {
                onOpenChange(false);
                onComplete?.();
              }}
            >
              Done
            </Button>
          </div>
        ) : current ? (
          <div className="space-y-4">
            {/* Room badge */}
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                <span
                  className="h-2 w-2 rounded-full mr-1.5"
                  style={{ backgroundColor: current.room.color }}
                />
                {current.room.name}
              </Badge>
            </div>

            {/* Learning (always shown) */}
            <div className="rounded-lg bg-muted/50 p-4">
              <p className="font-medium text-sm leading-relaxed">{current.learning}</p>
            </div>

            {/* Reveal button or revealed content */}
            {!revealed ? (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setRevealed(true)}
              >
                <Eye className="h-4 w-4 mr-2" />
                Reveal (Space)
              </Button>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">{current.significance}</p>
                  {current.applications && (
                    <p className="text-sm text-muted-foreground italic">
                      {current.applications}
                    </p>
                  )}
                  <Link
                    href={`/papers/${current.paper.id}`}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                    onClick={() => onOpenChange(false)}
                  >
                    <FileText className="h-3 w-3" />
                    {current.paper.title}
                  </Link>
                </div>

                {/* Rating buttons */}
                <div className="flex gap-2">
                  {RATINGS.map((r) => (
                    <Button
                      key={r.value}
                      className={`flex-1 text-white ${r.color}`}
                      size="sm"
                      onClick={() => submitRating(r.value)}
                    >
                      {r.label}
                      <span className="ml-1 opacity-60 text-xs">({r.shortcut})</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
