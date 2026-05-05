"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { fetchSnapshots } from "@/lib/api";
import { useIclCode } from "@/lib/iclCode";
import IclSelector from "@/components/IclSelector";

export default function SnapshotsPage() {
  const { iclCode } = useIclCode();
  const { data, isLoading, error } = useQuery({
    queryKey: ["snapshots", iclCode],
    queryFn: () => fetchSnapshots(iclCode),
  });

  return (
    <main className="mx-auto max-w-[640px] px-6 py-16">
      <header className="mb-12 border-b hairline pb-8">
        <IclSelector />
        <h1 className="serif text-5xl font-medium leading-tight mt-3">Snapshots</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Saved Salesforce opportunity assignments. Captured at a point in time so
          you can refer back even after the assignments change.
        </p>
        <nav className="mt-6 flex gap-6 label">
          <Link href="/" className="hover:text-[var(--ink)]">Roster</Link>
          <Link href="/saved" className="hover:text-[var(--ink)]">Saved Routes</Link>
          <Link href="/snapshots" className="text-[var(--ink)] underline underline-offset-4">Snapshots</Link>
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
          No snapshots yet. Open a rep on the roster and tap Save Snapshot.
        </div>
      )}
      {data && data.length > 0 && (
        <ul>
          {data.map((snap) => (
            <li key={snap.id}>
              <Link
                href={`/snapshots/${snap.id}`}
                className="block border-b hairline py-5 hover:bg-black/[0.03]"
              >
                <div className="flex items-baseline justify-between">
                  <div>
                    <div className="serif text-2xl">{snap.rep_name}</div>
                    <div className="label mt-1">
                      {new Date(snap.created_at).toLocaleString()}
                      {snap.label ? ` · ${snap.label}` : ""}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="serif text-3xl tabular-nums">{snap.opportunity_count}</div>
                    <div className="label">opportunities</div>
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
