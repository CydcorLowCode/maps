#!/usr/bin/env python3
"""
Reusable core logic for the address-order canvass route builder.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

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

SEGMENT_COLORS = [
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
    "#8c564b", "#e377c2", "#17becf", "#bcbd22", "#393b79",
    "#637939", "#8c6d31", "#843c39", "#7b4173", "#3182bd",
    "#e6550d", "#31a354", "#756bb1", "#636363", "#9edae5",
]


@dataclass
class CanvassUnit:
    unit_id: str
    row_ids: List[int]
    segment_key: str
    street_key: str
    street_display: str
    block_label: str
    side_label: str
    chunk_number: int
    chunk_size: int
    default_sequence: int
    first_side: str
    direction: str = "forward"

    @property
    def count(self) -> int:
        return len(self.row_ids)


def _norm_col(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower()).strip("_")


def segment_color_for_order(segment_order: int) -> str:
    return SEGMENT_COLORS[(max(1, int(segment_order)) - 1) % len(SEGMENT_COLORS)]


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


def block_label_from_house_number(house_number: Optional[float], block_size: int) -> str:
    if house_number is None or pd.isna(house_number) or block_size <= 0:
        return "unknown"
    block_start = (int(house_number) // block_size) * block_size
    block_end = block_start + block_size - 1
    return f"{block_start}-{block_end}"


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


def prepare_dataframe(
    raw: pd.DataFrame,
    block_size: int = 100,
    use_block_segments: bool = True,
    use_side_segments: bool = True,
) -> pd.DataFrame:
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
    if use_block_segments:
        df["address_block"] = df["house_number"].apply(lambda house_number: block_label_from_house_number(house_number, block_size))
    else:
        df["address_block"] = "all"
    df["segment_side"] = df["parity"] if use_side_segments else "both"
    df["segment_key"] = (
        df["street_key"].astype(str)
        + "::block::"
        + df["address_block"].astype(str)
        + "::side::"
        + df["segment_side"].astype(str)
    )

    if original_stop_col:
        df["original_stop"] = df[original_stop_col]
    else:
        df["original_stop"] = df["_source_order"] + 1

    return df


def _street_groups(
    df: pd.DataFrame,
    street_order: str,
    start_row_id: Optional[int],
) -> List[Dict[str, object]]:
    groups = []
    for segment_key, group in df.groupby("segment_key", sort=False, dropna=False):
        street_key = str(group["street_key"].iloc[0])
        block_label = str(group["address_block"].iloc[0])
        side_label = str(group["segment_side"].iloc[0])
        numeric_original = pd.to_numeric(group["original_stop"], errors="coerce")
        display = str(group["street_display"].dropna().astype(str).iloc[0]) if not group["street_display"].dropna().empty else str(street_key)
        groups.append({
            "segment_key": segment_key,
            "street_key": street_key,
            "block_label": block_label,
            "side_label": side_label,
            "group": group,
            "display": display,
            "first_source_order": int(group["_source_order"].min()),
            "first_original_stop": float(numeric_original.min()) if numeric_original.notna().any() else math.inf,
        })

    start_segment_key = df.loc[start_row_id, "segment_key"] if start_row_id is not None and start_row_id in df.index else None
    if street_order == "name":
        groups.sort(key=lambda item: (str(item["street_key"]), str(item["block_label"]), str(item["side_label"])))
    elif street_order == "original":
        groups.sort(key=lambda item: (item["first_original_stop"], item["first_source_order"]))
    else:
        groups.sort(key=lambda item: item["first_source_order"])

    if start_segment_key is not None:
        groups.sort(key=lambda item: 0 if item["segment_key"] == start_segment_key else 1)
    return groups


def _ordered_rows_for_street(
    group: pd.DataFrame,
    first_side: str,
    start_row_id: Optional[int],
) -> Tuple[List[int], str]:
    chosen_first_side = choose_first_side(group, first_side)
    if start_row_id is not None and start_row_id in group.index:
        ordered_rows = build_starting_loop_rows(group, start_row_id, first_side)
    else:
        ordered_rows = build_loop_rows(group, first_side)
    unknown_rows = group[group["parity"] == "unknown"].sort_values("_source_order", kind="mergesort").index.tolist()
    ordered_rows.extend(int(index) for index in unknown_rows)
    return ordered_rows, chosen_first_side


def _row_point(df: pd.DataFrame, row_id: int) -> Optional[Tuple[float, float]]:
    row = df.loc[row_id]
    if "Latitude" in df.columns and "Longitude" in df.columns and pd.notna(row.get("Latitude")) and pd.notna(row.get("Longitude")):
        return float(row["Latitude"]), float(row["Longitude"])
    if pd.notna(row.get("house_number")):
        return float(row["house_number"]), 0.0
    return None


def _point_distance(a: Optional[Tuple[float, float]], b: Optional[Tuple[float, float]]) -> float:
    if a is None or b is None:
        return 0.0
    lat1, lon1 = a
    lat2, lon2 = b
    if abs(lat1) <= 90 and abs(lat2) <= 90 and abs(lon1) <= 180 and abs(lon2) <= 180:
        meters_per_deg_lat = 110_540.0
        meters_per_deg_lon = 111_320.0 * math.cos(math.radians((lat1 + lat2) / 2.0))
        return math.hypot((lon2 - lon1) * meters_per_deg_lon, (lat2 - lat1) * meters_per_deg_lat)
    return math.hypot(lat2 - lat1, lon2 - lon1)


def _sequence_units_by_endpoint(
    units: List[CanvassUnit],
    df: pd.DataFrame,
    start_row_id: Optional[int],
) -> List[CanvassUnit]:
    if not units:
        return []

    street_order = []
    units_by_street: Dict[str, List[CanvassUnit]] = {}
    for unit in units:
        if unit.street_key not in units_by_street:
            street_order.append(unit.street_key)
            units_by_street[unit.street_key] = []
        units_by_street[unit.street_key].append(unit)

    current_point = _row_point(df, start_row_id) if start_row_id is not None and start_row_id in df.index else None
    sequenced: List[CanvassUnit] = []
    next_sequence = 1

    for street_key in street_order:
        remaining = list(units_by_street[street_key])
        while remaining:
            best = None
            for index, unit in enumerate(remaining):
                forward_rows = list(unit.row_ids)
                reverse_rows = list(reversed(unit.row_ids))
                candidates = [
                    ("forward", forward_rows, _row_point(df, forward_rows[0]), _row_point(df, forward_rows[-1])),
                    ("reverse", reverse_rows, _row_point(df, reverse_rows[0]), _row_point(df, reverse_rows[-1])),
                ]
                for direction, rows, start_point, end_point in candidates:
                    distance = _point_distance(current_point, start_point)
                    tie_breaker = min(float(df.loc[row_id, "house_number"]) for row_id in rows if pd.notna(df.loc[row_id, "house_number"])) if rows else math.inf
                    candidate = (distance, tie_breaker, index, direction, rows, end_point, unit)
                    if best is None or candidate[:3] < best[:3]:
                        best = candidate

            if best is None:
                break
            _, _, index, direction, rows, end_point, unit = best
            remaining.pop(index)
            sequenced.append(
                replace(
                    unit,
                    row_ids=rows,
                    direction=direction,
                    default_sequence=next_sequence,
                )
            )
            next_sequence += 1
            current_point = end_point

    return sequenced


def build_street_units(
    df: pd.DataFrame,
    first_side: str,
    street_order: str,
    max_stops: int,
    target_stops: int,
    start_row_id: Optional[int] = None,
) -> List[CanvassUnit]:
    units: List[CanvassUnit] = []
    chunk_size = min(max_stops, max(1, target_stops))
    default_sequence = 1
    for item in _street_groups(df, street_order, start_row_id):
        segment_key = str(item["segment_key"])
        street_key = str(item["street_key"])
        block_label = str(item["block_label"])
        side_label = str(item["side_label"])
        group = item["group"]
        ordered_rows, chosen_first_side = _ordered_rows_for_street(group, first_side, start_row_id)
        if not ordered_rows:
            continue

        for chunk_number, start in enumerate(range(0, len(ordered_rows), chunk_size)):
            chunk_rows = ordered_rows[start:start + chunk_size]
            unit_id = f"{street_key}::block{block_label}::side{side_label}::address_loop"
            if len(ordered_rows) > chunk_size:
                unit_id = f"{unit_id}::chunk{chunk_number}"
            units.append(
                CanvassUnit(
                    unit_id=unit_id,
                    row_ids=chunk_rows,
                    segment_key=segment_key,
                    street_key=street_key,
                    street_display=str(item["display"]),
                    block_label=block_label,
                    side_label=side_label,
                    chunk_number=chunk_number,
                    chunk_size=chunk_size,
                    default_sequence=default_sequence,
                    first_side=chosen_first_side,
                )
            )
            default_sequence += 1
    return _sequence_units_by_endpoint(units, df, start_row_id)


def _override_column(df: pd.DataFrame, candidates: Sequence[str]) -> Optional[str]:
    for candidate in candidates:
        for col in df.columns:
            if _norm_col(col) == _norm_col(candidate):
                return col
    return None


def apply_segment_overrides(
    units: List[CanvassUnit],
    df: pd.DataFrame,
    first_side: str,
    start_row_id: Optional[int],
    overrides: Optional[pd.DataFrame],
) -> List[CanvassUnit]:
    if overrides is None or overrides.empty:
        return units

    id_col = _override_column(overrides, ["Canvass Unit ID", "unit_id", "segment_id"])
    seq_col = _override_column(overrides, ["Segment Order", "segment_order", "sequence", "order"])
    direction_col = _override_column(overrides, ["Segment Direction", "direction"])
    first_side_col = _override_column(overrides, ["Segment First Side", "first_side"])
    if id_col is None:
        return units

    override_map: Dict[str, Dict[str, object]] = {}
    for _, row in overrides.iterrows():
        segment_id = str(row.get(id_col, "")).strip()
        if not segment_id:
            continue
        override_map[segment_id] = {
            "sequence": row.get(seq_col) if seq_col else None,
            "direction": row.get(direction_col) if direction_col else None,
            "first_side": row.get(first_side_col) if first_side_col else None,
        }

    segment_groups = {str(segment_key): group for segment_key, group in df.groupby("segment_key", sort=False, dropna=False)}
    applied: List[Tuple[int, int, CanvassUnit]] = []
    for unit in units:
        override = override_map.get(unit.unit_id, {})
        sequence = override.get("sequence")
        try:
            sequence_int = int(sequence)
        except Exception:
            sequence_int = unit.default_sequence

        direction = str(override.get("direction", unit.direction)).strip().lower()
        direction = direction if direction in {"forward", "reverse"} else unit.direction

        requested_first_side = str(override.get("first_side", unit.first_side)).strip().lower()
        requested_first_side = requested_first_side if requested_first_side in {"auto", "odd", "even"} else unit.first_side

        row_ids = list(unit.row_ids)
        applied_first_side = unit.first_side
        current_direction = unit.direction
        if requested_first_side != unit.first_side:
            group = segment_groups.get(unit.segment_key)
            if group is not None:
                street_rows, applied_first_side = _ordered_rows_for_street(group, requested_first_side, start_row_id)
                start = unit.chunk_number * unit.chunk_size
                row_ids = street_rows[start:start + unit.chunk_size]
                current_direction = "forward"
                if not row_ids:
                    row_ids = list(unit.row_ids)
                    applied_first_side = unit.first_side
                    current_direction = unit.direction

        if direction != current_direction:
            row_ids = list(reversed(row_ids))

        applied.append(
            (
                sequence_int,
                unit.default_sequence,
                replace(unit, row_ids=row_ids, direction=direction, first_side=applied_first_side),
            )
        )

    applied.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in applied]


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


def _build_output(df: pd.DataFrame, routes: List[List[CanvassUnit]]) -> Tuple[pd.DataFrame, pd.DataFrame]:
    ordered_row_ids: List[int] = []
    route_ids: List[int] = []
    route_stop_numbers: List[int] = []
    unit_ids: List[str] = []
    unit_sequence_numbers: List[int] = []
    first_side_values: List[str] = []
    direction_values: List[str] = []
    stop_range_values: List[str] = []
    segment_color_values: List[str] = []

    route_lookup: Dict[str, Tuple[int, int]] = {}
    stop_number_lookup: Dict[str, int] = {}
    stop_range_lookup: Dict[str, str] = {}
    segment_color_lookup: Dict[str, str] = {}
    segment_order = 1

    for route_number, route_units in enumerate(routes, start=1):
        stop_number = 1
        for unit_number, unit in enumerate(route_units, start=1):
            route_lookup[unit.unit_id] = (route_number, unit_number)
            stop_number_lookup[unit.unit_id] = stop_number
            segment_color = segment_color_for_order(segment_order)
            segment_color_lookup[unit.unit_id] = segment_color
            start_stop_number = stop_number
            for row_id in unit.row_ids:
                ordered_row_ids.append(row_id)
                route_ids.append(route_number)
                route_stop_numbers.append(stop_number)
                unit_ids.append(unit.unit_id)
                unit_sequence_numbers.append(unit_number)
                first_side_values.append(unit.first_side)
                direction_values.append(unit.direction)
                segment_color_values.append(segment_color)
                stop_number += 1
            end_stop_number = stop_number - 1
            stop_range = f"{start_stop_number}-{end_stop_number}" if end_stop_number > start_stop_number else str(start_stop_number)
            stop_range_lookup[unit.unit_id] = stop_range
            stop_range_values.extend([stop_range] * unit.count)
            segment_order += 1

    output = df.loc[ordered_row_ids].copy()
    output.insert(0, "Route #", route_ids)
    output.insert(1, "Route Stop #", route_stop_numbers)
    output.insert(2, "Canvass Unit #", unit_sequence_numbers)
    output.insert(3, "Canvass Unit ID", unit_ids)
    output.insert(4, "Segment First Side", first_side_values)
    output.insert(5, "Segment Direction", direction_values)
    output.insert(6, "Route Stop Range", stop_range_values)
    output.insert(7, "Segment Color", segment_color_values)
    output = output.drop(columns=["_source_order"]).reset_index(drop=True)

    summary_rows = []
    ordered_units: List[CanvassUnit] = [unit for route in routes for unit in route]
    for sequence, unit in enumerate(ordered_units, start=1):
        route_number, route_unit_number = route_lookup.get(unit.unit_id, (None, None))
        if unit.row_ids:
            first_row = df.loc[unit.row_ids[0]]
            last_row = df.loc[unit.row_ids[-1]]
            start_addr = f"{'' if pd.isna(first_row['house_number']) else int(first_row['house_number'])} {first_row.get('street_display', '')}".strip()
            end_addr = f"{'' if pd.isna(last_row['house_number']) else int(last_row['house_number'])} {last_row.get('street_display', '')}".strip()
        else:
            start_addr = ""
            end_addr = ""
        summary_rows.append(
            {
                "Canvass Unit ID": unit.unit_id,
                "Segment Order": sequence,
                "Route #": route_number,
                "Route Segment #": route_unit_number,
                "Route Stop Range": stop_range_lookup.get(unit.unit_id, ""),
                "Street Key": unit.street_key,
                "Street Display": unit.street_display,
                "Address Block": unit.block_label,
                "Street Side": unit.side_label,
                "Stop Count": unit.count,
                "Segment Color": segment_color_lookup.get(unit.unit_id, ""),
                "Segment First Side": unit.first_side,
                "Segment Direction": unit.direction,
                "Start Address": start_addr,
                "End Address": end_addr,
            }
        )
    segment_summary = pd.DataFrame(summary_rows)
    return output, segment_summary


def build_routes_from_dataframe(
    raw_df: pd.DataFrame,
    min_stops: int = 45,
    max_stops: int = 75,
    target_stops: int = 60,
    first_side: str = "auto",
    street_order: str = "name",
    block_size: int = 100,
    use_block_segments: bool = True,
    use_side_segments: bool = True,
    segment_overrides: Optional[pd.DataFrame] = None,
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    df = prepare_dataframe(
        raw_df,
        block_size=block_size,
        use_block_segments=use_block_segments,
        use_side_segments=use_side_segments,
    )
    start_row_id = int(df["_source_order"].idxmin()) if not df.empty else None
    units = build_street_units(
        df,
        first_side=first_side,
        street_order=street_order,
        max_stops=max_stops,
        target_stops=target_stops,
        start_row_id=start_row_id,
    )
    units = apply_segment_overrides(units, df, first_side=first_side, start_row_id=start_row_id, overrides=segment_overrides)
    routes = pack_units_into_routes(units, min_stops=min_stops, max_stops=max_stops)
    return _build_output(df, routes)


def build_routes(
    input_csv: Path,
    min_stops: int = 45,
    max_stops: int = 75,
    target_stops: int = 60,
    first_side: str = "auto",
    street_order: str = "name",
    block_size: int = 100,
    use_block_segments: bool = True,
    use_side_segments: bool = True,
) -> pd.DataFrame:
    raw = pd.read_csv(input_csv)
    ordered, _ = build_routes_from_dataframe(
        raw_df=raw,
        min_stops=min_stops,
        max_stops=max_stops,
        target_stops=target_stops,
        first_side=first_side,
        street_order=street_order,
        block_size=block_size,
        use_block_segments=use_block_segments,
        use_side_segments=use_side_segments,
    )
    return ordered


def build_map(ordered: pd.DataFrame, center: Optional[Sequence[float]] = None, zoom_start: int = 16):
    if folium is None:
        raise RuntimeError("folium is not installed. Run: pip install folium")
    if "Latitude" not in ordered.columns or "Longitude" not in ordered.columns:
        raise RuntimeError("Map output requires Latitude and Longitude columns.")

    plottable = ordered.dropna(subset=["Latitude", "Longitude"])
    if plottable.empty:
        raise RuntimeError("Map output requires at least one row with Latitude and Longitude.")

    if center is None:
        center = [float(plottable["Latitude"].mean()), float(plottable["Longitude"].mean())]
    else:
        center = [float(center[0]), float(center[1])]
    route_colors = ["blue", "red", "green", "purple", "orange", "darkred", "cadetblue", "darkgreen", "black"]
    m = folium.Map(location=center, zoom_start=zoom_start, control_scale=True)

    for route_id, route_df in plottable.groupby("Route #"):
        route_df = route_df.sort_values("Route Stop #")
        color = route_colors[(int(route_id) - 1) % len(route_colors)]
        coords = route_df[["Latitude", "Longitude"]].values.tolist()
        if len(coords) >= 2:
            folium.PolyLine(coords, weight=3, opacity=0.35, color=color, tooltip=f"Route {route_id}").add_to(m)

        for unit_id, unit_df in route_df.groupby("Canvass Unit ID", sort=False):
            unit_df = unit_df.sort_values("Route Stop #")
            unit_coords = unit_df[["Latitude", "Longitude"]].values.tolist()
            if len(unit_coords) >= 2:
                first = unit_df.iloc[0]
                segment_color = str(first.get("Segment Color", color))
                folium.PolyLine(
                    unit_coords,
                    weight=7,
                    opacity=0.92,
                    color=segment_color,
                    tooltip=(
                        f"Route {int(route_id)} | Segment {first.get('Canvass Unit #', '')} | "
                        f"Stops {first.get('Route Stop Range', '')} | {unit_id} | "
                        f"{first.get('Segment Direction', 'forward')}"
                    ),
                ).add_to(m)

        for _, row in route_df.iterrows():
            stop_no = int(row["Route Stop #"])
            route_no = int(row["Route #"])
            street = row.get("Street", row.get("street_display", ""))
            segment_color = str(row.get("Segment Color", "#2b83ba"))
            popup_html = f"""
            <div style="width:280px;">
              <b>Route {route_no}, Stop {stop_no}</b><br>
              <b>Segment Stops:</b> {row.get('Route Stop Range', '')}<br>
              <b>Original Stop:</b> {row.get('original_stop', '')}<br>
              <b>Address:</b> {street}<br>
              <b>Street Side:</b> {row.get('parity', '')}<br>
              <b>Segment:</b> {row.get('Canvass Unit ID', '')}<br>
              <b>First Side:</b> {row.get('Segment First Side', '')}<br>
              <b>Direction:</b> {row.get('Segment Direction', '')}<br>
            </div>
            """
            icon_html = f"""
            <div style="position: relative; width: 32px; height: 44px;">
              <svg width="32" height="44" viewBox="0 0 32 44" xmlns="http://www.w3.org/2000/svg">
                <path d="M16 1C8.2 1 2 7.2 2 15c0 10.8 14 27.5 14 27.5S30 25.8 30 15C30 7.2 23.8 1 16 1z"
                      fill="{segment_color}" stroke="#222" stroke-width="1.5"/>
                <circle cx="16" cy="15" r="9" fill="white"/>
              </svg>
              <div style="position:absolute;top:7px;left:0;width:32px;text-align:center;font-size:10px;font-weight:bold;color:#111;line-height:16px;font-family:Arial,sans-serif;">{stop_no}</div>
            </div>
            """
            folium.Marker(
                location=[float(row["Latitude"]), float(row["Longitude"])],
                popup=folium.Popup(popup_html, max_width=320),
                tooltip=f"Route {route_no}, Stop {stop_no} | Segment: {row.get('Canvass Unit ID', '')}",
                icon=DivIcon(html=icon_html, icon_size=(32, 44), icon_anchor=(16, 44)),
            ).add_to(m)

    return m


def make_map(ordered: pd.DataFrame, map_path: Path) -> None:
    m = build_map(ordered)
    m.save(str(map_path))
