#!/usr/bin/env python3
"""Build a self-contained HTML map visualizer for every route CSV in a folder.

Usage:
    python3 visualize_routes.py [--in routes_out] [--out visualize.html]

Open the resulting HTML file directly in a browser — no server needed.
"""
import argparse
import csv
import json
from pathlib import Path


def load_routes(in_dir: Path) -> list[dict]:
    routes = []
    for csv_path in sorted(in_dir.glob("*.csv")):
        stops = []
        with csv_path.open() as f:
            for row in csv.DictReader(f):
                try:
                    lat = float(row["Latitude"])
                    lng = float(row["Longitude"])
                except (TypeError, ValueError):
                    continue
                stops.append({
                    "n": row["Stop #"] or str(len(stops) + 1),
                    "name": row["Name"],
                    "addr": f'{row["Street"]}, {row["City"]}, {row["State"]} {row["Postal Code"]}',
                    "id": row["Id"],
                    "lat": lat,
                    "lng": lng,
                })
        if stops:
            routes.append({"file": csv_path.name, "stops": stops})
    return routes


HTML_TEMPLATE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Route Visualizer</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  html, body { margin: 0; height: 100%; font-family: -apple-system, system-ui, sans-serif; }
  #app { display: grid; grid-template-rows: auto 1fr; height: 100%; }
  header { padding: 10px 14px; background: #1f2937; color: #f9fafb; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header select { padding: 6px 8px; font-size: 14px; min-width: 320px; }
  header .meta { font-size: 13px; color: #9ca3af; }
  #map { width: 100%; height: 100%; }
  .stop-pin {
    background: #2563eb; color: white; border: 2px solid white;
    border-radius: 50%; width: 30px; height: 30px;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700; box-shadow: 0 1px 3px rgba(0,0,0,0.4);
  }
  .stop-pin.start { background: #16a34a; }
  .stop-pin.end { background: #dc2626; }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>Route Visualizer</h1>
    <select id="picker"></select>
    <span class="meta" id="meta"></span>
  </header>
  <div id="map"></div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const ROUTES = __ROUTES_JSON__;
const map = L.map('map').setView([39.5, -98.35], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap', maxZoom: 19,
}).addTo(map);

const layer = L.layerGroup().addTo(map);
const picker = document.getElementById('picker');
const meta = document.getElementById('meta');

ROUTES.forEach((r, i) => {
  const opt = document.createElement('option');
  opt.value = i; opt.textContent = `${r.file} (${r.stops.length} stops)`;
  picker.appendChild(opt);
});

function render(idx) {
  layer.clearLayers();
  const r = ROUTES[idx];
  if (!r || !r.stops.length) return;
  const pts = r.stops.map(s => [s.lat, s.lng]);
  L.polyline(pts, { color: '#2563eb', weight: 3, opacity: 0.6 }).addTo(layer);
  r.stops.forEach((s, i) => {
    const cls = i === 0 ? 'start' : (i === r.stops.length - 1 ? 'end' : '');
    const icon = L.divIcon({
      className: '',
      html: `<div class="stop-pin ${cls}">${s.n}</div>`,
      iconSize: [30, 30], iconAnchor: [15, 15],
    });
    L.marker([s.lat, s.lng], { icon }).addTo(layer)
      .bindPopup(`<b>Stop ${s.n}</b><br>${s.name}<br>${s.addr}<br><small>${s.id}</small>`);
  });
  map.fitBounds(L.latLngBounds(pts).pad(0.1));
  meta.textContent = `${r.stops.length} stops`;
}

picker.addEventListener('change', e => render(+e.target.value));
if (ROUTES.length) render(0);
</script>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_dir", default="routes_out")
    ap.add_argument("--out", default="visualize.html")
    args = ap.parse_args()

    in_dir = Path(args.in_dir)
    if not in_dir.is_dir():
        raise SystemExit(f"Input folder not found: {in_dir}")

    routes = load_routes(in_dir)
    if not routes:
        raise SystemExit(f"No CSVs with valid lat/lng found in {in_dir}")

    html = HTML_TEMPLATE.replace("__ROUTES_JSON__", json.dumps(routes))
    Path(args.out).write_text(html)
    total = sum(len(r["stops"]) for r in routes)
    print(f"Wrote {args.out} — {len(routes)} routes, {total} total stops")


if __name__ == "__main__":
    main()
