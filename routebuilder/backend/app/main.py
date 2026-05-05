from __future__ import annotations

import os
import re
from typing import List

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import geocoding, routing, salesforce, storage
from .models import (
    AutoRouteRequest,
    AutoRouteResponse,
    GeocodeRequest,
    GeocodeResponse,
    GeopointeRoute,
    LassoRouteRequest,
    LassoRouteResponse,
    OpportunityPin,
    RepRow,
    SaveRouteRequest,
    SaveRouteResponse,
    SaveSnapshotRequest,
    SaveSnapshotResponse,
    SavedRouteDetail,
    SavedRouteSummary,
    SnapshotDetail,
    SnapshotSummary,
    UpdateRouteRequest,
    UpdateSnapshotCorrectionsRequest,
    UpdateSnapshotNotesRequest,
    UpdateSnapshotZonesRequest,
)
from .routes import build_auto_route

load_dotenv()

app = FastAPI(title="Route Builder POC", version="0.1.0")

_origins_raw = os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000")
_static_origins = [origin.strip() for origin in _origins_raw.split(",") if origin.strip()]

# Regex covers any local dev port and any Vercel preview deployment.
_origin_regex = r"https?://(localhost|127\.0\.0\.1)(:\d+)?|https://.*\.vercel\.app"

app.add_middleware(
    CORSMiddleware,
    allow_origins=_static_origins,
    allow_origin_regex=_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/reps", response_model=List[RepRow])
def get_reps(icl_code: str = Query(..., min_length=1, max_length=32)) -> List[RepRow]:
    if not re.match(r"^[A-Za-z0-9_-]+$", icl_code):
        raise HTTPException(status_code=400, detail="Invalid icl_code")
    try:
        return salesforce.query_roster(icl_code)
    except salesforce.SalesforceAuthError as exc:
        raise HTTPException(status_code=502, detail=f"Salesforce auth failed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Salesforce query failed: {exc}") from exc


@app.get("/api/reps/{owner_id}/opportunities", response_model=List[OpportunityPin])
def get_opportunities(owner_id: str) -> List[OpportunityPin]:
    if not re.match(r"^[A-Za-z0-9]{15,18}$", owner_id):
        raise HTTPException(status_code=400, detail="Invalid Salesforce owner_id")
    try:
        return salesforce.query_opportunities_for_owner(owner_id)
    except salesforce.SalesforceAuthError as exc:
        raise HTTPException(status_code=502, detail=f"Salesforce auth failed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Salesforce query failed: {exc}") from exc


@app.get(
    "/api/reps/{owner_id}/geopointe-routes",
    response_model=List[GeopointeRoute],
)
def get_geopointe_routes(
    owner_id: str,
    days: int = Query(default=30, ge=1, le=365),
    limit: int = Query(default=10, ge=1, le=50),
) -> List[GeopointeRoute]:
    if not re.match(r"^[A-Za-z0-9]{15,18}$", owner_id):
        raise HTTPException(status_code=400, detail="Invalid Salesforce owner_id")
    try:
        return salesforce.query_geopointe_routes_for_owner(
            owner_id, days=days, limit=limit
        )
    except salesforce.SalesforceAuthError as exc:
        raise HTTPException(status_code=502, detail=f"Salesforce auth failed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Salesforce query failed: {exc}") from exc


@app.post("/api/routes/auto", response_model=AutoRouteResponse)
def post_auto_route(request: AutoRouteRequest) -> AutoRouteResponse:
    if not request.opportunities:
        raise HTTPException(status_code=400, detail="opportunities cannot be empty")
    try:
        return build_auto_route(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/routes/lasso", response_model=LassoRouteResponse)
async def post_lasso_route(request: LassoRouteRequest) -> LassoRouteResponse:
    if not request.opportunities:
        raise HTTPException(status_code=400, detail="opportunities cannot be empty")
    try:
        return await routing.build_lasso_route(request)
    except routing.LassoRoutingConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except routing.LassoRoutingError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/routes/save", response_model=SaveRouteResponse)
def post_save_route(request: SaveRouteRequest) -> SaveRouteResponse:
    return storage.save_route(request)


@app.get("/api/routes", response_model=List[SavedRouteSummary])
def get_saved_routes(icl_code: str = Query(..., min_length=1, max_length=32)) -> List[SavedRouteSummary]:
    if not re.match(r"^[A-Za-z0-9_-]+$", icl_code):
        raise HTTPException(status_code=400, detail="Invalid icl_code")
    return storage.list_routes(icl_code)


@app.get("/api/routes/{route_id}", response_model=SavedRouteDetail)
def get_saved_route(route_id: str) -> SavedRouteDetail:
    detail = storage.get_route(route_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Saved route not found")
    return detail


@app.post("/api/snapshots", response_model=SaveSnapshotResponse)
def post_snapshot(request: SaveSnapshotRequest) -> SaveSnapshotResponse:
    if not re.match(r"^[A-Za-z0-9_-]+$", request.icl_code):
        raise HTTPException(status_code=400, detail="Invalid icl_code")
    if not re.match(r"^[A-Za-z0-9]{15,18}$", request.rep_owner_id):
        raise HTTPException(status_code=400, detail="Invalid rep_owner_id")
    if not request.opportunities:
        raise HTTPException(status_code=400, detail="opportunities cannot be empty")
    return storage.save_snapshot(request)


@app.get("/api/snapshots", response_model=List[SnapshotSummary])
def get_snapshots(
    icl_code: str = Query(..., min_length=1, max_length=32),
    rep_owner_id: str | None = Query(default=None),
) -> List[SnapshotSummary]:
    if not re.match(r"^[A-Za-z0-9_-]+$", icl_code):
        raise HTTPException(status_code=400, detail="Invalid icl_code")
    if rep_owner_id and not re.match(r"^[A-Za-z0-9]{15,18}$", rep_owner_id):
        raise HTTPException(status_code=400, detail="Invalid rep_owner_id")
    return storage.list_snapshots(icl_code, rep_owner_id)


@app.get("/api/snapshots/{snapshot_id}", response_model=SnapshotDetail)
def get_snapshot(snapshot_id: str) -> SnapshotDetail:
    detail = storage.get_snapshot(snapshot_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return detail


@app.patch("/api/snapshots/{snapshot_id}/zones")
def patch_snapshot_zones(
    snapshot_id: str, request: UpdateSnapshotZonesRequest
) -> dict:
    if not storage.update_snapshot_zones(snapshot_id, request.zone_overrides):
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return {"ok": True}


@app.patch("/api/snapshots/{snapshot_id}/zone-notes")
def patch_snapshot_zone_notes(
    snapshot_id: str, request: UpdateSnapshotNotesRequest
) -> dict:
    if not storage.update_snapshot_zone_notes(snapshot_id, request.zone_notes):
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return {"ok": True}


@app.patch("/api/routes/{route_id}", response_model=SavedRouteDetail)
def patch_route(route_id: str, request: UpdateRouteRequest) -> SavedRouteDetail:
    detail = storage.update_route(route_id, request.label, request.notes)
    if detail is None:
        raise HTTPException(status_code=404, detail="Saved route not found")
    return detail


@app.get("/api/snapshots/{snapshot_id}/routes", response_model=List[SavedRouteDetail])
def get_snapshot_routes(snapshot_id: str) -> List[SavedRouteDetail]:
    return storage.list_routes_for_snapshot(snapshot_id)


@app.patch("/api/snapshots/{snapshot_id}/corrections", response_model=SnapshotDetail)
def patch_snapshot_corrections(
    snapshot_id: str, request: UpdateSnapshotCorrectionsRequest
) -> SnapshotDetail:
    if not request.corrections:
        raise HTTPException(status_code=400, detail="corrections cannot be empty")
    detail = storage.apply_snapshot_corrections(
        snapshot_id, [c.model_dump() for c in request.corrections]
    )
    if detail is None:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return detail


@app.get("/api/geocode/providers")
def get_geocode_providers() -> dict:
    return {
        "google": bool(os.environ.get("GOOGLE_MAPS_API_KEY")),
        "ors": bool(os.environ.get("ORS_API_KEY")),
    }


@app.post("/api/geocode", response_model=GeocodeResponse)
async def post_geocode(request: GeocodeRequest) -> GeocodeResponse:
    if not request.addresses:
        raise HTTPException(status_code=400, detail="addresses cannot be empty")
    try:
        results = await geocoding.geocode_batch(request.provider, request.addresses)
    except geocoding.GeocodingConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return GeocodeResponse(provider=request.provider, results=results)
