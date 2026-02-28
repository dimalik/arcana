"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

type LayoutTheme = "classic" | "clean";

export interface PageInfo {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}

interface LayoutThemeCtx {
  theme: LayoutTheme;
  setTheme: (t: LayoutTheme) => void;
  pageInfo: PageInfo | null;
  setPageInfo: (info: PageInfo | null) => void;
}

const Ctx = createContext<LayoutThemeCtx>({
  theme: "classic",
  setTheme: () => {},
  pageInfo: null,
  setPageInfo: () => {},
});

const STORAGE_KEY = "layout-theme";

export function LayoutThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<LayoutTheme>("classic");
  const [mounted, setMounted] = useState(false);
  const [pageInfo, setPageInfoState] = useState<PageInfo | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as LayoutTheme | null;
    if (stored === "clean" || stored === "classic") {
      setThemeState(stored);
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    document.documentElement.setAttribute(
      "data-theme",
      theme === "clean" ? "clean" : ""
    );
  }, [theme, mounted]);

  const setTheme = (t: LayoutTheme) => {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
  };

  const setPageInfo = useCallback((info: PageInfo | null) => {
    setPageInfoState(info);
  }, []);

  return (
    <Ctx.Provider value={{ theme, setTheme, pageInfo, setPageInfo }}>
      {children}
    </Ctx.Provider>
  );
}

export function useLayoutTheme() {
  return useContext(Ctx);
}
