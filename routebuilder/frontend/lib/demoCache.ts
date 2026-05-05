/**
 * Demo cache fallback. If `?demo_mode=cache` is in the URL or Salesforce auth
 * fails mid-demo, we serve a pre-baked roster + opportunity set + auto-route
 * response so the demo flow keeps working. Replace these values at the end of
 * Wednesday's dry-run with a real captured response (Tony Bao or Brandon
 * Brown) per handoff section 8.
 */
import type { AutoRouteResponse, OpportunityPin, RepRow } from "./types";

export const DEMO_REPS: RepRow[] = [
  { owner_id: "005Qi00000WqlurIAB", name: "Tony Bao", total: 87 },
  { owner_id: "005Qi00000WOBWBIA5", name: "Brandon Brown", total: 64 },
];

export const DEMO_OPPORTUNITIES: OpportunityPin[] = [];

export const DEMO_AUTO_ROUTE: AutoRouteResponse = { routes: [] };
