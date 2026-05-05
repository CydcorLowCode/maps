"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { fetchReps } from "@/lib/api";
import { useIclCode } from "@/lib/iclCode";
import IclSelector from "@/components/IclSelector";

export default function RosterPage() {
  const { iclCode } = useIclCode();
  const { data, isLoading, error } = useQuery({
    queryKey: ["reps", iclCode],
    queryFn: () => fetchReps(iclCode),
  });

  return (
    <main className="mx-auto max-w-[640px] px-6 py-16">
      <header className="mb-12 border-b hairline pb-8">
        <IclSelector />
        <h1 className="serif text-5xl font-medium leading-tight mt-3">Roster</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Pick a rep to plan their next walking route.
        </p>
        <nav className="mt-6 flex gap-6 label">
          <Link href="/" className="text-[var(--ink)] underline underline-offset-4">Roster</Link>
          <Link href="/saved" className="hover:text-[var(--ink)]">Saved Routes</Link>
          <Link href="/snapshots" className="hover:text-[var(--ink)]">Snapshots</Link>
        </nav>
      </header>

      {isLoading && <SkeletonRows />}
      {error instanceof Error && (
        <div className="border hairline p-4 text-sm">
          <div className="label mb-1">Error</div>
          <div>{error.message}</div>
        </div>
      )}

      {data && (
        <ul>
          {data.map((rep) => {
            const disabled = rep.total === 0;
            const row = (
              <div
                className={`flex items-baseline justify-between border-b hairline py-5 transition-colors ${
                  disabled ? "opacity-40" : "hover:bg-black/[0.03]"
                }`}
              >
                <div>
                  <div className="serif text-2xl">{rep.name}</div>
                  <div className="label mt-1">{rep.owner_id}</div>
                </div>
                <div className="text-right">
                  <div className="serif text-3xl tabular-nums">{rep.total}</div>
                  <div className="label">opportunities</div>
                </div>
              </div>
            );
            return (
              <li key={rep.owner_id}>
                {disabled ? (
                  <div title="No active opportunities in the last 60 days">{row}</div>
                ) : (
                  <Link href={`/rep/${rep.owner_id}?name=${encodeURIComponent(rep.name)}`}>{row}</Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

function SkeletonRows() {
  return (
    <ul>
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="flex items-baseline justify-between border-b hairline py-5">
          <div className="space-y-2">
            <div className="h-6 w-48 bg-black/5 rounded-sm" />
            <div className="h-3 w-28 bg-black/5 rounded-sm" />
          </div>
          <div className="h-8 w-12 bg-black/5 rounded-sm" />
        </li>
      ))}
    </ul>
  );
}
