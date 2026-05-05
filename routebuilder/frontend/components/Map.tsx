"use client";

import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { AutoRouteResponse, OpportunityPin } from "@/lib/types";

export type MapZone = {
  id: string;
  polygon: [number, number][];
  color: string;
  label?: string;
  active?: boolean;
  dim?: boolean;
};

export type GeocodedPoint = {
  pinId: string;
  lat: number;
  lng: number;
  provider: string;
  formattedAddress?: string | null;
  locationType?: string | null;
  originalLat: number;
  originalLng: number;
};

export type OverlayRouteStop = {
  stopNumber: number;
  lat: number;
  lng: number;
  label?: string | null;
};

export type OverlayRoute = {
  id: string;
  color: string;
  coords: [number, number][];
  label?: string;
  stops?: OverlayRouteStop[];
};

export type LassoRouteMarker = {
  stopNumber: number;
  kind: "start" | "opportunity" | "end";
  lat: number;
  lng: number;
  label?: string | null;
};

export type LassoRouteOverlay = {
  polyline: [number, number][];
  markers: LassoRouteMarker[];
  color?: string;
};

type Props = {
  pins: OpportunityPin[];
  startingId: string | null;
  onPinClick: (id: string) => void;
  autoRoute: AutoRouteResponse | null;
  drawnOrder: string[] | null;
  zones?: MapZone[];
  geocoded?: GeocodedPoint[];
  overlayRoutes?: OverlayRoute[];
  lassoRoute?: LassoRouteOverlay | null;
  highlightedPinIds?: Set<string> | null;
  className?: string;
  onMapReady?: (map: L.Map, container: HTMLDivElement) => void;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPopupHtml(
  pin: OpportunityPin,
  stop: { stopNumber: number; routeNumber: number; color: string } | undefined,
): string {
  const titleRaw = pin.name && pin.name.trim() ? pin.name : pin.street;
  const title = escapeHtml(titleRaw || "Opportunity");
  const cityLine = [pin.city, pin.state].filter(Boolean).join(", ");
  const addressLines = [
    pin.street,
    [cityLine, pin.postal_code].filter(Boolean).join(" "),
  ]
    .filter((s) => s && s.trim())
    .map((s) => `<div>${escapeHtml(s)}</div>`)
    .join("");
  const stage = pin.stage_name ? escapeHtml(pin.stage_name) : null;
  const stopBadge = stop
    ? `<div class="popup-stop"><span class="popup-dot" style="background:${stop.color}"></span>Stop ${stop.stopNumber} · Route ${stop.routeNumber}</div>`
    : "";
  return `
    <div class="pin-popup">
      ${stopBadge}
      <div class="popup-title">${title}</div>
      <div class="popup-address">${addressLines}</div>
      ${stage ? `<div class="popup-stage">${stage}</div>` : ""}
      <div class="popup-id">${escapeHtml(pin.id)}</div>
    </div>
  `;
}

const TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_ATTR = "&copy; OpenStreetMap &copy; CartoDB";

export default function RouteMap({
  pins,
  startingId,
  onPinClick,
  autoRoute,
  drawnOrder,
  zones,
  geocoded,
  overlayRoutes,
  lassoRoute,
  highlightedPinIds,
  className,
  onMapReady,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayer = useRef<L.LayerGroup | null>(null);
  const linesLayer = useRef<L.LayerGroup | null>(null);
  const overlayLayer = useRef<L.LayerGroup | null>(null);
  const overlayStopsLayer = useRef<L.LayerGroup | null>(null);
  const zonesLayer = useRef<L.LayerGroup | null>(null);
  const geocodedLayer = useRef<L.LayerGroup | null>(null);
  const lassoRouteLayer = useRef<L.LayerGroup | null>(null);

  const stopByOppId = useMemo(() => {
    const map = new Map<string, { stopNumber: number; color: string; routeNumber: number }>();
    if (autoRoute) {
      for (const route of autoRoute.routes) {
        for (const stop of route.stops) {
          map.set(stop.opportunity_id, {
            stopNumber: stop.stop_number,
            color: stop.segment_color,
            routeNumber: route.route_number,
          });
        }
      }
    }
    if (drawnOrder) {
      drawnOrder.forEach((id, i) => {
        map.set(id, { stopNumber: i + 1, color: "#d94f2c", routeNumber: 1 });
      });
    }
    return map;
  }, [autoRoute, drawnOrder]);

  // Initialize map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true });
    L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);
    // Order matters: zones go below polylines and markers.
    zonesLayer.current = L.layerGroup().addTo(map);
    overlayLayer.current = L.layerGroup().addTo(map);
    linesLayer.current = L.layerGroup().addTo(map);
    lassoRouteLayer.current = L.layerGroup().addTo(map);
    geocodedLayer.current = L.layerGroup().addTo(map);
    markersLayer.current = L.layerGroup().addTo(map);
    // Numbered stops for comparison-mode overlay routes — added last so the
    // badges sit above the rep's regular opportunity pins.
    overlayStopsLayer.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    onMapReady?.(map, containerRef.current);
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fit bounds when pins change (only once per pin set, not on route changes).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || pins.length === 0) return;
    const bounds = L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [pins]);

  // Snap to the active zone when its identity changes (e.g. user picks a
  // starting pin inside a different zone). Skipped if zones don't change
  // selection — re-renders that only flip dim/active flags shouldn't re-fit.
  const lastActiveZoneIdRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const active = zones?.find((z) => z.active) ?? null;
    const id = active ? active.id : null;
    if (id === lastActiveZoneIdRef.current) return;
    lastActiveZoneIdRef.current = id;
    if (!active || active.polygon.length < 2) return;
    map.fitBounds(L.latLngBounds(active.polygon), {
      padding: [60, 60],
      maxZoom: 17,
    });
  }, [zones]);

  // Snap to the visible overlay routes when the set of visible route ids
  // changes. We fit the union of every visible route's stops/coords.
  const lastOverlayKeyRef = useRef<string>("");
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const ids = (overlayRoutes ?? [])
      .map((r) => r.id)
      .sort()
      .join(",");
    if (ids === lastOverlayKeyRef.current) return;
    lastOverlayKeyRef.current = ids;
    if (!overlayRoutes || overlayRoutes.length === 0) return;
    const points: [number, number][] = [];
    for (const r of overlayRoutes) {
      for (const c of r.coords) points.push(c);
      if (r.stops) for (const s of r.stops) points.push([s.lat, s.lng]);
    }
    if (points.length === 0) return;
    map.fitBounds(L.latLngBounds(points), {
      padding: [60, 60],
      maxZoom: 17,
    });
  }, [overlayRoutes]);

  // Render markers.
  const routeActive = Boolean(autoRoute) || Boolean(drawnOrder && drawnOrder.length);
  useEffect(() => {
    const layer = markersLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const pin of pins) {
      const stop = stopByOppId.get(pin.id);
      const isStart = pin.id === startingId && !stop;
      const highlighted = highlightedPinIds?.has(pin.id) ?? false;
      const dim = highlightedPinIds && !highlighted && !stop && !isStart;
      const extraClass = highlighted ? " highlighted" : dim ? " dimmed" : "";
      const html = stop
        ? `<div class="route-pin routed${extraClass}" style="background:${stop.color}">${stop.stopNumber}</div>`
        : isStart
          ? `<div class="route-pin starting${extraClass}"></div>`
          : `<div class="route-pin${extraClass}"></div>`;
      const icon = L.divIcon({ className: "", html, iconSize: [28, 28], iconAnchor: [14, 14] });
      const marker = L.marker([pin.lat, pin.lng], { icon, riseOnHover: true });
      if (routeActive) {
        marker.bindPopup(buildPopupHtml(pin, stop), {
          closeButton: true,
          autoPan: true,
          maxWidth: 260,
          className: "pin-popup-wrapper",
        });
      } else {
        marker.on("click", () => onPinClick(pin.id));
      }
      marker.addTo(layer);
      const el = marker.getElement() as HTMLElement | null;
      if (el) el.dataset.pinId = pin.id;
    }
  }, [pins, startingId, stopByOppId, onPinClick, routeActive, highlightedPinIds]);

  // Render cluster zone polygons.
  useEffect(() => {
    const layer = zonesLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (!zones || zones.length === 0) return;
    for (const zone of zones) {
      if (zone.polygon.length < 3) continue;
      const active = Boolean(zone.active);
      const dim = Boolean(zone.dim);
      const poly = L.polygon(zone.polygon, {
        color: zone.color,
        weight: active ? 3 : 2,
        opacity: dim ? 0.25 : active ? 0.95 : 0.7,
        fillColor: zone.color,
        fillOpacity: dim ? 0.03 : active ? 0.16 : 0.08,
        dashArray: active ? undefined : "6 6",
        interactive: false,
      });
      poly.addTo(layer);
      if (zone.label) {
        const lat = zone.polygon.reduce((s, p) => s + p[0], 0) / zone.polygon.length;
        const lng = zone.polygon.reduce((s, p) => s + p[1], 0) / zone.polygon.length;
        L.marker([lat, lng], {
          interactive: false,
          icon: L.divIcon({
            className: "",
            html: `<div class="zone-label" style="border-color:${zone.color};color:${zone.color}">${zone.label}</div>`,
            iconSize: [120, 22],
            iconAnchor: [60, 11],
          }),
        }).addTo(layer);
      }
    }
  }, [zones]);

  // Render polylines for auto route segments.
  useEffect(() => {
    const layer = linesLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (autoRoute) {
      for (const route of autoRoute.routes) {
        if (route.stops.length < 2) continue;
        const coords = route.stops.map((s) => [s.lat, s.lng] as [number, number]);
        // One color per route — applyRouteColors writes the same color into
        // every stop's segment_color, so any stop is fine to read.
        const color = route.stops[0].segment_color || "#1c1917";
        L.polyline(coords, { color, weight: 5, opacity: 0.9 }).addTo(layer);
      }
    }
    if (drawnOrder && drawnOrder.length >= 2) {
      const byId = new Map(pins.map((p) => [p.id, p]));
      const coords = drawnOrder
        .map((id) => byId.get(id))
        .filter((p): p is OpportunityPin => Boolean(p))
        .map((p) => [p.lat, p.lng] as [number, number]);
      if (coords.length >= 2) {
        L.polyline(coords, { color: "#d94f2c", weight: 5, opacity: 0.9 }).addTo(layer);
      }
    }
  }, [autoRoute, drawnOrder, pins]);

  // Render comparison-mode overlay routes. Polylines + start/end caps live on
  // overlayLayer (below the rep's pins). Numbered stop markers, when provided,
  // render on overlayStopsLayer above the pins so the order is readable.
  useEffect(() => {
    const lineLayer = overlayLayer.current;
    const stopsLayer = overlayStopsLayer.current;
    if (!lineLayer || !stopsLayer) return;
    lineLayer.clearLayers();
    stopsLayer.clearLayers();
    if (!overlayRoutes || overlayRoutes.length === 0) return;
    for (const r of overlayRoutes) {
      if (r.coords.length >= 2) {
        L.polyline(r.coords, {
          color: r.color,
          weight: 4,
          opacity: 0.85,
          interactive: false,
        }).addTo(lineLayer);
      }
      if (r.coords.length > 0) {
        const start = r.coords[0];
        const end = r.coords[r.coords.length - 1];
        L.circleMarker(start, {
          radius: 5,
          color: r.color,
          weight: 2,
          fillColor: "#ffffff",
          fillOpacity: 1,
        }).addTo(lineLayer);
        L.circleMarker(end, {
          radius: 5,
          color: r.color,
          weight: 2,
          fillColor: r.color,
          fillOpacity: 1,
        }).addTo(lineLayer);
      }
      if (r.stops && r.stops.length > 0) {
        for (const s of r.stops) {
          const html = `<div class="route-pin routed overlay-stop" style="background:${r.color}">${s.stopNumber}</div>`;
          const icon = L.divIcon({
            className: "",
            html,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          });
          const marker = L.marker([s.lat, s.lng], { icon, riseOnHover: true });
          const titleParts = [r.label, `Stop ${s.stopNumber}`].filter(Boolean) as string[];
          const popupHtml = `
            <div class="pin-popup">
              <div class="popup-stop"><span class="popup-dot" style="background:${r.color}"></span>${escapeHtml(titleParts.join(" · "))}</div>
              ${s.label ? `<div class="popup-title">${escapeHtml(s.label)}</div>` : ""}
            </div>
          `;
          marker.bindPopup(popupHtml, {
            closeButton: true,
            autoPan: true,
            maxWidth: 240,
            className: "pin-popup-wrapper",
          });
          marker.addTo(stopsLayer);
        }
      }
    }
  }, [overlayRoutes]);

  // Render the lasso (walking) route — encoded polyline + numbered stops with
  // start/end caps. Drawn underneath markers but above the auto-route lines.
  useEffect(() => {
    const layer = lassoRouteLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (!lassoRoute) return;
    const color = lassoRoute.color || "#0ea5e9";
    if (lassoRoute.polyline.length >= 2) {
      L.polyline(lassoRoute.polyline, {
        color,
        weight: 5,
        opacity: 0.92,
        interactive: false,
      }).addTo(layer);
    }
    for (const m of lassoRoute.markers) {
      const labelHtml = escapeHtml(m.label || "");
      let html: string;
      if (m.kind === "start") {
        html = `<div class="lasso-cap start" style="background:${color}">A</div>`;
      } else if (m.kind === "end") {
        html = `<div class="lasso-cap end" style="border-color:${color};color:${color}">B</div>`;
      } else {
        html = `<div class="route-pin routed" style="background:${color}">${m.stopNumber}</div>`;
      }
      const icon = L.divIcon({
        className: "",
        html,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const marker = L.marker([m.lat, m.lng], { icon, riseOnHover: true });
      const tooltip = `<div class="pin-popup"><div class="popup-title">${
        m.kind === "start" ? "Start" : m.kind === "end" ? "End" : `Stop ${m.stopNumber}`
      }</div>${labelHtml ? `<div class="popup-address"><div>${labelHtml}</div></div>` : ""}</div>`;
      marker.bindPopup(tooltip, {
        closeButton: true,
        autoPan: true,
        maxWidth: 240,
        className: "pin-popup-wrapper",
      });
      marker.addTo(layer);
    }
  }, [lassoRoute]);

  // Render geocoded points + leader lines from the original pin location.
  useEffect(() => {
    const layer = geocodedLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (!geocoded || geocoded.length === 0) return;

    const providerColor = (provider: string) =>
      provider === "google" ? "#4285f4" : provider === "ors" ? "#7c3aed" : "#0ea5e9";

    for (const g of geocoded) {
      const color = providerColor(g.provider);
      L.polyline(
        [
          [g.originalLat, g.originalLng],
          [g.lat, g.lng],
        ],
        { color, weight: 2, opacity: 0.7, dashArray: "4 4", interactive: false },
      ).addTo(layer);

      const html = `<div class="geocoded-pin" style="background:${color};color:${color}"></div>`;
      const icon = L.divIcon({
        className: "",
        html,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      const marker = L.marker([g.lat, g.lng], { icon, riseOnHover: true });
      const meters = haversineMeters(g.originalLat, g.originalLng, g.lat, g.lng);
      const ft = (meters * 3.28084).toFixed(0);
      const tooltip = [
        `<div class="popup-title">${escapeHtml(g.provider.toUpperCase())} geocode</div>`,
        g.formattedAddress
          ? `<div class="popup-address"><div>${escapeHtml(g.formattedAddress)}</div></div>`
          : "",
        g.locationType
          ? `<div class="popup-stage">${escapeHtml(g.locationType)}</div>`
          : "",
        `<div class="popup-id">Δ ${ft} ft from original</div>`,
      ].join("");
      marker.bindPopup(`<div class="pin-popup">${tooltip}</div>`, {
        closeButton: true,
        autoPan: true,
        maxWidth: 260,
        className: "pin-popup-wrapper",
      });
      marker.addTo(layer);
    }
  }, [geocoded]);

  return <div ref={containerRef} className={className} />;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
