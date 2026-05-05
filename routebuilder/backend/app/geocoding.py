"""
Address geocoding via Google or OpenRouteService (Pelias).

Both providers are called per-address with bounded concurrency so a zone's worth
of leads (typically a few dozen) returns in well under a second. Failures on
individual addresses are reported in the response rather than aborting the
whole batch — the UI shows them as "failed" pins next to the originals.
"""
from __future__ import annotations

import asyncio
import os
from typing import List, Optional

import httpx

from .models import GeocodeAddress, GeocodeResult

GOOGLE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
ORS_URL = "https://api.openrouteservice.org/geocode/search/structured"

CONCURRENCY = 8
TIMEOUT_S = 15.0


class GeocodingConfigError(RuntimeError):
    pass


def _format_address(addr: GeocodeAddress) -> str:
    parts = [addr.street, addr.city, addr.state, addr.postal_code]
    return ", ".join(p for p in parts if p)


async def _geocode_one_google(
    client: httpx.AsyncClient,
    addr: GeocodeAddress,
    api_key: str,
) -> GeocodeResult:
    try:
        resp = await client.get(
            GOOGLE_URL,
            params={"address": _format_address(addr), "key": api_key},
            timeout=TIMEOUT_S,
        )
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as exc:
        return GeocodeResult(id=addr.id, status="error", error=str(exc))

    status = data.get("status", "UNKNOWN")
    if status == "OK" and data.get("results"):
        first = data["results"][0]
        loc = first["geometry"]["location"]
        return GeocodeResult(
            id=addr.id,
            status="ok",
            lat=float(loc["lat"]),
            lng=float(loc["lng"]),
            formatted_address=first.get("formatted_address"),
            location_type=first.get("geometry", {}).get("location_type"),
            provider="google",
        )
    if status == "ZERO_RESULTS":
        return GeocodeResult(id=addr.id, status="no_match", provider="google")
    return GeocodeResult(
        id=addr.id,
        status="error",
        error=data.get("error_message") or status,
        provider="google",
    )


async def _geocode_one_ors(
    client: httpx.AsyncClient,
    addr: GeocodeAddress,
    api_key: str,
) -> GeocodeResult:
    params = {
        "api_key": api_key,
        "address": addr.street,
    }
    if addr.city:
        params["locality"] = addr.city
    if addr.state:
        params["region"] = addr.state
    if addr.postal_code:
        params["postalcode"] = addr.postal_code
    params.setdefault("country", "USA")

    try:
        resp = await client.get(ORS_URL, params=params, timeout=TIMEOUT_S)
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as exc:
        return GeocodeResult(id=addr.id, status="error", error=str(exc), provider="ors")

    features = data.get("features") or []
    if not features:
        return GeocodeResult(id=addr.id, status="no_match", provider="ors")

    first = features[0]
    coords = first.get("geometry", {}).get("coordinates")  # [lng, lat]
    props = first.get("properties", {})
    if not coords or len(coords) < 2:
        return GeocodeResult(id=addr.id, status="error", error="No coordinates", provider="ors")

    return GeocodeResult(
        id=addr.id,
        status="ok",
        lat=float(coords[1]),
        lng=float(coords[0]),
        formatted_address=props.get("label"),
        location_type=props.get("accuracy") or props.get("match_type"),
        provider="ors",
    )


async def geocode_batch(
    provider: str,
    addresses: List[GeocodeAddress],
    api_key_override: Optional[str] = None,
) -> List[GeocodeResult]:
    if provider not in ("google", "ors"):
        raise ValueError(f"Unknown provider: {provider}")

    if provider == "google":
        api_key = api_key_override or os.environ.get("GOOGLE_MAPS_API_KEY")
        if not api_key:
            raise GeocodingConfigError("GOOGLE_MAPS_API_KEY is not set")
        worker = _geocode_one_google
    else:
        api_key = api_key_override or os.environ.get("ORS_API_KEY")
        if not api_key:
            raise GeocodingConfigError("ORS_API_KEY is not set")
        worker = _geocode_one_ors

    sem = asyncio.Semaphore(CONCURRENCY)

    async with httpx.AsyncClient() as client:
        async def run_one(addr: GeocodeAddress) -> GeocodeResult:
            async with sem:
                return await worker(client, addr, api_key)

        return await asyncio.gather(*(run_one(a) for a in addresses))
