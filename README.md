# Canvass Route Builder Methods

This folder keeps the shared input CSVs at the top level and separates the two route-building approaches into method folders.

## Inputs

- `Route.csv`
- `route2.csv`

## Methods

- `coordinate_geometry_method/`: original Phase 1 builder. Uses latitude/longitude to infer street direction, split geometric segments, sequence units, and draw the map.
- `address_order_method/`: alternate address-first builder. Uses parsed street name, odd/even side, and house-number order for route sequencing. Latitude/longitude are only used for map output.

Each method folder contains its script, generated CSV output, generated HTML map, and run instructions.
