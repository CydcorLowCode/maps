"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AutoRouteResponse,
  OpportunityPin,
  RoutePayload,
  RouteSegment,
  RouteStop,
} from "@/lib/types";
import { isSubsegmentId, parentIdOf, type SegmentDirection } from "@/lib/routeEdits";

export type ZoneSummary = {
  id: string;
  label: string;
  color: string;
  leadCount: number;
};

export type GeocodeProviderId = "google" | "ors";

export type GeocodeControls = {
  provider: GeocodeProviderId;
  onProviderChange: (p: GeocodeProviderId) => void;
  providersAvailable: { google: boolean; ors: boolean };
  onGeocodeZone: (zoneId: string) => void;
  onClearGeocoded: () => void;
  zonesWithResults: Set<string>;
  pendingZoneId: string | null;
  errorMessage?: string | null;
  resultsSummary?: { ok: number; noMatch: number; error: number } | null;
  // Snapshot mode only — accept persists corrected coords back to the
  // snapshot so pins move on the map; reject just clears the overlay.
  onAcceptZone?: (zoneId: string) => void;
  onRejectZone?: (zoneId: string) => void;
  acceptingZoneId?: string | null;
};

type Props = {
  pins: OpportunityPin[];
  autoRoute: AutoRouteResponse | null;
  drawnOrder: string[] | null;
  startingId: string | null;
  zones?: ZoneSummary[];
  activeZoneId?: string | null;
  onSplitZone?: (zoneId: string) => void;
  onResetZone?: (zoneId: string) => void;
  onResetAllZones?: () => void;
  onLassoIntoZone?: (zoneId: string) => void;
  onCutZone?: (zoneId: string) => void;
  zoneNotes?: Record<string, string>;
  onZoneNoteChange?: (zoneId: string, note: string) => void;
  onMoveSegment?: (route: RoutePayload, segmentId: string, delta: -1 | 1) => void;
  onSetSegmentDirection?: (segmentId: string, direction: SegmentDirection) => void;
  onSplitSegment?: (segmentId: string, localAfterPosition: number) => void;
  onSuggestSplit?: (segmentId: string) => void;
  onResetSplits?: (segmentId: string) => void;
  splitParents?: Set<string>;
  geocode?: GeocodeControls;
  buildControls?: BuildControls;
};

export type BuildControls = {
  onBuildZone: (zoneId: string) => void;
  onDrawZone: (zoneId: string) => void;
  buildingZoneId: string | null;
  drawingZoneId: string | null;
};

function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const φ1 = (a[0] * Math.PI) / 180;
  const φ2 = (b[0] * Math.PI) / 180;
  const Δφ = ((b[0] - a[0]) * Math.PI) / 180;
  const Δλ = ((b[1] - a[1]) * Math.PI) / 180;
  const x = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function totalDistanceMeters(coords: [number, number][]): number {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
  return d;
}

function textColorFor(hex: string): string {
  const c = String(hex || "").replace("#", "");
  if (c.length !== 6) return "#111";
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return "#111";
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "#111" : "#fff";
}

