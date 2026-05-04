# Address Order Method

This alternate builder keeps route sequencing independent from latitude/longitude.

## Logic

1. Read unordered lead records.
2. Parse house number and street name.
3. Split each street into odd/even sides.
4. Preserve the first data row in the source CSV as the initial stop.
5. Build a canvassing loop:
   - walk the starting side in address order from the starting stop
   - cross at the end
   - walk the opposite side back
6. Pack canvass units into 45-75 stop routes.
7. Export a new ordered route CSV and optional map.

Latitude and longitude are only used to draw the HTML map.

## Run

```bash
python -m pip install pandas folium streamlit streamlit-folium
python canvass_route_builder_address_order.py "../Route.csv" \
  --output ordered_canvass_routes_address_order.csv \
  --map canvass_route_map_address_order.html \
  --min-stops 45 \
  --max-stops 75 \
  --target-stops 60 \
  --block-size 100
```

To run against the second sample input:

```bash
python canvass_route_builder_address_order.py "../route2.csv" \
  --output ordered_route2_address_order.csv \
  --map route2_address_order_map.html \
  --min-stops 45 \
  --max-stops 75 \
  --target-stops 60 \
  --block-size 100
```

## Interactive UI

Run the local Streamlit interface for upload, map review, segment reordering, and regeneration:

```bash
python -m streamlit run route_builder_app.py
```

Use `python -m streamlit` so Streamlit runs with the same Python environment where `folium` and `streamlit-folium` are installed. If `streamlit-folium` is not installed, the app falls back to an embedded Folium HTML map.

The UI and CLI split streets into house-number blocks and odd/even side segments by default. With the default `--block-size 100`, `600 Indian Oaks Dr` and `610 Indian Oaks Dr` are grouped in the `600-699` even-side segment, while `611 Indian Oaks Dr` is in the `600-699` odd-side segment and `720 Indian Oaks Dr` starts the `700-799` even-side segment. Use `--no-block-segments` to restore whole-street blocks, or `--no-side-segments` to keep odd/even sides together within each block.

Initial sequencing uses a two-level optimizer. The builder keeps street/block/side segments available for editing, then globally orders those segments by nearest endpoint so a route can naturally walk one side across adjacent blocks, cross at an endpoint, and return on the opposite side. The scorer includes small penalties for jumping away from the current street/block and for entering large loops before short nearby cleanup segments are handled.

Street names are normalized before segmentation so common CSV variants such as `Boston AveSE`, `Overlook SE Ave`, unit suffixes, and trailing one-character unit markers are less likely to create artificial street groups.

The UI saves learning bundles under `saved_routes/`. Each saved run includes the uploaded CSV, initial ordered output, manually corrected output, segment summaries, change comparison, settings, and notes. Use these saved comparisons to identify recurring manual corrections and improve the initial routing heuristic over time.
