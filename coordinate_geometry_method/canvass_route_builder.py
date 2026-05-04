#!/usr/bin/env python3
"""
Canvass Route Builder - Phase 1

Purpose:
  Turn randomly ordered residential leads into human-walkable door-to-door routes.

Core behavior:
  - Normalizes addresses
  - Groups by street
  - Splits opposite sides using house-number parity
  - Infers street direction from lat/lng using PCA projection
  - Builds canvassing units: down one side, cross, back the other side
  - Packs units into 45-75 stop routes
  - Exports ordered CSV and optional Folium HTML map

Install:
  pip install pandas numpy folium

Run:
  python canvass_route_builder.py "Geopointe Route.csv" --output ordered_routes.csv --map route_map.html
"""

from __future__ import annotations

import argparse
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

try:
    import folium
    from folium.features import DivIcon
except Exception:  # pragma: no cover - map output is optional
    folium = None
    DivIcon = None


# -----------------------------
# Column detection / normalization
# -----------------------------

def _norm_col(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower()).strip("_")


def find_column(df: pd.DataFrame, candidates: Sequence[str], required: bool = True) -> Optional[str]:
    normalized = {_norm_col(c): c for c in df.columns}
    for cand in candidates:
        key = _norm_col(cand)
        if key in normalized:
            return normalized[key]
    if required:
        raise ValueError(f"Missing required column. Looked for one of: {candidates}. Available: {list(df.columns)}")
    return None


# -----------------------------
# Address utilities
# -----------------------------

SUFFIX_NORMALIZATION = {
    "street": "st", "st.": "st", "st": "st",
    "avenue": "ave", "ave.": "ave", "ave": "ave",
    "road": "rd", "rd.": "rd", "rd": "rd",
    "drive": "dr", "dr.": "dr", "dr": "dr",
    "lane": "ln", "ln.": "ln", "ln": "ln",
    "court": "ct", "ct.": "ct", "ct": "ct",
    "place": "pl", "pl.": "pl", "pl": "pl",
    "terrace": "ter", "ter.": "ter", "ter": "ter",
    "circle": "cir", "cir.": "cir", "cir": "cir",
    "boulevard": "blvd", "blvd.": "blvd", "blvd": "blvd",
    "way": "way",
    "parkway": "pkwy", "pkwy.": "pkwy", "pkwy": "pkwy",
}

DIRECTION_NORMALIZATION = {
    "north": "n", "south": "s", "east": "e", "west": "w",
    "n.": "n", "s.": "s", "e.": "e", "w.": "w",
    "n": "n", "s": "s", "e": "e", "w": "w",
    "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw",
    "ne": "ne", "nw": "nw", "se": "se", "sw": "sw",
}


def parse_street_address(value: object) -> Tuple[Optional[int], str, str]:
    """Return (house_number, display_street_name, canonical_street_key)."""
    raw = "" if pd.isna(value) else str(value).strip()
    match = re.match(r"^\s*(\d+)\s+(.+?)\s*$", raw)
    if not match:
        return None, raw, canonical_street_name(raw)
    house_number = int(match.group(1))
    display = match.group(2).strip()
    return house_number, display, canonical_street_name(display)


def canonical_street_name(name: object) -> str:
    text = "" if pd.isna(name) else str(name).strip().lower()
    text = re.sub(r"[#].*$", "", text)
    text = re.sub(r"\b(apt|unit|suite|ste)\b.*$", "", text)
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    parts = [p for p in text.split() if p]
    cleaned = []
    for p in parts:
        cleaned.append(DIRECTION_NORMALIZATION.get(SUFFIX_NORMALIZATION.get(p, p), DIRECTION_NORMALIZATION.get(p, SUFFIX_NORMALIZATION.get(p, p))))
    return " ".join(cleaned)


def parity_from_house_number(n: Optional[int]) -> str:
    if n is None or pd.isna(n):
        return "unknown"
    return "even" if int(n) % 2 == 0 else "odd"


# -----------------------------
# Geometry utilities
# -----------------------------