export default function RouteSidebar({
  pins,
  autoRoute,
  drawnOrder,
  startingId,
  zones,
  activeZoneId,
  onSplitZone,
  onResetZone,
  onResetAllZones,
  onLassoIntoZone,
  onCutZone,
  zoneNotes,
  onZoneNoteChange,
  onMoveSegment,
  onSetSegmentDirection,
  onSplitSegment,
  onSuggestSplit,
  onResetSplits,
  splitParents,
  geocode,
  buildControls,
}: Props) {
  const totalPins = pins.length;
  const hasOutput = Boolean(autoRoute && autoRoute.routes.length) || Boolean(drawnOrder && drawnOrder.length);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [allExpanded, setAllExpanded] = useState(false);

  const isExpanded = (id: string) => expanded[id] ?? allExpanded;

  const toggleSegment = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !(prev[id] ?? allExpanded) }));

  const expandAll = () => {
    setAllExpanded(true);
    setExpanded({});
  };
  const collapseAll = () => {
    setAllExpanded(false);
    setExpanded({});
  };

  return (
    <aside className="flex flex-col h-full overflow-hidden bg-paper border-l hairline">
      <div className="px-6 py-5 border-b hairline">
        <div className="label">Route</div>
        {!hasOutput ? (
          <p className="serif text-xl mt-2">
            {startingId
              ? "Start point picked. Build a route or draw one by hand."
              : "Tap a pin to set the starting point."}
          </p>
        ) : (
          <Stats pins={pins} autoRoute={autoRoute} drawnOrder={drawnOrder} />
        )}
      </div>

      {zones && zones.length > 0 && (
        <div className="border-b hairline">
          <div className="px-6 py-2 flex items-center justify-between">
            <div className="label">Zones</div>
            {onResetAllZones && (
              <button
                type="button"
                onClick={onResetAllZones}
                className="label px-2 py-1 border hairline hover:bg-black/5"
              >
                Reset all
              </button>
            )}
          </div>
          {geocode && (
            <div className="px-6 pb-2 flex items-center gap-2 flex-wrap">
              <span className="label">Geocode</span>
              <div className="flex border hairline rounded overflow-hidden">
                {(["google", "ors"] as const).map((p) => {
                  const enabled = geocode.providersAvailable[p];
                  const active = geocode.provider === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      disabled={!enabled}
                      onClick={() => geocode.onProviderChange(p)}
                      title={
                        enabled
                          ? p === "google"
                            ? "Google Geocoding API"
                            : "OpenRouteService (Pelias)"
                          : `${p.toUpperCase()} key not configured on backend`
                      }
                      className={`label px-2 py-1 ${
                        active ? "bg-[var(--ink)] text-paper" : "hover:bg-black/5"
                      } disabled:opacity-30 disabled:cursor-not-allowed`}
                    >
                      {p === "google" ? "Google" : "ORS"}
                    </button>
                  );
                })}
              </div>
              {geocode.zonesWithResults.size > 0 && (
                <button
                  type="button"
                  onClick={geocode.onClearGeocoded}
                  className="label px-2 py-1 border hairline hover:bg-black/5"
                >
                  Clear
                </button>
              )}
              {geocode.resultsSummary && (
                <span className="label" title="Last geocode batch">
                  {geocode.resultsSummary.ok} ok
                  {geocode.resultsSummary.noMatch
                    ? ` · ${geocode.resultsSummary.noMatch} no match`
                    : ""}
                  {geocode.resultsSummary.error
                    ? ` · ${geocode.resultsSummary.error} error`
                    : ""}
                </span>
              )}
              {geocode.errorMessage && (
                <span className="label text-[var(--accent)]" title={geocode.errorMessage}>
                  {geocode.errorMessage.length > 40
                    ? geocode.errorMessage.slice(0, 40) + "…"
                    : geocode.errorMessage}
                </span>
              )}
            </div>
          )}
          <ul className="px-3 pb-3 flex flex-col gap-2">
            {zones.map((z) => {
              const isActive = z.id === activeZoneId;
              return (
                <ZoneCard
                  key={z.id}
                  zone={z}
                  active={isActive}
                  note={zoneNotes?.[z.id] ?? ""}
                  onNoteChange={onZoneNoteChange}
                  onLasso={onLassoIntoZone}
                  onCut={onCutZone}
                  onAutoSplit={onSplitZone}
                  onReset={onResetZone}
                  geocode={geocode}
                  buildControls={buildControls}
                />
              );
            })}
          </ul>
        </div>
      )}

      {autoRoute && autoRoute.routes.length > 0 && (
        <div className="px-6 py-2 border-b hairline flex items-center justify-between">
          <div className="label">Segments</div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={expandAll}
              className="label px-2 py-1 border hairline hover:bg-black/5"
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={collapseAll}
              className="label px-2 py-1 border hairline hover:bg-black/5"
            >
              Collapse all
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {autoRoute &&
          autoRoute.routes.map((route) => (
            <RouteBlock
              key={route.route_number}
              route={route}
              isExpanded={isExpanded}
              toggleSegment={toggleSegment}
              onMoveSegment={onMoveSegment}
              onSetSegmentDirection={onSetSegmentDirection}
              onSplitSegment={onSplitSegment}
              onSuggestSplit={onSuggestSplit}
              onResetSplits={onResetSplits}
              splitParents={splitParents}
            />
          ))}

        {drawnOrder && drawnOrder.length > 0 && (
          <div className="border-b hairline">
            <div className="px-6 py-3 flex items-baseline justify-between bg-black/[0.02]">
              <div className="serif text-lg">Drawn route</div>
              <div className="label">{drawnOrder.length} stops</div>
            </div>
            <ol className="px-6 py-2">
              {drawnOrder.map((id, i) => {
                const pin = pins.find((p) => p.id === id);
                return (
                  <li key={id} className="flex items-baseline gap-3 py-1.5 text-sm">
                    <span className="inline-block w-6 text-right tabular-nums label">{i + 1}</span>
                    <span className="flex-1 truncate">{pin?.street ?? id}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>

      <div className="border-t hairline px-6 py-4 label">
        {totalPins} opportunit{totalPins === 1 ? "y" : "ies"} loaded
      </div>
    </aside>
  );
}

function RouteBlock({
  route,
  isExpanded,
  toggleSegment,
  onMoveSegment,
  onSetSegmentDirection,
  onSplitSegment,
  onSuggestSplit,
  onResetSplits,
  splitParents,
}: {
  route: RoutePayload;
  isExpanded: (id: string) => boolean;
  toggleSegment: (id: string) => void;
  onMoveSegment?: (route: RoutePayload, segmentId: string, delta: -1 | 1) => void;
  onSetSegmentDirection?: (segmentId: string, direction: SegmentDirection) => void;
  onSplitSegment?: (segmentId: string, localAfterPosition: number) => void;
  onSuggestSplit?: (segmentId: string) => void;
  onResetSplits?: (segmentId: string) => void;
  splitParents?: Set<string>;
}) {
  const stopsBySegment = useMemo(() => {
    const map = new Map<string, RouteStop[]>();
    for (const stop of route.stops) {
      let bucket = map.get(stop.segment_id);
      if (!bucket) {
        bucket = [];
        map.set(stop.segment_id, bucket);
      }
      bucket.push(stop);
    }
    return map;
  }, [route.stops]);

  const lastIdx = route.segments.length - 1;

  return (
    <div className="border-b hairline">
      <div className="px-6 py-3 flex items-baseline justify-between bg-black/[0.02]">
        <div className="serif text-lg">Route {route.route_number}</div>
        <div className="label">
          {route.segments.length} segments · {route.stops.length} stops
        </div>
      </div>
      <div className="px-3 py-2 flex flex-col gap-2">
        {route.segments.map((segment, idx) => {
          const parentHasSplits = Boolean(splitParents?.has(parentIdOf(segment.segment_id)));
          return (
            <SegmentCard
              key={segment.segment_id}
              segment={segment}
              stops={stopsBySegment.get(segment.segment_id) ?? []}
              expanded={isExpanded(segment.segment_id)}
              canMoveUp={idx > 0}
              canMoveDown={idx < lastIdx}
              parentHasSplits={parentHasSplits}
              onToggle={() => toggleSegment(segment.segment_id)}
              onMoveUp={() => onMoveSegment?.(route, segment.segment_id, -1)}
              onMoveDown={() => onMoveSegment?.(route, segment.segment_id, 1)}
              onDirectionChange={(d) => onSetSegmentDirection?.(segment.segment_id, d)}
              onSplitAfter={
                onSplitSegment
                  ? (localAfter) => onSplitSegment(segment.segment_id, localAfter)
                  : undefined
              }
              onSuggestSplit={
                onSuggestSplit ? () => onSuggestSplit(segment.segment_id) : undefined
              }
              onResetSplits={
                onResetSplits && parentHasSplits
                  ? () => onResetSplits(segment.segment_id)
                  : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function SegmentCard({
  segment,
  stops,
  expanded,
  canMoveUp,
  canMoveDown,
  parentHasSplits,
  onToggle,
  onMoveUp,
  onMoveDown,
  onDirectionChange,
  onSplitAfter,
  onSuggestSplit,
  onResetSplits,
}: {
  segment: RouteSegment;
  stops: RouteStop[];
  expanded: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  parentHasSplits: boolean;
  onToggle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDirectionChange: (d: SegmentDirection) => void;
  onSplitAfter?: (localAfterPosition: number) => void;
  onSuggestSplit?: () => void;
  onResetSplits?: () => void;
}) {
  const color = segment.color || "#999";
  const fg = textColorFor(color);
  const isSub = isSubsegmentId(segment.segment_id);

  return (
    <div
      className="rounded-md border hairline overflow-hidden"
      style={{ borderColor: color }}
    >
      <div
        className="px-3 py-2 flex items-center gap-2"
        style={{ background: color, color: fg }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse segment" : "Expand segment"}
          className="w-5 text-left tabular-nums font-mono text-sm"
        >
          {expanded ? "▾" : "▸"}
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 text-left"
        >
          <div className="text-sm font-semibold leading-tight">
            Stops {segment.stop_range}: {segment.street_display || "—"}
          </div>
          <div className="text-xs opacity-90 leading-tight">
            Block {segment.block_label || "—"} · {segment.side_label || "—"} side · {segment.stop_count} stops
          </div>
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            aria-label="Move segment up"
            className="w-6 h-6 leading-none border border-black/20 rounded disabled:opacity-30"
            style={{ background: "rgba(255,255,255,0.85)", color: "#111" }}
          >
            ↑
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            aria-label="Move segment down"
            className="w-6 h-6 leading-none border border-black/20 rounded disabled:opacity-30"
            style={{ background: "rgba(255,255,255,0.85)", color: "#111" }}
          >
            ↓
          </button>
        </div>
      </div>

      <div className="px-3 py-2 flex items-center gap-2 flex-wrap bg-paper">
        <label className="label" htmlFor={`dir-${segment.segment_id}`}>
          Direction
        </label>
        <select
          id={`dir-${segment.segment_id}`}
          value={segment.direction === "reverse" ? "reverse" : "forward"}
          onChange={(e) => onDirectionChange(e.target.value as SegmentDirection)}
          className="text-sm border hairline rounded px-2 py-1 bg-white"
        >
          <option value="forward">Forward</option>
          <option value="reverse">Reverse</option>
        </select>
        {onSuggestSplit && stops.length >= 3 && (
          <button
            type="button"
            onClick={onSuggestSplit}
            title="Split at the largest geographic gap (proxy for a major-road crossing)"
            className="label px-2 py-1 border hairline hover:bg-black/5"
          >
            Suggest split
          </button>
        )}
        {onResetSplits && (parentHasSplits || isSub) && (
          <button
            type="button"
            onClick={onResetSplits}
            className="label px-2 py-1 border hairline hover:bg-black/5"
          >
            Reset splits
          </button>
        )}
      </div>

      {expanded && stops.length > 0 && (
        <ol className="px-3 py-2 bg-white border-t hairline">
          {stops.map((stop, i) => (
            <li key={stop.stop_number}>
              <div className="flex items-baseline gap-3 py-1 text-sm">
                <span
                  className="inline-flex w-6 h-6 rounded-full flex-shrink-0 text-white text-[11px] font-mono font-semibold items-center justify-center"
                  style={{ background: stop.segment_color }}
                >
                  {stop.stop_number}
                </span>
                <span className="flex-1 truncate">{stop.street}</span>
              </div>
              {onSplitAfter && i < stops.length - 1 && (
                <div className="pl-9 -my-0.5">
                  <button
                    type="button"
                    onClick={() => onSplitAfter(i + 1)}
                    title="Split this segment here"
                    className="text-[10px] uppercase tracking-wider text-black/45 hover:text-black/85 px-2 py-0.5 border-t border-dashed border-black/15 w-full text-left"
                  >
                    ✂ split here
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Stats({
  pins,
  autoRoute,
  drawnOrder,
}: {
  pins: OpportunityPin[];
  autoRoute: AutoRouteResponse | null;
  drawnOrder: string[] | null;
}) {
  let stopCount = 0;
  let routeCount = 0;
  let coords: [number, number][] = [];
  if (autoRoute) {
    routeCount = autoRoute.routes.length;
    for (const route of autoRoute.routes) {
      stopCount += route.stops.length;
      coords.push(...(route.stops.map((s) => [s.lat, s.lng]) as [number, number][]));
    }
  } else if (drawnOrder) {
    routeCount = 1;
    stopCount = drawnOrder.length;
    const byId = new Map(pins.map((p) => [p.id, p]));
    coords = drawnOrder
      .map((id) => byId.get(id))
      .filter((p): p is OpportunityPin => Boolean(p))
      .map((p) => [p.lat, p.lng]);
  }
  const meters = totalDistanceMeters(coords);
  const miles = (meters / 1609.34).toFixed(2);

  return (
    <div className="mt-3 grid grid-cols-3 gap-4">
      <Stat label="Stops" value={`${stopCount}`} />
      <Stat label="Routes" value={`${routeCount}`} />
      <Stat label="Distance" value={`${miles} mi`} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="serif text-2xl tabular-nums">{value}</div>
    </div>
  );
}

function ZoneCard({
  zone,
  active,
  note,
  onNoteChange,
  onLasso,
  onCut,
  onAutoSplit,
  onReset,
  geocode,
  buildControls,
}: {
  zone: ZoneSummary;
  active: boolean;
  note: string;
  onNoteChange?: (zoneId: string, note: string) => void;
  onLasso?: (zoneId: string) => void;
  onCut?: (zoneId: string) => void;
  onAutoSplit?: (zoneId: string) => void;
  onReset?: (zoneId: string) => void;
  geocode?: GeocodeControls;
  buildControls?: BuildControls;
}) {
  // Auto-expand when there's something the user is likely to act on:
  // pending geocode results, an active zone, or an existing note.
  const hasGeocodeResults =
    geocode?.zonesWithResults.has(zone.id) ?? false;
  const [expanded, setExpanded] = useState(active || hasGeocodeResults || Boolean(note));
  const [draftNote, setDraftNote] = useState(note);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  // Adopt the canonical note from the server (e.g. after refetch) without
  // clobbering the user's in-progress edit when the textarea has focus.
  useEffect(() => {
    if (noteRef.current && document.activeElement === noteRef.current) return;
    setDraftNote(note);
  }, [note]);

  const isSplit = zone.id.includes("/");
  const hasResults = geocode?.zonesWithResults.has(zone.id) ?? false;
  const showAccept = hasResults && Boolean(geocode?.onAcceptZone);
  const showReject = hasResults && Boolean(geocode?.onRejectZone);
  const geocodeBusy =
    (geocode?.pendingZoneId ?? null) !== null ||
    (geocode?.acceptingZoneId ?? null) !== null;

  return (
    <li
      className="rounded border overflow-hidden"
      style={{
        borderColor: active ? zone.color : "rgba(0,0,0,0.12)",
        background: active ? `${zone.color}10` : "var(--paper)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        <span
          className="inline-block w-3 h-3 rounded-full flex-shrink-0"
          style={{ background: zone.color }}
          aria-hidden
        />
        <span className="text-sm flex-1 truncate">
          {zone.label}
          {active && <span className="label ml-2">active</span>}
          {note && !expanded && (
            <span className="label ml-2 opacity-70">· note</span>
          )}
        </span>
        {hasResults && !expanded && (
          <span
            className="label px-1.5 py-0.5 rounded"
            style={{
              background: `${zone.color}22`,
              color: zone.color,
            }}
          >
            geocoded
          </span>
        )}
        <span className="label tabular-nums w-5 text-right">
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-2 border-t hairline">
          {onNoteChange && (
            <textarea
              ref={noteRef}
              value={draftNote}
              onChange={(e) => {
                setDraftNote(e.target.value);
                onNoteChange(zone.id, e.target.value);
              }}
              placeholder="Notes for this zone…"
              rows={2}
              className="mt-2 w-full text-sm border hairline rounded px-2 py-1.5 bg-white resize-y min-h-[40px]"
            />
          )}

          {buildControls && zone.leadCount > 0 && (
            <div className="flex flex-wrap gap-1 items-center">
              <span className="label mr-1">Route</span>
              <button
                type="button"
                onClick={() => buildControls.onBuildZone(zone.id)}
                disabled={
                  buildControls.buildingZoneId !== null ||
                  buildControls.drawingZoneId !== null
                }
                title={`Auto-build a route through ${zone.label}`}
                className="label px-3 py-1.5 bg-[var(--accent)] text-white hover:bg-[var(--accent-dark)] disabled:opacity-40"
              >
                {buildControls.buildingZoneId === zone.id ? "Building…" : "Build"}
              </button>
              <button
                type="button"
                onClick={() => buildControls.onDrawZone(zone.id)}
                disabled={
                  buildControls.buildingZoneId !== null ||
                  buildControls.drawingZoneId !== null
                }
                title="Draw a route by hand — trace through pins in this zone"
                className="label px-3 py-1.5 border-2 border-[var(--ink)] hover:bg-[var(--ink)] hover:text-paper disabled:opacity-40"
              >
                Draw
              </button>
            </div>
          )}

          {(onLasso || onCut || onAutoSplit || onReset) && (
            <div className="flex flex-wrap gap-1">
              <span className="label self-center mr-1">Edit</span>
              {onLasso && (
                <button
                  type="button"
                  onClick={() => onLasso(zone.id)}
                  title="Lasso pins on the map to add them to this zone"
                  className="label px-2 py-1 border hairline hover:bg-black/5"
                >
                  Lasso
                </button>
              )}
              {onCut && zone.leadCount >= 2 && (
                <button
                  type="button"
                  onClick={() => onCut(zone.id)}
                  title="Draw a line through this zone to split it manually"
                  className="label px-2 py-1 border hairline hover:bg-black/5"
                >
                  Cut
                </button>
              )}
              {onAutoSplit && zone.leadCount >= 4 && (
                <button
                  type="button"
                  onClick={() => onAutoSplit(zone.id)}
                  title="Auto-split this zone in two using the most-distant pins as seeds"
                  className="label px-2 py-1 border hairline hover:bg-black/5"
                >
                  Auto-split
                </button>
              )}
              {onReset && isSplit && (
                <button
                  type="button"
                  onClick={() => onReset(zone.id.split("/")[0])}
                  title="Undo splits on this zone"
                  className="label px-2 py-1 border hairline hover:bg-black/5"
                >
                  Reset
                </button>
              )}
            </div>
          )}

          {geocode && (
            <div className="flex flex-wrap gap-1">
              <span className="label self-center mr-1">Geocode</span>
              <button
                type="button"
                onClick={() => geocode.onGeocodeZone(zone.id)}
                disabled={
                  geocodeBusy ||
                  !geocode.providersAvailable[geocode.provider]
                }
                title={
                  geocode.providersAvailable[geocode.provider]
                    ? `Geocode ${zone.leadCount} addresses with ${
                        geocode.provider === "google" ? "Google" : "ORS"
                      }`
                    : `${geocode.provider.toUpperCase()} key not configured on backend`
                }
                className="label px-2 py-1 border hairline hover:bg-black/5 disabled:opacity-40"
              >
                {geocode.pendingZoneId === zone.id
                  ? "…"
                  : hasResults
                    ? "Re-geocode"
                    : "Geocode"}
              </button>
              {showAccept && (
                <button
                  type="button"
                  onClick={() => geocode.onAcceptZone?.(zone.id)}
                  disabled={geocodeBusy}
                  title="Accept geocoded coords — pins will move and the snapshot is updated"
                  className="label px-2 py-1 border hairline hover:bg-black/5 disabled:opacity-40"
                  style={{ borderColor: "#1c7c4a", color: "#1c7c4a" }}
                >
                  {geocode.acceptingZoneId === zone.id ? "…" : "Accept"}
                </button>
              )}
              {showReject && (
                <button
                  type="button"
                  onClick={() => geocode.onRejectZone?.(zone.id)}
                  disabled={geocodeBusy}
                  title="Discard the geocoded result for this zone"
                  className="label px-2 py-1 border hairline hover:bg-black/5 disabled:opacity-40"
                  style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
                >
                  Reject
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
