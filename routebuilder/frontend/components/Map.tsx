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

export type OverlayRoute = {
  id: string;
  color: string;
  coords: [number, number][];
  label?: string;
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
  className,
  onMapReady,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayer = useRef<L.LayerGroup | null>(null);
  const linesLayer = useRef<L.LayerGroup | null>(null);
  const overlayLayer = useRef<L.LayerGroup | null>(null);
  const zonesLayer = useRef<L.LayerGroup | null>(null);
  const geocodedLayer = useRef<L.LayerGroup | null>(null);

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
    geocodedLayer.current = L.layerGroup().addTo(map);
    markersLayer.current = L.layerGroup().addTo(map);
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

  // Render markers.
  const routeActive = Boolean(autoRoute) || Boolean(drawnOrder && drawnOrder.length);
  useEffect(() => {
    const layer = markersLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const pin of pins) {
      const stop = stopByOppId.get(pin.id);
      const isStart = pin.id === startingId && !stop;
      const html = stop
        ? `<div class="route-pin routed" style="background:${stop.color}">${stop.stopNumber}</div>`
        : isStart
          ? `<div class="route-pin starting"></div>`
          : `<div class="route-pin"></div>`;
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
  }, [pins, startingId, stopByOppId, onPinClick, routeActive]);

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

  // Render comparison-mode overlay routes (one polyline per saved route, no
  // numbered stop markers — those would clash when several routes overlap).
  useEffect(() => {
    const layer = overlayLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (!overlayRoutes || overlayRoutes.length === 0) return;
    for (const r of overlayRoutes) {
      if (r.coords.length < 2) continue;
      L.polyline(r.coords, {
        color: r.color,
        weight: 4,
        opacity: 0.85,
        interactive: false,
      }).addTo(layer);
      const start = r.coords[0];
      const end = r.coords[r.coords.length - 1];
      L.circleMarker(start, {
        radius: 5,
        color: r.color,
        weight: 2,
        fillColor: "#ffffff",
        fillOpacity: 1,
      }).addTo(layer);
      L.circleMarker(end, {
        radius: 5,
        color: r.color,
        weight: 2,
        fillColor: r.color,
        fillOpacity: 1,
      }).addTo(layer);
    }
  }, [overlayRoutes]);

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
