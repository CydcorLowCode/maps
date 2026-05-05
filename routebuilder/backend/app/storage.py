"""
Supabase persistence for saved routes. Uses the service-role key so the
backend can write directly without an authenticated user. Skip RLS in the
POC per the handoff.
"""
from __future__ import annotations

import os
from typing import List, Optional

from supabase import Client, create_client

from .models import (
    AutoRouteResponse,
    OpportunityPin,
    OrderedStop,
    SaveRouteRequest,
    SaveRouteResponse,
    SaveSnapshotRequest,
    SaveSnapshotResponse,
    SavedRouteDetail,
    SavedRouteSummary,
    SnapshotDetail,
    SnapshotSummary,
)

_client: Optional[Client] = None


def _get_client() -> Client:
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, key)
    return _client


def save_route(request: SaveRouteRequest) -> SaveRouteResponse:
    client = _get_client()
    payload = {
        "rep_salesforce_id": request.rep_owner_id,
        "rep_name": request.rep_name,
        "icl_code": request.icl_code,
        "mode": request.mode,
        "ordered_stops": [stop.model_dump() for stop in request.ordered_stops],
        "auto_route_snapshot": request.auto_route_snapshot.model_dump() if request.auto_route_snapshot else None,
        "input_snapshot": [pin.model_dump() for pin in request.input_snapshot] if request.input_snapshot else None,
        "algorithm_params": request.algorithm_params,
        "notes": request.notes,
        "snapshot_id": request.snapshot_id,
        "label": request.label,
    }
    result = client.table("saved_routes").insert(payload).execute()
    if not result.data:
        raise RuntimeError("Failed to save route")
    row = result.data[0]
    return SaveRouteResponse(id=row["id"], created_at=row["created_at"])


def _summary_from_row(row: dict) -> SavedRouteSummary:
    ordered = row.get("ordered_stops") or []
    return SavedRouteSummary(
        id=row["id"],
        created_at=row["created_at"],
        rep_salesforce_id=row["rep_salesforce_id"],
        rep_name=row["rep_name"],
        icl_code=row["icl_code"],
        mode=row["mode"],
        stop_count=len(ordered),
        notes=row.get("notes"),
        snapshot_id=row.get("snapshot_id"),
        label=row.get("label"),
    )


def list_routes(icl_code: str) -> List[SavedRouteSummary]:
    client = _get_client()
    result = (
        client.table("saved_routes")
        .select(
            "id, created_at, rep_salesforce_id, rep_name, icl_code, mode, "
            "ordered_stops, notes, snapshot_id, label"
        )
        .eq("icl_code", icl_code)
        .order("created_at", desc=True)
        .limit(200)
        .execute()
    )
    return [_summary_from_row(row) for row in (result.data or [])]


def list_routes_for_snapshot(snapshot_id: str) -> List[SavedRouteDetail]:
    """Return full detail for every route built off a snapshot — the
    comparison view needs the polylines, not just summaries."""
    client = _get_client()
    result = (
        client.table("saved_routes")
        .select("*")
        .eq("snapshot_id", snapshot_id)
        .order("created_at", desc=True)
        .limit(200)
        .execute()
    )
    return [_detail_from_row(row) for row in (result.data or [])]


def _detail_from_row(row: dict) -> SavedRouteDetail:
    ordered_stops = [OrderedStop(**stop) for stop in (row.get("ordered_stops") or [])]
    auto_snapshot = (
        AutoRouteResponse(**row["auto_route_snapshot"]) if row.get("auto_route_snapshot") else None
    )
    input_snapshot = (
        [OpportunityPin(**pin) for pin in row["input_snapshot"]] if row.get("input_snapshot") else None
    )
    return SavedRouteDetail(
        id=row["id"],
        created_at=row["created_at"],
        rep_salesforce_id=row["rep_salesforce_id"],
        rep_name=row["rep_name"],
        icl_code=row["icl_code"],
        mode=row["mode"],
        stop_count=len(ordered_stops),
        notes=row.get("notes"),
        snapshot_id=row.get("snapshot_id"),
        label=row.get("label"),
        ordered_stops=ordered_stops,
        auto_route_snapshot=auto_snapshot,
        input_snapshot=input_snapshot,
        algorithm_params=row.get("algorithm_params"),
    )


