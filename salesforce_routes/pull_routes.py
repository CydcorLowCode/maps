#!/usr/bin/env python3
"""Pull a batch of Geopointe Routes via the `sf` CLI and write each to its own
CSV in the route_raw_example.csv format.

Usage:
    python3 pull_routes.py [--org ALIAS] [--limit 50] [--out routes_out]
                           [--min-stops 50] [--max-stops 80] [--when TODAY]

Examples:
    python3 pull_routes.py
    python3 pull_routes.py --org Cydcor_Prod --limit 50 --out routes_out
    python3 pull_routes.py --when "LAST_N_DAYS:7" --min-stops 30 --max-stops 200
"""
import argparse
import csv
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

FIELDS = [
    "Stop #", "Name", "Note", "Street", "City", "State", "Postal Code",
    "Country", "Start Time", "End Time", "Id", "Latitude", "Longitude",
]


def sf_query(soql: str, org: str) -> list[dict]:
    cmd = ["sf", "data", "query", "--query", soql, "-o", org, "--json"]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout)
    return payload["result"]["records"]


def text(el, tag: str) -> str:
    child = el.find(tag)
    if child is None or child.text is None:
        return ""
    val = child.text.strip()
    return "" if val.lower() == "null" else val


def parse_locations(record: dict) -> list[dict]:
    blob = ""
    for fld in ("geopointe__Locations_1__c", "geopointe__Locations_2__c", "geopointe__Locations_3__c"):
        blob += record.get(fld) or ""
    if not blob:
        return []
    blob = re.sub(r"</routelocs>\s*<routelocs>", "", blob)
    if not blob.startswith("<routelocs>"):
        blob = "<routelocs>" + blob
    if not blob.endswith("</routelocs>"):
        blob += "</routelocs>"
    root = ET.fromstring(blob)
    locs = root.findall("loc")
    arrivals = [text(l, "arrivalTime") for l in locs]
    has_arrivals = any(arrivals)
    rows = []
    for i, loc in enumerate(locs, start=1):
        rows.append({
            "Stop #": i,
            "Name": text(loc, "t"),
            "Note": text(loc, "stopNote"),
            "Street": text(loc, "str"),
            "City": text(loc, "cty"),
            "State": text(loc, "st"),
            "Postal Code": text(loc, "zip"),
            "Country": text(loc, "cntry"),
            "Start Time": text(loc, "arrivalTime") if has_arrivals else "",
            "End Time": "",
            "Id": text(loc, "sId"),
            "Latitude": text(loc, "lat"),
            "Longitude": text(loc, "lng"),
        })
    return rows


def safe_filename(name: str, route_id: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", (name or "route").strip())[:40].strip("_") or "route"
    return f"{slug}__{route_id}.csv"


def write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--org", default="Cydcor_Prod")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--out", default="routes_out")
    ap.add_argument("--min-stops", type=int, default=50)
    ap.add_argument("--max-stops", type=int, default=80)
    ap.add_argument("--when", default="TODAY", help="SOQL date literal for CreatedDate (e.g. TODAY, YESTERDAY, LAST_N_DAYS:7)")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    list_soql = (
        "SELECT Id, Name, geopointe__Number_of_Stops__c, CreatedDate "
        "FROM geopointe__Route__c "
        f"WHERE CreatedDate = {args.when} "
        f"AND geopointe__Number_of_Stops__c > {args.min_stops} "
        f"AND geopointe__Number_of_Stops__c < {args.max_stops} "
        "ORDER BY CreatedDate DESC "
        f"LIMIT {args.limit}"
    )
    print(f"Listing routes from {args.org} (limit {args.limit})...")
    routes = sf_query(list_soql, args.org)
    print(f"Found {len(routes)} routes")

    manifest = []
    for idx, r in enumerate(routes, start=1):
        rid = r["Id"]
        rname = r.get("Name") or ""
        detail_soql = (
            "SELECT Id, Name, geopointe__Number_of_Stops__c, "
            "geopointe__Locations_1__c, geopointe__Locations_2__c, geopointe__Locations_3__c "
            f"FROM geopointe__Route__c WHERE Id = '{rid}'"
        )
        try:
            detail = sf_query(detail_soql, args.org)[0]
            rows = parse_locations(detail)
            fname = safe_filename(rname, rid)
            write_csv(out_dir / fname, rows)
            print(f"[{idx}/{len(routes)}] {rid}  {len(rows):>3} stops  -> {fname}")
            manifest.append({"id": rid, "name": rname, "stops": len(rows), "file": fname})
        except subprocess.CalledProcessError as e:
            print(f"[{idx}/{len(routes)}] {rid}  ERROR: {e.stderr.strip()[:200]}", file=sys.stderr)
        except ET.ParseError as e:
            print(f"[{idx}/{len(routes)}] {rid}  XML parse failed: {e}", file=sys.stderr)

    (out_dir / "_manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nDone. Wrote {len(manifest)} CSVs to {out_dir}/")


if __name__ == "__main__":
    main()
