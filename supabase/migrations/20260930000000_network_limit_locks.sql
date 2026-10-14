-- The per-network caps count and then insert, so parallel requests from one network could each
-- see room under the cap. Both now take a lock per network (a keyed hash of the IP) for the
-- length of their transaction. Grants are kept by create or replace.

create or replace function public.new_eval_challenge(p_challenge text, p_ip_hash text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.eval_challenges where created_at < now() - interval '1 hour';
  -- Parallel requests from one network are counted one at a time.
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('eval-challenge-network:' || p_ip_hash, 0));
  end if;
  if p_ip_hash is not null and (
    select count(*) from public.eval_challenges
    where ip_hash = p_ip_hash and created_at > now() - interval '10 minutes'
  ) >= 30 then
    return false;
  end if;
  insert into public.eval_challenges (challenge, ip_hash) values (p_challenge, p_ip_hash);
  return true;
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
  last_3 timestamptz[];
  v_run uuid;
  bad_queries int;
  v_flags text[] := '{}';
begin
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
    return jsonb_build_object('error', 'network_limited');
  end if;
  if (select count(*) from public.eval_runs where received_at > now() - interval '1 hour') >= 300 then
    return jsonb_build_object('error', 'busy');
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
