"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

export interface PageInfo {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}

interface PageInfoCtx {
  pageInfo: PageInfo | null;
  setPageInfo: (info: PageInfo | null) => void;
}

const Ctx = createContext<PageInfoCtx>({
  pageInfo: null,
  setPageInfo: () => {},
});

export function PageInfoProvider({ children }: { children: ReactNode }) {
  const [pageInfo, setPageInfoState] = useState<PageInfo | null>(null);

  const setPageInfo = useCallback((info: PageInfo | null) => {
    setPageInfoState(info);
  }, []);

  return (
    <Ctx.Provider value={{ pageInfo, setPageInfo }}>
      {children}
    </Ctx.Provider>
  );
}

export function usePageInfo() {
  return useContext(Ctx);
}
