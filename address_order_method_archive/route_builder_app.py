#!/usr/bin/env python3
"""
Interactive Streamlit UI for address-order route generation.
"""

from __future__ import annotations

import io
import sys

import pandas as pd
import streamlit as st
import streamlit.components.v1 as components

try:
    from streamlit_folium import st_folium
except ModuleNotFoundError:
    st_folium = None

from route_core import build_map, build_routes_from_dataframe


st.set_page_config(page_title="Interactive Address-Order Route Builder", layout="wide")


def _init_state() -> None:
    defaults = {
        "raw_df": None,
        "ordered_df": None,
        "segment_df": None,
        "segment_editor_df": None,
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
            "Stop Count",
            "Route #",
            "Route Segment #",
            "Start Address",
            "End Address",
        ]
    ].copy()


def _render_map(map_object) -> None:
    if st_folium is not None:
        st_folium(map_object, width=None, height=700, returned_objects=[])
        return

    st.info("Install streamlit-folium for a native Streamlit map component. Showing embedded HTML map instead.")
    components.html(map_object.get_root().render(), height=700, scrolling=False)


def _build_map_or_show_error(ordered_df: pd.DataFrame):
    try:
        return build_map(ordered_df)
    except RuntimeError as exc:
        st.error(str(exc))
        st.info(
            "This Streamlit session is running with "
            f"`{sys.executable}`. Install map dependencies into that interpreter with "
            "`python -m pip install folium streamlit-folium`, then restart Streamlit with "
            "`python -m streamlit run route_builder_app.py`."
        )
        return None


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

uploaded = st.file_uploader("Upload route CSV", type=["csv"])
if uploaded is not None:
    st.session_state.raw_df = pd.read_csv(uploaded)
    st.success(f"Loaded {len(st.session_state.raw_df)} rows from {uploaded.name}")

action_col1, action_col2 = st.columns([1, 1])
with action_col1:
    if st.button("Run Initial Route", type="primary", use_container_width=True):
        _run_builder(overrides=None)
with action_col2:
    if st.button("Regenerate From Overrides", use_container_width=True):
        _run_builder(overrides=st.session_state.segment_editor_df)

if st.session_state.ordered_df is not None and st.session_state.segment_editor_df is not None:
    left, right = st.columns([1.15, 1])

    with left:
        st.subheader("Route Map")
        map_object = _build_map_or_show_error(st.session_state.ordered_df)
        if map_object is not None:
            _render_map(map_object)

    with right:
        st.subheader("Segment Overrides")
        st.caption("Edit Segment Order, Segment First Side, and Segment Direction then click Regenerate.")
        st.session_state.segment_editor_df = st.data_editor(
            st.session_state.segment_editor_df,
            key="segment_editor",
            use_container_width=True,
            hide_index=True,
            column_config={
                "Segment Order": st.column_config.NumberColumn(min_value=1, step=1),
                "Segment First Side": st.column_config.SelectboxColumn(options=["auto", "odd", "even"]),
                "Segment Direction": st.column_config.SelectboxColumn(options=["forward", "reverse"]),
            },
            disabled=[
                "Canvass Unit ID",
                "Street Display",
                "Stop Count",
                "Route #",
                "Route Segment #",
                "Start Address",
                "End Address",
            ],
        )

    st.subheader("Outputs")
    summary_col1, summary_col2 = st.columns(2)
    with summary_col1:
        route_summary = st.session_state.ordered_df.groupby("Route #").size().rename("stop_count").reset_index()
        st.dataframe(route_summary, use_container_width=True, hide_index=True)
    with summary_col2:
        st.dataframe(
            st.session_state.ordered_df[
                ["Route #", "Route Stop #", "Canvass Unit ID", "Segment First Side", "Segment Direction"]
            ].head(25),
            use_container_width=True,
            hide_index=True,
        )

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
