"""
Salesforce client wrapper. Uses OAuth 2.0 Resource Owner Password Credentials
Flow per maps/Salesforce_Auth_reference.md and the handoff. Caches the token
for 90 minutes so we don't re-auth per request.
"""
from __future__ import annotations

import os
import threading
import time
import xml.etree.ElementTree as ET
from typing import List, Optional

import httpx
from simple_salesforce import Salesforce

from .models import GeopointeRoute, GeopointeRouteStop, OpportunityPin, RepRow

TOKEN_TTL_SECONDS = 90 * 60


class SalesforceAuthError(RuntimeError):
    pass


class SalesforceClient:
    _lock = threading.Lock()
    _instance_token: Optional[str] = None
    _instance_url: Optional[str] = None
    _expires_at: float = 0.0
    _sf: Optional[Salesforce] = None

    def _login(self) -> Salesforce:
        login_url = os.environ.get("SF_LOGIN_URL", "https://login.salesforce.com").rstrip("/")
        client_id = os.environ["SF_CLIENT_ID"]
        client_secret = os.environ["SF_CLIENT_SECRET"]
        username = os.environ["SF_USERNAME"]
        password = os.environ["SF_PASSWORD"]
        token = os.environ.get("SF_SECURITY_TOKEN", "")
        full_password = f"{password}{token}" if token else password

        token_url = f"{login_url}/services/oauth2/token"
        with httpx.Client(timeout=20.0) as client:
            response = client.post(
                token_url,
                data={
                    "grant_type": "password",
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "username": username,
                    "password": full_password,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        if response.status_code != 200:
            raise SalesforceAuthError(
                f"Salesforce auth failed: {response.status_code} {response.text}"
            )
        body = response.json()
        access_token = body["access_token"]
        instance_url = body["instance_url"]
        return Salesforce(instance_url=instance_url, session_id=access_token)

    def get(self) -> Salesforce:
        now = time.time()
        with self._lock:
            if self._sf is None or now >= self._expires_at:
                self._sf = self._login()
                self._expires_at = now + TOKEN_TTL_SECONDS
            return self._sf


_client = SalesforceClient()


def _coalesce_lat(record: dict) -> Optional[float]:
    primary = record.get("Opportunity_GeoLocation__Latitude__s")
    if primary is not None:
        return float(primary)
    fallback = record.get("GeoCode_Geolocation__Latitude__s")
    return float(fallback) if fallback is not None else None


def _coalesce_lng(record: dict) -> Optional[float]:
    primary = record.get("Opportunity_GeoLocation__Longitude__s")
    if primary is not None:
        return float(primary)
    fallback = record.get("GeoCode_Geolocation__Longitude__s")
    return float(fallback) if fallback is not None else None


def _rep_from_ciaa_aggregate(record: dict) -> Optional[RepRow]:
    """Parse roster row from CIAA-based aggregate SOQL (aliases repId, repName)."""
    rep_id = record.get("repId")
    rep_name = record.get("repName")
    if rep_id is None:
        ciaa = record.get("Campaign_ICL_Agent_Assignment__r")
        if isinstance(ciaa, dict):
            rep_id = ciaa.get("ICL_Rep__c")
            nested = ciaa.get("ICL_Rep__r")
            if isinstance(nested, dict) and rep_name is None:
                rep_name = nested.get("Name")
    if not rep_id:
        return None
    return RepRow(
        owner_id=rep_id,
        name=(rep_name or "Unknown") if isinstance(rep_name, str) else "Unknown",
        total=int(record.get("total", 0)),
    )


def query_roster(icl_code: str) -> List[RepRow]:
    sf = _client.get()
    soql = (
        "SELECT Campaign_ICL_Agent_Assignment__r.ICL_Rep__c repId, "
        "Campaign_ICL_Agent_Assignment__r.ICL_Rep__r.Name repName, "
        "COUNT(Id) total "
        "FROM Opportunity "
        f"WHERE Campaign_ICL_Agent_Assignment__r.ICL__r.ICL_Unified_Code__c = '{icl_code}' "
        "AND Campaign_ICL_Agent_Assignment__r.Active_Flag__c = true "
        "AND IsClosed = false "
        "AND CreatedDate = LAST_N_DAYS:60 "
        "AND Opportunity_GeoLocation__Latitude__s != null "
        "GROUP BY Campaign_ICL_Agent_Assignment__r.ICL_Rep__c, "
        "Campaign_ICL_Agent_Assignment__r.ICL_Rep__r.Name "
        "ORDER BY COUNT(Id) DESC "
        "LIMIT 50"
    )
    result = sf.query_all(soql)
    rows: List[RepRow] = []
    for record in result.get("records", []):
        row = _rep_from_ciaa_aggregate(record)
        if row is not None:
            rows.append(row)
    return rows


def _geopointe_location_field_api_names() -> List[str]:
    """Return geopointe__Locations_1__c … _N__c for SOQL.

    Packaged Geopointe orgs vary: some objects only define slots 1–3. SOQL fails
    if you reference a field that is not on the object, so this count is
    configurable via GEOPOINTE_ROUTE_LOCATION_SLOTS (default 3, max 10).
    """
    raw = os.environ.get("GEOPOINTE_ROUTE_LOCATION_SLOTS", "3")
    try:
        n = int(raw)
    except ValueError:
        n = 3
    n = max(1, min(n, 10))
    return [f"geopointe__Locations_{i}__c" for i in range(1, n + 1)]


def _parse_geopointe_locations_xml(xml_text: str) -> List[GeopointeRouteStop]:
    """Parse the concatenated <routelocs> blob into ordered stops.

    The Geopointe XML contract is documented in geopointe_route_technical_spec.md.
    We tolerate missing optional tags but skip any <loc> without valid coords.
    """
    if not xml_text or not xml_text.strip():
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    stops: List[GeopointeRouteStop] = []
    for idx, loc in enumerate(root.findall("loc"), start=1):
        lat_text = (loc.findtext("lat") or "").strip()
        lng_text = (loc.findtext("lng") or "").strip()
        try:
            lat = float(lat_text)
            lng = float(lng_text)
        except ValueError:
            continue
        sid = (loc.findtext("sId") or "").strip() or None
        label = (loc.findtext("t") or "").strip() or None
        street = (loc.findtext("str") or "").strip() or None
        city = (loc.findtext("cty") or "").strip() or None
        state = (loc.findtext("st") or "").strip() or None
        postal = (loc.findtext("zip") or "").strip() or None
        stops.append(
            GeopointeRouteStop(
                stop_number=idx,
                opportunity_id=sid,
                label=label,
                street=street,
                city=city,
                state=state,
                postal_code=postal,
                lat=lat,
                lng=lng,
            )
        )
    return stops


def _resolve_user_id_for_rep(sf, rep_id: str) -> Optional[str]:
    """Resolve a rep identifier to the Salesforce User Id that owns work.

    Reps are tracked as Contacts (003 prefix) but Geopointe routes and
    Opportunities are owned by Users (005 prefix). When given a Contact, we
    look up the linked User via `User.ContactId`. User Ids pass through.
    Returns None if no active User is linked.
    """
    if rep_id.startswith("005"):
        return rep_id
    if rep_id.startswith("003"):
        soql = (
            f"SELECT Id FROM User "
            f"WHERE ContactId = '{rep_id}' AND IsActive = true LIMIT 1"
        )
        try:
            res = sf.query(soql)
        except Exception:
            print(f"[geopointe] User lookup failed: {soql}")
            raise
        records = res.get("records", [])
        if records:
            return records[0]["Id"]
        print(f"[geopointe] no active User found with ContactId={rep_id}")
        return None
    # Unknown prefix — return as-is and let the downstream query decide.
    return rep_id


def query_geopointe_routes_for_owner(
    owner_id: str, days: int = 30, limit: int = 10
) -> List[GeopointeRoute]:
    """Return the rep's recent Geopointe routes with parsed stops.

    `owner_id` may be a User Id (005…) or a Contact Id (003…). When a Contact
    is passed, we resolve it to the linked User via `User.ContactId` before
    querying routes. Sorted by most recent activity. Stops are parsed from
    geopointe__Locations_1__c … _N__c (N set by GEOPOINTE_ROUTE_LOCATION_SLOTS,
    default 3).

    `days` is currently unused but kept on the signature so callers can pass it
    once we decide which Geopointe date field is reliable in this org. The
    `null`-tolerant date filter we tried first was rejected by SOQL in some
    orgs, so we now sort by LastModifiedDate and trust the LIMIT.
    """
    del days  # reserved for future date filtering
    sf = _client.get()
    user_id = _resolve_user_id_for_rep(sf, owner_id)
    if not user_id:
        print(
            f"[geopointe] owner_id={owner_id} did not resolve to a User; "
            "returning [] (no routes)"
        )
        return []
    if user_id != owner_id:
        print(f"[geopointe] resolved Contact {owner_id} -> User {user_id}")
    location_fields = _geopointe_location_field_api_names()
    location_fields_csv = ", ".join(location_fields)
    soql = (
        f"SELECT Id, Name, OwnerId, LastModifiedDate, "
        f"geopointe__Date__c, geopointe__Route_Type__c, "
        f"geopointe__Number_of_Stops__c, geopointe__Total_Distance_mi__c, "
        f"{location_fields_csv} "
        f"FROM geopointe__Route__c "
        f"WHERE OwnerId = '{user_id}' "
        f"ORDER BY LastModifiedDate DESC "
        f"LIMIT {int(limit)}"
    )
    try:
        result = sf.query_all(soql)
    except Exception:
        # Print the SOQL once so the failure is debuggable in uvicorn logs
        # without leaking SF internals into the API response.
        print(f"[geopointe] SOQL failed: {soql}")
        raise
    raw_records = result.get("records", [])
    print(
        f"[geopointe] User {user_id} found {len(raw_records)} route record(s)"
    )
    routes: List[GeopointeRoute] = []
    dropped = 0
    for record in raw_records:
        xml_chunks = [record.get(f) or "" for f in location_fields]
        xml_text = "".join(xml_chunks).strip()
        stops = _parse_geopointe_locations_xml(xml_text) if xml_text else []
        if not stops:
            # A route with no plottable stops isn't worth surfacing.
            dropped += 1
            print(
                f"[geopointe]   dropping route {record.get('Id')} "
                f"(xml_len={len(xml_text)} parsed_stops=0)"
            )
            continue
        route_date = record.get("geopointe__Date__c")
        last_modified = record.get("LastModifiedDate")
        nos = record.get("geopointe__Number_of_Stops__c")
        dist = record.get("geopointe__Total_Distance_mi__c")
        routes.append(
            GeopointeRoute(
                id=record["Id"],
                name=record.get("Name"),
                route_date=str(route_date) if route_date is not None else None,
                route_type=record.get("geopointe__Route_Type__c"),
                number_of_stops=int(nos) if nos is not None else None,
                total_distance_mi=float(dist) if dist is not None else None,
                last_modified=str(last_modified) if last_modified is not None else None,
                stops=stops,
            )
        )
    print(
        f"[geopointe] returning {len(routes)} route(s); "
        f"dropped {dropped} for empty/invalid XML"
    )
    return routes


def query_opportunities_for_owner(owner_id: str) -> List[OpportunityPin]:
    sf = _client.get()
    soql = (
        "SELECT Id, Name, Street__c, City__c, State_Province__c, PostalCode__c, "
        "Street_Name_Only__c, "
        "Opportunity_GeoLocation__Latitude__s, Opportunity_GeoLocation__Longitude__s, "
        "GeoCode_Geolocation__Latitude__s, GeoCode_Geolocation__Longitude__s, "
        "StageName, Lead_Expiration__c, ICL_Unified_Code__c "
        "FROM Opportunity "
        f"WHERE Campaign_ICL_Agent_Assignment__r.ICL_Rep__c = '{owner_id}' "
        "AND Campaign_ICL_Agent_Assignment__r.Active_Flag__c = true "
        "AND IsClosed = false "
        "AND (Opportunity_GeoLocation__Latitude__s != null OR GeoCode_Geolocation__Latitude__s != null) "
        "ORDER BY Street_Name_Only__c, Street__c "
        "LIMIT 2000"
    )
    result = sf.query_all(soql)
    pins: List[OpportunityPin] = []
    for record in result.get("records", []):
        lat = _coalesce_lat(record)
        lng = _coalesce_lng(record)
        if lat is None or lng is None:
            continue
        lead_expiration = record.get("Lead_Expiration__c")
        pins.append(
            OpportunityPin(
                id=record["Id"],
                name=record.get("Name"),
                street=record.get("Street__c") or "",
                city=record.get("City__c"),
                state=record.get("State_Province__c"),
                postal_code=record.get("PostalCode__c"),
                lat=lat,
                lng=lng,
                stage_name=record.get("StageName"),
                lead_expiration=str(lead_expiration) if lead_expiration is not None else None,
                icl_code=record.get("ICL_Unified_Code__c"),
            )
        )
    return pins
