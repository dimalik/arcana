"use client";

import { type ReactNode, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ThemeProvider } from "next-themes";
import { CleanTopbar } from "./clean-topbar";

const AUTH_PATHS = ["/login", "/signup"];
const SKIP_ONBOARDING_CHECK = ["/login", "/signup", "/onboarding"];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAuthPage = AUTH_PATHS.includes(pathname);
  const isOnboardingPage = pathname === "/onboarding";

  // Redirect to onboarding if not completed
  useEffect(() => {
    if (SKIP_ONBOARDING_CHECK.includes(pathname)) return;

    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !data.onboardingCompleted) {
          router.replace("/onboarding");
        }
      })
      .catch(() => {});
  }, [pathname, router]);

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      {isAuthPage || isOnboardingPage ? (
        children
      ) : (
        <div className="flex h-screen flex-col overflow-hidden">
          <CleanTopbar />
          <main className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pl-8 pr-10 py-5">
            {children}
          </main>
        </div>
      )}
    </ThemeProvider>
  );
}
