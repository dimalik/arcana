"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Home, ArrowLeftRight } from "lucide-react";
import { useLayoutTheme } from "./theme-context";
import { NavCommandMenu } from "./nav-command-menu";
import { TopbarSearch } from "./topbar-search";
import { navItems } from "./nav-items";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function CleanTopbar() {
  const pathname = usePathname();
  const { setTheme, pageInfo } = useLayoutTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  const navLabel =
    navItems.find(
      (item) =>
        pathname === item.href ||
        (item.href !== "/" && pathname.startsWith(item.href))
    )?.label ?? "Arcana";

  return (
    <TooltipProvider delayDuration={0}>
      <header className="flex h-12 shrink-0 items-center gap-2 bg-card/50 px-4">
        {/* Menu button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setMenuOpen(true)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <Menu className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Navigation <kbd className="ml-1.5 text-[10px] font-mono opacity-60">&#8984;K</kbd>
          </TooltipContent>
        </Tooltip>

        {/* Home */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href="/"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <Home className="h-4 w-4" />
            </Link>
          </TooltipTrigger>
          <TooltipContent>Dashboard</TooltipContent>
        </Tooltip>

        {/* Page title + optional metadata */}
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          <span className="text-sm font-medium truncate">
            {pageInfo?.title ?? navLabel}
          </span>
          {pageInfo?.meta}
        </div>

        <div className="flex-1" />

        {/* Page-specific actions (e.g. like, pdf, overflow menu) */}
        {pageInfo?.actions}

        {/* Search */}
        <TopbarSearch />

        {/* Theme switch */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setTheme("classic")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <ArrowLeftRight className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Switch to classic layout</TooltipContent>
        </Tooltip>
      </header>

      <NavCommandMenu open={menuOpen} onOpenChange={setMenuOpen} />
    </TooltipProvider>
  );
}
