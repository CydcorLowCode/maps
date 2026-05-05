"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { fetchOpportunities } from "@/lib/api";
import { useIclCode } from "@/lib/iclCode";
import RouteBuilder from "@/components/RouteBuilder";

export default function MapScreenPage() {
  return (
    <Suspense fallback={null}>
      <MapScreen />
    </Suspense>
  );
}

function MapScreen() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const ownerId = params.id;
  const repName = searchParams.get("name") ?? "Rep";
  const { iclCode } = useIclCode();

  const { data: pins = [], isLoading } = useQuery({
    queryKey: ["opps", ownerId],
    queryFn: () => fetchOpportunities(ownerId),
  });

  return (
    <RouteBuilder
      pins={pins}
      pinsLoading={isLoading}
      repOwnerId={ownerId}
      repName={repName}
      iclCode={iclCode}
      mode="live"
      backLink={{ href: "/", label: "Roster" }}
      headerSubtitle="live from Salesforce"
    />
  );
}
