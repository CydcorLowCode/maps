#!/usr/bin/env python3
"""
Interactive Streamlit UI for address-order route generation.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import pandas as pd
import streamlit as st
import streamlit.components.v1 as components
from branca.element import MacroElement, Template

try:
    from streamlit_folium import st_folium
except ModuleNotFoundError:
    st_folium = None

from route_core import build_map, build_routes_from_dataframe
from route_learning_store import (
    compare_routes,
    current_settings,
    list_saved_runs,
    new_run_id,
    save_route_run,
)


st.set_page_config(page_title="Interactive Address-Order Route Builder", layout="wide")
segment_cards_component = components.declare_component(
    "segment_cards_component",
    path=str(Path(__file__).parent / "segment_cards_component"),
)


def _init_state() -> None:
    defaults = {
        "raw_df": None,
        "ordered_df": None,
        "segment_df": None,
        "segment_editor_df": None,
        "baseline_ordered_df": None,
        "baseline_segment_df": None,
        "uploaded_file_name": None,
        "route_run_id": None,
        "save_notes": "",
        "last_saved_path": None,
        "map_center": None,
        "map_zoom": 16,
        "sort_widget_version": 0,
        "selected_segment_id": None,
    }
    for key, value in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = value


def _run_builder(overrides: pd.DataFrame | None) -> None:
    if st.session_state.raw_df is None:
        st.warning("Upload a CSV first.")
        return

    ordered_df, segment_df = build_routes_from_dataframe(
        raw_df=st.session_state.raw_df,
        min_stops=st.session_state.min_stops,
        max_stops=st.session_state.max_stops,
        target_stops=st.session_state.target_stops,
        first_side=st.session_state.first_side,
        street_order=st.session_state.street_order,
        block_size=st.session_state.block_size,
        use_block_segments=st.session_state.use_block_segments,
        use_side_segments=st.session_state.use_side_segments,
        segment_overrides=overrides,
    )
    st.session_state.ordered_df = ordered_df
    st.session_state.segment_df = segment_df
    st.session_state.segment_editor_df = segment_df[
        [
            "Canvass Unit ID",
            "Segment Order",
            "Segment First Side",
            "Segment Direction",
            "Street Display",
            "Address Block",
            "Street Side",
            "Route Stop Range",
            "Segment Color",
            "Stop Count",
            "Route #",
            "Route Segment #",
            "Start Address",
            "End Address",
        ]
    ].copy()


def _capture_baseline() -> None:
    st.session_state.baseline_ordered_df = st.session_state.ordered_df.copy()
    st.session_state.baseline_segment_df = st.session_state.segment_df.copy()


def _clear_route_state_for_new_upload(upload_name: str) -> None:
    st.session_state.uploaded_file_name = upload_name
    st.session_state.route_run_id = new_run_id(upload_name)
    st.session_state.ordered_df = None
    st.session_state.segment_df = None
    st.session_state.segment_editor_df = None
    st.session_state.baseline_ordered_df = None
    st.session_state.baseline_segment_df = None
    st.session_state.last_saved_path = None
    st.session_state.selected_segment_id = None
    st.session_state.sort_widget_version += 1


def _has_saved_baseline() -> bool:
    return st.session_state.baseline_ordered_df is not None and st.session_state.baseline_segment_df is not None


def _attach_map_viewport_persistence(map_object) -> None:
    viewport_script = MacroElement()
    viewport_script._template = Template(
        """
        {% macro script(this, kwargs) %}
        (function() {
          const storageKey = "address_order_route_builder_map_viewport";
          const map = {{ this._parent.get_name() }};
          if (!map || map.__routeBuilderViewportPersistenceAttached) {
            return;
          }
          map.__routeBuilderViewportPersistenceAttached = true;

          try {
            const saved = JSON.parse(window.localStorage.getItem(storageKey) || "null");
            if (
              saved &&
              Number.isFinite(saved.lat) &&
              Number.isFinite(saved.lng) &&
              Number.isFinite(saved.zoom)
            ) {
              map.setView([saved.lat, saved.lng], saved.zoom, { animate: false });
            }
          } catch (error) {}

          function saveViewport() {
            const center = map.getCenter();
            window.localStorage.setItem(
              storageKey,
              JSON.stringify({ lat: center.lat, lng: center.lng, zoom: map.getZoom() })
            );
          }

          map.on("moveend zoomend", saveViewport);
        })();
        {% endmacro %}
        """
    )
    map_object.add_child(viewport_script)


def _render_map(map_object) -> None:
    _attach_map_viewport_persistence(map_object)
    if st_folium is not None:
        map_state = st_folium(
            map_object,
            key="route_map",
            width=None,
            height=700,
            returned_objects=["last_object_clicked_tooltip"],
        )
        _update_selected_segment(map_state)
        return

    st.info("Install streamlit-folium for a native Streamlit map component. Showing embedded HTML map instead.")
    components.html(map_object.get_root().render(), height=700, scrolling=False)


def _build_map_or_show_error(ordered_df: pd.DataFrame):
    try:
        return build_map(
            ordered_df,
            center=st.session_state.map_center,
            zoom_start=st.session_state.map_zoom,
        )
    except RuntimeError as exc:
        st.error(str(exc))
        st.info(
            "This Streamlit session is running with "
            f"`{sys.executable}`. Install map dependencies into that interpreter with "
            "`python -m pip install folium streamlit-folium`, then restart Streamlit with "
            "`python -m streamlit run route_builder_app.py`."
        )
        return None


def _update_selected_segment(map_state: dict | None) -> None:
    if not map_state:
        return

    tooltip = map_state.get("last_object_clicked_tooltip")
    if not isinstance(tooltip, str) or "Segment:" not in tooltip:
        return

    segment_id = tooltip.split("Segment:", 1)[1].strip()
    if segment_id:
        st.session_state.selected_segment_id = segment_id


def _segment_card_items(sorted_segments: pd.DataFrame) -> list[dict[str, object]]:
    return [
        {
            "id": str(row["Canvass Unit ID"]),
            "stopRange": str(row.get("Route Stop Range", "")),
            "street": str(row.get("Street Display", "")),
            "block": str(row.get("Address Block", "")),
            "side": str(row.get("Street Side", "")).title(),
            "stopCount": int(row.get("Stop Count", 0)),
            "direction": str(row.get("Segment Direction", "forward")),
            "color": str(row.get("Segment Color", "#999999")),
            "selectedSegmentId": st.session_state.selected_segment_id,
        }
        for _, row in sorted_segments.iterrows()
    ]


def _apply_segment_card_updates(segments: pd.DataFrame, card_updates: list[dict[str, object]] | None) -> None:
    if not card_updates:
        return

    updated_segments = segments.copy()
    id_to_order = {}
    id_to_direction = {}
    for update in card_updates:
        segment_id = str(update.get("id", ""))
        if not segment_id:
            continue
        try:
            id_to_order[segment_id] = int(update.get("order"))
        except Exception:
            continue
        direction = str(update.get("direction", "forward"))
        id_to_direction[segment_id] = direction if direction in {"forward", "reverse"} else "forward"

    current = segments.sort_values("Segment Order", kind="mergesort")
    current_signature = [
        (str(row["Canvass Unit ID"]), int(row["Segment Order"]), str(row["Segment Direction"]))
        for _, row in current.iterrows()
    ]

    updated_segments["Segment Order"] = updated_segments["Canvass Unit ID"].astype(str).map(id_to_order).fillna(updated_segments["Segment Order"])
    updated_segments["Segment Direction"] = updated_segments["Canvass Unit ID"].astype(str).map(id_to_direction).fillna(updated_segments["Segment Direction"])
    updated_segments = updated_segments.sort_values("Segment Order", kind="mergesort").reset_index(drop=True)
    updated_signature = [
        (str(row["Canvass Unit ID"]), int(row["Segment Order"]), str(row["Segment Direction"]))
        for _, row in updated_segments.iterrows()
    ]

    if updated_signature == current_signature:
        return

    st.session_state.segment_editor_df = updated_segments
    _run_builder(overrides=updated_segments)
    st.session_state.sort_widget_version += 1
    st.rerun()


def _render_segment_cards(sorted_segments: pd.DataFrame) -> None:
    st.markdown("#### Segment Cards")
    st.caption("Drag cards to reorder; use the direction menu inside each card.")
    card_updates = segment_cards_component(
        segments=_segment_card_items(sorted_segments),
        key=f"segment_cards_{st.session_state.sort_widget_version}_{st.session_state.selected_segment_id}",
        default=None,
    )
    if card_updates is None:
        st.info("Loading interactive segment cards...")
    _apply_segment_card_updates(st.session_state.segment_editor_df, card_updates)


def _render_learning_panel() -> None:
    st.subheader("Learn From Corrections")
    if not _has_saved_baseline():
        st.info("Run the initial route first to create a baseline for comparison.")
        return

    summary, changes_df = compare_routes(
        baseline_ordered=st.session_state.baseline_ordered_df,
        corrected_ordered=st.session_state.ordered_df,
        baseline_segments=st.session_state.baseline_segment_df,
        corrected_segments=st.session_state.segment_df,
    )
    metric_cols = st.columns(4)
    metric_cols[0].metric("Changed Segments", summary["changed_segment_count"])
    metric_cols[1].metric("Order Changes", summary["order_change_count"])
    metric_cols[2].metric("Direction Changes", summary["direction_change_count"])
    metric_cols[3].metric("Stop Range Changes", summary["stop_range_change_count"])

    with st.expander("Initial vs Corrected Segment Changes", expanded=summary["changed_segment_count"] > 0):
        if changes_df.empty:
            st.write("No manual changes from the initial route yet.")
        else:
            st.dataframe(changes_df, use_container_width=True, hide_index=True)

    st.session_state.save_notes = st.text_area(
        "Correction notes",
        value=st.session_state.save_notes,
        placeholder="What did you change and why? Example: kept 600 block even side separate before crossing.",
    )
    if st.button("Save Corrected Route For Learning", use_container_width=True):
        saved_path = save_route_run(
            run_id=st.session_state.route_run_id or new_run_id(st.session_state.uploaded_file_name or "uploaded-route.csv"),
            upload_name=st.session_state.uploaded_file_name or "uploaded-route.csv",
            raw_df=st.session_state.raw_df,
            baseline_ordered=st.session_state.baseline_ordered_df,
            baseline_segments=st.session_state.baseline_segment_df,
            corrected_ordered=st.session_state.ordered_df,
            corrected_segments=st.session_state.segment_df,
            settings=current_settings(st.session_state),
            notes=st.session_state.save_notes,
        )
        st.session_state.last_saved_path = str(saved_path)
        st.success(f"Saved route learning bundle: {saved_path}")

    if st.session_state.last_saved_path:
        st.caption(f"Last saved: `{st.session_state.last_saved_path}`")

    saved_runs = list_saved_runs()
    with st.expander("Saved Learning Runs"):
        if saved_runs.empty:
            st.write("No saved learning runs yet.")
        else:
            st.dataframe(saved_runs, use_container_width=True, hide_index=True)


_init_state()

st.title("Interactive Address-Order Route UI")
st.caption("Upload CSV, generate routes, override segment order/direction, and regenerate.")

with st.sidebar:
    st.header("Route Settings")
    st.number_input("Min Stops", min_value=1, max_value=500, value=45, key="min_stops")
    st.number_input("Max Stops", min_value=1, max_value=500, value=75, key="max_stops")
    st.number_input("Target Stops", min_value=1, max_value=500, value=60, key="target_stops")
    st.selectbox("Default First Side", options=["auto", "odd", "even"], key="first_side")
    st.selectbox("Street Order", options=["name", "input", "original"], key="street_order")
    st.checkbox("Split Streets Into Address Blocks", value=True, key="use_block_segments")
    st.checkbox("Split Odd/Even Sides Into Separate Segments", value=True, key="use_side_segments")
    st.number_input("Block Size", min_value=10, max_value=1000, value=100, step=10, key="block_size")

uploaded = st.file_uploader("Upload route CSV", type=["csv"])
if uploaded is not None:
    if st.session_state.uploaded_file_name != uploaded.name:
        _clear_route_state_for_new_upload(uploaded.name)
    st.session_state.raw_df = pd.read_csv(uploaded)
    st.success(f"Loaded {len(st.session_state.raw_df)} rows from {uploaded.name}")

if st.button("Run Initial Route", type="primary", use_container_width=True):
    if st.session_state.route_run_id is None:
        st.session_state.route_run_id = new_run_id(st.session_state.uploaded_file_name or "uploaded-route.csv")
    _run_builder(overrides=None)
    _capture_baseline()
    st.session_state.last_saved_path = None
    st.session_state.sort_widget_version += 1

if st.session_state.ordered_df is not None and st.session_state.segment_editor_df is not None:
    left, right = st.columns([1.15, 1])

    with left:
        st.subheader("Route Map")
        map_object = _build_map_or_show_error(st.session_state.ordered_df)
        if map_object is not None:
            _render_map(map_object)

    with right:
        st.subheader("Segment Overrides")
        st.caption("Drag cards to reorder. Change direction inside each card.")
        sorted_segment_df = st.session_state.segment_editor_df.sort_values("Segment Order", kind="mergesort")
        _render_segment_cards(sorted_segment_df)

    st.subheader("Outputs")
    summary_col1, summary_col2 = st.columns(2)
    with summary_col1:
        route_summary = st.session_state.ordered_df.groupby("Route #").size().rename("stop_count").reset_index()
        st.dataframe(route_summary, use_container_width=True, hide_index=True)
    with summary_col2:
        st.dataframe(
            st.session_state.ordered_df[
                [
                    "Route #",
                    "Route Stop #",
                    "Route Stop Range",
                    "Segment Color",
                    "Street",
                    "Canvass Unit ID",
                    "Segment First Side",
                    "Segment Direction",
                ]
            ].head(25),
            use_container_width=True,
            hide_index=True,
        )

    _render_learning_panel()

    csv_bytes = st.session_state.ordered_df.to_csv(index=False).encode("utf-8")
    st.download_button(
        "Download Ordered CSV",
        data=csv_bytes,
        file_name="ordered_canvass_routes_interactive.csv",
        mime="text/csv",
    )

    map_download = _build_map_or_show_error(st.session_state.ordered_df)
    if map_download is not None:
        html_buffer = io.BytesIO()
        html_buffer.write(map_download.get_root().render().encode("utf-8"))
        st.download_button(
            "Download Map HTML",
            data=html_buffer.getvalue(),
            file_name="canvass_route_map_interactive.html",
            mime="text/html",
        )
