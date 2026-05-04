#!/usr/bin/env python3
"""
Address-order canvass route builder.

This alternate Phase 1 builder keeps route order independent from lat/lng:
  - parse house number and street name
  - group records by street
  - split each street into odd/even sides
  - walk one side in ascending house-number order
  - cross at the end and walk the opposite side descending
  - pack those address-ordered units into 45-75 stop routes

Latitude and longitude are only used for optional map output.
"""

from __future__ import annotations

import argparse
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import pandas as pd

try:
    import folium
    from folium.features import DivIcon
except Exception:  # pragma: no cover - map output is optional
    folium = None
    DivIcon = None


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


@dataclass
class CanvassUnit:
    unit_id: str
    row_ids: List[int]

    @property
    def count(self) -> int:
        return len(self.row_ids)


def _norm_col(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower()).strip("_")


def find_column(df: pd.DataFrame, candidates: Sequence[str], required: bool = True) -> Optional[str]:
    normalized = {_norm_col(c): c for c in df.columns}
    for candidate in candidates:
        key = _norm_col(candidate)
        if key in normalized:
            return normalized[key]
    if required:
        raise ValueError(f"Missing required column. Looked for one of: {candidates}. Available: {list(df.columns)}")
    return None


def canonical_street_name(name: object) -> str:
    text = "" if pd.isna(name) else str(name).strip().lower()
    text = re.sub(r"[#].*$", "", text)
    text = re.sub(r"\b(apt|unit|suite|ste)\b.*$", "", text)
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    parts = [part for part in text.split() if part]
    cleaned = [
        DIRECTION_NORMALIZATION.get(
            SUFFIX_NORMALIZATION.get(part, part),
            DIRECTION_NORMALIZATION.get(part, SUFFIX_NORMALIZATION.get(part, part)),
        )
        for part in parts
    ]
    return " ".join(cleaned)


def parse_street_address(value: object) -> Tuple[Optional[int], str, str]:
    raw = "" if pd.isna(value) else str(value).strip()
    match = re.match(r"^\s*(\d+)\s+(.+?)\s*$", raw)
    if not match:
        return None, raw, canonical_street_name(raw)
    house_number = int(match.group(1))
    display = match.group(2).strip()
    return house_number, display, canonical_street_name(display)


def parity_from_house_number(house_number: Optional[int]) -> str:
    if house_number is None or pd.isna(house_number):
        return "unknown"
    return "even" if int(house_number) % 2 == 0 else "odd"


def ordered_side_rows(group: pd.DataFrame, side: str, ascending: bool) -> List[int]:
    side_df = group[group["parity"] == side]
    if side_df.empty:
        return []
    ordered = side_df.sort_values(
        ["house_number", "_source_order"],
        ascending=[ascending, True],
        na_position="last",
        kind="mergesort",
    )
    return [int(index) for index in ordered.index.tolist()]


def choose_first_side(group: pd.DataFrame, requested_side: str) -> str:
    available = [side for side in ("odd", "even") if not group[group["parity"] == side].empty]
    if not available:
        return "unknown"
    if requested_side in {"odd", "even"}:
        return requested_side if requested_side in available else available[0]

    side_mins = {
        side: float(group.loc[group["parity"] == side, "house_number"].min())
        for side in available
    }
    return min(side_mins, key=lambda side: (side_mins[side], side))


def build_loop_rows(group: pd.DataFrame, first_side: str) -> List[int]:
    first = choose_first_side(group, first_side)

    if first == "odd":
        return ordered_side_rows(group, "odd", True) + ordered_side_rows(group, "even", False)
    if first == "even":
        return ordered_side_rows(group, "even", True) + ordered_side_rows(group, "odd", False)
    return []


def build_starting_loop_rows(group: pd.DataFrame, start_row_id: int, fallback_first_side: str) -> List[int]:
    if start_row_id not in group.index:
        return build_loop_rows(group, fallback_first_side)

    start_row = group.loc[start_row_id]
    start_side = str(start_row["parity"])
    if start_side not in {"odd", "even"}:
        return build_loop_rows(group, fallback_first_side)

    same_side_asc = ordered_side_rows(group, start_side, True)
    if start_row_id not in same_side_asc:
        return build_loop_rows(group, fallback_first_side)

    # Preserve the first CSV row as the route start. If that row is an endpoint,
    # this remains a clean down-one-side/cross/back-the-other-side loop.
    if same_side_asc[0] == start_row_id:
        same_side = same_side_asc
        opposite_ascending = False
    elif same_side_asc[-1] == start_row_id:
        same_side = list(reversed(same_side_asc))
        opposite_ascending = True
    else:
        start_position = same_side_asc.index(start_row_id)
        toward_low = list(reversed(same_side_asc[:start_position + 1]))
        toward_high = same_side_asc[start_position + 1:]
        same_side = toward_low + toward_high
        opposite_ascending = True

    opposite_side = "even" if start_side == "odd" else "odd"
    return same_side + ordered_side_rows(group, opposite_side, opposite_ascending)


