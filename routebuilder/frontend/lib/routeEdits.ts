import type {
  AutoRouteResponse,
  RoutePayload,
  RouteSegment,
  RouteStop,
} from "./types";

export type SegmentDirection = "forward" | "reverse";

const SUB_DELIM = "#";

export type SegmentEdits = {
  // Per-route ordering of (logical) segment ids — may include sub-ids after splits.
  order: Record<number, string[]>;
  // Per-segment direction override. Logical id (parent or sub).
  direction: Record<string, SegmentDirection>;
  // Parent segmentId -> sorted split-after positions in the parent's natural
  // (backend-provided) stop order. 1-indexed; e.g., [3] splits a 10-stop
  // segment into [1..3] and [4..10].
  splits: Record<string, number[]>;
};

export const emptySegmentEdits: SegmentEdits = { order: {}, direction: {}, splits: {} };

export function parentIdOf(segmentId: string): string {
  const i = segmentId.indexOf(SUB_DELIM);
  return i === -1 ? segmentId : segmentId.slice(0, i);
}

export function isSubsegmentId(segmentId: string): boolean {
  return segmentId.includes(SUB_DELIM);
}

function subId(parent: string, idx: number): string {
  return `${parent}${SUB_DELIM}${idx}`;
}

export function applySegmentEdits(
  autoRoute: AutoRouteResponse,
  edits: SegmentEdits,
): AutoRouteResponse {
  return {
    routes: autoRoute.routes.map((route) => applyToRoute(route, edits)),
  };
}

type Logical = {
  id: string;
  parentId: string;
  subIndex: number;
  subTotal: number;
  naturalStops: RouteStop[];
};

function buildLogicals(route: RoutePayload, edits: SegmentEdits): Logical[] {
  const stopsBySegment = new Map<string, RouteStop[]>();
  for (const stop of route.stops) {
    let bucket = stopsBySegment.get(stop.segment_id);
    if (!bucket) {
      bucket = [];
      stopsBySegment.set(stop.segment_id, bucket);
    }
    bucket.push(stop);
  }
  const out: Logical[] = [];
  for (const seg of route.segments) {
    const parentId = seg.segment_id;
    const stops = stopsBySegment.get(parentId) ?? [];
    const splits = (edits.splits[parentId] ?? [])
      .filter((p) => p > 0 && p < stops.length)
      .slice()
      .sort((a, b) => a - b);
    if (splits.length === 0) {
      out.push({
        id: parentId,
        parentId,
        subIndex: 1,
        subTotal: 1,
        naturalStops: stops,
      });
      continue;
    }
    let prev = 0;
    splits.forEach((boundary, i) => {
      out.push({
        id: subId(parentId, i + 1),
        parentId,
        subIndex: i + 1,
        subTotal: splits.length + 1,
        naturalStops: stops.slice(prev, boundary),
      });
      prev = boundary;
    });
    out.push({
      id: subId(parentId, splits.length + 1),
      parentId,
      subIndex: splits.length + 1,
      subTotal: splits.length + 1,
      naturalStops: stops.slice(prev),
    });
  }
  return out;
}

function applyToRoute(route: RoutePayload, edits: SegmentEdits): RoutePayload {
  const logicals = buildLogicals(route, edits);
  const segmentById = new Map(route.segments.map((s) => [s.segment_id, s]));
  const logicalById = new Map(logicals.map((l) => [l.id, l]));
  const defaultOrder = logicals.map((l) => l.id);

  // Apply user-specified order; append any logicals missing from it.
  const userOrder = edits.order[route.route_number];
  const finalOrder: string[] = [];
  const seen = new Set<string>();
  if (userOrder) {
    for (const id of userOrder) {
      if (logicalById.has(id) && !seen.has(id)) {
        finalOrder.push(id);
        seen.add(id);
      }
    }
  }
  for (const id of defaultOrder) {
    if (!seen.has(id)) {
      finalOrder.push(id);
      seen.add(id);
    }
  }

  const newStops: RouteStop[] = [];
  const newSegments: RouteSegment[] = [];
  let counter = 1;

  finalOrder.forEach((logicalId, idx) => {
    const logical = logicalById.get(logicalId);
    if (!logical) return;
    const parentSeg = segmentById.get(logical.parentId);
    const originalDir = (parentSeg?.direction as SegmentDirection) || "forward";
    const currentDir =
      edits.direction[logicalId] ?? edits.direction[logical.parentId] ?? originalDir;
    const ordered =
      currentDir === originalDir ? logical.naturalStops.slice() : logical.naturalStops.slice().reverse();
    for (const stop of ordered) {
      newStops.push({
        ...stop,
        stop_number: counter,
        segment_id: logicalId,
        segment_direction: currentDir,
      });
      counter += 1;
    }
    if (parentSeg) {
      const isSplit = logical.subTotal > 1;
      newSegments.push({
        ...parentSeg,
        segment_id: logicalId,
        segment_order: idx + 1,
        direction: currentDir,
        stop_count: logical.naturalStops.length,
        stop_range: isSplit
          ? `${parentSeg.stop_range || ""} (part ${logical.subIndex}/${logical.subTotal})`
          : parentSeg.stop_range,
      });
    }
  });

  return { ...route, stops: newStops, segments: newSegments };
}

