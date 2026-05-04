# Coordinate Geometry Method

## What this builds

This is a first-pass Python route builder for door-to-door canvassing. It does not treat the problem like normal delivery routing. It creates human-walkable canvassing units first, then packs those units into 45-75 stop routes.

## Current Phase 1 logic

1. Read a CSV with `Street`, `Latitude`, and `Longitude`.
2. Parse the house number and street name.
3. Split street groups into odd and even sides.
4. Infer street direction from lat/lng.
5. Build a route unit as:

```text
walk one side forward
cross at the end
walk the opposite side backward
```

6. Pack route units into routes with configurable stop limits.
7. Export an ordered CSV and optional HTML map.

## Run

```bash
pip install pandas numpy folium
python canvass_route_builder.py "../Route.csv" \
  --output ordered_canvass_routes.csv \
  --map canvass_route_map.html \
  --min-stops 45 \
  --max-stops 75 \
  --target-stops 60
```

## Start mode

```bash
--start-mode auto
```

Default behavior:
- If the CSV has an original `Stop #`, the route starts nearest the lowest original stop.
- Otherwise it starts from a southwest spatial edge.

Other options:

```bash
--start-mode original_first
--start-mode southwest
```

## Important limitations

This is Phase 1. It intentionally avoids OSM/OSRM so the logic is easier to test.

Known limitations:
- It uses odd/even house numbers as a proxy for side-of-street.
- It does not yet snap leads to OSM road segments.
- It approximates block segmentation using gaps in projected geometry.
- Cul-de-sacs and loop streets are handled reasonably only when house-number ordering is clean.
- Major road crossing penalties are not implemented yet.

## Recommended Phase 2

Add:
- OSM road snapping
- true block-face IDs
- side-of-road using geometric cross product
- cul-de-sac detection
- major-road barriers
- OSRM walking distances between canvass units
- route compactness scoring