def build_street_units(
    df: pd.DataFrame,
    first_side: str,
    street_order: str,
    max_stops: int,
    target_stops: int,
    start_row_id: Optional[int] = None,
) -> List[CanvassUnit]:
    units: List[CanvassUnit] = []
    street_groups = []

    for street_key, group in df.groupby("street_key", sort=False, dropna=False):
        numeric_original = pd.to_numeric(group["original_stop"], errors="coerce")
        street_groups.append({
            "street_key": street_key,
            "group": group,
            "first_source_order": int(group["_source_order"].min()),
            "first_original_stop": float(numeric_original.min()) if numeric_original.notna().any() else math.inf,
        })

    start_street_key = df.loc[start_row_id, "street_key"] if start_row_id is not None and start_row_id in df.index else None

    if street_order == "name":
        street_groups.sort(key=lambda item: str(item["street_key"]))
    elif street_order == "original":
        street_groups.sort(key=lambda item: (item["first_original_stop"], item["first_source_order"]))
    else:
        street_groups.sort(key=lambda item: item["first_source_order"])

    if start_street_key is not None:
        street_groups.sort(key=lambda item: 0 if item["street_key"] == start_street_key else 1)

    for item in street_groups:
        street_key = item["street_key"]
        group = item["group"]

        if start_row_id is not None and start_row_id in group.index:
            ordered_rows = build_starting_loop_rows(group, start_row_id, first_side)
        else:
            ordered_rows = build_loop_rows(group, first_side)

        unknown_rows = group[group["parity"] == "unknown"].sort_values("_source_order", kind="mergesort").index.tolist()
        ordered_rows.extend(int(index) for index in unknown_rows)

        if not ordered_rows:
            continue

        chunk_size = min(max_stops, max(1, target_stops))
        for chunk_number, start in enumerate(range(0, len(ordered_rows), chunk_size)):
            chunk_rows = ordered_rows[start:start + chunk_size]
            unit_id = f"{street_key}::address_loop"
            if len(ordered_rows) > chunk_size:
                unit_id = f"{unit_id}::chunk{chunk_number}"
            units.append(CanvassUnit(unit_id=unit_id, row_ids=chunk_rows))

    return units


def pack_units_into_routes(units: List[CanvassUnit], min_stops: int, max_stops: int) -> List[List[CanvassUnit]]:
    routes: List[List[CanvassUnit]] = []
    current: List[CanvassUnit] = []
    current_count = 0

    for unit in units:
        if current and current_count >= min_stops and current_count + unit.count > max_stops:
            routes.append(current)
            current = []
            current_count = 0

        if current and current_count + unit.count > max_stops:
            routes.append(current)
            current = []
            current_count = 0

        current.append(unit)
        current_count += unit.count

    if current:
        routes.append(current)

    if len(routes) >= 2:
        final_count = sum(unit.count for unit in routes[-1])
        previous_count = sum(unit.count for unit in routes[-2])
        if final_count < min_stops and previous_count + final_count <= max_stops:
            routes[-2].extend(routes[-1])
            routes.pop()

    return routes


def build_routes(
    input_csv: Path,
    min_stops: int = 45,
    max_stops: int = 75,
    target_stops: int = 60,
    first_side: str = "auto",
    street_order: str = "name",
) -> pd.DataFrame:
    raw = pd.read_csv(input_csv)

    lat_col = find_column(raw, ["Latitude", "lat"], required=False)
    lon_col = find_column(raw, ["Longitude", "lng", "lon", "long"], required=False)
    street_col = find_column(raw, ["Street", "Address", "Street Address", "street_address"])
    original_stop_col = find_column(raw, ["Stop #", "Stop", "stop_number", "sequence"], required=False)

    df = raw.copy()
    if lat_col:
        df["Latitude"] = pd.to_numeric(df[lat_col], errors="coerce")
    if lon_col:
        df["Longitude"] = pd.to_numeric(df[lon_col], errors="coerce")

    df["_source_order"] = range(len(df))
    parsed = df[street_col].apply(parse_street_address)
    df["house_number"] = parsed.apply(lambda parsed_value: parsed_value[0]).astype("float")
    df["street_display"] = parsed.apply(lambda parsed_value: parsed_value[1])
    df["street_key"] = parsed.apply(lambda parsed_value: parsed_value[2])
    df["parity"] = df["house_number"].apply(parity_from_house_number)

    if original_stop_col:
        df["original_stop"] = df[original_stop_col]
    else:
        df["original_stop"] = df["_source_order"] + 1

    units = build_street_units(
        df,
        first_side=first_side,
        street_order=street_order,
        max_stops=max_stops,
        target_stops=target_stops,
        start_row_id=int(df["_source_order"].idxmin()),
    )
    routes = pack_units_into_routes(units, min_stops=min_stops, max_stops=max_stops)

    ordered_row_ids: List[int] = []
    route_ids: List[int] = []
    route_stop_numbers: List[int] = []
    unit_ids: List[str] = []
    unit_sequence_numbers: List[int] = []

    for route_number, route_units in enumerate(routes, start=1):
        stop_number = 1
        for unit_number, unit in enumerate(route_units, start=1):
            for row_id in unit.row_ids:
                ordered_row_ids.append(row_id)
                route_ids.append(route_number)
                route_stop_numbers.append(stop_number)
                unit_ids.append(unit.unit_id)
                unit_sequence_numbers.append(unit_number)
                stop_number += 1

    output = df.loc[ordered_row_ids].copy()
    output.insert(0, "Route #", route_ids)
    output.insert(1, "Route Stop #", route_stop_numbers)
    output.insert(2, "Canvass Unit #", unit_sequence_numbers)
    output.insert(3, "Canvass Unit ID", unit_ids)
    output = output.drop(columns=["_source_order"]).reset_index(drop=True)
    return output


