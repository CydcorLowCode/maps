"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import type { LassoRouteResponse, OpportunityPin } from "@/lib/types";
import { pointInPolygon, type LatLng } from "@/lib/geometry";
import { useRightClickPan } from "@/lib/useRightClickPan";

const STROKE_COLOR = "#0ea5e9";

export type LassoRoutePhase = "lasso" | "configure" | "result";

type Props = {
  pins: OpportunityPin[];
  map: L.Map | null;
  mapContainer: HTMLDivElement | null;
  phase: LassoRoutePhase;
  selectedIds: string[];
  startPinId: string | null;
  endPinId: string | null;
  roundTrip: boolean;
  result: LassoRouteResponse | null;
  isBuilding: boolean;
  errorMessage: string | null;
  onLassoComplete: (pinIds: string[]) => void;
  onSetStart: (pinId: string | null) => void;
  onSetEnd: (pinId: string | null) => void;
  onSetRoundTrip: (round: boolean) => void;
  onBuild: () => void;
  onReset: () => void;
  onCancel: () => void;
};

export default function LassoRouteMode({
  pins,
  map,
  mapContainer,
  phase,
  selectedIds,
  startPinId,
  endPinId,
  roundTrip,
  result,
  isBuilding,
  errorMessage,
  onLassoComplete,
  onSetStart,
  onSetEnd,
  onSetRoundTrip,
  onBuild,
  onReset,
  onCancel,
}: Props) {
  const trailPointsRef = useRef<L.LatLng[]>([]);
  const trailLineRef = useRef<L.Polyline | null>(null);
  const polygonRef = useRef<L.Polygon | null>(null);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  // Disable map drag/zoom while lassoing; right-click drag still pans.
  useEffect(() => {
    if (!map || phase !== "lasso") return;
    map.dragging.disable();
    map.touchZoom.disable();
    map.doubleClickZoom.disable();
    return () => {
      map.dragging.enable();
      map.touchZoom.enable();
      map.doubleClickZoom.enable();
    };
  }, [map, phase]);

  useRightClickPan(phase === "lasso" ? map : null, phase === "lasso" ? mapContainer : null);

  // Esc cancels at any phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Pointer handlers — only active during lasso phase.
  useEffect(() => {
    if (phase !== "lasso") return;
    const el = mapContainer;
    if (!map || !el) return;

    const cleanupTrail = () => {
      trailPointsRef.current = [];
      if (trailLineRef.current) {
        trailLineRef.current.remove();
        trailLineRef.current = null;
      }
      if (polygonRef.current) {
        polygonRef.current.remove();
        polygonRef.current = null;
      }
    };

    const getCoords = (clientX: number, clientY: number) => {
      const rect = el.getBoundingClientRect();
      return { px: clientX - rect.left, py: clientY - rect.top };
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();
      const { px, py } = getCoords(e.clientX, e.clientY);
      cleanupTrail();
      trailPointsRef.current = [map.containerPointToLatLng([px, py])];
      const initial = trailPointsRef.current[0];
      trailLineRef.current = L.polyline([initial], {
        color: STROKE_COLOR,
        weight: 3,
        opacity: 0.95,
      }).addTo(map);
      polygonRef.current = L.polygon([initial], {
        color: STROKE_COLOR,
        weight: 2,
        opacity: 0.85,
        fillColor: STROKE_COLOR,
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(map);
    };

    const onMove = (e: PointerEvent) => {
      if (trailPointsRef.current.length === 0) return;
      e.preventDefault();
      const { px, py } = getCoords(e.clientX, e.clientY);
      const latLng = map.containerPointToLatLng([px, py]);
      const last = trailPointsRef.current[trailPointsRef.current.length - 1];
      if (last && last.distanceTo(latLng) < 1) return;
      trailPointsRef.current.push(latLng);
      trailLineRef.current?.setLatLngs(trailPointsRef.current);
      polygonRef.current?.setLatLngs(trailPointsRef.current);
    };

    const finishStroke = () => {
      const trail = trailPointsRef.current;
      if (trail.length < 2) {
        cleanupTrail();
        return;
      }
      const path: LatLng[] = trail.map((p) => [p.lat, p.lng]);
      if (
        path.length >= 3 &&
        (path[0][0] !== path[path.length - 1][0] ||
          path[0][1] !== path[path.length - 1][1])
      ) {
        path.push([path[0][0], path[0][1]]);
      }
      const inside: string[] = [];
      for (const pin of pinsRef.current) {
        if (pointInPolygon([pin.lat, pin.lng], path)) inside.push(pin.id);
      }
      cleanupTrail();
      onLassoComplete(inside);
    };

    const onUp = (e: PointerEvent) => {
      if (trailPointsRef.current.length === 0) return;
      e.preventDefault();
      finishStroke();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    const prevTouchAction = el.style.touchAction;
    el.style.touchAction = "none";
    const prevCursor = el.style.cursor;
    el.style.cursor = "crosshair";

    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      el.style.touchAction = prevTouchAction;
      el.style.cursor = prevCursor;
      cleanupTrail();
    };
  }, [phase, map, mapContainer, onLassoComplete]);

  const selectedPins = useMemo(() => {
    const set = new Set(selectedIds);
    return pins.filter((p) => set.has(p.id));
  }, [pins, selectedIds]);

  if (phase === "lasso") {
    return (
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[500] flex items-center gap-3 bg-paper border hairline px-4 py-3 shadow-lg">
        <span
          className="inline-block w-3 h-3 rounded-full flex-shrink-0"
          style={{ background: STROKE_COLOR }}
          aria-hidden
        />
        <div className="text-sm">
          <div className="serif">Walk Route — lasso the stops</div>
          <div className="label">
            Drag a loop around the opportunities you want to walk — release to continue
          </div>
          <div className="label opacity-70 hidden md:block mt-0.5">
            right-click drag to pan · esc to cancel
          </div>
        </div>
        <button onClick={onCancel} className="label px-3 py-1.5 hover:bg-black/5">
          Cancel
        </button>
      </div>
    );
  }

  if (phase === "configure") {
    return (
      <ConfigurePanel
        selectedPins={selectedPins}
        startPinId={startPinId}
        endPinId={endPinId}
        roundTrip={roundTrip}
        isBuilding={isBuilding}
        errorMessage={errorMessage}
        onSetStart={onSetStart}
        onSetEnd={onSetEnd}
        onSetRoundTrip={onSetRoundTrip}
        onBuild={onBuild}
        onReset={onReset}
        onCancel={onCancel}
      />
    );
  }

  // result phase
  return (
    <ResultPanel
      result={result}
      selectedPins={selectedPins}
      onReset={onReset}
      onCancel={onCancel}
    />
  );
}

function ConfigurePanel({
  selectedPins,
  startPinId,
  endPinId,
  roundTrip,
  isBuilding,
  errorMessage,
  onSetStart,
  onSetEnd,
  onSetRoundTrip,
  onBuild,
  onReset,
  onCancel,
}: {
  selectedPins: OpportunityPin[];
  startPinId: string | null;
  endPinId: string | null;
  roundTrip: boolean;
  isBuilding: boolean;
  errorMessage: string | null;
  onSetStart: (pinId: string | null) => void;
  onSetEnd: (pinId: string | null) => void;
  onSetRoundTrip: (round: boolean) => void;
  onBuild: () => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const canBuild = selectedPins.length >= 1 && startPinId !== null && (roundTrip || endPinId !== null);

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[500] bg-paper border hairline px-4 py-3 shadow-lg w-[min(560px,calc(100vw-2rem))]">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="serif text-base">Walk Route — pick start &amp; end</div>
          <div className="label">{selectedPins.length} stop{selectedPins.length === 1 ? "" : "s"} selected</div>
        </div>
        <button onClick={onReset} className="label px-2 py-1 hover:bg-black/5">
          Re-lasso
        </button>
      </div>

      {selectedPins.length === 0 ? (
        <div className="text-sm">No pins fell inside the lasso.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="label">Start</span>
            <select
              value={startPinId ?? ""}
              onChange={(e) => onSetStart(e.target.value || null)}
              className="text-sm border hairline rounded px-2 py-1.5 bg-white"
            >
              <option value="">— pick a starting pin —</option>
              {selectedPins.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.street}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label flex items-center justify-between">
              End
              <span className="flex items-center gap-1 normal-case tracking-normal">
                <input
                  type="checkbox"
                  checked={roundTrip}
                  onChange={(e) => onSetRoundTrip(e.target.checked)}
                />
                <span>round trip</span>
              </span>
            </span>
            <select
              value={roundTrip ? "" : endPinId ?? ""}
              disabled={roundTrip}
              onChange={(e) => onSetEnd(e.target.value || null)}
              className="text-sm border hairline rounded px-2 py-1.5 bg-white disabled:opacity-50"
            >
              <option value="">— pick an ending pin —</option>
              {selectedPins.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.street}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {errorMessage && (
        <div className="mt-3 text-sm text-[var(--accent)]">{errorMessage}</div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button onClick={onCancel} className="label px-3 py-1.5 hover:bg-black/5">
          Cancel
        </button>
        <button
          onClick={onBuild}
          disabled={!canBuild || isBuilding}
          className="label px-4 py-1.5 border-2 border-[var(--ink)] hover:bg-[var(--ink)] hover:text-paper disabled:opacity-40"
        >
          {isBuilding ? "Building…" : "Build walking route"}
        </button>
      </div>
    </div>
  );
}

function ResultPanel({
  result,
  selectedPins,
  onReset,
  onCancel,
}: {
  result: LassoRouteResponse | null;
  selectedPins: OpportunityPin[];
  onReset: () => void;
  onCancel: () => void;
}) {
  const pinById = useMemo(() => new Map(selectedPins.map((p) => [p.id, p])), [selectedPins]);

  const [open, setOpen] = useState(true);
  const onCopy = useCallback(() => {
    if (!result) return;
    const ordered = result.stops
      .filter((s) => s.kind === "opportunity" && s.opportunity_id)
      .map((s, i) => {
        const pin = pinById.get(s.opportunity_id ?? "");
        return `${i + 1}. ${pin?.street ?? s.label ?? s.opportunity_id}`;
      })
      .join("\n");
    navigator.clipboard?.writeText(ordered).catch(() => {});
  }, [result, pinById]);

  if (!result) return null;

  const miles = (result.total_distance_m / 1609.34).toFixed(2);
  const minutes = Math.round(result.total_duration_s / 60);

  return (
    <div className="absolute top-4 left-4 z-[500] bg-paper border hairline shadow-lg w-[min(360px,calc(100vw-2rem))]">
      <div className="px-4 py-3 flex items-center justify-between border-b hairline">
        <div>
          <div className="serif text-base">Walk Route</div>
          <div className="label">
            {miles} mi · {minutes} min · {result.stops.filter((s) => s.kind === "opportunity").length} stops
          </div>
        </div>
        <button onClick={() => setOpen((v) => !v)} className="label px-2 py-1 hover:bg-black/5">
          {open ? "▾" : "▸"}
        </button>
      </div>
      {open && (
        <div className="max-h-[50vh] overflow-y-auto">
          <ol className="px-4 py-2 text-sm">
            {result.stops.map((s, i) => {
              const isOpp = s.kind === "opportunity";
              const pin = isOpp && s.opportunity_id ? pinById.get(s.opportunity_id) : undefined;
              const label =
                s.kind === "start"
                  ? "Start"
                  : s.kind === "end"
                    ? "End"
                    : pin?.street ?? s.label ?? s.opportunity_id;
              return (
                <li
                  key={`${s.kind}-${i}-${s.opportunity_id ?? ""}`}
                  className="flex items-baseline gap-3 py-1"
                >
                  <span
                    className="inline-flex w-6 h-6 rounded-full flex-shrink-0 text-[11px] font-mono font-semibold items-center justify-center border"
                    style={{
                      background:
                        s.kind === "opportunity" ? STROKE_COLOR : s.kind === "start" ? STROKE_COLOR : "#fff",
                      color: s.kind === "end" ? STROKE_COLOR : "#fff",
                      borderColor: STROKE_COLOR,
                    }}
                  >
                    {s.kind === "start" ? "A" : s.kind === "end" ? "B" : s.stop_number}
                  </span>
                  <span className="flex-1 truncate">{label}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <div className="px-4 py-2 border-t hairline flex items-center justify-end gap-1">
        <button onClick={onCopy} className="label px-2 py-1 hover:bg-black/5">
          Copy order
        </button>
        <button onClick={onReset} className="label px-2 py-1 hover:bg-black/5">
          Re-lasso
        </button>
        <button onClick={onCancel} className="label px-2 py-1 hover:bg-black/5">
          Close
        </button>
      </div>
    </div>
  );
}
