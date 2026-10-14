-- Shared runs only from a real phone running the genuine app, at most 3 a day, and never
-- changed or deleted once stored.
--
-- - eval_devices: one row per phone key. Android: a hardware-backed Keystore key whose
--   certificate chain ends at Google's attestation root and names this app and its release
--   signing key. iOS: an App Attest key vouched for by Apple. The id is the SHA-256 of the key,
--   so a device is a key, not a person; nothing personal is stored.
-- - eval_challenges: one-time server nonces (5 minutes), so a signed request can't be replayed.
-- - submit_eval_run(): the limits (3 runs a device per 24 hours, 1 hour apart, 6 per network,
--   300 an hour in total), the run, its rows and its scores in ONE transaction, under a lock per
--   device, so parallel requests can't slip past the limit.
-- - Implausible numbers are stored but their scores stay hidden for review.
-- - The eval tables are append-only for every role but the owner: no update, delete or truncate,
--   even with the secret key.

-- Devices -------------------------------------------------------------------------------------

create table public.eval_devices (
  id           text primary key check (id ~ '^[0-9a-f]{64}$'),
  platform     text not null check (platform in ('android', 'ios')),
  -- Android: SubjectPublicKeyInfo (DER, base64). iOS: the attested key's X.509 SPKI (DER, base64).
  public_key   text not null check (length(public_key) <= 400),
  -- iOS App Attest assertion counter; each assertion must be higher than the last.
  sign_count   bigint not null default 0 check (sign_count >= 0),
  -- What the attestation said (security level, verified boot, patch level, app certificate).
  attestation  jsonb not null,
  created_at   timestamptz not null default now(),
  banned       boolean not null default false
);
alter table public.eval_devices enable row level security;
revoke all on public.eval_devices from public, anon, authenticated;

create table public.eval_challenges (
  challenge   text primary key check (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at  timestamptz not null default now(),
  used_at     timestamptz
);
create index eval_challenges_by_age on public.eval_challenges (created_at);
alter table public.eval_challenges enable row level security;
revoke all on public.eval_challenges from public, anon, authenticated;

-- The questions of each eval set: rows for anything else are refused. Keep in sync with
-- src/eval/evalSet.ts (bump EVAL_SET_VERSION there, add the new set here).
create table public.eval_set_queries (
  eval_set_version  text not null,
  query_id          text not null,
  primary key (eval_set_version, query_id)
);
alter table public.eval_set_queries enable row level security;
revoke all on public.eval_set_queries from public, anon, authenticated;
insert into public.eval_set_queries (eval_set_version, query_id)
select '1', q from unnest(array[
  'greeting-1', 'factual-1', 'factual-2', 'explanation-1', 'explanation-2', 'comparison-1',
  'comparison-2', 'synthesis-1', 'synthesis-2', 'synthesis-3', 'reasoning-1', 'reasoning-2',
  'reasoning-3', 'grounded-1', 'grounded-2', 'no-kb-1', 'no-kb-2'
]) as q;

-- Runs ----------------------------------------------------------------------------------------

alter table public.eval_runs
  add column device   text references public.eval_devices (id),
  add column ip_hash  text check (ip_hash ~ '^[0-9a-f]{64}$'),
  add column flags    text[] not null default '{}' check (cardinality(flags) <= 20);
create index eval_runs_by_device on public.eval_runs (device, received_at desc);
create index eval_runs_by_ip on public.eval_runs (ip_hash, received_at desc);
create index eval_runs_by_time on public.eval_runs (received_at desc);

-- One answer per question and model in a run.
create unique index eval_rows_one_per_query on public.eval_rows (run, config_id, query_id);

-- The runs shared before attestation existed were test runs: off the public scores.
update public.eval_scores set hidden = true where run in (select id from public.eval_runs where device is null);

-- Scores of a flagged run are stored hidden. submit_eval_run() sets boar.hide_scores for its
-- own transaction; compute_eval_scores() doesn't need to know.
create function public.eval_scores_hide_flagged()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('boar.hide_scores', true), '') = 'on' then
    new.hidden := true;
  end if;
  return new;
end;
$$;
create trigger eval_scores_hide_flagged before insert on public.eval_scores
  for each row execute function public.eval_scores_hide_flagged();

