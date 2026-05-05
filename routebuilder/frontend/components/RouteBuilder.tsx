"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type LType from "leaflet";
import {
  applySnapshotCorrections,
  buildAutoRoute,
  buildLassoRoute,
  fetchGeocodeProviders,
  fetchGeopointeRoutes,
  geocodeAddresses,
  saveRoute,
  saveSnapshot,
  updateSnapshotZoneNotes,
  updateSnapshotZones,
} from "@/lib/api";
import type {
  AutoRouteResponse,
  GeocodeProvider,
  GeopointeRoute,
  LassoRouteResponse,
  OpportunityPin,
  OrderedStop,
  RoutePayload,
} from "@/lib/types";
import { decodePolyline } from "@/lib/polyline";
import {
  applySegmentEdits,
  clearSplits,
  emptySegmentEdits,
  moveSegment,
  parentIdOf,
  setSegmentDirection,
  splitSegment,
  suggestSplitPosition,
  type SegmentDirection,
  type SegmentEdits,
} from "@/lib/routeEdits";
import { clusterByGap } from "@/lib/clustering";
import { convexHull, expandHull, type LatLng } from "@/lib/hull";
import { splitInto2 } from "@/lib/kmeans";
import { applyRouteColors } from "@/lib/routeColors";
import type {
  GeocodedPoint,
  LassoRouteOverlay,
  MapZone,
  OverlayRoute,
} from "@/components/Map";
import type { ZoneEditorMode } from "@/components/ZoneEditor";
import type { LassoRoutePhase } from "@/components/LassoRouteMode";
import RouteSidebar from "@/components/RouteSidebar";
import BuildSettings, {
  DEFAULT_BUILD_SETTINGS,
  type BuildSettingsValues,
} from "@/components/BuildSettings";

const RouteMap = dynamic(() => import("@/components/Map"), { ssr: false });
const DrawMode = dynamic(() => import("@/components/DrawMode"), { ssr: false });
const ZoneEditor = dynamic(() => import("@/components/ZoneEditor"), { ssr: false });
const LassoRouteMode = dynamic(() => import("@/components/LassoRouteMode"), {
  ssr: false,
});

const ZONE_COLORS = ["#1f77b4", "#d94f2c", "#2ca02c", "#9467bd", "#8c564b", "#17becf", "#bcbd22"];

function zoneDisplayName(idx: number): string {
  if (idx < 26) return String.fromCharCode(65 + idx);
  const first = Math.floor(idx / 26) - 1;
  const second = idx % 26;
  return String.fromCharCode(65 + first) + String.fromCharCode(65 + second);
}

export type RouteBuilderProps = {
  pins: OpportunityPin[];
  pinsLoading: boolean;
  repOwnerId: string;
  repName: string;
  iclCode: string;
  /**
   * "live" — pulls from Salesforce, allows Save Snapshot. After saving a route,
   * navigates to /saved.
   * "snapshot" — works off a saved snapshot, no Save Snapshot button. Persists
   * zone overrides back to the snapshot. After saving a route, stays on page
   * so the user can build more variants.
   */
  mode: "live" | "snapshot";
  snapshotId?: string;
  initialZoneOverrides?: Record<string, string>;
  initialZoneNotes?: Record<string, string>;
  backLink: { href: string; label: string };
  headerSubtitle?: React.ReactNode;
};

