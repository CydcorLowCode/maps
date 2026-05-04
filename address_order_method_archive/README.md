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
  --target-stops 60
```

To run against the second sample input:

```bash
python canvass_route_builder_address_order.py "../route2.csv" \
  --output ordered_route2_address_order.csv \
  --map route2_address_order_map.html \
  --min-stops 45 \
  --max-stops 75 \
  --target-stops 60
```

## Interactive UI

Run the local Streamlit interface for upload, map review, segment reordering, and regeneration:

```bash
python -m streamlit run route_builder_app.py
```

Use `python -m streamlit` so Streamlit runs with the same Python environment where `folium` and `streamlit-folium` are installed. If `streamlit-folium` is not installed, the app falls back to an embedded Folium HTML map.
