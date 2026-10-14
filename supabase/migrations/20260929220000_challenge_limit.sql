-- One network can't use up the challenges everyone needs: at most 30 per 10 minutes each
-- (a share takes one, or two when a key is re-registered). The IP is stored only as a keyed
-- SHA-256, like eval_runs.ip_hash, and challenges are deleted after an hour.
alter table public.eval_challenges add column ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$');
create index eval_challenges_by_ip on public.eval_challenges (ip_hash, created_at);

drop function public.new_eval_challenge(text);
-- False when this network already asked for too many.
create function public.new_eval_challenge(p_challenge text, p_ip_hash text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.eval_challenges where created_at < now() - interval '1 hour';
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
revoke all on function public.new_eval_challenge(text, text) from public, anon, authenticated;
grant execute on function public.new_eval_challenge(text, text) to service_role;