export default function RouteBuilder({
  pins,
  pinsLoading,
  repOwnerId,
  repName,
  iclCode,
  mode,
  snapshotId,
  initialZoneOverrides,
  initialZoneNotes,
  backLink,
  headerSubtitle,
}: RouteBuilderProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [startingId, setStartingId] = useState<string | null>(null);
  const [autoRoute, setAutoRoute] = useState<AutoRouteResponse | null>(null);
  const [segmentEdits, setSegmentEdits] = useState<SegmentEdits>(emptySegmentEdits);
  const [drawing, setDrawing] = useState(false);
  const [drawnOrder, setDrawnOrder] = useState<string[] | null>(null);
  const [drawZoneId, setDrawZoneId] = useState<string | null>(null);
  const [zoneEdit, setZoneEdit] = useState<{
    mode: ZoneEditorMode;
    zoneId: string;
  } | null>(null);
  const [buildSettings, setBuildSettings] = useState<BuildSettingsValues>(DEFAULT_BUILD_SETTINGS);
  const [pinZoneOverride, setPinZoneOverride] = useState<Record<string, string>>(
    initialZoneOverrides ?? {},
  );
  const [zoneNotes, setZoneNotes] = useState<Record<string, string>>(
    initialZoneNotes ?? {},
  );

  const [lassoPhase, setLassoPhase] = useState<LassoRoutePhase | null>(null);
  const [lassoSelectedIds, setLassoSelectedIds] = useState<string[]>([]);
  const [lassoStartId, setLassoStartId] = useState<string | null>(null);
  const [lassoEndId, setLassoEndId] = useState<string | null>(null);
  const [lassoRoundTrip, setLassoRoundTrip] = useState(false);
  const [lassoResult, setLassoResult] = useState<LassoRouteResponse | null>(null);
  const [lassoError, setLassoError] = useState<string | null>(null);

  const [geocodeProvider, setGeocodeProvider] = useState<GeocodeProvider>("google");
  const [geocodedByZone, setGeocodedByZone] = useState<Record<string, GeocodedPoint[]>>({});
  const [geocodePendingZone, setGeocodePendingZone] = useState<string | null>(null);
  const [geocodeAcceptingZone, setGeocodeAcceptingZone] = useState<string | null>(null);
  const [geocodeError, setGeocodeError] = useState<string | null>(null);
  const [geocodeSummary, setGeocodeSummary] = useState<
    { ok: number; noMatch: number; error: number } | null
  >(null);

  const { data: providersStatus } = useQuery({
    queryKey: ["geocode-providers"],
    queryFn: fetchGeocodeProviders,
    staleTime: 60_000,
  });

  // Geopointe routes the rep currently has in Salesforce — surfaced so the
  // owner can see how the rep is working their assignments today. Only
  // fetched in live mode (snapshots are detached from the rep's current SF
  // state by design).
  const [geopointePanelOpen, setGeopointePanelOpen] = useState(false);
  const [visibleGeopointeIds, setVisibleGeopointeIds] = useState<Set<string>>(
    () => new Set(),
  );
  const { data: geopointeRoutes = [] } = useQuery<GeopointeRoute[]>({
    queryKey: ["geopointe-routes", repOwnerId],
    queryFn: () => fetchGeopointeRoutes(repOwnerId),
    enabled: Boolean(repOwnerId),
    staleTime: 5 * 60_000,
  });

  const GEOPOINTE_PALETTE = useMemo(
    () => ["#0f766e", "#7c3aed", "#b45309", "#be185d", "#15803d", "#0369a1"],
    [],
  );

  const geopointeColorById = useMemo(() => {
    const m = new Map<string, string>();
    geopointeRoutes.forEach((r, i) => {
      m.set(r.id, GEOPOINTE_PALETTE[i % GEOPOINTE_PALETTE.length]);
    });
    return m;
  }, [geopointeRoutes, GEOPOINTE_PALETTE]);

  const geopointeOverlay = useMemo<OverlayRoute[]>(() => {
    if (visibleGeopointeIds.size === 0) return [];
    return geopointeRoutes
      .filter((r) => visibleGeopointeIds.has(r.id) && r.stops.length >= 1)
      .map((r) => ({
        id: r.id,
        color: geopointeColorById.get(r.id) ?? "#0f766e",
        coords: r.stops.map((s) => [s.lat, s.lng] as [number, number]),
        label: r.name ?? undefined,
        stops: r.stops.map((s) => ({
          stopNumber: s.stop_number,
          lat: s.lat,
          lng: s.lng,
          label: s.label ?? s.street ?? null,
        })),
      }));
  }, [visibleGeopointeIds, geopointeRoutes, geopointeColorById]);

  const toggleGeopointeRoute = useCallback((id: string) => {
    setVisibleGeopointeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const showAllGeopointe = useCallback(() => {
    setVisibleGeopointeIds(new Set(geopointeRoutes.map((r) => r.id)));
  }, [geopointeRoutes]);

  const hideAllGeopointe = useCallback(() => {
    setVisibleGeopointeIds(new Set());
  }, []);

  // If the route list changes (e.g. rep refreshed), drop any visibility entries
  // that no longer correspond to a real route.
  useEffect(() => {
    if (visibleGeopointeIds.size === 0) return;
    const valid = new Set(geopointeRoutes.map((r) => r.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of visibleGeopointeIds) {
      if (valid.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setVisibleGeopointeIds(next);
  }, [geopointeRoutes, visibleGeopointeIds]);

  // In snapshot mode, debounce-save zone overrides back to the snapshot.
  const lastPersistedRef = useRef<string>("");
  useEffect(() => {
    if (mode !== "snapshot" || !snapshotId) return;
    const serialized = JSON.stringify(pinZoneOverride);
    if (serialized === lastPersistedRef.current) return;
    const handle = window.setTimeout(() => {
      lastPersistedRef.current = serialized;
      updateSnapshotZones(snapshotId, pinZoneOverride).catch(() => {
        lastPersistedRef.current = "";
      });
    }, 500);
    return () => window.clearTimeout(handle);
  }, [mode, snapshotId, pinZoneOverride]);

  // Seed lastPersistedRef so the initial overrides aren't re-PATCHed.
  useEffect(() => {
    if (mode === "snapshot") {
      lastPersistedRef.current = JSON.stringify(initialZoneOverrides ?? {});
    }
  }, [mode, initialZoneOverrides]);

  // Same pattern for zone notes — debounced PATCH to the snapshot.
  const lastNotesRef = useRef<string>("");
  useEffect(() => {
    if (mode !== "snapshot" || !snapshotId) return;
    const serialized = JSON.stringify(zoneNotes);
    if (serialized === lastNotesRef.current) return;
    const handle = window.setTimeout(() => {
      lastNotesRef.current = serialized;
      updateSnapshotZoneNotes(snapshotId, zoneNotes).catch(() => {
        lastNotesRef.current = "";
      });
    }, 600);
    return () => window.clearTimeout(handle);
  }, [mode, snapshotId, zoneNotes]);

  useEffect(() => {
    if (mode === "snapshot") {
      lastNotesRef.current = JSON.stringify(initialZoneNotes ?? {});
    }
  }, [mode, initialZoneNotes]);

  const handleZoneNoteChange = useCallback((zoneId: string, note: string) => {
    setZoneNotes((prev) => {
      if (note === "" && !(zoneId in prev)) return prev;
      return { ...prev, [zoneId]: note };
    });
  }, []);

  const displayedAutoRoute = useMemo(
    () => (autoRoute ? applyRouteColors(applySegmentEdits(autoRoute, segmentEdits)) : null),
    [autoRoute, segmentEdits],
  );

  const zoneIndex = useMemo(() => {
    type Zone = {
      id: string;
      pinIds: string[];
      color: string;
      label: string;
      polygon: LatLng[];
    };
    if (pins.length === 0) {
      return { zones: [] as Zone[], byPinId: new Map<string, string>() };
    }
    const clusters = clusterByGap(pins, buildSettings.cluster_eps_meters, 1);
    const eligibleBase = clusters.filter((c) => c.length >= buildSettings.min_zone_size);
    const basePinZone = new Map<string, string>();
    eligibleBase.forEach((indices, idx) => {
      const baseId = `zone-${idx}`;
      for (const i of indices) basePinZone.set(pins[i].id, baseId);
    });

    const finalPinZone = new Map<string, string>();
    for (const pin of pins) {
      const override = pinZoneOverride[pin.id];
      const base = basePinZone.get(pin.id);
      const final = override ?? base;
      if (final) finalPinZone.set(pin.id, final);
    }

    const order: string[] = [];
    const groups = new Map<string, string[]>();
    for (const pin of pins) {
      const id = finalPinZone.get(pin.id);
      if (!id) continue;
      let g = groups.get(id);
      if (!g) {
        g = [];
        groups.set(id, g);
        order.push(id);
      }
      g.push(pin.id);
    }

    const pinById = new Map(pins.map((p) => [p.id, p]));
    const zones: Zone[] = [];
    let displayIdx = 0;
    for (const id of order) {
      const pinIds = groups.get(id) ?? [];
      if (pinIds.length < buildSettings.min_zone_size) continue;
      const points: LatLng[] = pinIds
        .map((pid) => pinById.get(pid))
        .filter((p): p is OpportunityPin => Boolean(p))
        .map((p) => [p.lat, p.lng]);
      const polygon = expandHull(convexHull(points), 60);
      const color = ZONE_COLORS[displayIdx % ZONE_COLORS.length];
      const label = `Zone ${zoneDisplayName(displayIdx)} · ${pinIds.length} leads`;
      zones.push({ id, pinIds, color, label, polygon });
      displayIdx += 1;
    }

    const byPinId = new Map<string, string>();
    for (const z of zones) {
      for (const pinId of z.pinIds) byPinId.set(pinId, z.id);
    }
    return { zones, byPinId };
  }, [pins, buildSettings.cluster_eps_meters, buildSettings.min_zone_size, pinZoneOverride]);

  const activeZoneId = startingId ? zoneIndex.byPinId.get(startingId) ?? null : null;

  const mapZones = useMemo<MapZone[]>(() => {
    if (!buildSettings.show_zones) return [];
    return zoneIndex.zones.map((z) => ({
      id: z.id,
      polygon: z.polygon,
      color: z.color,
      label: z.label,
      active: activeZoneId === z.id,
      dim: activeZoneId !== null && activeZoneId !== z.id,
    }));
  }, [zoneIndex.zones, buildSettings.show_zones, activeZoneId]);

  const handleMoveSegment = useCallback(
    (route: RoutePayload, segmentId: string, delta: -1 | 1) => {
      setSegmentEdits((prev) => moveSegment(prev, route, segmentId, delta));
    },
    [],
  );
  const handleSetDirection = useCallback(
    (segmentId: string, direction: SegmentDirection) => {
      setSegmentEdits((prev) => setSegmentDirection(prev, segmentId, direction));
    },
    [],
  );
  const toNaturalAfter = useCallback(
    (segmentId: string, displayedAfter: number): number | null => {
      if (!autoRoute || !displayedAutoRoute) return null;
      const dispSeg = displayedAutoRoute.routes
        .flatMap((r) => r.segments)
        .find((s) => s.segment_id === segmentId);
      if (!dispSeg) return null;
      const parentId = parentIdOf(segmentId);
      const origSeg = autoRoute.routes
        .flatMap((r) => r.segments)
        .find((s) => s.segment_id === parentId);
      const originalDir = origSeg?.direction ?? "forward";
      const reversed = dispSeg.direction !== originalDir;
      return reversed ? dispSeg.stop_count - displayedAfter : displayedAfter;
    },
    [autoRoute, displayedAutoRoute],
  );

  const handleSplitSegment = useCallback(
    (segmentId: string, localAfterPosition: number) => {
      if (!autoRoute) return;
      const natural = toNaturalAfter(segmentId, localAfterPosition);
      if (natural === null) return;
      setSegmentEdits((prev) => splitSegment(prev, autoRoute, segmentId, natural));
    },
    [autoRoute, toNaturalAfter],
  );
  const handleSuggestSplit = useCallback(
    (segmentId: string) => {
      if (!autoRoute || !displayedAutoRoute) return;
      const stopsInThisSegment = displayedAutoRoute.routes
        .flatMap((r) => r.stops)
        .filter((s) => s.segment_id === segmentId);
      const local = suggestSplitPosition(stopsInThisSegment);
      if (!local) return;
      const natural = toNaturalAfter(segmentId, local);
      if (natural === null) return;
      setSegmentEdits((prev) => splitSegment(prev, autoRoute, segmentId, natural));
    },
    [autoRoute, displayedAutoRoute, toNaturalAfter],
  );
  const handleResetSplits = useCallback((segmentId: string) => {
    setSegmentEdits((prev) => clearSplits(prev, segmentId));
  }, []);

  const handleSplitZone = useCallback(
    (zoneId: string) => {
      const zone = zoneIndex.zones.find((z) => z.id === zoneId);
      if (!zone || zone.pinIds.length < 4) return;
      const pinById = new Map(pins.map((p) => [p.id, p]));
      const points = zone.pinIds
        .map((id) => pinById.get(id))
        .filter((p): p is OpportunityPin => Boolean(p))
        .map((p) => ({ lat: p.lat, lng: p.lng }));
      const assignments = splitInto2(points);
      const next: Record<string, string> = {};
      zone.pinIds.forEach((pid, i) => {
        next[pid] = `${zoneId}/${assignments[i]}`;
      });
      setPinZoneOverride((prev) => ({ ...prev, ...next }));
    },
    [pins, zoneIndex.zones],
  );

  const handleResetZone = useCallback(
    (zoneId: string) => {
      setPinZoneOverride((prev) => {
        const next: Record<string, string> = {};
        for (const [pinId, ovr] of Object.entries(prev)) {
          if (!(ovr === zoneId || ovr.startsWith(zoneId + "/"))) {
            next[pinId] = ovr;
          }
        }
        return next;
      });
    },
    [],
  );

  const handleResetAllZoneSplits = useCallback(() => {
    setPinZoneOverride({});
  }, []);

  const handleStartLasso = useCallback(
    (zoneId: string) => setZoneEdit({ mode: "lasso", zoneId }),
    [],
  );
  const handleStartCut = useCallback(
    (zoneId: string) => setZoneEdit({ mode: "splitline", zoneId }),
    [],
  );
  const handleCancelZoneEdit = useCallback(() => setZoneEdit(null), []);

  const handleLassoComplete = useCallback(
    (pinIds: string[]) => {
      if (!zoneEdit) return;
      const targetZoneId = zoneEdit.zoneId;
      if (pinIds.length === 0) {
        setZoneEdit(null);
        return;
      }
      setPinZoneOverride((prev) => {
        const next = { ...prev };
        for (const id of pinIds) next[id] = targetZoneId;
        return next;
      });
      setZoneEdit(null);
    },
    [zoneEdit],
  );

  const handleSplitLineComplete = useCallback(
    (aIds: string[], bIds: string[]) => {
      if (!zoneEdit) return;
      const zoneId = zoneEdit.zoneId;
      // If everything ended up on one side, treat as a no-op rather than
      // tagging every pin with the same /0 suffix (which would be a noisy
      // override with no visible effect).
      if (aIds.length === 0 || bIds.length === 0) {
        setZoneEdit(null);
        return;
      }
      setPinZoneOverride((prev) => {
        const next = { ...prev };
        for (const id of aIds) next[id] = `${zoneId}/0`;
        for (const id of bIds) next[id] = `${zoneId}/1`;
        return next;
      });
      setZoneEdit(null);
    },
    [zoneEdit],
  );

  const handleGeocodeZone = useCallback(
    async (zoneId: string) => {
      const zone = zoneIndex.zones.find((z) => z.id === zoneId);
      if (!zone) return;
      const pinById = new Map(pins.map((p) => [p.id, p]));
      const addresses = zone.pinIds
        .map((id) => pinById.get(id))
        .filter((p): p is OpportunityPin => Boolean(p))
        .map((p) => ({
          id: p.id,
          street: p.street,
          city: p.city ?? null,
          state: p.state ?? null,
          postal_code: p.postal_code ?? null,
          original_lat: p.lat,
          original_lng: p.lng,
        }));
      if (addresses.length === 0) return;
      setGeocodePendingZone(zoneId);
      setGeocodeError(null);
      try {
        const resp = await geocodeAddresses({ provider: geocodeProvider, addresses });
        const points: GeocodedPoint[] = [];
        let ok = 0;
        let noMatch = 0;
        let error = 0;
        for (const r of resp.results) {
          if (r.status === "ok" && r.lat != null && r.lng != null) {
            const orig = pinById.get(r.id);
            if (!orig) continue;
            points.push({
              pinId: r.id,
              lat: r.lat,
              lng: r.lng,
              provider: r.provider ?? geocodeProvider,
              formattedAddress: r.formatted_address ?? null,
              locationType: r.location_type ?? null,
              originalLat: orig.lat,
              originalLng: orig.lng,
            });
            ok += 1;
          } else if (r.status === "no_match") {
            noMatch += 1;
          } else {
            error += 1;
          }
        }
        setGeocodedByZone((prev) => ({ ...prev, [zoneId]: points }));
        setGeocodeSummary({ ok, noMatch, error });
      } catch (err) {
        setGeocodeError(err instanceof Error ? err.message : String(err));
      } finally {
        setGeocodePendingZone(null);
      }
    },
    [pins, zoneIndex.zones, geocodeProvider],
  );

  const handleClearGeocoded = useCallback(() => {
    setGeocodedByZone({});
    setGeocodeSummary(null);
    setGeocodeError(null);
  }, []);

  const handleRejectZone = useCallback((zoneId: string) => {
    setGeocodedByZone((prev) => {
      if (!(zoneId in prev)) return prev;
      const next = { ...prev };
      delete next[zoneId];
      return next;
    });
    setGeocodeError(null);
  }, []);

  const handleAcceptZone = useCallback(
    async (zoneId: string) => {
      if (!snapshotId) return;
      const points = geocodedByZone[zoneId];
      if (!points || points.length === 0) return;
      setGeocodeAcceptingZone(zoneId);
      setGeocodeError(null);
      try {
        await applySnapshotCorrections(
          snapshotId,
          points.map((p) => ({
            id: p.pinId,
            corrected_lat: p.lat,
            corrected_lng: p.lng,
            geocode_provider: p.provider,
          })),
        );
        // Refetch the snapshot so pins re-render with the corrected coords —
        // the snapshot build page maps corrected_lat/lng → lat/lng.
        await queryClient.invalidateQueries({ queryKey: ["snapshot", snapshotId] });
        setGeocodedByZone((prev) => {
          if (!(zoneId in prev)) return prev;
          const next = { ...prev };
          delete next[zoneId];
          return next;
        });
      } catch (err) {
        setGeocodeError(err instanceof Error ? err.message : String(err));
      } finally {
        setGeocodeAcceptingZone(null);
      }
    },
    [snapshotId, geocodedByZone, queryClient],
  );

  const allGeocoded = useMemo<GeocodedPoint[]>(
    () => Object.values(geocodedByZone).flat(),
    [geocodedByZone],
  );
  const zonesWithGeocoded = useMemo(
    () => new Set(Object.keys(geocodedByZone).filter((k) => geocodedByZone[k].length > 0)),
    [geocodedByZone],
  );

  // If the underlying clustering basis changes, scrub overrides so we don't
  // dangle assignments that no longer make sense.
  const lastBasisRef = useRef<string>("");
  const basisKey = `${buildSettings.cluster_eps_meters}|${buildSettings.min_zone_size}|${pins.length}`;
  if (lastBasisRef.current !== basisKey) {
    if (lastBasisRef.current !== "" && Object.keys(pinZoneOverride).length > 0) {
      queueMicrotask(() => setPinZoneOverride({}));
    }
    lastBasisRef.current = basisKey;
  }

  const splitParents = useMemo(
    () => new Set(Object.keys(segmentEdits.splits)),
    [segmentEdits.splits],
  );
  const [mapHandles, setMapHandles] = useState<{
    map: LType.Map;
    container: HTMLDivElement;
  } | null>(null);

  const handleMapReady = useCallback((map: LType.Map, container: HTMLDivElement) => {
    setMapHandles({ map, container });
  }, []);

  const [buildingZoneId, setBuildingZoneId] = useState<string | null>(null);

  const buildMutation = useMutation({
    mutationFn: (vars: { zoneId: string; startId: string }) => {
      const { show_zones: _zones, min_zone_size: _mzs, ...algoParams } = buildSettings;
      const zone = zoneIndex.zones.find((z) => z.id === vars.zoneId);
      const scopedPins = zone
        ? pins.filter((p) => zone.pinIds.includes(p.id))
        : pins;
      return buildAutoRoute({
        owner_id: repOwnerId,
        opportunities: scopedPins,
        starting_opportunity_id: vars.startId,
        ...algoParams,
      });
    },
    onMutate: (vars) => {
      setBuildingZoneId(vars.zoneId);
    },
    onSuccess: (data) => {
      setAutoRoute(data);
      setSegmentEdits(emptySegmentEdits);
      setDrawnOrder(null);
      setBuildingZoneId(null);
    },
    onError: () => setBuildingZoneId(null),
  });

  const handleBuildZone = useCallback(
    (zoneId: string) => {
      const zone = zoneIndex.zones.find((z) => z.id === zoneId);
      if (!zone) return;
      // Reuse the user's selected start pin if it's already in this zone;
      // otherwise pick the pin closest to the zone centroid.
      let startId =
        startingId && zone.pinIds.includes(startingId) ? startingId : null;
      if (!startId) {
        const zonePins = pins.filter((p) => zone.pinIds.includes(p.id));
        if (zonePins.length === 0) return;
        const cy = zonePins.reduce((s, p) => s + p.lat, 0) / zonePins.length;
        const cx = zonePins.reduce((s, p) => s + p.lng, 0) / zonePins.length;
        let best = zonePins[0];
        let bestD = Infinity;
        for (const p of zonePins) {
          const d = Math.hypot(p.lat - cy, p.lng - cx);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        startId = best.id;
        setStartingId(startId);
      }
      buildMutation.mutate({ zoneId, startId });
    },
    [zoneIndex.zones, pins, startingId, buildMutation],
  );

  const lassoMutation = useMutation({
    mutationFn: () => {
      if (!lassoStartId) throw new Error("Pick a starting pin");
      const pinById = new Map(pins.map((p) => [p.id, p]));
      const startPin = pinById.get(lassoStartId);
      if (!startPin) throw new Error("Starting pin not found");
      const endPin = lassoRoundTrip
        ? startPin
        : lassoEndId
          ? pinById.get(lassoEndId)
          : null;
      if (!endPin) throw new Error("Pick an ending pin or check round trip");
      const opportunities = lassoSelectedIds
        .map((id) => pinById.get(id))
        .filter((p): p is OpportunityPin => Boolean(p));
      return buildLassoRoute({
        start: { lat: startPin.lat, lng: startPin.lng, label: startPin.street },
        end: { lat: endPin.lat, lng: endPin.lng, label: endPin.street },
        opportunities,
        round_trip: lassoRoundTrip,
      });
    },
    onMutate: () => setLassoError(null),
    onSuccess: (data) => {
      setLassoResult(data);
      setLassoPhase("result");
      setLassoError(null);
    },
    onError: (err) => {
      setLassoError(err instanceof Error ? err.message : String(err));
    },
  });

  const startLassoRoute = useCallback(() => {
    setAutoRoute(null);
    setSegmentEdits(emptySegmentEdits);
    setDrawnOrder(null);
    setStartingId(null);
    setLassoSelectedIds([]);
    setLassoStartId(null);
    setLassoEndId(null);
    setLassoRoundTrip(false);
    setLassoResult(null);
    setLassoError(null);
    setLassoPhase("lasso");
  }, []);

  const handleLassoRouteComplete = useCallback((pinIds: string[]) => {
    setLassoSelectedIds(pinIds);
    setLassoStartId((prev) => (prev && pinIds.includes(prev) ? prev : pinIds[0] ?? null));
    setLassoEndId((prev) =>
      prev && pinIds.includes(prev) ? prev : pinIds[pinIds.length - 1] ?? null,
    );
    setLassoPhase(pinIds.length > 0 ? "configure" : "lasso");
  }, []);

  const handleLassoReset = useCallback(() => {
    setLassoResult(null);
    setLassoError(null);
    setLassoPhase("lasso");
  }, []);

  const handleLassoCancel = useCallback(() => {
    setLassoPhase(null);
    setLassoResult(null);
    setLassoError(null);
    setLassoSelectedIds([]);
    setLassoStartId(null);
    setLassoEndId(null);
    setLassoRoundTrip(false);
  }, []);

  const lassoOverlay = useMemo<LassoRouteOverlay | null>(() => {
    if (!lassoResult || lassoPhase !== "result") return null;
    const polyCoords = lassoResult.polyline ? decodePolyline(lassoResult.polyline) : [];
    return {
      polyline: polyCoords,
      color: "#0ea5e9",
      markers: lassoResult.stops.map((s) => ({
        stopNumber: s.stop_number,
        kind: s.kind,
        lat: s.lat,
        lng: s.lng,
        label: s.label ?? s.street ?? null,
      })),
    };
  }, [lassoResult, lassoPhase]);

  const highlightedPinIds = useMemo<Set<string> | null>(() => {
    if (!lassoPhase || lassoPhase === "result") return null;
    return new Set(lassoSelectedIds);
  }, [lassoPhase, lassoSelectedIds]);

  const snapshotMutation = useMutation({
    mutationFn: (input: { label: string | null; notes: string | null }) => {
      const correctionByPinId = new Map<string, GeocodedPoint>();
      for (const pts of Object.values(geocodedByZone)) {
        for (const p of pts) correctionByPinId.set(p.pinId, p);
      }
      const opportunities: OpportunityPin[] = pins.map((pin) => {
        const c = correctionByPinId.get(pin.id);
        return c
          ? {
              ...pin,
              corrected_lat: c.lat,
              corrected_lng: c.lng,
              geocode_provider: c.provider,
            }
          : pin;
      });
      return saveSnapshot({
        icl_code: iclCode,
        rep_owner_id: repOwnerId,
        rep_name: repName,
        opportunities,
        label: input.label,
        notes: input.notes,
        zone_overrides: Object.keys(pinZoneOverride).length > 0 ? pinZoneOverride : null,
        zone_notes: Object.keys(zoneNotes).length > 0 ? zoneNotes : null,
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["snapshots"] });
      router.push(`/snapshots/${data.id}/build`);
    },
  });

  const handleSaveSnapshot = () => {
    if (pins.length === 0) return;
    const label = window.prompt(
      `Label this snapshot of ${pins.length} opportunities (optional):`,
      new Date().toLocaleString(),
    );
    if (label === null) return;
    snapshotMutation.mutate({ label: label || null, notes: null });
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const orderedStops = computeOrderedStops(displayedAutoRoute, drawnOrder, pins);
      const routeMode: "auto" | "drawn" = drawnOrder ? "drawn" : "auto";
      const label =
        window.prompt(
          "Label this route (optional, e.g. 'auto v1' or 'loop'):",
          `${routeMode === "auto" ? "Auto" : "Drawn"} ${new Date().toLocaleTimeString()}`,
        ) ?? null;
      return saveRoute({
        rep_owner_id: repOwnerId,
        rep_name: repName,
        icl_code: iclCode,
        mode: routeMode,
        ordered_stops: orderedStops,
        auto_route_snapshot: displayedAutoRoute ?? null,
        input_snapshot: pins,
        algorithm_params: {
          starting_opportunity_id: startingId,
          ...buildSettings,
        },
        snapshot_id: snapshotId ?? null,
        label,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["saved-routes"] });
      if (mode === "snapshot" && snapshotId) {
        queryClient.invalidateQueries({ queryKey: ["snapshot-routes", snapshotId] });
        // Stay on page so the user can build another variant.
        setAutoRoute(null);
        setDrawnOrder(null);
        setStartingId(null);
        setSegmentEdits(emptySegmentEdits);
      } else {
        router.push("/saved");
      }
    },
  });

  const handlePinClick = useCallback(
    (id: string) => {
      if (drawing || zoneEdit) return;
      setStartingId((current) => (current === id ? null : id));
    },
    [drawing, zoneEdit],
  );

  const handleClearRoute = useCallback(() => {
    setAutoRoute(null);
    setSegmentEdits(emptySegmentEdits);
    setDrawnOrder(null);
    setStartingId(null);
  }, []);

  const handleDrawZone = useCallback((zoneId: string) => {
    setDrawZoneId(zoneId);
    setAutoRoute(null);
    setSegmentEdits(emptySegmentEdits);
    setDrawnOrder([]);
    setDrawing(true);
  }, []);

  const finishDraw = (order: string[]) => {
    setDrawnOrder(order);
    setDrawing(false);
    // Keep drawZoneId so the saved route knows its zone scope.
  };

  const cancelDraw = () => {
    setDrawing(false);
    setDrawnOrder(null);
    setDrawZoneId(null);
  };

  const drawScopedPins = useMemo(() => {
    if (!drawZoneId) return pins;
    const zone = zoneIndex.zones.find((z) => z.id === drawZoneId);
    if (!zone) return pins;
    return pins.filter((p) => zone.pinIds.includes(p.id));
  }, [pins, drawZoneId, zoneIndex.zones]);

  const hasOutput = Boolean(displayedAutoRoute) || Boolean(drawnOrder && drawnOrder.length);

  return (
    <main className="grid grid-cols-1 md:grid-cols-[1fr_400px] grid-rows-[auto_auto_1fr] h-screen">
      <header className="md:col-span-2 flex items-center justify-between border-b hairline px-6 py-4 bg-paper z-[400]">
        <div className="flex items-center gap-4">
          <Link href={backLink.href} className="label hover:text-[var(--ink)]">
            ← {backLink.label}
          </Link>
          <div className="hidden md:block w-px h-6 bg-[var(--rule)]" />
          <div>
            <div className="serif text-xl leading-tight">{repName}</div>
            <div className="label">
              {pins.length} opportunities
              {headerSubtitle ? <> · {headerSubtitle}</> : null}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {drawing ? (
            <button
              onClick={cancelDraw}
              className="label px-3 py-2 border hairline hover:bg-black/5"
            >
              Cancel
            </button>
          ) : lassoPhase ? (
            <button
              onClick={handleLassoCancel}
              className="label px-3 py-2 border hairline hover:bg-black/5"
            >
              Exit Walk Route
            </button>
          ) : (
            <>
              <button
                onClick={startLassoRoute}
                disabled={pins.length === 0}
                title="Lasso a subset of opportunities and build an optimized walking route"
                className="label px-3 py-2 border hairline hover:bg-black/5 disabled:opacity-40"
              >
                Walk Route
              </button>
              {geopointeRoutes.length > 0 && (
                <button
                  onClick={() => setGeopointePanelOpen((v) => !v)}
                  title="Toggle this rep's recent Geopointe routes from Salesforce"
                  aria-pressed={geopointePanelOpen}
                  className={
                    "label px-3 py-2 border hairline hover:bg-black/5 " +
                    (geopointePanelOpen || visibleGeopointeIds.size > 0
                      ? "bg-[var(--ink)] text-paper"
                      : "")
                  }
                >
                  SF Routes ({visibleGeopointeIds.size}/{geopointeRoutes.length})
                </button>
              )}
              {mode === "live" && (
                <button
                  onClick={handleSaveSnapshot}
                  disabled={pins.length === 0 || snapshotMutation.isPending}
                  title={
                    allGeocoded.length > 0
                      ? `Save the current assignments + ${allGeocoded.length} geocoded correction${allGeocoded.length === 1 ? "" : "s"}`
                      : "Save the current Salesforce assignments for this rep"
                  }
                  className="label px-3 py-2 border hairline hover:bg-black/5 disabled:opacity-40"
                >
                  {snapshotMutation.isPending
                    ? "Saving…"
                    : allGeocoded.length > 0
                      ? `Save Snapshot (+${allGeocoded.length})`
                      : "Save Snapshot"}
                </button>
              )}
              {hasOutput && (
                <>
                  <button
                    onClick={handleClearRoute}
                    className="label px-3 py-2 border hairline hover:bg-black/5"
                    title="Clear the current route so you can pick a new starting point"
                  >
                    Clear Route
                  </button>
                  <button
                    onClick={() => saveMutation.mutate()}
                    disabled={saveMutation.isPending}
                    className="label px-4 py-2 border-2 border-[var(--ink)] hover:bg-[var(--ink)] hover:text-paper disabled:opacity-40"
                  >
                    {saveMutation.isPending ? "Saving…" : "Save Route"}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </header>

      <div className="md:col-span-2 z-[400]">
        <BuildSettings values={buildSettings} onChange={setBuildSettings} />
      </div>

      <section className="relative">
        {pinsLoading && (
          <div className="absolute inset-0 flex items-center justify-center label z-[500]">
            Loading opportunities…
          </div>
        )}
        <RouteMap
          pins={pins}
          startingId={startingId}
          onPinClick={handlePinClick}
          autoRoute={displayedAutoRoute}
          drawnOrder={drawnOrder}
          zones={mapZones}
          geocoded={allGeocoded}
          overlayRoutes={geopointeOverlay}
          lassoRoute={lassoOverlay}
          highlightedPinIds={highlightedPinIds}
          className="absolute inset-0"
          onMapReady={handleMapReady}
        />
        {geopointePanelOpen && geopointeRoutes.length > 0 && (
          <div className="absolute bottom-4 left-4 max-w-[340px] bg-paper/95 border hairline p-3 z-[500] shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <div className="label">Salesforce routes</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={showAllGeopointe}
                  className="label px-2 py-1 border hairline hover:bg-black/5 disabled:opacity-40"
                  disabled={visibleGeopointeIds.size === geopointeRoutes.length}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={hideAllGeopointe}
                  className="label px-2 py-1 border hairline hover:bg-black/5 disabled:opacity-40"
                  disabled={visibleGeopointeIds.size === 0}
                >
                  None
                </button>
              </div>
            </div>
            <ul className="space-y-1">
              {geopointeRoutes.map((r) => {
                const color = geopointeColorById.get(r.id) ?? "#0f766e";
                const visible = visibleGeopointeIds.has(r.id);
                const date = r.route_date ?? r.last_modified?.slice(0, 10) ?? "—";
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => toggleGeopointeRoute(r.id)}
                      aria-pressed={visible}
                      title={visible ? "Hide this route" : "Show this route"}
                      className={
                        "w-full flex items-center gap-2 text-sm text-left px-1.5 py-1 border hairline hover:bg-black/5 " +
                        (visible ? "bg-black/5" : "opacity-70")
                      }
                    >
                      <span
                        className="inline-block w-3 h-3 rounded-sm shrink-0"
                        style={{
                          background: visible ? color : "transparent",
                          border: `2px solid ${color}`,
                        }}
                      />
                      <span className="truncate flex-1">
                        {r.name || "Route"}{" "}
                        <span className="label">
                          · {date} · {r.stops.length} stops
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {drawing && (
          <DrawMode
            pins={drawScopedPins}
            map={mapHandles?.map ?? null}
            mapContainer={mapHandles?.container ?? null}
            onComplete={finishDraw}
            onCancel={cancelDraw}
          />
        )}
        {zoneEdit &&
          (() => {
            const targetZone = zoneIndex.zones.find((z) => z.id === zoneEdit.zoneId);
            if (!targetZone) return null;
            const candidatePins =
              zoneEdit.mode === "lasso"
                ? pins
                : pins.filter((p) => targetZone.pinIds.includes(p.id));
            return (
              <ZoneEditor
                mode={zoneEdit.mode}
                targetZoneLabel={targetZone.label}
                targetZoneColor={targetZone.color}
                candidatePins={candidatePins}
                map={mapHandles?.map ?? null}
                mapContainer={mapHandles?.container ?? null}
                onCompleteLasso={handleLassoComplete}
                onCompleteSplit={handleSplitLineComplete}
                onCancel={handleCancelZoneEdit}
              />
            );
          })()}
        {lassoPhase && (
          <LassoRouteMode
            pins={pins}
            map={mapHandles?.map ?? null}
            mapContainer={mapHandles?.container ?? null}
            phase={lassoPhase}
            selectedIds={lassoSelectedIds}
            startPinId={lassoStartId}
            endPinId={lassoEndId}
            roundTrip={lassoRoundTrip}
            result={lassoResult}
            isBuilding={lassoMutation.isPending}
            errorMessage={lassoError}
            onLassoComplete={handleLassoRouteComplete}
            onSetStart={setLassoStartId}
            onSetEnd={setLassoEndId}
            onSetRoundTrip={setLassoRoundTrip}
            onBuild={() => lassoMutation.mutate()}
            onReset={handleLassoReset}
            onCancel={handleLassoCancel}
          />
        )}
        {buildMutation.error instanceof Error && (
          <div className="absolute bottom-4 left-4 right-4 bg-paper border hairline p-3 text-sm z-[500]">
            <div className="label mb-1">Build failed</div>
            <div>{buildMutation.error.message}</div>
          </div>
        )}
      </section>

      <RouteSidebar
        pins={pins}
        autoRoute={displayedAutoRoute}
        drawnOrder={drawnOrder}
        startingId={startingId}
        zones={zoneIndex.zones.map((z) => ({
          id: z.id,
          label: z.label,
          color: z.color,
          leadCount: z.pinIds.length,
        }))}
        activeZoneId={activeZoneId}
        onSplitZone={handleSplitZone}
        onResetZone={handleResetZone}
        onResetAllZones={handleResetAllZoneSplits}
        onLassoIntoZone={handleStartLasso}
        onCutZone={handleStartCut}
        zoneNotes={zoneNotes}
        onZoneNoteChange={handleZoneNoteChange}
        buildControls={{
          onBuildZone: handleBuildZone,
          onDrawZone: handleDrawZone,
          buildingZoneId: buildingZoneId,
          drawingZoneId: drawing ? drawZoneId : null,
        }}
        onMoveSegment={handleMoveSegment}
        onSetSegmentDirection={handleSetDirection}
        onSplitSegment={handleSplitSegment}
        onSuggestSplit={handleSuggestSplit}
        onResetSplits={handleResetSplits}
        splitParents={splitParents}
        geocode={{
          provider: geocodeProvider,
          onProviderChange: setGeocodeProvider,
          providersAvailable: providersStatus ?? { google: false, ors: false },
          onGeocodeZone: handleGeocodeZone,
          onClearGeocoded: handleClearGeocoded,
          zonesWithResults: zonesWithGeocoded,
          pendingZoneId: geocodePendingZone,
          errorMessage: geocodeError,
          resultsSummary: geocodeSummary,
          onAcceptZone: mode === "snapshot" && snapshotId ? handleAcceptZone : undefined,
          onRejectZone: handleRejectZone,
          acceptingZoneId: geocodeAcceptingZone,
        }}
      />
    </main>
  );
}

function computeOrderedStops(
  autoRoute: AutoRouteResponse | null,
  drawnOrder: string[] | null,
  pins: OpportunityPin[],
): OrderedStop[] {
  if (autoRoute) {
    return autoRoute.routes.flatMap((route) =>
      route.stops.map((stop) => ({
        stop_number: stop.stop_number,
        opportunity_id: stop.opportunity_id,
        lat: stop.lat,
        lng: stop.lng,
      })),
    );
  }
  if (drawnOrder) {
    const byId = new Map(pins.map((p) => [p.id, p]));
    return drawnOrder
      .map((id, i) => {
        const pin = byId.get(id);
        if (!pin) return null;
        return { stop_number: i + 1, opportunity_id: id, lat: pin.lat, lng: pin.lng };
      })
      .filter((s): s is OrderedStop => Boolean(s));
  }
  return [];
}
