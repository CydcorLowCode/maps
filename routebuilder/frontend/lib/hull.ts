export type LatLng = [number, number]; // [lat, lng]

// Andrew's monotone chain convex hull. Operates on [lat, lng] tuples.
// For visualization on a city-scale map, we ignore the spherical correction.
export function convexHull(points: LatLng[]): LatLng[] {
  if (points.length <= 1) return points.slice();
  const pts = points.slice().sort((a, b) => (a[1] === b[1] ? a[0] - b[0] : a[1] - b[1]));
  const cross = (o: LatLng, a: LatLng, b: LatLng) =>
    (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);

  const lower: LatLng[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: LatLng[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Push each vertex outward from the polygon centroid by `paddingMeters`.
// Cheap "halo" so the polygon doesn't run through the outermost pins.
export function expandHull(hull: LatLng[], paddingMeters: number): LatLng[] {
  if (hull.length === 0 || paddingMeters <= 0) return hull;
  const clat = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const clng = hull.reduce((s, p) => s + p[1], 0) / hull.length;

  // Convert padding meters → degrees. Latitude is uniform; longitude shrinks
  // by cos(lat). Approximate using the centroid latitude.
  const dLat = paddingMeters / 111_000;
  const dLng = paddingMeters / (111_000 * Math.max(0.05, Math.cos((clat * Math.PI) / 180)));

  return hull.map(([lat, lng]) => {
    const dy = lat - clat;
    const dx = lng - clng;
    const norm = Math.hypot(dy / dLat, dx / dLng) || 1;
    return [lat + (dy / norm) * dLat, lng + (dx / norm) * dLng] as LatLng;
  });
}
