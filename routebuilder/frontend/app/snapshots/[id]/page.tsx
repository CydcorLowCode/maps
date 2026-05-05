"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSnapshot, fetchSnapshotRoutes, updateRoute } from "@/lib/api";
import type {
  AutoRouteResponse,
  OpportunityPin,
  SavedRouteDetail,
} from "@/lib/types";
import type { OverlayRoute } from "@/components/Map";

const RouteMap = dynamic(() => import("@/components/Map"), { ssr: false });

const ROUTE_PALETTE = [
  "#1f77b4",
  "#d94f2c",
  "#2ca02c",
  "#9467bd",
  "#8c564b",
  "#17becf",
  "#bcbd22",
  "#e377c2",
  "#7f7f7f",
];

export default function SnapshotDetailPage() {
  const params = useParams<{ id: string }>();
  const snapshotId = params.id;

  const { data: snapshot, isLoading: snapshotLoading, error } = useQuery({
    queryKey: ["snapshot", snapshotId],
    queryFn: () => fetchSnapshot(snapshotId),
  });

  const { data: routes = [], isLoading: routesLoading } = useQuery({
    queryKey: ["snapshot-routes", snapshotId],
    queryFn: () => fetchSnapshotRoutes(snapshotId),
    enabled: Boolean(snapshot),
  });

  const colorByRouteId = useMemo(() => {
    const map = new Map<string, string>();
    routes.forEach((r, i) => map.set(r.id, ROUTE_PALETTE[i % ROUTE_PALETTE.length]));
    return map;
  }, [routes]);

  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // Default visibility: when routes first load, show them all.
  useEffect(() => {
    if (routes.length > 0 && visibleIds.size === 0) {
      setVisibleIds(new Set(routes.map((r) => r.id)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes]);

  const pins = useMemo<OpportunityPin[]>(() => {
    if (!snapshot) return [];
    // Use corrected coords when present so the map matches what was used to
    // build the routes off this snapshot.
    return snapshot.opportunities.map((opp) => {
      if (opp.corrected_lat != null && opp.corrected_lng != null) {
        return { ...opp, lat: opp.corrected_lat, lng: opp.corrected_lng };
      }
      return opp;
    });
  }, [snapshot]);

  const overlayRoutes = useMemo<OverlayRoute[]>(() => {
    return routes
      .filter((r) => visibleIds.has(r.id) && r.id !== highlightId)
      .map((r) => ({
        id: r.id,
        color: colorByRouteId.get(r.id) ?? "#888",
        coords: r.ordered_stops.map((s) => [s.lat, s.lng] as [number, number]),
        label: r.label ?? undefined,
      }));
  }, [routes, visibleIds, highlightId, colorByRouteId]);

  const highlightedRoute = highlightId
    ? routes.find((r) => r.id === highlightId)
    : null;
  const highlightedAuto: AutoRouteResponse | null = useMemo(() => {
    if (!highlightedRoute) return null;
    if (highlightedRoute.mode === "auto" && highlightedRoute.auto_route_snapshot) {
      return highlightedRoute.auto_route_snapshot;
    }
    return null;
  }, [highlightedRoute]);
  const highlightedDrawn: string[] | null = useMemo(() => {
    if (!highlightedRoute) return null;
    if (highlightedRoute.mode === "drawn") {
      return highlightedRoute.ordered_stops.map((s) => s.opportunity_id);
    }
    return null;
  }, [highlightedRoute]);

  if (error instanceof Error) {
    return (
      <main className="p-8">
        <Link href="/snapshots" className="label">
          ← Snapshots
        </Link>
        <div className="mt-4 border hairline p-4 text-sm">
          <div className="label mb-1">Error</div>
          <div>{error.message}</div>
        </div>
      </main>
    );
  }

  if (snapshotLoading || !snapshot) {
    return (
      <main className="h-screen flex items-center justify-center label">
        Loading snapshot…
      </main>
    );
  }

  const toggleVisible = (id: string) => {
    setVisibleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (highlightId === id) setHighlightId(null);
  };

  const toggleHighlight = (id: string) => {
    setHighlightId((prev) => (prev === id ? null : id));
    setVisibleIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  return (
    <main className="grid grid-cols-1 md:grid-cols-[1fr_400px] grid-rows-[auto_1fr] h-screen">
      <header className="md:col-span-2 flex items-center justify-between border-b hairline px-6 py-4 bg-paper z-[400]">
        <div className="flex items-center gap-4">
          <Link href="/snapshots" className="label hover:text-[var(--ink)]">
            ← Snapshots
          </Link>
          <div className="hidden md:block w-px h-6 bg-[var(--rule)]" />
          <div>
            <div className="serif text-xl leading-tight">{snapshot.rep_name}</div>
            <div className="label">
              ICL {snapshot.icl_code} · {snapshot.opportunity_count} opportunities ·{" "}
              {new Date(snapshot.created_at).toLocaleString()}
              {snapshot.label ? ` · ${snapshot.label}` : ""}
            </div>
          </div>
        </div>
        <Link
          href={`/snapshots/${snapshot.id}/build`}
          className="label px-4 py-2 border-2 border-[var(--ink)] hover:bg-[var(--ink)] hover:text-paper"
        >
          Build a route
        </Link>
      </header>

      <section className="relative">
        <RouteMap
          pins={pins}
          startingId={null}
          onPinClick={() => {}}
          autoRoute={highlightedAuto}
          drawnOrder={highlightedDrawn}
          overlayRoutes={overlayRoutes}
          className="absolute inset-0"
        />
      </section>

      <aside className="flex flex-col h-full overflow-hidden bg-paper border-l hairline">
        <div className="px-6 py-5 border-b hairline">
          <div className="label">Routes built from this snapshot</div>
          <div className="serif text-xl mt-2">
            {routesLoading
              ? "Loading…"
              : routes.length === 0
                ? "No routes yet."
                : `${routes.length} route${routes.length === 1 ? "" : "s"}`}
          </div>
          {snapshot.notes && (
            <p className="mt-3 text-sm text-[var(--muted)]">{snapshot.notes}</p>
          )}
          {routes.length > 0 && (
            <div className="label mt-3">
              {visibleIds.size} visible
              {highlightId ? " · 1 highlighted (numbered stops)" : ""}
            </div>
          )}
        </div>

        <ul className="flex-1 overflow-y-auto">
          {routes.map((r) => (
            <RouteRow
              key={r.id}
              route={r}
              snapshotId={snapshotId}
              color={colorByRouteId.get(r.id) ?? "#888"}
              visible={visibleIds.has(r.id)}
              highlighted={highlightId === r.id}
              onToggleVisible={() => toggleVisible(r.id)}
              onToggleHighlight={() => toggleHighlight(r.id)}
            />
          ))}
        </ul>

        <div className="border-t hairline px-6 py-4 label">
          {snapshot.opportunity_count} opportunities · rep {snapshot.rep_salesforce_id}
        </div>
      </aside>
    </main>
  );
}

function RouteRow({
  route,
  snapshotId,
  color,
  visible,
  highlighted,
  onToggleVisible,
  onToggleHighlight,
}: {
  route: SavedRouteDetail;
  snapshotId: string;
  color: string;
  visible: boolean;
  highlighted: boolean;
  onToggleVisible: () => void;
  onToggleHighlight: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(route.label ?? "");
  const [draftNotes, setDraftNotes] = useState(route.notes ?? "");

  // Re-sync drafts when the underlying route changes (after a save) and we're
  // not actively editing.
  useEffect(() => {
    if (!editing) {
      setDraftLabel(route.label ?? "");
      setDraftNotes(route.notes ?? "");
    }
  }, [route.label, route.notes, editing]);

  const saveMutation = useMutation({
    mutationFn: () =>
      updateRoute(route.id, {
        label: draftLabel.trim() || null,
        notes: draftNotes.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["snapshot-routes", snapshotId] });
      queryClient.invalidateQueries({ queryKey: ["saved-route", route.id] });
      setEditing(false);
    },
  });

  const hasNote = (route.notes ?? "").trim().length > 0;

  return (
    <li
      className="border-b hairline px-6 py-3 flex flex-col gap-2"
      style={{ background: highlighted ? `${color}1a` : "transparent" }}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={visible}
          onChange={onToggleVisible}
          aria-label={`Toggle route ${route.label ?? route.id}`}
          className="mt-1.5 flex-shrink-0"
        />
        <span
          className="inline-block w-3 h-3 rounded-full mt-2 flex-shrink-0"
          style={{ background: color }}
          aria-hidden
        />
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={onToggleHighlight}
            className="text-left w-full"
            title="Highlight this route — numbered stops + segment colors"
          >
            <div className="serif text-base leading-tight truncate">
              {route.label ?? `${route.mode === "auto" ? "Auto" : "Drawn"} route`}
            </div>
            <div className="label mt-1 truncate">
              {route.mode.toUpperCase()} · {route.stop_count} stops ·{" "}
              {new Date(route.created_at).toLocaleString()}
              {hasNote && !editing ? " · note" : ""}
            </div>
          </button>
        </div>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="label px-2 py-1 border hairline hover:bg-black/5 flex-shrink-0"
          title="Edit label and notes"
        >
          {editing ? "Close" : "Edit"}
        </button>
        <Link
          href={`/saved/${route.id}`}
          className="label px-2 py-1 border hairline hover:bg-black/5 flex-shrink-0"
          title="Open this route on its own page"
        >
          Open
        </Link>
      </div>

      {!editing && hasNote && (
        <div className="ml-6 text-sm text-[var(--ink)] whitespace-pre-wrap border-l-2 pl-3"
          style={{ borderColor: color }}>
          {route.notes}
        </div>
      )}

      {editing && (
        <div className="ml-6 flex flex-col gap-2">
          <input
            type="text"
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            placeholder="Label (e.g. 'auto v1', 'loop')"
            className="text-sm border hairline rounded px-2 py-1.5 bg-white"
          />
          <textarea
            value={draftNotes}
            onChange={(e) => setDraftNotes(e.target.value)}
            placeholder="Notes about this route…"
            rows={3}
            className="text-sm border hairline rounded px-2 py-1.5 bg-white resize-y min-h-[60px]"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="label px-3 py-1.5 border-2 border-[var(--ink)] hover:bg-[var(--ink)] hover:text-paper disabled:opacity-40"
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftLabel(route.label ?? "");
                setDraftNotes(route.notes ?? "");
                setEditing(false);
              }}
              className="label px-3 py-1.5 border hairline hover:bg-black/5"
            >
              Cancel
            </button>
            {saveMutation.error instanceof Error && (
              <span className="label text-[var(--accent)] truncate">
                {saveMutation.error.message}
              </span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
