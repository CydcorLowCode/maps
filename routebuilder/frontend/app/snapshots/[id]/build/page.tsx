"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { fetchSnapshot } from "@/lib/api";
import type { OpportunityPin } from "@/lib/types";
import RouteBuilder from "@/components/RouteBuilder";

export default function SnapshotBuildPage() {
  const params = useParams<{ id: string }>();
  const snapshotId = params.id;

  const { data: snapshot, isLoading } = useQuery({
    queryKey: ["snapshot", snapshotId],
    queryFn: () => fetchSnapshot(snapshotId),
  });

  // Use corrected coords when available — that's the whole point of the
  // geocoding flow. Originals stay on the pin object for inspection.
  const pins = useMemo<OpportunityPin[]>(() => {
    if (!snapshot) return [];
    return snapshot.opportunities.map((opp) => {
      if (opp.corrected_lat != null && opp.corrected_lng != null) {
        return { ...opp, lat: opp.corrected_lat, lng: opp.corrected_lng };
      }
      return opp;
    });
  }, [snapshot]);

  if (isLoading || !snapshot) {
    return (
      <main className="h-screen flex items-center justify-center label">
        Loading snapshot…
      </main>
    );
  }

  return (
    <RouteBuilder
      pins={pins}
      pinsLoading={false}
      repOwnerId={snapshot.rep_salesforce_id}
      repName={snapshot.rep_name}
      iclCode={snapshot.icl_code}
      mode="snapshot"
      snapshotId={snapshot.id}
      initialZoneOverrides={snapshot.zone_overrides ?? {}}
      initialZoneNotes={snapshot.zone_notes ?? {}}
      backLink={{ href: `/snapshots/${snapshot.id}`, label: "Snapshot" }}
      headerSubtitle={
        <>
          snapshot {snapshot.label ?? new Date(snapshot.created_at).toLocaleString()}
        </>
      }
    />
  );
}
