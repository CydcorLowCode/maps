from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class RepRow(BaseModel):
    owner_id: str
    name: str
    total: int


class OpportunityPin(BaseModel):
    id: str
    name: Optional[str] = None
    street: str
    city: Optional[str] = None
    state: Optional[str] = None
    postal_code: Optional[str] = None
    lat: float
    lng: float
    stage_name: Optional[str] = None
    lead_expiration: Optional[str] = None
    icl_code: Optional[str] = None
    # Corrected coords from a geocoding provider, attached at snapshot save
    # time. The originals in lat/lng are preserved so we can compare.
    corrected_lat: Optional[float] = None
    corrected_lng: Optional[float] = None
    geocode_provider: Optional[str] = None


class AutoRouteRequest(BaseModel):
    owner_id: str
    opportunities: List[OpportunityPin]
    starting_opportunity_id: str
    min_stops: int = 45
    max_stops: int = 75
    target_stops: int = 60
    # Distance gap (meters) above which leads belong to separate clusters.
    cluster_eps_meters: float = Field(default=500.0, ge=0)
    # Clusters smaller than this merge into their nearest neighbor cluster.
    cluster_min_size: int = Field(default=2, ge=1)


class RouteStop(BaseModel):
    stop_number: int
    opportunity_id: str
    street: str
    city: Optional[str] = None
    lat: float
    lng: float
    segment_id: str
    segment_color: str
    segment_direction: str
    stop_range: str


class RouteSegment(BaseModel):
    segment_id: str
    segment_order: int
    stop_range: str
    color: str
    street_display: str
    block_label: str
    side_label: str
    direction: str
    stop_count: int


class RoutePayload(BaseModel):
    route_number: int
    stops: List[RouteStop]
    segments: List[RouteSegment]


class AutoRouteResponse(BaseModel):
    routes: List[RoutePayload]


class OrderedStop(BaseModel):
    stop_number: int
    opportunity_id: str
    lat: float
    lng: float


class SaveRouteRequest(BaseModel):
    rep_owner_id: str
    rep_name: str
    icl_code: str
    mode: Literal["auto", "drawn"]
    ordered_stops: List[OrderedStop]
    auto_route_snapshot: Optional[AutoRouteResponse] = None
    input_snapshot: Optional[List[OpportunityPin]] = None
    algorithm_params: Optional[dict] = None
    notes: Optional[str] = None
    snapshot_id: Optional[str] = None
    label: Optional[str] = None


class SaveRouteResponse(BaseModel):
    id: str
    created_at: str


class SavedRouteSummary(BaseModel):
    id: str
    created_at: str
    rep_salesforce_id: str
    rep_name: str
    icl_code: str
    mode: str
    stop_count: int
    notes: Optional[str] = None
    snapshot_id: Optional[str] = None
    label: Optional[str] = None


class SavedRouteDetail(SavedRouteSummary):
    ordered_stops: List[OrderedStop]
    auto_route_snapshot: Optional[AutoRouteResponse] = None
    input_snapshot: Optional[List[OpportunityPin]] = None
    algorithm_params: Optional[dict] = None


class SaveSnapshotRequest(BaseModel):
    icl_code: str
    rep_owner_id: str
    rep_name: str
    opportunities: List[OpportunityPin]
    label: Optional[str] = None
    notes: Optional[str] = None
    zone_overrides: Optional[dict] = None
    zone_notes: Optional[dict] = None


class UpdateSnapshotZonesRequest(BaseModel):
    zone_overrides: dict


class OpportunityCorrection(BaseModel):
    id: str
    corrected_lat: float
    corrected_lng: float
    geocode_provider: Optional[str] = None


class UpdateSnapshotCorrectionsRequest(BaseModel):
    corrections: List[OpportunityCorrection]


class SaveSnapshotResponse(BaseModel):
    id: str
    created_at: str


class SnapshotSummary(BaseModel):
    id: str
    created_at: str
    icl_code: str
    rep_salesforce_id: str
    rep_name: str
    opportunity_count: int
    label: Optional[str] = None
    notes: Optional[str] = None


class SnapshotDetail(SnapshotSummary):
    opportunities: List[OpportunityPin]
    zone_overrides: Optional[dict] = None
    zone_notes: Optional[dict] = None


class UpdateSnapshotNotesRequest(BaseModel):
    zone_notes: dict


class UpdateRouteRequest(BaseModel):
    label: Optional[str] = None
    notes: Optional[str] = None


class GeocodeAddress(BaseModel):
    id: str
    street: str
    city: Optional[str] = None
    state: Optional[str] = None
    postal_code: Optional[str] = None
    original_lat: Optional[float] = None
    original_lng: Optional[float] = None


class GeocodeRequest(BaseModel):
    provider: Literal["google", "ors"]
    addresses: List[GeocodeAddress]


class GeocodeResult(BaseModel):
    id: str
    status: Literal["ok", "no_match", "error"]
    lat: Optional[float] = None
    lng: Optional[float] = None
    formatted_address: Optional[str] = None
    location_type: Optional[str] = None
    provider: Optional[str] = None
    error: Optional[str] = None


class GeocodeResponse(BaseModel):
    provider: str
    results: List[GeocodeResult]


class LassoWaypoint(BaseModel):
    lat: float
    lng: float
    label: Optional[str] = None


class LassoRouteRequest(BaseModel):
    start: LassoWaypoint
    end: Optional[LassoWaypoint] = None
    opportunities: List[OpportunityPin]
    round_trip: bool = False


class LassoStop(BaseModel):
    stop_number: int
    kind: Literal["start", "opportunity", "end"]
    opportunity_id: Optional[str] = None
    label: Optional[str] = None
    street: Optional[str] = None
    city: Optional[str] = None
    lat: float
    lng: float


class LassoLeg(BaseModel):
    from_stop: int
    to_stop: int
    distance_m: float
    duration_s: float


class LassoRouteResponse(BaseModel):
    stops: List[LassoStop]
    legs: List[LassoLeg]
    total_distance_m: float
    total_duration_s: float
    polyline: Optional[str] = None
    provider: str
    profile: str


class GeopointeRouteStop(BaseModel):
    stop_number: int
    opportunity_id: Optional[str] = None
    label: Optional[str] = None
    street: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    postal_code: Optional[str] = None
    lat: float
    lng: float


class GeopointeRoute(BaseModel):
    id: str
    name: Optional[str] = None
    route_date: Optional[str] = None
    route_type: Optional[str] = None
    number_of_stops: Optional[int] = None
    total_distance_mi: Optional[float] = None
    last_modified: Optional[str] = None
    stops: List[GeopointeRouteStop]