-- Append-only -----------------------------------------------------------------------------------

-- Only the owner (the dashboard, a migration) may change or remove stored results, e.g. to hide
-- a score. The Edge Function's secret key (service_role) can only add.
create function public.eval_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return coalesce(new, old);
  end if;
  -- A device's App Attest counter may only go up; nothing else about a device changes.
  if tg_table_name = 'eval_devices' and tg_op = 'UPDATE'
     and new.id = old.id and new.platform = old.platform and new.public_key = old.public_key
     and new.attestation = old.attestation and new.created_at = old.created_at
     and new.banned = old.banned and new.sign_count > old.sign_count then
    return new;
  end if;
  raise exception 'public.% is append-only', tg_table_name using errcode = '42501';
end;
$$;

create trigger eval_runs_append_only before update or delete on public.eval_runs
  for each row execute function public.eval_append_only();
create trigger eval_rows_append_only before update or delete on public.eval_rows
  for each row execute function public.eval_append_only();
create trigger eval_scores_append_only before update or delete on public.eval_scores
  for each row execute function public.eval_append_only();
create trigger eval_devices_append_only before update or delete on public.eval_devices
  for each row execute function public.eval_append_only();
create trigger eval_runs_no_truncate before truncate on public.eval_runs
  for each statement execute function public.eval_append_only();
create trigger eval_rows_no_truncate before truncate on public.eval_rows
  for each statement execute function public.eval_append_only();
create trigger eval_scores_no_truncate before truncate on public.eval_scores
  for each statement execute function public.eval_append_only();
create trigger eval_devices_no_truncate before truncate on public.eval_devices
  for each statement execute function public.eval_append_only();

-- And in the grants too, for the API roles and the secret key.
revoke update, delete, truncate on public.eval_runs, public.eval_rows, public.eval_scores
  from service_role, anon, authenticated;
revoke delete, truncate on public.eval_devices from service_role;

-- Challenges ------------------------------------------------------------------------------------

create function public.new_eval_challenge(p_challenge text)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.eval_challenges where created_at < now() - interval '1 hour';
  insert into public.eval_challenges (challenge) values (p_challenge);
$$;

-- True once per challenge, within 5 minutes of it being issued.
create function public.take_eval_challenge(p_challenge text)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with taken as (
    update public.eval_challenges set used_at = now()
    where challenge = p_challenge and used_at is null and created_at > now() - interval '5 minutes'
    returning 1
  )
  select exists (select 1 from taken);
$$;

-- Submitting ------------------------------------------------------------------------------------