def get_route(route_id: str) -> Optional[SavedRouteDetail]:
    client = _get_client()
    result = (
        client.table("saved_routes")
        .select("*")
        .eq("id", route_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        return None
    return _detail_from_row(rows[0])


def save_snapshot(request: SaveSnapshotRequest) -> SaveSnapshotResponse:
    client = _get_client()
    payload = {
        "icl_code": request.icl_code,
        "rep_salesforce_id": request.rep_owner_id,
        "rep_name": request.rep_name,
        "opportunity_count": len(request.opportunities),
        "opportunities": [pin.model_dump() for pin in request.opportunities],
        "label": request.label,
        "notes": request.notes,
        "zone_overrides": request.zone_overrides,
        "zone_notes": request.zone_notes,
    }
    result = client.table("assignment_snapshots").insert(payload).execute()
    if not result.data:
        raise RuntimeError("Failed to save snapshot")
    row = result.data[0]
    return SaveSnapshotResponse(id=row["id"], created_at=row["created_at"])


def update_snapshot_zones(snapshot_id: str, zone_overrides: dict) -> bool:
    client = _get_client()
    result = (
        client.table("assignment_snapshots")
        .update({"zone_overrides": zone_overrides})
        .eq("id", snapshot_id)
        .execute()
    )
    return bool(result.data)


def update_snapshot_zone_notes(snapshot_id: str, zone_notes: dict) -> bool:
    client = _get_client()
    result = (
        client.table("assignment_snapshots")
        .update({"zone_notes": zone_notes})
        .eq("id", snapshot_id)
        .execute()
    )
    return bool(result.data)


def update_route(
    route_id: str,
    label: Optional[str],
    notes: Optional[str],
) -> Optional[SavedRouteDetail]:
    client = _get_client()
    payload: dict = {}
    # Allow explicit None to clear a field — empty string is treated as "clear".
    if label is not None:
        payload["label"] = label or None
    if notes is not None:
        payload["notes"] = notes or None
    if not payload:
        return get_route(route_id)
    result = (
        client.table("saved_routes")
        .update(payload)
        .eq("id", route_id)
        .execute()
    )
    if not result.data:
        return None
    return get_route(route_id)


def apply_snapshot_corrections(
    snapshot_id: str, corrections: List[dict]
) -> Optional[SnapshotDetail]:
    """Merge corrected_lat/lng/geocode_provider into the snapshot's
    opportunities jsonb. Returns the updated snapshot detail, or None if not
    found. Read-modify-write — adequate for POC volume (single rep, <500
    pins). If we ever need concurrent edits, switch to a Supabase RPC."""
    client = _get_client()
    fetched = (
        client.table("assignment_snapshots")
        .select("opportunities")
        .eq("id", snapshot_id)
        .limit(1)
        .execute()
    )
    rows = fetched.data or []
    if not rows:
        return None
    opps = rows[0].get("opportunities") or []
    by_id = {c["id"]: c for c in corrections}
    merged: List[dict] = []
    for opp in opps:
        c = by_id.get(opp.get("id"))
        if c is not None:
            opp = {
                **opp,
                "corrected_lat": c["corrected_lat"],
                "corrected_lng": c["corrected_lng"],
                "geocode_provider": c.get("geocode_provider"),
            }
        merged.append(opp)
    update = (
        client.table("assignment_snapshots")
        .update({"opportunities": merged})
        .eq("id", snapshot_id)
        .execute()
    )
    if not update.data:
        return None
    return get_snapshot(snapshot_id)


def list_snapshots(
    icl_code: str, rep_owner_id: Optional[str] = None
) -> List[SnapshotSummary]:
    client = _get_client()
    query = (
        client.table("assignment_snapshots")
        .select(
            "id, created_at, icl_code, rep_salesforce_id, rep_name, "
            "opportunity_count, label, notes"
        )
        .eq("icl_code", icl_code)
    )
    if rep_owner_id:
        query = query.eq("rep_salesforce_id", rep_owner_id)
    result = query.order("created_at", desc=True).limit(200).execute()
    return [
        SnapshotSummary(
            id=row["id"],
            created_at=row["created_at"],
            icl_code=row["icl_code"],
            rep_salesforce_id=row["rep_salesforce_id"],
            rep_name=row["rep_name"],
            opportunity_count=row["opportunity_count"],
            label=row.get("label"),
            notes=row.get("notes"),
        )
        for row in (result.data or [])
    ]


def get_snapshot(snapshot_id: str) -> Optional[SnapshotDetail]:
    client = _get_client()
    result = (
        client.table("assignment_snapshots")
        .select("*")
        .eq("id", snapshot_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        return None
    row = rows[0]
    opportunities = [OpportunityPin(**pin) for pin in (row.get("opportunities") or [])]
    return SnapshotDetail(
        id=row["id"],
        created_at=row["created_at"],
        icl_code=row["icl_code"],
        rep_salesforce_id=row["rep_salesforce_id"],
        rep_name=row["rep_name"],
        opportunity_count=row["opportunity_count"],
        label=row.get("label"),
        notes=row.get("notes"),
        opportunities=opportunities,
        zone_overrides=row.get("zone_overrides"),
        zone_notes=row.get("zone_notes"),
    )
