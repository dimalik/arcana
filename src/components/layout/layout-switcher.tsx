"use client";

import { type ReactNode } from "react";
import { useLayoutTheme } from "./theme-context";
import { Sidebar } from "./sidebar";
import { CleanTopbar } from "./clean-topbar";

export function LayoutSwitcher({ children }: { children: ReactNode }) {
  const { theme } = useLayoutTheme();

  if (theme === "clean") {
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        <CleanTopbar />
        <main className="flex-1 min-h-0 overflow-y-auto pl-8 pr-10 py-5">{children}</main>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