export function moveSegment(
  edits: SegmentEdits,
  route: RoutePayload,
  segmentId: string,
  delta: -1 | 1,
): SegmentEdits {
  const logicals = buildLogicals(route, edits);
  const defaultOrder = logicals.map((l) => l.id);
  const current = (edits.order[route.route_number] ?? defaultOrder).slice();
  for (const id of defaultOrder) {
    if (!current.includes(id)) current.push(id);
  }
  // Drop any stale ids no longer present (e.g., after un-split).
  const validSet = new Set(defaultOrder);
  const filtered = current.filter((id) => validSet.has(id));
  const idx = filtered.indexOf(segmentId);
  if (idx === -1) return edits;
  const target = idx + delta;
  if (target < 0 || target >= filtered.length) return edits;
  [filtered[idx], filtered[target]] = [filtered[target], filtered[idx]];
  return {
    ...edits,
    order: { ...edits.order, [route.route_number]: filtered },
  };
}

export function setSegmentDirection(
  edits: SegmentEdits,
  segmentId: string,
  direction: SegmentDirection,
): SegmentEdits {
  return {
    ...edits,
    direction: { ...edits.direction, [segmentId]: direction },
  };
}

// Resolve a local "split-after" position within a logical (possibly sub-) segment
// to an absolute position in the parent's natural stop ordering, then add it.
export function splitSegment(
  edits: SegmentEdits,
  autoRoute: AutoRouteResponse,
  segmentId: string,
  localAfterPosition: number,
): SegmentEdits {
  const parentId = parentIdOf(segmentId);
  let parentStops: RouteStop[] = [];
  for (const route of autoRoute.routes) {
    const matches = route.stops.filter((s) => s.segment_id === parentId);
    if (matches.length > 0) {
      parentStops = matches;
      break;
    }
  }
  if (parentStops.length === 0) return edits;

  const sortedExisting = (edits.splits[parentId] ?? []).slice().sort((a, b) => a - b);

  // Find the sub-range this segmentId occupies within the parent.
  let subIdx = 1;
  if (isSubsegmentId(segmentId)) {
    const tail = segmentId.slice(parentId.length + SUB_DELIM.length);
    subIdx = parseInt(tail, 10) || 1;
  }
  const start = subIdx === 1 ? 0 : sortedExisting[subIdx - 2];
  const end = subIdx <= sortedExisting.length ? sortedExisting[subIdx - 1] : parentStops.length;

  const absolute = start + localAfterPosition;
  if (absolute <= start || absolute >= end) return edits;
  if (sortedExisting.includes(absolute)) return edits;

  const next = [...sortedExisting, absolute].sort((a, b) => a - b);
  return {
    ...edits,
    splits: { ...edits.splits, [parentId]: next },
  };
}

export function clearSplits(edits: SegmentEdits, segmentId: string): SegmentEdits {
  const parentId = parentIdOf(segmentId);
  if (!(parentId in edits.splits)) return edits;
  const next = { ...edits.splits };
  delete next[parentId];
  // Also drop any per-sub direction overrides — sub ids no longer exist.
  const direction = { ...edits.direction };
  for (const key of Object.keys(direction)) {
    if (key.startsWith(parentId + SUB_DELIM)) delete direction[key];
  }
  return { ...edits, splits: next, direction };
}

// Heuristic split suggestion: largest haversine gap between consecutive natural-
// order stops in this logical segment. Returns the local 1-indexed position to
// split AFTER, or null if no usable gap exists.
export function suggestSplitPosition(stops: RouteStop[]): number | null {
  if (stops.length < 3) return null;
  let bestIdx = -1;
  let bestDist = -1;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
    if (d > bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 1) return null;
  return bestIdx;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const x = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