def make_map(ordered: pd.DataFrame, map_path: Path) -> None:
    if folium is None:
        raise RuntimeError("folium is not installed. Run: pip install folium")
    if "Latitude" not in ordered.columns or "Longitude" not in ordered.columns:
        raise RuntimeError("Map output requires Latitude and Longitude columns.")

    plottable = ordered.dropna(subset=["Latitude", "Longitude"])
    if plottable.empty:
        raise RuntimeError("Map output requires at least one row with Latitude and Longitude.")

    center = [float(plottable["Latitude"].mean()), float(plottable["Longitude"].mean())]
    route_colors = ["blue", "red", "green", "purple", "orange", "darkred", "cadetblue", "darkgreen", "black"]
    m = folium.Map(location=center, zoom_start=16, control_scale=True)

    for route_id, route_df in plottable.groupby("Route #"):
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
            icon_html = f"""
            <div style="position: relative; width: 32px; height: 44px;">
              <svg width="32" height="44" viewBox="0 0 32 44" xmlns="http://www.w3.org/2000/svg">
                <path d="M16 1C8.2 1 2 7.2 2 15c0 10.8 14 27.5 14 27.5S30 25.8 30 15C30 7.2 23.8 1 16 1z"
                      fill="#2b83ba" stroke="#1f5f87" stroke-width="1.5"/>
                <circle cx="16" cy="15" r="9" fill="white"/>
              </svg>
              <div style="position:absolute;top:7px;left:0;width:32px;text-align:center;font-size:10px;font-weight:bold;color:#111;line-height:16px;font-family:Arial,sans-serif;">{stop_no}</div>
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
    # Keep CLI stable while delegating route generation to the reusable core module.
    from route_core import build_routes as core_build_routes
    from route_core import make_map as core_make_map

    parser = argparse.ArgumentParser(description="Build address-ordered canvassing routes without using lat/lng for sequencing.")
    parser.add_argument("input_csv", type=Path, help="Input CSV with a Street or Address column")
    parser.add_argument("--output", type=Path, default=Path("ordered_canvass_routes_address_order.csv"))
    parser.add_argument("--map", dest="map_path", type=Path, default=None, help="Optional output HTML map path")
    parser.add_argument("--min-stops", type=int, default=45)
    parser.add_argument("--max-stops", type=int, default=75)
    parser.add_argument("--target-stops", type=int, default=60)
    parser.add_argument("--first-side", choices=["auto", "odd", "even"], default="auto")
    parser.add_argument("--street-order", choices=["name", "input", "original"], default="name")
    parser.add_argument("--block-size", type=int, default=100, help="House-number range used to split street blocks.")
    parser.add_argument("--no-block-segments", action="store_true", help="Disable house-number block segmentation.")
    parser.add_argument("--no-side-segments", action="store_true", help="Keep odd/even sides together within each block segment.")
    args = parser.parse_args()

    ordered = core_build_routes(
        args.input_csv,
        min_stops=args.min_stops,
        max_stops=args.max_stops,
        target_stops=args.target_stops,
        first_side=args.first_side,
        street_order=args.street_order,
        block_size=args.block_size,
        use_block_segments=not args.no_block_segments,
        use_side_segments=not args.no_side_segments,
    )
    ordered.to_csv(args.output, index=False)

    route_summary = ordered.groupby("Route #").size().rename("stop_count").reset_index()
    print("Route summary:")
    print(route_summary.to_string(index=False))
    print(f"\nWrote ordered CSV: {args.output}")

    if args.map_path:
        core_make_map(ordered, args.map_path)
        print(f"Wrote HTML map: {args.map_path}")


if __name__ == "__main__":
    main()
