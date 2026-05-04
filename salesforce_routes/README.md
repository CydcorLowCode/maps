# Salesforce Routes — Pull & Visualize

Tools for extracting Geopointe routes (`geopointe__Route__c`) from Salesforce, exporting each route's stops to CSV, and rendering them on a map.

## Prerequisites

- Python 3.9+ (standard library only — no `pip install` needed)
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) authenticated to at least one org
  ```bash
  sf org login web -a Cydcor_Prod
  sf org list
  ```

## Files

| File | Purpose |
|------|---------|
| `pull_routes.py` | Query the org, write one CSV per route into an output folder |
| `convert_route.py` | Convert a single saved JSON query result into one CSV (used internally / for ad-hoc) |
| `visualize_routes.py` | Build a self-contained `visualize.html` map from a folder of route CSVs |
| `route_raw_example.csv` | Reference for the target CSV schema |

## CSV schema

Matches the Geopointe "Export Stops" format:

```
Stop #, Name, Note, Street, City, State, Postal Code, Country,
Start Time, End Time, Id, Latitude, Longitude
```

`Id` is the underlying Salesforce record ID for each stop (typically an Opportunity / Lead). `Start Time` is populated only when the source route has been optimized with arrival times.

## Workflow

### 1. Pull routes

```bash
python3 pull_routes.py                              # 50 routes, today, 50<stops<80 → routes_out/
python3 pull_routes.py --limit 100 --out big_pull   # bigger batch into custom folder
python3 pull_routes.py --when LAST_N_DAYS:7         # past 7 days
python3 pull_routes.py --min-stops 30 --max-stops 200
python3 pull_routes.py --org lowcode-sandbox        # different org alias
```

Flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--org` | `Cydcor_Prod` | `sf` org alias to query |
| `--limit` | `50` | Max routes to pull |
| `--out` | `routes_out` | Output folder (created if missing) |
| `--min-stops` | `50` | Strict lower bound on `geopointe__Number_of_Stops__c` |
| `--max-stops` | `80` | Strict upper bound |
| `--when` | `TODAY` | Any SOQL date literal (`TODAY`, `YESTERDAY`, `THIS_WEEK`, `LAST_N_DAYS:N`) |

Output:
- `<out>/<RouteName>__<RouteId>.csv` per route
- `<out>/_manifest.json` summary index

How it works: one SOQL pulls the matching route IDs, then each route is fetched individually because the `Locations_1/2/3__c` text-area fields can total 60K+ chars per route (Salesforce splits the XML across the three fields when it overflows 32K). The script reassembles them before parsing.

### 2. Visualize

```bash
python3 visualize_routes.py                                 # reads routes_out/ → visualize.html
python3 visualize_routes.py --in big_pull --out big.html
open visualize.html
```

The output is a single self-contained HTML file (Leaflet + OpenStreetMap tiles via CDN). Open it directly in a browser — no server required.

UI:
- Dropdown to switch between routes
- Numbered circular pins for each stop (green = stop 1 / start, red = last stop, blue = middle)
- Polyline connecting stops in route order
- Click a pin for a popup with the stop name, address, and Salesforce Id

### 3. Ad-hoc one-off conversion

If you already have a JSON query result saved (e.g. from the Salesforce MCP tool), you can convert it directly:

```bash
python3 convert_route.py path/to/saved-query-result.json out.csv
```

Expects either a raw `sf data query --json` payload or the MCP-wrapped `[{"type":"text","text":"..."}]` form.

## Notes

- The script uses `sf data query`, which auto-paginates up to 2000 records — sufficient for the route-list step. The per-route detail query returns a single record so size is never an issue.
- If a route's XML is malformed, the script logs the error and continues to the next route. Failures appear in stderr; successes in stdout.
- `Stop #` in the output CSV is sequential by XML order. Geopointe's optimization order is preserved because the XML is stored in route order.
