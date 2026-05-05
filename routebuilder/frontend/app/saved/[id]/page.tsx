"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { fetchSavedRoute } from "@/lib/api";
import type { OpportunityPin } from "@/lib/types";

const RouteMap = dynamic(() => import("@/components/Map"), { ssr: false });

export default function SavedRouteDetailPage() {
  const params = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["saved-route", params.id],
    queryFn: () => fetchSavedRoute(params.id),
  });

  if (isLoading) return <div className="p-8 label">Loading…</div>;
  if (error instanceof Error) return <div className="p-8 label">Error: {error.message}</div>;
  if (!data) return null;

  // Reconstruct map pins from input snapshot if present, otherwise from ordered_stops.
  const pins: OpportunityPin[] = data.input_snapshot ?? data.ordered_stops.map((s) => ({
    id: s.opportunity_id,
    street: "",
    lat: s.lat,
    lng: s.lng,
  }));
  const drawnOrder = data.mode === "drawn" ? data.ordered_stops.map((s) => s.opportunity_id) : null;
  const autoRoute = data.mode === "auto" ? data.auto_route_snapshot ?? null : null;

  return (
    <main className="grid grid-rows-[auto_1fr] h-screen">
      <header className="flex items-center justify-between border-b hairline px-6 py-4">
        <div className="flex items-center gap-4">
          <Link href="/saved" className="label hover:text-[var(--ink)]">← Saved</Link>
          <div className="hidden md:block w-px h-6 bg-[var(--rule)]" />
          <div>
            <div className="serif text-xl">{data.rep_name}</div>
            <div className="label">
              {data.mode.toUpperCase()} · {data.stop_count} stops · {new Date(data.created_at).toLocaleString()}
            </div>
          </div>
        </div>
      </header>
      <section className="relative">
        <RouteMap
          pins={pins}
          startingId={null}
          onPinClick={() => {}}
          autoRoute={autoRoute}
          drawnOrder={drawnOrder}
          className="absolute inset-0"
        />
      </section>
    </main>
  );
}
