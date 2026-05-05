import type { AutoRouteResponse } from "./types";

const ROUTE_COLOR_PALETTE = [
  "#1f77b4",
  "#d94f2c",
  "#2ca02c",
  "#9467bd",
  "#8c564b",
  "#17becf",
  "#bcbd22",
  "#e377c2",
  "#7f7f7f",
  "#ff7f0e",
];

export function routeColor(routeNumber: number): string {
  const idx = ((routeNumber - 1) % ROUTE_COLOR_PALETTE.length + ROUTE_COLOR_PALETTE.length) %
    ROUTE_COLOR_PALETTE.length;
  return ROUTE_COLOR_PALETTE[idx];
}

// Override per-segment colors with a single per-route color so the map / sidebar
// render one color per route, not one per segment.
export function applyRouteColors(response: AutoRouteResponse): AutoRouteResponse {
  return {
    routes: response.routes.map((route) => {
      const color = routeColor(route.route_number);
      return {
        ...route,
        stops: route.stops.map((s) => ({ ...s, segment_color: color })),
        segments: route.segments.map((s) => ({ ...s, color })),
      };
    }),
  };
}
