"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Brain, Cpu, Microscope, Atom, BookOpen } from "lucide-react";

const ICON_MAP: Record<string, typeof Brain> = {
  brain: Brain,
  cpu: Cpu,
  microscope: Microscope,
  atom: Atom,
  book: BookOpen,
};

interface RoomCardProps {
  room: {
    id: string;
    name: string;
    description?: string | null;
    color: string;
    icon: string;
    _count: { insights: number };
  };
}

export function RoomCard({ room }: RoomCardProps) {
  const Icon = ICON_MAP[room.icon] || Brain;

  return (
    <Link href={`/mind-palace/${room.id}`}>
      <Card className="group hover:shadow-md transition-shadow cursor-pointer">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{ backgroundColor: room.color + "20" }}
            >
              <Icon className="h-4 w-4" style={{ color: room.color }} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-medium truncate group-hover:text-primary transition-colors">
                {room.name}
              </h3>
              {room.description && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                  {room.description}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {room._count.insights} insight{room._count.insights !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