def latlon_to_xy(lat: np.ndarray, lon: np.ndarray, lat0: float, lon0: float) -> Tuple[np.ndarray, np.ndarray]:
    """Convert lat/lon to approximate local meters around a reference point."""
    meters_per_deg_lat = 110_540.0
    meters_per_deg_lon = 111_320.0 * math.cos(math.radians(lat0))
    x = (lon - lon0) * meters_per_deg_lon
    y = (lat - lat0) * meters_per_deg_lat
    return x, y


def euclidean_m(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def infer_projection_for_group(group: pd.DataFrame) -> pd.Series:
    """Infer a 1D street-axis projection for each point in a street group."""
    if len(group) <= 1:
        return pd.Series([0.0] * len(group), index=group.index)

    xy = group[["x_m", "y_m"]].to_numpy(dtype=float)
    center = xy.mean(axis=0)
    centered = xy - center

    # PCA axis. If degenerate, use x-axis.
    try:
        cov = np.cov(centered.T)
        vals, vecs = np.linalg.eigh(cov)
        axis = vecs[:, np.argmax(vals)]
    except Exception:
        axis = np.array([1.0, 0.0])

    proj = centered @ axis

    # Make projection usually increase with house number when possible.
    nums = group["house_number"].to_numpy(dtype=float)
    valid = ~np.isnan(nums)
    if valid.sum() >= 3 and np.nanstd(nums[valid]) > 0 and np.nanstd(proj[valid]) > 0:
        corr = np.corrcoef(nums[valid], proj[valid])[0, 1]
        if corr < 0:
            proj = -proj

    # Normalize to start near zero for readability.
    proj = proj - np.nanmin(proj)
    return pd.Series(proj, index=group.index)


def assign_street_segments(df: pd.DataFrame, gap_multiplier: float = 4.0, min_gap_m: float = 90.0) -> pd.Series:
    """
    Split a street into separate geometric segments when projected gaps are large.
    This is a Phase 1 proxy for OSM intersection/block segmentation.
    """
    segment_ids = pd.Series(index=df.index, dtype="object")

    for street_key, group in df.groupby("street_key", dropna=False):
        if len(group) <= 1:
            segment_ids.loc[group.index] = f"{street_key}::seg0"
            continue

        ordered = group.sort_values("street_projection_m")
        gaps = ordered["street_projection_m"].diff().fillna(0).to_numpy()
        positive_gaps = gaps[gaps > 0]
        if len(positive_gaps) == 0:
            threshold = min_gap_m
        else:
            med = float(np.median(positive_gaps))
            threshold = max(min_gap_m, med * gap_multiplier)

        seg = 0
        values = []
        for gap in gaps:
            if gap > threshold:
                seg += 1
            values.append(f"{street_key}::seg{seg}")
        segment_ids.loc[ordered.index] = values

    return segment_ids


def assign_large_segment_chunks(df: pd.DataFrame, max_stops: int, target_stops: int) -> pd.Series:
    """Split very large street segments into projection-based chunks."""
    chunk_ids = pd.Series(index=df.index, dtype="object")
    for seg_id, group in df.groupby("street_segment_id", dropna=False):
        n = len(group)
        if n <= max_stops:
            chunk_ids.loc[group.index] = f"{seg_id}::chunk0"
            continue

        chunks = max(2, int(math.ceil(n / float(target_stops))))
        ordered = group.sort_values("street_projection_m")
        # np.array_split keeps chunks as even as possible.
        for i, idx_chunk in enumerate(np.array_split(ordered.index.to_numpy(), chunks)):
            chunk_ids.loc[idx_chunk] = f"{seg_id}::chunk{i}"
    return chunk_ids


# -----------------------------
# Canvass units
# -----------------------------

@dataclass
class UnitVariant:
    row_ids: List[int]
    start_xy: Tuple[float, float]
    end_xy: Tuple[float, float]


@dataclass
class CanvassUnit:
    unit_id: str
    row_ids: List[int]
    variants: List[UnitVariant]
    count: int
    centroid_xy: Tuple[float, float]
    street_names: str


def unique_variants(variants: Iterable[List[int]], df: pd.DataFrame) -> List[UnitVariant]:
    seen = set()
    out: List[UnitVariant] = []
    for seq in variants:
        seq = [int(x) for x in seq]
        if not seq:
            continue
        key = tuple(seq)
        if key in seen:
            continue
        seen.add(key)
        first = df.loc[seq[0]]
        last = df.loc[seq[-1]]
        out.append(UnitVariant(
            row_ids=seq,
            start_xy=(float(first["x_m"]), float(first["y_m"])),
            end_xy=(float(last["x_m"]), float(last["y_m"])),
        ))
    return out


def build_canvass_units(df: pd.DataFrame) -> List[CanvassUnit]:
    """Build ordered street-side/pair units."""
    units: List[CanvassUnit] = []

    for chunk_id, group in df.groupby("segment_chunk_id", dropna=False):
        if group.empty:
            continue

        # Use parity as Phase 1 side-of-street signal.
        side_groups: Dict[str, List[int]] = {}
        for side, sg in group.groupby("parity", dropna=False):
            ordered = sg.sort_values(["house_number", "street_projection_m", "Latitude", "Longitude"])
            side_groups[str(side)] = [int(i) for i in ordered.index.tolist()]

        known_sides = [s for s in ["odd", "even"] if s in side_groups and len(side_groups[s]) > 0]
        unknown_sides = [s for s in side_groups if s not in {"odd", "even"}]

        variants: List[List[int]] = []

        if len(known_sides) == 2:
            odd = side_groups["odd"]
            even = side_groups["even"]
            # Four valid canvassing variants:
            # start odd near end, start even near end, start odd far end, start even far end.
            variants.extend([
                odd + list(reversed(even)),
                even + list(reversed(odd)),
                list(reversed(odd)) + even,
                list(reversed(even)) + odd,
            ])
            row_ids = odd + even
        elif len(known_sides) == 1:
            side_rows = side_groups[known_sides[0]]
            variants.extend([side_rows, list(reversed(side_rows))])
            row_ids = side_rows
        else:
            ordered = group.sort_values(["street_projection_m", "Latitude", "Longitude"]).index.astype(int).tolist()
            variants.extend([ordered, list(reversed(ordered))])
            row_ids = ordered

        # Unknown house numbers become their own simple units so they don't poison parity logic.
        for uside in unknown_sides:
            ordered_unknown = side_groups[uside]
            if ordered_unknown:
                uid = f"{chunk_id}::{uside}"
                centroid = df.loc[ordered_unknown, ["x_m", "y_m"]].mean().to_numpy()
                uvars = unique_variants([ordered_unknown, list(reversed(ordered_unknown))], df)
                units.append(CanvassUnit(
                    unit_id=uid,
                    row_ids=ordered_unknown,
                    variants=uvars,
                    count=len(ordered_unknown),
                    centroid_xy=(float(centroid[0]), float(centroid[1])),
                    street_names=", ".join(sorted(df.loc[ordered_unknown, "street_display"].dropna().unique())),
                ))

        uid = str(chunk_id)
        row_ids = [int(x) for x in row_ids]
        centroid = df.loc[row_ids, ["x_m", "y_m"]].mean().to_numpy()
        units.append(CanvassUnit(
            unit_id=uid,
            row_ids=row_ids,
            variants=unique_variants(variants, df),
            count=len(row_ids),
            centroid_xy=(float(centroid[0]), float(centroid[1])),
            street_names=", ".join(sorted(df.loc[row_ids, "street_display"].dropna().unique())),
        ))

    return units


# -----------------------------
# Packing and sequencing
# -----------------------------

def distance_point_to_route(unit: CanvassUnit, route_units: List[CanvassUnit]) -> float:
    if not route_units:
        return 0.0
    return min(euclidean_m(unit.centroid_xy, other.centroid_xy) for other in route_units)


def pack_units_into_routes(units: List[CanvassUnit], min_stops: int, max_stops: int, target_stops: int) -> List[List[CanvassUnit]]:
    """
    Capacity-aware greedy clustering of canvass units.
    This intentionally packs logical units, not individual dots.
    """
    unassigned = list(units)
    routes: List[List[CanvassUnit]] = []

    while unassigned:
        # Start with a spatially extreme unit for stable, neighborhood-sweep-like output.
        seed = min(unassigned, key=lambda u: (u.centroid_xy[1], u.centroid_xy[0]))
        route = [seed]
        unassigned.remove(seed)
        count = seed.count

        while unassigned:
            candidates = []
            for unit in unassigned:
                new_count = count + unit.count
                if new_count > max_stops:
                    continue
                dist = distance_point_to_route(unit, route)
                # Slightly prefer filling toward target/min instead of creating many small routes.
                capacity_penalty = abs(target_stops - new_count) * 2.0
                candidates.append((dist + capacity_penalty, dist, unit))

            if not candidates:
                break

            candidates.sort(key=lambda x: (x[0], x[1], x[2].count))
            chosen = candidates[0][2]

            # Keep adding until at least min. After target, only add very nearby units.
            projected_count = count + chosen.count
            chosen_dist = candidates[0][1]
            if count >= min_stops and projected_count > target_stops and chosen_dist > 180:
                break

            route.append(chosen)
            unassigned.remove(chosen)
            count += chosen.count

            if count >= target_stops:
                # Stop at target unless a tiny neighboring unit gets us closer to max without ugly sprawl.
                nearby = [u for u in unassigned if count + u.count <= max_stops and distance_point_to_route(u, route) <= 90]
                if not nearby:
                    break

        routes.append(route)

    # Try to merge final tiny route into nearby existing routes when capacity allows.
    changed = True
    while changed and len(routes) > 1:
        changed = False
        small_routes = [r for r in routes if sum(u.count for u in r) < min_stops]
        for small in small_routes:
            small_count = sum(u.count for u in small)
            best = None
            for target in routes:
                if target is small:
                    continue
                target_count = sum(u.count for u in target)
                if target_count + small_count > max_stops:
                    continue
                dist = min(euclidean_m(a.centroid_xy, b.centroid_xy) for a in small for b in target)
                if best is None or dist < best[0]:
                    best = (dist, target)
            if best:
                best[1].extend(small)
                routes.remove(small)
                changed = True
                break

    return routes


def sequence_route_units(
    route_units: List[CanvassUnit],
    df: pd.DataFrame,
    start_mode: str = "auto",
) -> List[Tuple[CanvassUnit, UnitVariant]]:
    """Order route units and choose the best variant orientation for each."""
    remaining = list(route_units)
    sequence: List[Tuple[CanvassUnit, UnitVariant]] = []

    # Starting strategy:
    # - auto/original_first: if an original Stop # exists, start closest to the lowest original stop in this route.
    # - southwest: otherwise start from a spatial edge for stable neighborhood-sweep output.
    route_row_ids = [rid for unit in remaining for rid in unit.row_ids]
    target_xy = None
    if start_mode in {"auto", "original_first"} and "original_stop" in df.columns:
        numeric_stops = pd.to_numeric(df.loc[route_row_ids, "original_stop"], errors="coerce")
        if numeric_stops.notna().any():
            start_row_id = int(numeric_stops.idxmin())
            start_row = df.loc[start_row_id]
            target_xy = (float(start_row["x_m"]), float(start_row["y_m"]))

    best_start = None
    for unit in remaining:
        for variant in unit.variants:
            if target_xy is not None:
                key = (euclidean_m(target_xy, variant.start_xy), variant.start_xy[1], variant.start_xy[0])
            else:
                key = (variant.start_xy[1], variant.start_xy[0])
            if best_start is None or key < best_start[0]:
                best_start = (key, unit, variant)

    _, current_unit, current_variant = best_start
    sequence.append((current_unit, current_variant))
    remaining.remove(current_unit)
    current_exit = current_variant.end_xy

    while remaining:
        best = None
        for unit in remaining:
            for variant in unit.variants:
                dist = euclidean_m(current_exit, variant.start_xy)
                if best is None or dist < best[0]:
                    best = (dist, unit, variant)
        _, unit, variant = best
        sequence.append((unit, variant))
        remaining.remove(unit)
        current_exit = variant.end_xy

    return sequence


# -----------------------------
# Main pipeline
# -----------------------------

def build_routes(
    input_csv: Path,
    min_stops: int = 45,
    max_stops: int = 75,
    target_stops: int = 60,
    start_mode: str = "auto",
) -> Tuple[pd.DataFrame, List[List[Tuple[CanvassUnit, UnitVariant]]]]:
    raw = pd.read_csv(input_csv)

    lat_col = find_column(raw, ["Latitude", "lat"])
    lon_col = find_column(raw, ["Longitude", "lng", "lon", "long"])
    street_col = find_column(raw, ["Street", "Address", "Street Address", "street_address"])
    original_stop_col = find_column(raw, ["Stop #", "Stop", "stop_number", "sequence"], required=False)

    df = raw.copy()
    df["Latitude"] = pd.to_numeric(df[lat_col], errors="coerce")
    df["Longitude"] = pd.to_numeric(df[lon_col], errors="coerce")
    df = df.dropna(subset=["Latitude", "Longitude"]).copy()

    parsed = df[street_col].apply(parse_street_address)
    df["house_number"] = parsed.apply(lambda x: x[0]).astype("float")
    df["street_display"] = parsed.apply(lambda x: x[1])
    df["street_key"] = parsed.apply(lambda x: x[2])
    df["parity"] = df["house_number"].apply(parity_from_house_number)

    if original_stop_col:
        df["original_stop"] = df[original_stop_col]
    else:
        df["original_stop"] = np.arange(1, len(df) + 1)

    lat0 = float(df["Latitude"].mean())
    lon0 = float(df["Longitude"].mean())
    df["x_m"], df["y_m"] = latlon_to_xy(df["Latitude"].to_numpy(), df["Longitude"].to_numpy(), lat0, lon0)

    df["street_projection_m"] = np.nan
    for _, group in df.groupby("street_key", dropna=False):
        df.loc[group.index, "street_projection_m"] = infer_projection_for_group(group)

    df["street_segment_id"] = assign_street_segments(df)
    df["segment_chunk_id"] = assign_large_segment_chunks(df, max_stops=max_stops, target_stops=target_stops)

    units = build_canvass_units(df)
    routes_as_units = pack_units_into_routes(units, min_stops=min_stops, max_stops=max_stops, target_stops=target_stops)
    sequenced_routes = [sequence_route_units(route, df, start_mode=start_mode) for route in routes_as_units]

    ordered_row_ids: List[int] = []
    route_ids: List[int] = []
    route_stop_numbers: List[int] = []
    unit_ids: List[str] = []
    unit_sequence_numbers: List[int] = []

    for route_idx, route_sequence in enumerate(sequenced_routes, start=1):
        stop_counter = 1
        for unit_seq, (unit, variant) in enumerate(route_sequence, start=1):
            for row_id in variant.row_ids:
                ordered_row_ids.append(row_id)
                route_ids.append(route_idx)
                route_stop_numbers.append(stop_counter)
                unit_ids.append(unit.unit_id)
                unit_sequence_numbers.append(unit_seq)
                stop_counter += 1

    output = df.loc[ordered_row_ids].copy()
    output.insert(0, "Route #", route_ids)
    output.insert(1, "Route Stop #", route_stop_numbers)
    output.insert(2, "Canvass Unit #", unit_sequence_numbers)
    output.insert(3, "Canvass Unit ID", unit_ids)

    # User-facing route order should supersede any original Stop #.
    output = output.reset_index(drop=True)

    return output, sequenced_routes


def make_map(ordered: pd.DataFrame, map_path: Path) -> None:
    if folium is None:
        raise RuntimeError("folium is not installed. Run: pip install folium")

    center = [float(ordered["Latitude"].mean()), float(ordered["Longitude"].mean())]
    m = folium.Map(location=center, zoom_start=16, control_scale=True)

    # Folium marker colors. Keep short cycle.
    route_colors = ["blue", "red", "green", "purple", "orange", "darkred", "cadetblue", "darkgreen", "black"]

    for route_id, route_df in ordered.groupby("Route #"):
        route_df = route_df.sort_values("Route Stop #")
        color = route_colors[(int(route_id) - 1) % len(route_colors)]
        coords = route_df[["Latitude", "Longitude"]].values.tolist()
        if len(coords) >= 2:
            folium.PolyLine(coords, weight=3, opacity=0.75, color=color, tooltip=f"Route {route_id}").add_to(m)

        for _, row in route_df.iterrows():
            stop_no = int(row["Route Stop #"])
            route_no = int(row["Route #"])
            street = row.get("Street", row.get("street_display", ""))
            popup_html = f"""
            <div style="width:260px;">
              <b>Route {route_no}, Stop {stop_no}</b><br>
              <b>Original Stop:</b> {row.get('original_stop', '')}<br>
              <b>Address:</b> {street}<br>
              <b>Street Side:</b> {row.get('parity', '')}<br>
              <b>Unit:</b> {row.get('Canvass Unit ID', '')}<br>
            </div>
            """

            label = f"{stop_no}"
            icon_html = f"""
            <div style="position: relative; width: 32px; height: 44px;">
              <svg width="32" height="44" viewBox="0 0 32 44" xmlns="http://www.w3.org/2000/svg">
                <path d="M16 1C8.2 1 2 7.2 2 15c0 10.8 14 27.5 14 27.5S30 25.8 30 15C30 7.2 23.8 1 16 1z"
                      fill="#2b83ba" stroke="#1f5f87" stroke-width="1.5"/>
                <circle cx="16" cy="15" r="9" fill="white"/>
              </svg>
              <div style="position:absolute;top:7px;left:0;width:32px;text-align:center;font-size:10px;font-weight:bold;color:#111;line-height:16px;font-family:Arial,sans-serif;">{label}</div>
            </div>
            """

            folium.Marker(
                location=[float(row["Latitude"]), float(row["Longitude"])],
                popup=folium.Popup(popup_html, max_width=300),
                tooltip=f"Route {route_no}, Stop {stop_no}",
                icon=DivIcon(html=icon_html, icon_size=(32, 44), icon_anchor=(16, 44)),
            ).add_to(m)

    m.save(str(map_path))


def main() -> None:
    parser = argparse.ArgumentParser(description="Build human-walkable canvassing routes from unordered residential leads.")
    parser.add_argument("input_csv", type=Path, help="Input CSV with Street, Latitude, Longitude columns")
    parser.add_argument("--output", type=Path, default=Path("ordered_canvass_routes.csv"), help="Output ordered route CSV")
    parser.add_argument("--map", dest="map_path", type=Path, default=None, help="Optional output HTML map path")
    parser.add_argument("--min-stops", type=int, default=45)
    parser.add_argument("--max-stops", type=int, default=75)
    parser.add_argument("--target-stops", type=int, default=60)
    parser.add_argument(
        "--start-mode",
        choices=["auto", "original_first", "southwest"],
        default="auto",
        help="auto/original_first starts closest to lowest original Stop # when present; southwest uses a spatial edge.",
    )
    args = parser.parse_args()

    ordered, sequenced_routes = build_routes(
        args.input_csv,
        min_stops=args.min_stops,
        max_stops=args.max_stops,
        target_stops=args.target_stops,
        start_mode=args.start_mode,
    )
    ordered.to_csv(args.output, index=False)

    route_summary = ordered.groupby("Route #").size().rename("stop_count").reset_index()
    print("Route summary:")
    print(route_summary.to_string(index=False))
    print(f"\nWrote ordered CSV: {args.output}")

    if args.map_path:
        make_map(ordered, args.map_path)
        print(f"Wrote HTML map: {args.map_path}")


if __name__ == "__main__":
    main()
