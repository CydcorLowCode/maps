import type {
  AutoRouteResponse,
  GeocodeRequest,
  GeocodeResponse,
  GeopointeRoute,
  LassoRouteRequest,
  LassoRouteResponse,
  OpportunityPin,
  ProvidersStatus,
  RepRow,
  SaveRouteRequest,
  SaveSnapshotRequest,
  SavedRouteDetail,
  SavedRouteSummary,
  SnapshotDetail,
  SnapshotSummary,
} from "./types";

export type OpportunityCorrection = {
  id: string;
  corrected_lat: number;
  corrected_lng: number;
  geocode_provider?: string | null;
};
import { DEMO_OPPORTUNITIES, DEMO_REPS, DEMO_AUTO_ROUTE } from "./demoCache";

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

function isDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("demo_mode") === "cache";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text || response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchReps(iclCode: string): Promise<RepRow[]> {
  if (isDemoMode()) return DEMO_REPS;
  try {
    return await request<RepRow[]>(`/api/reps?icl_code=${encodeURIComponent(iclCode)}`);
  } catch (error) {
    if (isDemoMode()) return DEMO_REPS;
    throw error;
  }
}

export async function fetchOpportunities(ownerId: string): Promise<OpportunityPin[]> {
  if (isDemoMode()) return DEMO_OPPORTUNITIES;
  return request<OpportunityPin[]>(`/api/reps/${ownerId}/opportunities`);
}

export async function fetchGeopointeRoutes(
  ownerId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<GeopointeRoute[]> {
  if (isDemoMode()) return [];
  const params = new URLSearchParams();
  if (opts.days != null) params.set("days", String(opts.days));
  if (opts.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const path = `/api/reps/${ownerId}/geopointe-routes${qs ? `?${qs}` : ""}`;
  return request<GeopointeRoute[]>(path);
}

export async function buildAutoRoute(payload: {
  owner_id: string;
  opportunities: OpportunityPin[];
  starting_opportunity_id: string;
  min_stops?: number;
  max_stops?: number;
  target_stops?: number;
  cluster_eps_meters?: number;
  cluster_min_size?: number;
}): Promise<AutoRouteResponse> {
  if (isDemoMode()) return DEMO_AUTO_ROUTE;
  return request<AutoRouteResponse>("/api/routes/auto", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function buildLassoRoute(payload: LassoRouteRequest): Promise<LassoRouteResponse> {
  return request<LassoRouteResponse>("/api/routes/lasso", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function saveRoute(payload: SaveRouteRequest): Promise<{ id: string; created_at: string }> {
  return request("/api/routes/save", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchSavedRoutes(iclCode: string): Promise<SavedRouteSummary[]> {
  return request<SavedRouteSummary[]>(`/api/routes?icl_code=${encodeURIComponent(iclCode)}`);
}

export async function fetchSavedRoute(routeId: string): Promise<SavedRouteDetail> {
  return request<SavedRouteDetail>(`/api/routes/${routeId}`);
}

export async function saveSnapshot(
  payload: SaveSnapshotRequest,
): Promise<{ id: string; created_at: string }> {
  return request("/api/snapshots", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchSnapshots(
  iclCode: string,
  repOwnerId?: string,
): Promise<SnapshotSummary[]> {
  const params = new URLSearchParams({ icl_code: iclCode });
  if (repOwnerId) params.set("rep_owner_id", repOwnerId);
  return request<SnapshotSummary[]>(`/api/snapshots?${params.toString()}`);
}

export async function fetchSnapshot(snapshotId: string): Promise<SnapshotDetail> {
  return request<SnapshotDetail>(`/api/snapshots/${snapshotId}`);
}

export async function fetchGeocodeProviders(): Promise<ProvidersStatus> {
  return request<ProvidersStatus>("/api/geocode/providers");
}

export async function geocodeAddresses(payload: GeocodeRequest): Promise<GeocodeResponse> {
  return request<GeocodeResponse>("/api/geocode", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateSnapshotZones(
  snapshotId: string,
  zoneOverrides: Record<string, string>,
): Promise<{ ok: boolean }> {
  return request(`/api/snapshots/${snapshotId}/zones`, {
    method: "PATCH",
    body: JSON.stringify({ zone_overrides: zoneOverrides }),
  });
}

export async function fetchSnapshotRoutes(snapshotId: string): Promise<SavedRouteDetail[]> {
  return request<SavedRouteDetail[]>(`/api/snapshots/${snapshotId}/routes`);
}

export async function applySnapshotCorrections(
  snapshotId: string,
  corrections: OpportunityCorrection[],
): Promise<SnapshotDetail> {
  return request<SnapshotDetail>(`/api/snapshots/${snapshotId}/corrections`, {
    method: "PATCH",
    body: JSON.stringify({ corrections }),
  });
}

export async function updateSnapshotZoneNotes(
  snapshotId: string,
  zoneNotes: Record<string, string>,
): Promise<{ ok: boolean }> {
  return request(`/api/snapshots/${snapshotId}/zone-notes`, {
    method: "PATCH",
    body: JSON.stringify({ zone_notes: zoneNotes }),
  });
}

export async function updateRoute(
  routeId: string,
  changes: { label?: string | null; notes?: string | null },
): Promise<SavedRouteDetail> {
  return request<SavedRouteDetail>(`/api/routes/${routeId}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}
