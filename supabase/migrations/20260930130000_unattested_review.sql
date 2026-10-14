-- Phones whose secure hardware can't attest a key (some genuine phones ship without, or lose,
-- their attestation keys) can still share. Their key is registered as unattested: requests are
-- still signed with it, but nothing proves it lives in a real phone running BOAR, so every run
-- from it is flagged "unattested" and its scores stay hidden until the team approves them.
-- At most 100 such runs a day in total.

alter table public.eval_devices add column attested boolean not null default true;

-- The append-only rule for devices: attested can't change either (only the counter may go up).
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
  -- A phone that can't attest its key waits for review, and there's room for only so many a day,
  -- so a script (which can make such keys too) can't bury the queue.
  if not dev.attested then
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

-- The review list, for the owner (dashboard SQL editor): runs whose scores are hidden, with why.
-- Approve one with: update public.eval_scores set hidden = false where run = '<id>';
create view public.eval_review_queue with (security_invoker = true) as
select r.id as run, r.received_at, r.flags, r.device_brand, r.device_model, r.soc, r.ram_bytes,
       r.app_version, r.row_count, d.attested, d.attestation,
       (select json_agg(json_build_object('config', s.config_id, 'score', s.score,
          'tok_per_sec', round(s.median_tok_per_sec::numeric, 1)) order by s.config_id)
        from public.eval_scores s where s.run = r.id) as scores
from public.eval_runs r
join public.eval_devices d on d.id = r.device
where exists (select 1 from public.eval_scores s where s.run = r.id and s.hidden)
order by r.received_at desc;
revoke all on public.eval_review_queue from public, anon, authenticated, service_role;
