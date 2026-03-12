"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Home } from "lucide-react";
import { usePageInfo } from "./theme-context";
import { NavCommandMenu } from "./nav-command-menu";
import { TopbarSearch } from "./topbar-search";
import { UserMenu } from "./user-menu";
import { navItems } from "./nav-items";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function CleanTopbar() {
  const pathname = usePathname();
  const { pageInfo } = usePageInfo();
  const [menuOpen, setMenuOpen] = useState(false);

  const navLabel =
    navItems.find(
      (item) =>
        pathname === item.href ||
        (item.href !== "/" && pathname.startsWith(item.href))
    )?.label ?? "Arcana";

  const isDashboard = pathname === "/";
  // Paper detail pages (/papers/[id]) get compact search; everything else gets wide centered search
  const isPaperDetail = /^\/papers\/[^/]+$/.test(pathname);
  const wideSearch = !isPaperDetail;

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

        {!isDashboard && (
          <>
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
          </>
        )}

        {wideSearch ? (
          <>
            <div className="flex-1" />
            <TopbarSearch wide />
            <div className="flex-1" />
            {pageInfo?.actions}
          </>
        ) : (
          <>
            <div className="flex-1" />
            {pageInfo?.actions}
            <TopbarSearch />
          </>
        )}

        <UserMenu />
      </header>

      <NavCommandMenu open={menuOpen} onOpenChange={setMenuOpen} />
    </TooltipProvider>
  );
}
