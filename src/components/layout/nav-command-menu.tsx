"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { navItems } from "./nav-items";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NavCommandMenu({ open, onOpenChange }: Props) {
  const router = useRouter();
  const [insightCount, setInsightCount] = useState<number | null>(null);

  // Fetch mind palace stats for badge
  useEffect(() => {
    fetch("/api/mind-palace/stats")
      .then((r) => r.json())
      .then((data) => {
        if (typeof data.totalInsights === "number" && data.totalInsights > 0) {
          setInsightCount(data.totalInsights);
        }
      })
      .catch(() => {});
  }, []);

  // Cmd+K global shortcut
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Go to..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Pages">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isMindPalace = item.href === "/mind-palace";
            return (
              <CommandItem
                key={item.href}
                value={item.label}
                onSelect={() => {
                  router.push(item.href);
                  onOpenChange(false);
                }}
              >
                <Icon className="mr-2 h-4 w-4" />
                {item.label}
                {isMindPalace && insightCount !== null && (
                  <span className="ml-auto text-[10px] font-medium rounded-full bg-primary/10 text-primary px-1.5 py-0.5">
                    {insightCount}
                  </span>
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