-- p_run: the eval_runs columns as the Edge Function validated them. p_rows: an array of
-- {query_id, config_id, model_id, outcome, ttft_ms, tok_per_sec, total_latency_ms, data}.
-- Answers {"id", "scores"} or {"error", "retry_at"?}; raises only on a bug.
create function public.submit_eval_run(p_device text, p_ip_hash text, p_run jsonb, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  dev public.eval_devices;
  last_3 timestamptz[];
  v_run uuid;
  bad_queries int;
  v_flags text[] := '{}';
begin
  -- One submission per device at a time: the checks below and the insert can't interleave.
  perform pg_advisory_xact_lock(hashtextextended('eval-device:' || p_device, 0));

  select * into dev from public.eval_devices where id = p_device;
  if not found then return jsonb_build_object('error', 'unknown_device'); end if;
  if dev.banned then return jsonb_build_object('error', 'banned'); end if;

  select array_agg(received_at order by received_at desc) into last_3 from (
    select received_at from public.eval_runs
    where device = p_device and received_at > now() - interval '24 hours'
    order by received_at desc limit 3
  ) r;
  if cardinality(last_3) >= 3 then
    return jsonb_build_object('error', 'rate_limited', 'retry_at', last_3[3] + interval '24 hours');
  end if;
  if cardinality(last_3) >= 1 and last_3[1] > now() - interval '1 hour' then
    return jsonb_build_object('error', 'cooldown', 'retry_at', last_3[1] + interval '1 hour');
  end if;
  if p_ip_hash is not null and (
    select count(*) from public.eval_runs
    where ip_hash = p_ip_hash and received_at > now() - interval '24 hours'
  ) >= 6 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if (select count(*) from public.eval_runs where received_at > now() - interval '1 hour') >= 300 then
    return jsonb_build_object('error', 'busy');
  end if;
  if exists (select 1 from public.eval_runs where submitter_hash = p_device and run_id = p_run->>'run_id') then
    return jsonb_build_object('error', 'duplicate');
  end if;

  select count(*) into bad_queries
  from jsonb_array_elements(p_rows) x
  where not exists (
    select 1 from public.eval_set_queries q
    where q.eval_set_version = p_run->>'eval_set_version' and q.query_id = x->>'query_id'
  );
  if bad_queries > 0 then return jsonb_build_object('error', 'unknown_query'); end if;

  -- Stored, but kept off the public scores until someone looks.
  if exists (
    select 1 from jsonb_array_elements(p_rows) x
    where (x->>'tok_per_sec')::real > 250 or (x->>'ttft_ms')::real < 0
       or (x->>'total_latency_ms')::real < coalesce((x->>'ttft_ms')::real, 0)
  ) then
    v_flags := v_flags || 'implausible_timing'::text;
  end if;
  if (p_run->>'ram_bytes') is not null and exists (
    select 1 from jsonb_array_elements(p_rows) x
    where (x->'data'->>'peakRssBytes')::bigint > (p_run->>'ram_bytes')::bigint
  ) then
    v_flags := v_flags || 'rss_above_ram'::text;
  end if;

  insert into public.eval_runs (
    submitter_hash, device, ip_hash, flags, run_id, eval_set_version, app_version, platform,
    os_version, device_brand, device_model, soc, soc_manufacturer, hardware, api_level,
    ram_bytes, cpu_cores, cpu_features, core_max_khz, row_count
  ) values (
    p_device, p_device, p_ip_hash, v_flags, p_run->>'run_id', p_run->>'eval_set_version',
    p_run->>'app_version', p_run->>'platform', p_run->>'os_version', p_run->>'device_brand',
    p_run->>'device_model', p_run->>'soc', p_run->>'soc_manufacturer', p_run->>'hardware',
    (p_run->>'api_level')::smallint, (p_run->>'ram_bytes')::bigint, (p_run->>'cpu_cores')::smallint,
    (select array_agg(v) from jsonb_array_elements_text(p_run->'cpu_features') v),
    (select array_agg(v::int) from jsonb_array_elements_text(p_run->'core_max_khz') v),
    jsonb_array_length(p_rows)
  ) returning id into v_run;

  insert into public.eval_rows (run, query_id, config_id, model_id, outcome, ttft_ms, tok_per_sec, total_latency_ms, data)
  select v_run, x->>'query_id', x->>'config_id', x->>'model_id', x->>'outcome',
         (x->>'ttft_ms')::real, (x->>'tok_per_sec')::real, (x->>'total_latency_ms')::real, x->'data'
  from jsonb_array_elements(p_rows) x;

  if cardinality(v_flags) > 0 then
    perform set_config('boar.hide_scores', 'on', true);
  end if;
  perform public.compute_eval_scores(v_run);

  return jsonb_build_object(
    'id', v_run,
    'hidden', cardinality(v_flags) > 0,
    'scores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'config_id', s.config_id, 'score', s.score, 'median_tok_per_sec', s.median_tok_per_sec,
        'median_ttft_ms', s.median_ttft_ms, 'peak_rss_bytes', s.peak_rss_bytes))
      from public.eval_scores s where s.run = v_run
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.new_eval_challenge(text) from public, anon, authenticated;
revoke all on function public.take_eval_challenge(text) from public, anon, authenticated;
revoke all on function public.submit_eval_run(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.eval_scores_hide_flagged() from public, anon, authenticated;
revoke all on function public.eval_append_only() from public, anon, authenticated;
grant execute on function public.new_eval_challenge(text) to service_role;
grant execute on function public.take_eval_challenge(text) to service_role;
grant execute on function public.submit_eval_run(text, text, jsonb, jsonb) to service_role;

-- New objects in public are closed by default ---------------------------------------------------

-- Supabase's default grants every new table, sequence and function in public to anon and
-- authenticated, so a table created without RLS is open to the publishable key. From now on a
-- new object is closed until a migration grants it.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;
