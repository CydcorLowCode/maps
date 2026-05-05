-- Link saved routes to the snapshot they were built from, so we can list
-- "all routes built off snapshot X" and overlay them for comparison.
alter table saved_routes
  add column if not exists snapshot_id uuid references assignment_snapshots(id) on delete set null;

create index if not exists saved_routes_snapshot_id_idx
  on saved_routes(snapshot_id);

-- Persist the user's manual zone splits with the snapshot. Map of
-- pin id -> overridden zone id. Loaded back into pinZoneOverride state when
-- re-opening the snapshot's build mode.
alter table assignment_snapshots
  add column if not exists zone_overrides jsonb;

-- Optional human label per saved route, shown in the snapshot comparison view
-- so users can distinguish e.g. "loop", "auto v1", "drawn alternate".
alter table saved_routes
  add column if not exists label text;

-- Per-zone notes captured by the user during the build session. Map of
-- zone_id -> note text. Stored on the snapshot so it survives reload.
alter table assignment_snapshots
  add column if not exists zone_notes jsonb;
