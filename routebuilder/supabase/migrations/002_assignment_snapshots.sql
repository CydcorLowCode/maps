create table if not exists assignment_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  icl_code text not null,
  rep_salesforce_id text not null,
  rep_name text not null,

  opportunity_count integer not null,
  opportunities jsonb not null,

  label text,
  notes text
);

create index if not exists assignment_snapshots_icl_code_idx
  on assignment_snapshots(icl_code);
create index if not exists assignment_snapshots_rep_idx
  on assignment_snapshots(rep_salesforce_id);
create index if not exists assignment_snapshots_created_at_idx
  on assignment_snapshots(created_at desc);
