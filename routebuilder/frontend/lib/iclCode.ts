"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "routebuilder.icl_code";
const DEFAULT_ICL = process.env.NEXT_PUBLIC_DEMO_ICL_CODE ?? "GAC6";

function readStored(): string {
  if (typeof window === "undefined") return DEFAULT_ICL;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored && stored.trim() ? stored.trim() : DEFAULT_ICL;
}

export function useIclCode(): {
  iclCode: string;
  setIclCode: (next: string) => void;
  resetIclCode: () => void;
  defaultIclCode: string;
} {
  const [iclCode, setIclCodeState] = useState<string>(DEFAULT_ICL);

  useEffect(() => {
    setIclCodeState(readStored());
    function onStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY) setIclCodeState(readStored());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setIclCode = (next: string) => {
    const trimmed = next.trim().toUpperCase();
    if (!trimmed) return;
    window.localStorage.setItem(STORAGE_KEY, trimmed);
    setIclCodeState(trimmed);
  };

  const resetIclCode = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setIclCodeState(DEFAULT_ICL);
  };

  return { iclCode, setIclCode, resetIclCode, defaultIclCode: DEFAULT_ICL };
}
