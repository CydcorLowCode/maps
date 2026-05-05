"""
Lasso route builder via OpenRouteService.

Given a starting point, an optional ending point, and a set of opportunities,
this calls ORS Optimization (VROOM) to compute the optimal visit order for
foot-walking, then ORS Directions to get the actual walking polyline + per-leg
distance/duration. The result is a single ordered route with one leg between
each pair of consecutive stops.
"""
from __future__ import annotations

import os
from typing import List, Optional

import httpx

from .models import (
    LassoLeg,
    LassoRouteRequest,
    LassoRouteResponse,
    LassoStop,
    LassoWaypoint,
    OpportunityPin,
)

ORS_OPTIMIZATION_URL = "https://api.openrouteservice.org/optimization"
ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/foot-walking"

TIMEOUT_S = 30.0


class LassoRoutingConfigError(RuntimeError):
    pass


class LassoRoutingError(RuntimeError):
    pass


def _coord(pin_or_wp) -> List[float]:
    return [float(pin_or_wp.lng), float(pin_or_wp.lat)]


async def _optimize_order(
    client: httpx.AsyncClient,
    start: LassoWaypoint,
    end: LassoWaypoint,
    opportunities: List[OpportunityPin],
    api_key: str,
) -> List[int]:
    """Returns the opportunity indices (0-based into the input list) in optimal visit order."""
    jobs = [
        {"id": i + 1, "location": _coord(p)}
        for i, p in enumerate(opportunities)
    ]
    vehicle = {
        "id": 1,
        "profile": "foot-walking",
        "start": _coord(start),
        "end": _coord(end),
    }
    body = {"jobs": jobs, "vehicles": [vehicle]}

    resp = await client.post(
        ORS_OPTIMIZATION_URL,
        headers={"Authorization": api_key, "Content-Type": "application/json"},
        json=body,
        timeout=TIMEOUT_S,
    )
    if resp.status_code >= 400:
        raise LassoRoutingError(f"ORS optimization failed: {resp.status_code} {resp.text}")
    data = resp.json()

    routes = data.get("routes") or []
    if not routes:
        unassigned = data.get("unassigned") or []
        raise LassoRoutingError(
            f"ORS optimization returned no route. Unassigned: {len(unassigned)}"
        )

    steps = routes[0].get("steps") or []
    order: List[int] = []
    for step in steps:
        if step.get("type") == "job":
            job_id = int(step["id"])
            order.append(job_id - 1)
    return order


async def _directions(
    client: httpx.AsyncClient,
    coordinates: List[List[float]],
    api_key: str,
) -> dict:
    # Note: when instructions=false, ORS omits the segments[] array entirely,
    # leaving us with only the summary. We need per-leg distance/duration, so
    # accept the instruction-step payload (we ignore it on the response side).
    body = {
        "coordinates": coordinates,
        "geometry": True,
    }
    resp = await client.post(
        ORS_DIRECTIONS_URL,
        headers={"Authorization": api_key, "Content-Type": "application/json"},
        json=body,
        timeout=TIMEOUT_S,
    )
    if resp.status_code >= 400:
        raise LassoRoutingError(f"ORS directions failed: {resp.status_code} {resp.text}")
    data = resp.json()
    routes = data.get("routes") or []
    if not routes:
        raise LassoRoutingError("ORS directions returned no route")
    return routes[0]


async def build_lasso_route(
    request: LassoRouteRequest,
    api_key_override: Optional[str] = None,
) -> LassoRouteResponse:
    api_key = api_key_override or os.environ.get("ORS_API_KEY")
    if not api_key:
        raise LassoRoutingConfigError("ORS_API_KEY is not set")

    if not request.opportunities:
        raise LassoRoutingError("opportunities cannot be empty")

    start = request.start
    end = request.end if request.end is not None else (
        request.start if request.round_trip else request.start
    )

    pins_by_id = {p.id: p for p in request.opportunities}
    pins = list(request.opportunities)

    async with httpx.AsyncClient() as client:
        if len(pins) == 1:
            order = [0]
        else:
            order = await _optimize_order(client, start, end, pins, api_key)

        ordered_pins = [pins[i] for i in order]
        coordinates = (
            [_coord(start)]
            + [_coord(p) for p in ordered_pins]
            + [_coord(end)]
        )

        route = await _directions(client, coordinates, api_key)

    summary = route.get("summary") or {}
    segments = route.get("segments") or []
    geometry = route.get("geometry")  # encoded polyline (ORS default)

    stops: List[LassoStop] = []
    # Stop 0 = start waypoint, then opportunities, then end as final stop.
    stops.append(
        LassoStop(
            stop_number=0,
            kind="start",
            opportunity_id=None,
            label=start.label,
            street=None,
            city=None,
            lat=start.lat,
            lng=start.lng,
        )
    )
    for i, p in enumerate(ordered_pins, start=1):
        stops.append(
            LassoStop(
                stop_number=i,
                kind="opportunity",
                opportunity_id=p.id,
                label=p.name,
                street=p.street,
                city=p.city,
                lat=p.lat,
                lng=p.lng,
            )
        )
    stops.append(
        LassoStop(
            stop_number=len(ordered_pins) + 1,
            kind="end",
            opportunity_id=None,
            label=end.label,
            street=None,
            city=None,
            lat=end.lat,
            lng=end.lng,
        )
    )

    legs: List[LassoLeg] = []
    for idx, seg in enumerate(segments):
        legs.append(
            LassoLeg(
                from_stop=idx,
                to_stop=idx + 1,
                distance_m=float(seg.get("distance") or 0.0),
                duration_s=float(seg.get("duration") or 0.0),
            )
        )

    # Sanity check: ORS returns one segment per coordinate pair, so legs == len(stops) - 1.
    # If counts disagree we still return what we have rather than failing.

    _ = pins_by_id  # silence linter; reserved for future enrichment

    return LassoRouteResponse(
        stops=stops,
        legs=legs,
        total_distance_m=float(summary.get("distance") or 0.0),
        total_duration_s=float(summary.get("duration") or 0.0),
        polyline=geometry if isinstance(geometry, str) else None,
        provider="ors",
        profile="foot-walking",
    )
