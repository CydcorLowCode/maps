"""
Salesforce client wrapper. Uses OAuth 2.0 Resource Owner Password Credentials
Flow per maps/Salesforce_Auth_reference.md and the handoff. Caches the token
for 90 minutes so we don't re-auth per request.
"""
from __future__ import annotations

import os
import threading
import time
from typing import List, Optional

import httpx
from simple_salesforce import Salesforce

from .models import OpportunityPin, RepRow

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


def query_roster(icl_code: str) -> List[RepRow]:
    sf = _client.get()
    soql = (
        "SELECT OwnerId, Owner.Name, COUNT(Id) total "
        "FROM Opportunity "
        f"WHERE ICL_Unified_Code__c = '{icl_code}' "
        "AND IsClosed = false "
        "AND CreatedDate = LAST_N_DAYS:60 "
        "AND Opportunity_GeoLocation__Latitude__s != null "
        "AND OwnerId IN (SELECT Id FROM User WHERE IsActive = true AND (NOT Name LIKE '%Queue%')) "
        "GROUP BY OwnerId, Owner.Name "
        "ORDER BY COUNT(Id) DESC "
        "LIMIT 50"
    )
    result = sf.query_all(soql)
    rows: List[RepRow] = []
    for record in result.get("records", []):
        owner_id = record.get("OwnerId")
        owner_name = (record.get("Owner") or {}).get("Name") if isinstance(record.get("Owner"), dict) else None
        if not owner_name:
            owner_name = record.get("Name") or "Unknown"
        rows.append(RepRow(owner_id=owner_id, name=owner_name, total=int(record.get("total", 0))))
    return rows


def query_opportunities_for_owner(owner_id: str) -> List[OpportunityPin]:
    sf = _client.get()
    soql = (
        "SELECT Id, Name, Street__c, City__c, State_Province__c, PostalCode__c, "
        "Street_Name_Only__c, "
        "Opportunity_GeoLocation__Latitude__s, Opportunity_GeoLocation__Longitude__s, "
        "GeoCode_Geolocation__Latitude__s, GeoCode_Geolocation__Longitude__s, "
        "StageName, Lead_Expiration__c, ICL_Unified_Code__c "
        "FROM Opportunity "
        f"WHERE OwnerId = '{owner_id}' "
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
