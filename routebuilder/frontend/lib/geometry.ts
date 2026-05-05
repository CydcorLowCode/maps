// Geometry primitives for manual zone editing. Lat/lng is treated as planar
// at zone scale — the error from ignoring earth curvature over a few km is
// well below the snap radius the user can perceive on the map.

export type LatLng = [number, number]; // [lat, lng]

/**
 * Ray-casting point-in-polygon. Polygon does not need to be explicitly closed;
 * the algorithm wraps the last vertex back to the first.
 */
export function pointInPolygon(p: LatLng, poly: LatLng[]): boolean {
  if (poly.length < 3) return false;
  const [py, px] = p;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [iy, ix] = poly[i];
    const [jy, jx] = poly[j];
    const intersect =
      iy > py !== jy > py &&
      px < ((jx - ix) * (py - iy)) / (jy - iy + 1e-12) + ix;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * For each polyline segment, compute the perpendicular distance from the
 * point to that segment (clamped to the segment endpoints) and the sign of
 * the 2D cross product (left vs right of the segment direction). Returns the
 * side associated with the *closest* segment — robust for multi-vertex cuts.
 *
 * Returns 0 or 1, mapping cross >= 0 → 0 ("left"), cross < 0 → 1 ("right").
 */
export function classifyByPolyline(p: LatLng, line: LatLng[]): 0 | 1 {
  if (line.length < 2) return 0;
  let bestDist = Infinity;
  let bestCross = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const apx = p[0] - a[0];
    const apy = p[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = 0;
    if (len2 > 0) t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
    const fx = a[0] + t * abx;
    const fy = a[1] + t * aby;
    const dx = p[0] - fx;
    const dy = p[1] - fy;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      // 2D cross of segment direction × pin offset from segment start
      bestCross = abx * apy - aby * apx;
    }
  }
  return bestCross >= 0 ? 0 : 1;
}
