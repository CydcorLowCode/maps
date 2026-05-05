-- Built-in on Postgres 13+; avoids uuid-ossp schema/search_path issues on Supabase.
create table if not exists saved_routes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),

  rep_salesforce_id text not null,
  rep_name text not null,
  icl_code text not null,

  mode text not null check (mode in ('auto', 'drawn')),

  ordered_stops jsonb not null,
  auto_route_snapshot jsonb,
  input_snapshot jsonb,
  algorithm_params jsonb,

  notes text
);

create index if not exists saved_routes_icl_code_idx on saved_routes(icl_code);
create index if not exists saved_routes_created_at_idx on saved_routes(created_at desc);
create index if not exists saved_routes_rep_idx on saved_routes(rep_salesforce_id);
