export type RepRow = {
  owner_id: string;
  name: string;
  total: number;
};

export type OpportunityPin = {
  id: string;
  name?: string | null;
  street: string;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  lat: number;
  lng: number;
  stage_name?: string | null;
  lead_expiration?: string | null;
  icl_code?: string | null;
  corrected_lat?: number | null;
  corrected_lng?: number | null;
  geocode_provider?: string | null;
};

export type RouteStop = {
  stop_number: number;
  opportunity_id: string;
  street: string;
  city?: string | null;
  lat: number;
  lng: number;
  segment_id: string;
  segment_color: string;
  segment_direction: string;
  stop_range: string;
};

export type RouteSegment = {
  segment_id: string;
  segment_order: number;
  stop_range: string;
  color: string;
  street_display: string;
  block_label: string;
  side_label: string;
  direction: string;
  stop_count: number;
};

export type RoutePayload = {
  route_number: number;
  stops: RouteStop[];
  segments: RouteSegment[];
};

export type AutoRouteResponse = {
  routes: RoutePayload[];
};

export type OrderedStop = {
  stop_number: number;
  opportunity_id: string;
  lat: number;
  lng: number;
};

export type SaveRouteRequest = {
  rep_owner_id: string;
  rep_name: string;
  icl_code: string;
  mode: "auto" | "drawn";
  ordered_stops: OrderedStop[];
  auto_route_snapshot?: AutoRouteResponse | null;
  input_snapshot?: OpportunityPin[] | null;
  algorithm_params?: Record<string, unknown> | null;
  notes?: string | null;
  snapshot_id?: string | null;
  label?: string | null;
};

export type SavedRouteSummary = {
  id: string;
  created_at: string;
  rep_salesforce_id: string;
  rep_name: string;
  icl_code: string;
  mode: "auto" | "drawn" | string;
  stop_count: number;
  notes?: string | null;
  snapshot_id?: string | null;
  label?: string | null;
};

export type SavedRouteDetail = SavedRouteSummary & {
  ordered_stops: OrderedStop[];
  auto_route_snapshot?: AutoRouteResponse | null;
  input_snapshot?: OpportunityPin[] | null;
  algorithm_params?: Record<string, unknown> | null;
};

export type SaveSnapshotRequest = {
  icl_code: string;
  rep_owner_id: string;
  rep_name: string;
  opportunities: OpportunityPin[];
  label?: string | null;
  notes?: string | null;
  zone_overrides?: Record<string, string> | null;
  zone_notes?: Record<string, string> | null;
};

export type SnapshotSummary = {
  id: string;
  created_at: string;
  icl_code: string;
  rep_salesforce_id: string;
  rep_name: string;
  opportunity_count: number;
  label?: string | null;
  notes?: string | null;
};

export type SnapshotDetail = SnapshotSummary & {
  opportunities: OpportunityPin[];
  zone_overrides?: Record<string, string> | null;
  zone_notes?: Record<string, string> | null;
};

export type GeocodeProvider = "google" | "ors";

export type GeocodeAddress = {
  id: string;
  street: string;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  original_lat?: number | null;
  original_lng?: number | null;
};

export type GeocodeRequest = {
  provider: GeocodeProvider;
  addresses: GeocodeAddress[];
};

export type GeocodeResult = {
  id: string;
  status: "ok" | "no_match" | "error";
  lat?: number | null;
  lng?: number | null;
  formatted_address?: string | null;
  location_type?: string | null;
  provider?: string | null;
  error?: string | null;
};

export type GeocodeResponse = {
  provider: string;
  results: GeocodeResult[];
};

export type ProvidersStatus = {
  google: boolean;
  ors: boolean;
};

export type LassoWaypoint = {
  lat: number;
  lng: number;
  label?: string | null;
};

export type LassoRouteRequest = {
  start: LassoWaypoint;
  end?: LassoWaypoint | null;
  opportunities: OpportunityPin[];
  round_trip?: boolean;
};

export type LassoStop = {
  stop_number: number;
  kind: "start" | "opportunity" | "end";
  opportunity_id?: string | null;
  label?: string | null;
  street?: string | null;
  city?: string | null;
  lat: number;
  lng: number;
};

export type LassoLeg = {
  from_stop: number;
  to_stop: number;
  distance_m: number;
  duration_s: number;
};

export type LassoRouteResponse = {
  stops: LassoStop[];
  legs: LassoLeg[];
  total_distance_m: number;
  total_duration_s: number;
  polyline?: string | null;
  provider: string;
  profile: string;
};

export type GeopointeRouteStop = {
  stop_number: number;
  opportunity_id?: string | null;
  label?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  lat: number;
  lng: number;
};

export type GeopointeRoute = {
  id: string;
  name?: string | null;
  route_date?: string | null;
  route_type?: string | null;
  number_of_stops?: number | null;
  total_distance_mi?: number | null;
  last_modified?: string | null;
  stops: GeopointeRouteStop[];
};
