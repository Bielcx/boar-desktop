-- Evaluation results shared from the app (Settings > Share results), written only by the
-- submit-results Edge Function with the secret key. The publishable key shipped in the app
-- can't read or write these tables: RLS is on and there are no policies for anon or
-- authenticated. A public read view can be added once we decide what to publish.

create table public.eval_runs (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  -- sha256 of a random id the app creates once per install; never the id itself.
  submitter_hash text not null check (length(submitter_hash) = 64),
  run_id text not null check (length(run_id) <= 100),
  eval_set_version text not null check (length(eval_set_version) <= 20),
  app_version text not null check (length(app_version) <= 40),
  platform text not null check (platform in ('android', 'ios')),
  os_version text check (length(os_version) <= 40),
  device_brand text check (length(device_brand) <= 80),
  device_model text check (length(device_model) <= 80),
  soc text check (length(soc) <= 80),
  ram_bytes bigint check (ram_bytes > 0),
  cpu_cores smallint check (cpu_cores > 0),
  row_count integer not null check (row_count between 1 and 1000),
  unique (submitter_hash, run_id)
);

create index eval_runs_submitter_received on public.eval_runs (submitter_hash, received_at desc);

-- One row per question and configuration: the app's eval JSONL row, kept whole in `data`
-- so a change in the harness's format doesn't need a migration. The columns next to it are
-- the ones we filter and compare on.
create table public.eval_rows (
  id bigint generated always as identity primary key,
  run uuid not null references public.eval_runs (id) on delete cascade,
  query_id text not null check (length(query_id) <= 100),
  config_id text not null check (length(config_id) <= 200),
  model_id text check (length(model_id) <= 200),
  outcome text not null check (length(outcome) <= 40),
  ttft_ms real,
  tok_per_sec real,
  total_latency_ms real,
  data jsonb not null
);

create index eval_rows_run on public.eval_rows (run);
create index eval_rows_model on public.eval_rows (model_id);

alter table public.eval_runs enable row level security;
alter table public.eval_rows enable row level security;

revoke all on public.eval_runs from anon, authenticated;
revoke all on public.eval_rows from anon, authenticated;
