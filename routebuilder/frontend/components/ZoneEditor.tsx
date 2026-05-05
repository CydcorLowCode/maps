"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import type { OpportunityPin } from "@/lib/types";
import {
  classifyByPolyline,
  pointInPolygon,
  type LatLng,
} from "@/lib/geometry";
import { useRightClickPan } from "@/lib/useRightClickPan";

export type ZoneEditorMode = "lasso" | "splitline";

type Props = {
  mode: ZoneEditorMode;
  targetZoneLabel: string;
  targetZoneColor: string;
  /**
   * Pins eligible for the operation:
   *  - lasso mode: every pin (a lasso may pull pins from neighbouring zones)
   *  - splitline mode: only the target zone's pins
   */
  candidatePins: OpportunityPin[];
  map: L.Map | null;
  mapContainer: HTMLDivElement | null;
  /**
   * Called once the user releases the pointer.
   *  - lasso: pinIds inside the closed polygon → assign to the target zone
   *  - splitline: { aIds, bIds } classified by side of the polyline
   */
  onCompleteLasso?: (pinIds: string[]) => void;
  onCompleteSplit?: (aIds: string[], bIds: string[]) => void;
  onCancel: () => void;
};

export default function ZoneEditor({
  mode,
  targetZoneLabel,
  targetZoneColor,
  candidatePins,
  map,
  mapContainer,
  onCompleteLasso,
  onCompleteSplit,
  onCancel,
}: Props) {
  const trailPointsRef = useRef<L.LatLng[]>([]);
  const trailLineRef = useRef<L.Polyline | null>(null);
  const polygonRef = useRef<L.Polygon | null>(null);
  const candidatePinsRef = useRef(candidatePins);
  candidatePinsRef.current = candidatePins;

  // Disable left-button drag/zoom while editor is mounted. Wheel zoom stays
  // on so the user can zoom while drawing.
  useEffect(() => {
    if (!map) return;
    map.dragging.disable();
    map.touchZoom.disable();
    map.doubleClickZoom.disable();
    return () => {
      map.dragging.enable();
      map.touchZoom.enable();
      map.doubleClickZoom.enable();
    };
  }, [map]);

  // Right-click drag pans the map without disturbing the lasso/cut stroke.
  useRightClickPan(map, mapContainer);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  useEffect(() => {
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
      // Only primary button / first touch.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();
      const { px, py } = getCoords(e.clientX, e.clientY);
      cleanupTrail();
      trailPointsRef.current = [map.containerPointToLatLng([px, py])];
      const initialLatLng = trailPointsRef.current[0];
      trailLineRef.current = L.polyline([initialLatLng], {
        color: targetZoneColor,
        weight: 3,
        opacity: 0.95,
        dashArray: mode === "splitline" ? "8 4" : undefined,
      }).addTo(map);
      if (mode === "lasso") {
        polygonRef.current = L.polygon([initialLatLng], {
          color: targetZoneColor,
          weight: 2,
          opacity: 0.85,
          fillColor: targetZoneColor,
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(map);
      }
    };

    const onMove = (e: PointerEvent) => {
      if (trailPointsRef.current.length === 0) return;
      e.preventDefault();
      const { px, py } = getCoords(e.clientX, e.clientY);
      const latLng = map.containerPointToLatLng([px, py]);
      // Drop near-duplicate points to keep the trail light.
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
      if (mode === "lasso") {
        // Auto-close: ensure first ≈ last so the polygon test is well-defined.
        if (
          path.length >= 3 &&
          (path[0][0] !== path[path.length - 1][0] ||
            path[0][1] !== path[path.length - 1][1])
        ) {
          path.push([path[0][0], path[0][1]]);
        }
        const inside: string[] = [];
        for (const pin of candidatePinsRef.current) {
          if (pointInPolygon([pin.lat, pin.lng], path)) inside.push(pin.id);
        }
        cleanupTrail();
        onCompleteLasso?.(inside);
      } else {
        const aIds: string[] = [];
        const bIds: string[] = [];
        for (const pin of candidatePinsRef.current) {
          const side = classifyByPolyline([pin.lat, pin.lng], path);
          (side === 0 ? aIds : bIds).push(pin.id);
        }
        cleanupTrail();
        onCompleteSplit?.(aIds, bIds);
      }
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
  }, [map, mapContainer, mode, targetZoneColor, onCompleteLasso, onCompleteSplit]);

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[500] flex items-center gap-3 bg-paper border hairline px-4 py-3 shadow-lg">
      <span
        className="inline-block w-3 h-3 rounded-full flex-shrink-0"
        style={{ background: targetZoneColor }}
        aria-hidden
      />
      <div className="text-sm">
        <div className="serif">
          {mode === "lasso" ? "Lasso into" : "Cut"} {targetZoneLabel}
        </div>
        <div className="label">
          {mode === "lasso"
            ? "Drag a loop around the pins to add — release to finish"
            : "Drag a line through the zone — release to split"}
        </div>
        <div className="label opacity-70 hidden md:block mt-0.5">
          right-click drag to pan
        </div>
      </div>
      <button onClick={onCancel} className="label px-3 py-1.5 hover:bg-black/5">
        Cancel
      </button>
    </div>
  );
}
