"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { fetchSavedRoutes } from "@/lib/api";
import { useIclCode } from "@/lib/iclCode";
import IclSelector from "@/components/IclSelector";

export default function SavedRoutesPage() {
  const { iclCode } = useIclCode();
  const { data, isLoading, error } = useQuery({
    queryKey: ["saved-routes", iclCode],
    queryFn: () => fetchSavedRoutes(iclCode),
  });

  return (
    <main className="mx-auto max-w-[640px] px-6 py-16">
      <header className="mb-12 border-b hairline pb-8">
        <IclSelector />
        <h1 className="serif text-5xl font-medium leading-tight mt-3">Saved Routes</h1>
        <nav className="mt-6 flex gap-6 label">
          <Link href="/" className="hover:text-[var(--ink)]">Roster</Link>
          <Link href="/saved" className="text-[var(--ink)] underline underline-offset-4">Saved Routes</Link>
          <Link href="/snapshots" className="hover:text-[var(--ink)]">Snapshots</Link>
        </nav>
      </header>

      {isLoading && <div className="label">Loading…</div>}
      {error instanceof Error && (
        <div className="border hairline p-4 text-sm">
          <div className="label mb-1">Error</div>
          <div>{error.message}</div>
        </div>
      )}
      {data && data.length === 0 && (
        <div className="serif text-xl text-[var(--muted)]">
          No saved routes yet. Build one from the roster.
        </div>
      )}
      {data && data.length > 0 && (
        <ul>
          {data.map((route) => (
            <li key={route.id}>
              <Link
                href={`/saved/${route.id}`}
                className="block border-b hairline py-5 hover:bg-black/[0.03]"
              >
                <div className="flex items-baseline justify-between">
                  <div>
                    <div className="serif text-2xl">{route.rep_name}</div>
                    <div className="label mt-1">
                      {route.mode.toUpperCase()} · {new Date(route.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="serif text-3xl tabular-nums">{route.stop_count}</div>
                    <div className="label">stops</div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
