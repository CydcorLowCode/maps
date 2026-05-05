"""
Wraps address_order_method.route_core.build_routes_from_dataframe so the
algorithm is the source of truth.

Pipeline:
  1. Cluster opportunities by spatial gap (cluster_eps_meters). Tiny clusters
     (< cluster_min_size) merge into their nearest neighbor cluster.
  2. For each cluster, build a DataFrame with a starting row at index 0 and
     run build_routes_from_dataframe. The cluster containing the user's
     starting_opportunity_id starts there; other clusters start at the lead
     closest to that cluster's centroid.
  3. Concatenate per-cluster results, offsetting Route # so each cluster's
     routes get distinct numbers in the merged AutoRouteResponse.
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import List, Sequence, Tuple

import pandas as pd

from .models import (
    AutoRouteRequest,
    AutoRouteResponse,
    OpportunityPin,
    RoutePayload,
    RouteSegment,
    RouteStop,
)

# Add the maps repo root so `address_order_method` is importable as a sibling.
_MAPS_ROOT = Path(__file__).resolve().parents[3]
if str(_MAPS_ROOT) not in sys.path:
    sys.path.insert(0, str(_MAPS_ROOT))

from address_order_method.route_core import build_routes_from_dataframe  # noqa: E402


def _opportunity_to_row(pin: OpportunityPin) -> dict:
    return {
        "Stop #": None,
        "Street": pin.street,
        "City": pin.city or "",
        "State": pin.state or "",
        "PostalCode": pin.postal_code or "",
        "Latitude": pin.lat,
        "Longitude": pin.lng,
        "OpportunityId": pin.id,
    }


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _cluster_pins(
    pins: Sequence[OpportunityPin],
    eps_meters: float,
    min_size: int,
) -> List[List[int]]:
    """Single-link clustering by haversine gap. Returns lists of pin indices."""
    n = len(pins)
    if n == 0:
        return []
    parents = list(range(n))

    def find(i: int) -> int:
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parents[ri] = rj

    if eps_meters > 0:
        for i in range(n):
            for j in range(i + 1, n):
                if _haversine_m(pins[i].lat, pins[i].lng, pins[j].lat, pins[j].lng) <= eps_meters:
                    union(i, j)

    groups: dict[int, List[int]] = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)
    clusters = list(groups.values())

    if min_size > 1 and len(clusters) > 1:
        big = [c for c in clusters if len(c) >= min_size]
        small = [c for c in clusters if len(c) < min_size]
        if big:
            for s in small:
                best_idx = 0
                best_dist = float("inf")
                for k, b in enumerate(big):
                    d = min(
                        _haversine_m(pins[i].lat, pins[i].lng, pins[j].lat, pins[j].lng)
                        for i in s
                        for j in b
                    )
                    if d < best_dist:
                        best_dist = d
                        best_idx = k
                big[best_idx].extend(s)
            clusters = big

    return clusters


def _starting_index(pins: Sequence[OpportunityPin]) -> int:
    """Pick the pin closest to the cluster centroid as a default start."""
    n = len(pins)
    if n == 1:
        return 0
    clat = sum(p.lat for p in pins) / n
    clng = sum(p.lng for p in pins) / n
    best = 0
    best_d = float("inf")
    for i, p in enumerate(pins):
        d = _haversine_m(p.lat, p.lng, clat, clng)
        if d < best_d:
            best_d = d
            best = i
    return best


def _build_cluster(
    cluster_pins: List[OpportunityPin],
    starting_index: int,
    request: AutoRouteRequest,
    pins_by_id: dict[str, OpportunityPin],
    route_number_offset: int,
) -> Tuple[List[RoutePayload], int]:
    """Run build_routes_from_dataframe for one cluster. Returns (routes, max_route_number_used)."""
    if not cluster_pins:
        return [], route_number_offset

    starting = cluster_pins[starting_index]
    rest = [p for i, p in enumerate(cluster_pins) if i != starting_index]
    rows = [_opportunity_to_row(starting)] + [_opportunity_to_row(p) for p in rest]
    raw_df = pd.DataFrame(rows)
    raw_df["Stop #"] = range(1, len(raw_df) + 1)

    ordered, segment_summary = build_routes_from_dataframe(
        raw_df=raw_df,
        min_stops=request.min_stops,
        max_stops=request.max_stops,
        target_stops=request.target_stops,
    )

    summary_by_unit = {row["Canvass Unit ID"]: row for _, row in segment_summary.iterrows()}

    routes: dict[int, dict] = defaultdict(lambda: {"stops": [], "segment_ids_in_order": []})
    for _, row in ordered.iterrows():
        local_route_number = int(row["Route #"])
        unit_id = str(row["Canvass Unit ID"])
        opp_id = str(row.get("OpportunityId") or "")
        pin = pins_by_id.get(opp_id)
        lat = float(row["Latitude"]) if not _is_nan(row.get("Latitude")) else (pin.lat if pin else 0.0)
        lng = float(row["Longitude"]) if not _is_nan(row.get("Longitude")) else (pin.lng if pin else 0.0)

        stop = RouteStop(
            stop_number=int(row["Route Stop #"]),
            opportunity_id=opp_id,
            street=str(row.get("Street") or (pin.street if pin else "")),
            city=str(row.get("City") or (pin.city if pin else "")) or None,
            lat=lat,
            lng=lng,
            segment_id=unit_id,
            segment_color=str(row.get("Segment Color") or ""),
            segment_direction=str(row.get("Segment Direction") or "forward"),
            stop_range=str(row.get("Route Stop Range") or ""),
        )
        routes[local_route_number]["stops"].append(stop)
        if unit_id not in routes[local_route_number]["segment_ids_in_order"]:
            routes[local_route_number]["segment_ids_in_order"].append(unit_id)

    payload: List[RoutePayload] = []
    max_number_used = route_number_offset
    for local_route_number in sorted(routes.keys()):
        global_number = route_number_offset + local_route_number
        max_number_used = max(max_number_used, global_number)
        stops = routes[local_route_number]["stops"]
        segments: List[RouteSegment] = []
        for order_within_route, unit_id in enumerate(
            routes[local_route_number]["segment_ids_in_order"], start=1
        ):
            summary_row = summary_by_unit.get(unit_id, {})
            segments.append(
                RouteSegment(
                    segment_id=unit_id,
                    segment_order=order_within_route,
                    stop_range=str(summary_row.get("Route Stop Range") or ""),
                    color=str(summary_row.get("Segment Color") or ""),
                    street_display=str(summary_row.get("Street Display") or ""),
                    block_label=str(summary_row.get("Address Block") or ""),
                    side_label=str(summary_row.get("Street Side") or ""),
                    direction=str(summary_row.get("Segment Direction") or "forward"),
                    stop_count=int(summary_row.get("Stop Count") or 0),
                )
            )
        payload.append(RoutePayload(route_number=global_number, stops=stops, segments=segments))

    return payload, max_number_used


def build_auto_route(request: AutoRouteRequest) -> AutoRouteResponse:
    pins_by_id = {pin.id: pin for pin in request.opportunities}
    if request.starting_opportunity_id not in pins_by_id:
        raise ValueError("starting_opportunity_id not present in opportunities list")

    pins = list(request.opportunities)
    cluster_indices = _cluster_pins(
        pins,
        eps_meters=request.cluster_eps_meters,
        min_size=request.cluster_min_size,
    )

    # Identify which cluster owns the user's starting opportunity.
    start_idx_global = next(
        i for i, p in enumerate(pins) if p.id == request.starting_opportunity_id
    )
    starting_cluster = next(
        (k for k, c in enumerate(cluster_indices) if start_idx_global in c),
        0,
    )

    # Order clusters: starting cluster first, then others by ascending centroid
    # distance from starting cluster's centroid (so the rep can drive between
    # them in a vaguely sensible sequence).
    def centroid(c: List[int]) -> Tuple[float, float]:
        lat = sum(pins[i].lat for i in c) / len(c)
        lng = sum(pins[i].lng for i in c) / len(c)
        return lat, lng

    centroids = [centroid(c) for c in cluster_indices]
    start_centroid = centroids[starting_cluster]
    ordered_cluster_keys = [starting_cluster] + sorted(
        [k for k in range(len(cluster_indices)) if k != starting_cluster],
        key=lambda k: _haversine_m(
            start_centroid[0], start_centroid[1], centroids[k][0], centroids[k][1]
        ),
    )

    all_routes: List[RoutePayload] = []
    next_offset = 0
    for k in ordered_cluster_keys:
        cluster_pin_list = [pins[i] for i in cluster_indices[k]]
        if k == starting_cluster:
            local_start = next(
                i for i, p in enumerate(cluster_pin_list) if p.id == request.starting_opportunity_id
            )
        else:
            local_start = _starting_index(cluster_pin_list)
        routes, max_used = _build_cluster(
            cluster_pin_list,
            starting_index=local_start,
            request=request,
            pins_by_id=pins_by_id,
            route_number_offset=next_offset,
        )
        all_routes.extend(routes)
        next_offset = max_used

    return AutoRouteResponse(routes=all_routes)


def _is_nan(value) -> bool:
    try:
        return math.isnan(float(value))
    except (TypeError, ValueError):
        return value is None
