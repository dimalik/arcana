"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  Paintbrush,
} from "lucide-react";
import { navItems } from "./nav-items";
import { useLayoutTheme } from "./theme-context";

const STORAGE_KEY = "sidebar-collapsed";

export function Sidebar() {
  const pathname = usePathname();
  const { setTheme } = useLayoutTheme();
  const [collapsed, setCollapsed] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      setCollapsed(stored === "true");
    }
    setMounted(true);
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  };

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "flex h-full flex-col border-r bg-card transition-[width] duration-200 overflow-hidden",
          collapsed ? "w-14" : "w-56"
        )}
      >
        {/* Logo */}
        <div className={cn("flex h-14 items-center", collapsed ? "justify-center px-0" : "px-4")}>
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold overflow-hidden"
          >
            <FileText className="h-5 w-5 shrink-0" />
            {!collapsed && <span className="whitespace-nowrap">Arcana</span>}
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 p-2">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/" && pathname.startsWith(item.href));

            const link = (
              <Link
                href={item.href}
                className={cn(
                  "flex items-center rounded-md text-sm font-medium transition-colors",
                  collapsed
                    ? "h-9 w-10 justify-center"
                    : "gap-3 px-3 py-2",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
              </Link>
            );

            if (collapsed) {
              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              );
            }

            return <div key={item.href}>{link}</div>;
          })}
        </nav>

        {/* Theme toggle + Collapse toggle */}
        <div className="p-2 space-y-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setTheme("clean")}
                className={cn(
                  "flex items-center rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors",
                  collapsed
                    ? "h-9 w-10 justify-center"
                    : "gap-3 px-3 py-2 w-full"
                )}
              >
                <Paintbrush className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="whitespace-nowrap">Clean theme</span>}
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={8}>
                Switch to clean theme
              </TooltipContent>
            )}
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={toggle}
                className={cn(
                  "flex items-center rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors",
                  collapsed
                    ? "h-9 w-10 justify-center"
                    : "gap-3 px-3 py-2 w-full"
                )}
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-4 w-4 shrink-0" />
                ) : (
                  <>
                    <PanelLeftClose className="h-4 w-4 shrink-0" />
                    <span className="whitespace-nowrap">Collapse</span>
                  </>
                )}
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={8}>
                Expand sidebar
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
}
