#!/usr/bin/env python3
"""
Local persistence and comparison helpers for learning from route corrections.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Tuple

import pandas as pd


SAVE_DIR = Path(__file__).resolve().parent / "saved_routes"


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "route"


def new_run_id(upload_name: str) -> str:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{timestamp}-{_slugify(upload_name)}"


def current_settings(state: Any) -> Dict[str, Any]:
    return {
        "min_stops": int(state.min_stops),
        "max_stops": int(state.max_stops),
        "target_stops": int(state.target_stops),
        "first_side": state.first_side,
        "street_order": state.street_order,
        "block_size": int(state.block_size),
        "use_block_segments": bool(state.use_block_segments),
        "use_side_segments": bool(state.use_side_segments),
    }


def compare_routes(
    baseline_ordered: pd.DataFrame,
    corrected_ordered: pd.DataFrame,
    baseline_segments: pd.DataFrame,
    corrected_segments: pd.DataFrame,
) -> Tuple[Dict[str, Any], pd.DataFrame]:
    segment_comparison = baseline_segments.merge(
        corrected_segments,
        on="Canvass Unit ID",
        how="outer",
        suffixes=("_Initial", "_Corrected"),
    )
    change_rows = []
    for _, row in segment_comparison.iterrows():
        initial_order = row.get("Segment Order_Initial")
        corrected_order = row.get("Segment Order_Corrected")
        initial_direction = row.get("Segment Direction_Initial")
        corrected_direction = row.get("Segment Direction_Corrected")
        initial_range = row.get("Route Stop Range_Initial")
        corrected_range = row.get("Route Stop Range_Corrected")
        changes = []
        if pd.notna(initial_order) and pd.notna(corrected_order) and int(initial_order) != int(corrected_order):
            changes.append("segment_order")
        if pd.notna(initial_direction) and pd.notna(corrected_direction) and initial_direction != corrected_direction:
            changes.append("direction")
        if pd.notna(initial_range) and pd.notna(corrected_range) and initial_range != corrected_range:
            changes.append("stop_range")
        if changes:
            change_rows.append(
                {
                    "Canvass Unit ID": row.get("Canvass Unit ID"),
                    "Street": row.get("Street Display_Corrected", row.get("Street Display_Initial", "")),
                    "Block": row.get("Address Block_Corrected", row.get("Address Block_Initial", "")),
                    "Side": row.get("Street Side_Corrected", row.get("Street Side_Initial", "")),
                    "Initial Order": initial_order,
                    "Corrected Order": corrected_order,
                    "Initial Direction": initial_direction,
                    "Corrected Direction": corrected_direction,
                    "Initial Stop Range": initial_range,
                    "Corrected Stop Range": corrected_range,
                    "Changes": ", ".join(changes),
                }
            )

    changes_df = pd.DataFrame(change_rows)
    summary = {
        "segment_count": int(len(corrected_segments)),
        "changed_segment_count": int(len(changes_df)),
        "order_change_count": int(changes_df["Changes"].str.contains("segment_order").sum()) if not changes_df.empty else 0,
        "direction_change_count": int(changes_df["Changes"].str.contains("direction").sum()) if not changes_df.empty else 0,
        "stop_range_change_count": int(changes_df["Changes"].str.contains("stop_range").sum()) if not changes_df.empty else 0,
        "initial_stop_count": int(len(baseline_ordered)),
        "corrected_stop_count": int(len(corrected_ordered)),
    }
    return summary, changes_df


def save_route_run(
    run_id: str,
    upload_name: str,
    raw_df: pd.DataFrame,
    baseline_ordered: pd.DataFrame,
    baseline_segments: pd.DataFrame,
    corrected_ordered: pd.DataFrame,
    corrected_segments: pd.DataFrame,
    settings: Dict[str, Any],
    notes: str = "",
) -> Path:
    summary, changes_df = compare_routes(
        baseline_ordered=baseline_ordered,
        corrected_ordered=corrected_ordered,
        baseline_segments=baseline_segments,
        corrected_segments=corrected_segments,
    )
    run_dir = SAVE_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    raw_df.to_csv(run_dir / "uploaded.csv", index=False)
    baseline_ordered.to_csv(run_dir / "initial_ordered.csv", index=False)
    baseline_segments.to_csv(run_dir / "initial_segments.csv", index=False)
    corrected_ordered.to_csv(run_dir / "corrected_ordered.csv", index=False)
    corrected_segments.to_csv(run_dir / "corrected_segments.csv", index=False)
    changes_df.to_csv(run_dir / "changes.csv", index=False)

    metadata = {
        "run_id": run_id,
        "upload_name": upload_name,
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "settings": settings,
        "notes": notes,
        "summary": summary,
    }
    (run_dir / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return run_dir


def list_saved_runs() -> pd.DataFrame:
    rows = []
    if not SAVE_DIR.exists():
        return pd.DataFrame(rows)
    for metadata_path in sorted(SAVE_DIR.glob("*/metadata.json"), reverse=True):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        summary = metadata.get("summary", {})
        rows.append(
            {
                "Run ID": metadata.get("run_id", metadata_path.parent.name),
                "Upload": metadata.get("upload_name", ""),
                "Saved At": metadata.get("saved_at", ""),
                "Changed Segments": summary.get("changed_segment_count", 0),
                "Order Changes": summary.get("order_change_count", 0),
                "Direction Changes": summary.get("direction_change_count", 0),
                "Path": str(metadata_path.parent),
            }
        )
    return pd.DataFrame(rows)
