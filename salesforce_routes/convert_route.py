#!/usr/bin/env python3
"""Convert a Geopointe Route's Locations XML into the route_raw_example.csv format."""
import csv
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

FIELDS = [
    "Stop #", "Name", "Note", "Street", "City", "State", "Postal Code",
    "Country", "Start Time", "End Time", "Id", "Latitude", "Longitude",
]

TAG_MAP = {
    "Name": "t", "Note": "stopNote", "Street": "str", "City": "cty",
    "State": "st", "Postal Code": "zip", "Country": "cntry",
    "Id": "sId", "Latitude": "lat", "Longitude": "lng",
}


def text(el, tag):
    child = el.find(tag)
    if child is None or child.text is None:
        return ""
    val = child.text.strip()
    return "" if val.lower() == "null" else val


def main(json_path: str, out_path: str):
    payload = json.loads(Path(json_path).read_text())
    if isinstance(payload, list):
        payload = json.loads(payload[0]["text"])
    record = payload["records"][0]

    combined = ""
    for fld in ("geopointe__Locations_1__c", "geopointe__Locations_2__c", "geopointe__Locations_3__c"):
        val = record.get(fld) or ""
        combined += val

    # Locations_1/2/3 may split mid-tag; ensure single root
    xml_blob = combined
    # Strip the outer <routelocs> from each chunk if duplicated
    xml_blob = re.sub(r"</routelocs>\s*<routelocs>", "", xml_blob)
    if not xml_blob.startswith("<routelocs>"):
        xml_blob = "<routelocs>" + xml_blob
    if not xml_blob.endswith("</routelocs>"):
        xml_blob = xml_blob + "</routelocs>"

    root = ET.fromstring(xml_blob)
    locs = root.findall("loc")

    # Detect optimization/start time presence
    arrival_times = [text(l, "arrivalTime") for l in locs]
    has_arrivals = any(a for a in arrival_times)

    rows = []
    for i, loc in enumerate(locs, start=1):
        arrival = text(loc, "arrivalTime")
        row = {
            "Stop #": i,
            "Name": text(loc, "t"),
            "Note": text(loc, "stopNote"),
            "Street": text(loc, "str"),
            "City": text(loc, "cty"),
            "State": text(loc, "st"),
            "Postal Code": text(loc, "zip"),
            "Country": text(loc, "cntry"),
            "Start Time": arrival if has_arrivals else "",
            "End Time": "",
            "Id": text(loc, "sId"),
            "Latitude": text(loc, "lat"),
            "Longitude": text(loc, "lng"),
        }
        rows.append(row)

    with open(out_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)

    print(f"Wrote {len(rows)} stops to {out_path}")
    print(f"Route: {record.get('Name')} ({record.get('Id')})")
    print(f"Number_of_Stops field: {record.get('geopointe__Number_of_Stops__c')}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
