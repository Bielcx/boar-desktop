-- A per-phone allowance for our own test phones. eval_devices.daily_limit, set only by the owner
-- (dashboard SQL editor), replaces the 3 runs a day and skips the hour between runs and the
-- per-network cap for that phone. Null, the default, keeps the normal limits.
--   update eval_devices set daily_limit = 20 where id = '<device id>';
-- The global 300 an hour and the unattested review cap still apply.

alter table public.eval_devices
  add column daily_limit smallint check (daily_limit between 1 and 100);

-- The server's key may still only raise an App Attest counter: the allowance is the owner's alone.
create or replace function public.eval_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return coalesce(new, old);
  end if;
  if tg_table_name = 'eval_devices' and tg_op = 'UPDATE'
     and new.id = old.id and new.platform = old.platform and new.public_key = old.public_key
     and new.attestation = old.attestation and new.created_at = old.created_at
     and new.banned = old.banned and new.attested = old.attested
     and new.daily_limit is not distinct from old.daily_limit
     and new.sign_count > old.sign_count then
    return new;
  end if;
  raise exception 'public.% is append-only', tg_table_name using errcode = '42501';
end;
$$;

create or replace function public.submit_eval_run(p_device text, p_ip_hash text, p_run jsonb, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  dev public.eval_devices;
  last_n timestamptz[];
  v_daily int;
  v_run uuid;
  bad_queries int;
  v_flags text[] := '{}';
begin
  -- One run per transaction: the locks below are then always taken in the same order, once, so
  -- two transactions can't wait for each other's (the Edge Function sends one run per call).
  if coalesce(current_setting('boar.submitted', true), '') = 'on' then
    raise exception 'submit_eval_run: one run per transaction';
  end if;
  perform set_config('boar.submitted', 'on', true);
  -- One submission per device at a time: the checks below and the insert can't interleave.
  perform pg_advisory_xact_lock(hashtextextended('eval-device:' || p_device, 0));
  -- And one per network, taken after the device's (always in this order), so two phones on
  -- the same network can't both pass its cap.
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('eval-network:' || p_ip_hash, 0));
  end if;

  select * into dev from public.eval_devices where id = p_device;
  if not found then return jsonb_build_object('error', 'unknown_device'); end if;
  if dev.banned then return jsonb_build_object('error', 'banned'); end if;
  -- A retry of a run that is already stored (its answer got lost) says so, before any limit.
  if exists (select 1 from public.eval_runs where submitter_hash = p_device and run_id = p_run->>'run_id') then
    return jsonb_build_object('error', 'duplicate');
  end if;

  -- A test phone we set an allowance for (daily_limit) gets that many runs a day, with no cooldown
  -- and no network cap; every other phone keeps 3 a day, an hour apart.
  v_daily := coalesce(dev.daily_limit, 3);
  select array_agg(received_at order by received_at desc) into last_n from (
    select received_at from public.eval_runs
    where device = p_device and received_at > now() - interval '24 hours'
    order by received_at desc limit v_daily
  ) r;
  if cardinality(last_n) >= v_daily then
    return jsonb_build_object('error', 'rate_limited', 'retry_at', last_n[v_daily] + interval '24 hours');
  end if;
  if dev.daily_limit is null and cardinality(last_n) >= 1 and last_n[1] > now() - interval '1 hour' then
    return jsonb_build_object('error', 'cooldown', 'retry_at', last_n[1] + interval '1 hour');
  end if;
  if dev.daily_limit is null and p_ip_hash is not null and (
    select count(*) from public.eval_runs
    where ip_hash = p_ip_hash and received_at > now() - interval '24 hours'
  ) >= 6 then
    return jsonb_build_object('error', 'network_limited');
  end if;
  if (select count(*) from public.eval_runs where received_at > now() - interval '1 hour') >= 300 then
    return jsonb_build_object('error', 'busy');
  end if;
  -- A phone that can't attest its key waits for review, and there's room for only so many a day,
  -- so a script (which can make such keys too) can't bury the queue.
  if not dev.attested then
    -- The cap counts, then the run is inserted below: one unattested share at a time (after the
    -- device and network locks), so parallel ones can't all see room under it.
    perform pg_advisory_xact_lock(hashtextextended('eval-unattested', 0));
    if (select count(*) from public.eval_runs
        where 'unattested' = any(flags) and received_at > now() - interval '24 hours') >= 100 then
      return jsonb_build_object('error', 'review_queue_full');
    end if;
    v_flags := v_flags || 'unattested'::text;
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
    -- A JSON null (unknown, e.g. an iPhone's CPU flags) isn't SQL NULL: only expand real arrays.
    case when jsonb_typeof(p_run->'cpu_features') = 'array'
      then (select array_agg(v) from jsonb_array_elements_text(p_run->'cpu_features') v) end,
    case when jsonb_typeof(p_run->'core_max_khz') = 'array'
      then (select array_agg(v::int) from jsonb_array_elements_text(p_run->'core_max_khz') v) end,
    jsonb_array_length(p_rows)
  ) returning id into v_run;

  insert into public.eval_rows (run, query_id, config_id, model_id, outcome, ttft_ms, tok_per_sec, total_latency_ms, data)
  select v_run, x->>'query_id', x->>'config_id', x->>'model_id', x->>'outcome',
         (x->>'ttft_ms')::real, (x->>'tok_per_sec')::real, (x->>'total_latency_ms')::real, x->'data'
  from jsonb_array_elements(p_rows) x;

  -- Set for this call either way: the setting lasts the transaction, and a caller could send
  -- more than one run in one.
  perform set_config('boar.hide_scores', case when cardinality(v_flags) > 0 then 'on' else 'off' end, true);
  perform public.compute_eval_scores(v_run);

  return jsonb_build_object(
    'id', v_run,
    'hidden', cardinality(v_flags) > 0,
    'pending_review', not dev.attested,
    'scores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'config_id', s.config_id, 'score', s.score, 'median_tok_per_sec', s.median_tok_per_sec,
        'median_ttft_ms', s.median_ttft_ms, 'peak_rss_bytes', s.peak_rss_bytes))
      from public.eval_scores s where s.run = v_run
    ), '[]'::jsonb)
  );
end;
$$;
