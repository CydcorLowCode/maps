"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type { OpportunityPin } from "@/lib/types";
import { useRightClickPan } from "@/lib/useRightClickPan";

type Props = {
  pins: OpportunityPin[];
  map: L.Map | null;
  mapContainer: HTMLDivElement | null;
  onComplete: (order: string[]) => void;
  onCancel: () => void;
};

const SNAP_PX = 22;
const CURSOR_DIAMETER = 44;

export default function DrawMode({ pins, map, mapContainer, onComplete, onCancel }: Props) {
  const [pickedCount, setPickedCount] = useState(0);

  const orderRef = useRef<string[]>([]);
  const orderSetRef = useRef<Set<string>>(new Set());
  const trailPointsRef = useRef<L.LatLng[]>([]);
  const trailLineRef = useRef<L.Polyline | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);
  const pinElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  // Disable map gestures while draw mode is mounted. Scroll wheel zoom stays
  // enabled so the user can zoom in/out while tracing.
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

  // Right-click drag pans the map even though the left button is consumed
  // by the freehand-trace handler.
  useRightClickPan(map, mapContainer);

  // Build id -> marker DOM element lookup. Map.tsx tags each marker with
  // data-pin-id at creation time; DOM render order is NOT reliable (Leaflet
  // re-orders for z-index and riseOnHover, and zone labels are also markers).
  useEffect(() => {
    if (!mapContainer) return;
    const nodes = mapContainer.querySelectorAll<HTMLElement>("[data-pin-id]");
    pinElsRef.current.clear();
    nodes.forEach((node) => {
      const id = node.dataset.pinId;
      if (id) pinElsRef.current.set(id, node);
    });
    return () => {
      for (const el of pinElsRef.current.values()) {
        const inner = el.querySelector<HTMLElement>(".route-pin");
        if (!inner) continue;
        inner.classList.remove("draw-visited");
        inner.textContent = "";
      }
    };
  }, [mapContainer, pins]);

  // Native pointer/touch listeners — attached once per (map, mapContainer) pair.
  // Everything inside is ref-driven; no React state reads or writes per move.
  useEffect(() => {
    const el = mapContainer;
    if (!map || !el) return;

    const redrawRoute = () => {
      if (routeLineRef.current) {
        routeLineRef.current.remove();
        routeLineRef.current = null;
      }
      if (orderRef.current.length < 2) return;
      const byId = new Map(pinsRef.current.map((p) => [p.id, p] as const));
      const coords = orderRef.current
        .map((id) => byId.get(id))
        .filter((p): p is OpportunityPin => Boolean(p))
        .map((p) => [p.lat, p.lng] as [number, number]);
      routeLineRef.current = L.polyline(coords, {
        color: "#d94f2c",
        weight: 4,
        opacity: 0.85,
      }).addTo(map);
    };

    const commitPin = (id: string) => {
      if (orderSetRef.current.has(id)) return;
      orderSetRef.current.add(id);
      orderRef.current.push(id);
      const num = orderRef.current.length;
      const inner = pinElsRef.current.get(id)?.querySelector<HTMLElement>(".route-pin");
      if (inner) {
        inner.classList.add("draw-visited");
        inner.textContent = String(num);
      }
      redrawRoute();
      setPickedCount(num); // infrequent — only on snap hit
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(15);
    };

    const findHit = (px: number, py: number): OpportunityPin | null => {
      let best: OpportunityPin | null = null;
      let bestDist = SNAP_PX;
      const committed = orderSetRef.current;
      for (const p of pinsRef.current) {
        if (committed.has(p.id)) continue;
        const pt = map.latLngToContainerPoint([p.lat, p.lng]);
        const d = Math.hypot(pt.x - px, pt.y - py);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      return best;
    };

    const updateCursor = (cx: number, cy: number, hit: boolean) => {
      const c = cursorRef.current;
      if (!c) return;
      c.style.display = "block";
      c.style.left = `${cx}px`;
      c.style.top = `${cy}px`;
      if (hit) c.classList.add("snap");
      else c.classList.remove("snap");
    };

    const getCoords = (clientX: number, clientY: number) => {
      const rect = el.getBoundingClientRect();
      return { px: clientX - rect.left, py: clientY - rect.top };
    };

    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      const { px, py } = getCoords(e.clientX, e.clientY);
      trailPointsRef.current = [map.containerPointToLatLng([px, py])];
      if (trailLineRef.current) trailLineRef.current.remove();
      trailLineRef.current = L.polyline(trailPointsRef.current, {
        color: "#1a1d24",
        weight: 3,
        opacity: 0.4,
        dashArray: "4,6",
      }).addTo(map);
      const hit = findHit(px, py);
      updateCursor(e.clientX, e.clientY, !!hit);
      if (hit) commitPin(hit.id);
    };

    const onMove = (e: PointerEvent) => {
      const { px, py } = getCoords(e.clientX, e.clientY);
      const hit = findHit(px, py);
      updateCursor(e.clientX, e.clientY, !!hit);
      if (trailPointsRef.current.length === 0) return;
      e.preventDefault();
      trailPointsRef.current.push(map.containerPointToLatLng([px, py]));
      trailLineRef.current?.setLatLngs(trailPointsRef.current);
      if (hit) commitPin(hit.id);
    };

    const onUp = () => {
      trailPointsRef.current = [];
      if (trailLineRef.current) {
        trailLineRef.current.remove();
        trailLineRef.current = null;
      }
    };

    const onLeave = () => {
      const c = cursorRef.current;
      if (c) c.style.display = "none";
    };

    const onTouchMove = (e: TouchEvent) => {
      // Block native scroll while a stroke is in progress.
      if (trailPointsRef.current.length > 0) e.preventDefault();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove, { passive: false });
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    const prevTouchAction = el.style.touchAction;
    el.style.touchAction = "none";

    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      el.style.touchAction = prevTouchAction;
      if (trailLineRef.current) {
        trailLineRef.current.remove();
        trailLineRef.current = null;
      }
      if (routeLineRef.current) {
        routeLineRef.current.remove();
        routeLineRef.current = null;
      }
    };
  }, [map, mapContainer]);

  const undo = () => {
    const last = orderRef.current.pop();
    if (!last) return;
    orderSetRef.current.delete(last);
    const inner = pinElsRef.current.get(last)?.querySelector<HTMLElement>(".route-pin");
    if (inner) {
      inner.classList.remove("draw-visited");
      inner.textContent = "";
    }
    if (routeLineRef.current) {
      routeLineRef.current.remove();
      routeLineRef.current = null;
    }
    if (orderRef.current.length >= 2 && map) {
      const byId = new Map(pinsRef.current.map((p) => [p.id, p] as const));
      const coords = orderRef.current
        .map((id) => byId.get(id))
        .filter((p): p is OpportunityPin => Boolean(p))
        .map((p) => [p.lat, p.lng] as [number, number]);
      routeLineRef.current = L.polyline(coords, {
        color: "#d94f2c",
        weight: 4,
        opacity: 0.85,
      }).addTo(map);
    }
    setPickedCount(orderRef.current.length);
  };

  const clear = () => {
    for (const id of orderRef.current) {
      const inner = pinElsRef.current.get(id)?.querySelector<HTMLElement>(".route-pin");
      if (!inner) continue;
      inner.classList.remove("draw-visited");
      inner.textContent = "";
    }
    orderRef.current = [];
    orderSetRef.current.clear();
    if (routeLineRef.current) {
      routeLineRef.current.remove();
      routeLineRef.current = null;
    }
    setPickedCount(0);
  };

  return (
    <>
      <div
        ref={cursorRef}
        className="draw-cursor"
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: CURSOR_DIAMETER,
          height: CURSOR_DIAMETER,
          marginLeft: -CURSOR_DIAMETER / 2,
          marginTop: -CURSOR_DIAMETER / 2,
          borderRadius: "9999px",
          border: "2px solid var(--accent)",
          background: "rgba(217, 79, 44, 0.08)",
          pointerEvents: "none",
          display: "none",
          zIndex: 9999,
        }}
      />
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[500] flex items-center gap-2 bg-paper border hairline px-4 py-3 shadow-lg">
        <div className="label">{pickedCount} picked</div>
        <div className="label opacity-70 hidden md:block">right-click drag to pan</div>
        <div className="w-px h-5 bg-[var(--rule)] mx-1" />
        <button
          onClick={undo}
          disabled={pickedCount === 0}
          className="label px-3 py-1.5 hover:bg-black/5 disabled:opacity-40"
        >
          Undo
        </button>
        <button
          onClick={clear}
          disabled={pickedCount === 0}
          className="label px-3 py-1.5 hover:bg-black/5 disabled:opacity-40"
        >
          Clear
        </button>
        <button onClick={onCancel} className="label px-3 py-1.5 hover:bg-black/5">
          Cancel
        </button>
        <button
          onClick={() => onComplete(orderRef.current.slice())}
          disabled={pickedCount < 2}
          className="label px-3 py-1.5 bg-[var(--ink)] text-paper hover:bg-black disabled:opacity-40"
        >
          Done
        </button>
      </div>
    </>
  );
}
