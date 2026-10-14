-- Hardware details for shared runs, and a per-model summary with a score (docs/RESULTS_SCORE.md).
-- eval_scores is the public part: anyone can read and sort it, it holds no install hash, and a run
-- can be hidden (eval_scores.hidden) if it turns out to be junk. eval_runs and eval_rows stay closed.

alter table public.eval_runs
  add column soc_manufacturer text check (length(soc_manufacturer) <= 80),
  add column hardware text check (length(hardware) <= 80),
  add column api_level smallint check (api_level > 0),
  add column cpu_features text[] check (cardinality(cpu_features) <= 100),
  add column core_max_khz integer[] check (cardinality(core_max_khz) <= 64);

create table public.eval_scores (
  id bigint generated always as identity primary key,
  run uuid not null references public.eval_runs (id) on delete cascade,
  received_at timestamptz not null,
  score_version smallint not null,
  -- Hardware, copied from the run so the table can be read without eval_runs.
  platform text not null,
  device_brand text,
  device_model text,
  soc text,
  soc_manufacturer text,
  ram_bytes bigint,
  cpu_cores smallint,
  cpu_max_mhz integer,
  has_i8mm boolean,
  has_dotprod boolean,
  app_version text not null,
  eval_set_version text not null,
  -- The model and how it ran.
  config_id text not null,
  model_id text,
  model_label text,
  answers integer not null,
  completed integer not null,
  retrieval_questions integer not null,
  retrieval_hits integer not null,
  -- Raw metrics (medians over completed answers).
  median_tok_per_sec real,
  median_ttft_ms real,
  median_total_ms real,
  peak_rss_bytes bigint,
  -- 0-1 parts and the 0-100 score.
  speed real not null,
  reliability real not null,
  retrieval real,
  score smallint not null check (score between 0 and 100),
  -- Set by us to take junk out of the public table without deleting the evidence.
  hidden boolean not null default false,
  unique (run, config_id)
);

create index eval_scores_soc on public.eval_scores (soc);
create index eval_scores_model on public.eval_scores (model_id);
create index eval_scores_run on public.eval_scores (run);

alter table public.eval_scores enable row level security;
revoke all on public.eval_scores from anon, authenticated;
grant select on public.eval_scores to anon, authenticated;

create policy "shared scores are public unless hidden"
  on public.eval_scores for select to anon, authenticated
  using (not hidden);

-- Score v1. Keep in sync with src/eval/score.pure.ts (the app's preview) and docs/RESULTS_SCORE.md.
--   speed       = min(1, median decode tok/s / 20), over completed answers of >= 16 tokens
--   reliability = completed / answers (completed = success and not timed out)
--   retrieval   = expected article found / questions that expect one (null when none do)
--   score       = 100 * (0.60 speed + 0.25 reliability + 0.15 retrieval), weights rescaled to
--                 0.60/0.85 and 0.25/0.85 when retrieval is null; 0 when reliability < 0.5.
create function public.compute_eval_scores(p_run uuid)
returns integer
language sql
security invoker
set search_path = ''
as $$
  with per_config as (
    select
      x.config_id,
      max(x.model_id) as model_id,
      max(x.data->>'configLabel') as model_label,
      count(*)::int as answers,
      count(*) filter (where x.outcome = 'success' and coalesce((x.data->>'timedOut')::boolean, false) = false)::int as completed,
      count(*) filter (where x.data->>'expectedKbHit' in ('true', 'false'))::int as retrieval_questions,
      count(*) filter (where x.data->>'expectedKbHit' = 'true')::int as retrieval_hits,
      percentile_cont(0.5) within group (order by x.tok_per_sec) filter (
        where x.outcome = 'success' and coalesce((x.data->>'timedOut')::boolean, false) = false
          and coalesce((x.data->>'tokensGenerated')::int, 0) >= 16 and x.tok_per_sec > 0
      ) as median_tok_per_sec,
      percentile_cont(0.5) within group (order by x.ttft_ms) filter (
        where x.outcome = 'success' and coalesce((x.data->>'timedOut')::boolean, false) = false
      ) as median_ttft_ms,
      percentile_cont(0.5) within group (order by x.total_latency_ms) filter (
        where x.outcome = 'success' and coalesce((x.data->>'timedOut')::boolean, false) = false
      ) as median_total_ms,
      max((x.data->>'peakRssBytes')::bigint) as peak_rss_bytes
    from public.eval_rows x
    where x.run = p_run
    group by x.config_id
  ),
  parts as (
    select
      c.*,
      least(1.0, coalesce(c.median_tok_per_sec, 0) / 20.0) as speed,
      c.completed::real / c.answers as reliability,
      case when c.retrieval_questions > 0 then c.retrieval_hits::real / c.retrieval_questions end as retrieval
    from per_config c
  ),
  ins as (
    insert into public.eval_scores (
      run, received_at, score_version, platform, device_brand, device_model, soc, soc_manufacturer,
      ram_bytes, cpu_cores, cpu_max_mhz, has_i8mm, has_dotprod, app_version, eval_set_version,
      config_id, model_id, model_label, answers, completed, retrieval_questions, retrieval_hits,
      median_tok_per_sec, median_ttft_ms, median_total_ms, peak_rss_bytes,
      speed, reliability, retrieval, score
    )
    select
      r.id, r.received_at, 1, r.platform, r.device_brand, r.device_model, r.soc, r.soc_manufacturer,
      r.ram_bytes, r.cpu_cores,
      (select max(k) / 1000 from unnest(r.core_max_khz) as k),
      case when r.cpu_features is null then null else 'i8mm' = any (r.cpu_features) end,
      case when r.cpu_features is null then null else 'asimddp' = any (r.cpu_features) end,
      r.app_version, r.eval_set_version,
      p.config_id, p.model_id, p.model_label, p.answers, p.completed, p.retrieval_questions, p.retrieval_hits,
      p.median_tok_per_sec, p.median_ttft_ms, p.median_total_ms, p.peak_rss_bytes,
      p.speed, p.reliability, p.retrieval,
      case
        when p.reliability < 0.5 then 0
        when p.retrieval is null then round(100 * ((0.60 / 0.85) * p.speed + (0.25 / 0.85) * p.reliability))
        else round(100 * (0.60 * p.speed + 0.25 * p.reliability + 0.15 * p.retrieval))
      end
    from parts p
    join public.eval_runs r on r.id = p_run
    returning 1
  )
  select count(*)::int from ins;
$$;

revoke all on function public.compute_eval_scores(uuid) from public, anon, authenticated;
grant execute on function public.compute_eval_scores(uuid) to service_role;
