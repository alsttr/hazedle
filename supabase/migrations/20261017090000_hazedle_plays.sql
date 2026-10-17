-- One row per finished round per device. Read only through the functions below.
create table if not exists public.hazedle_plays (
  round_id   text        not null check (round_id ~ '^\d{4}-\d{2}-\d{2}-(00|06|12|18)$'),
  player_id  uuid        not null,
  scores     smallint[]  not null check (array_length(scores, 1) = 5 and 0 <= all(scores) and 100 >= all(scores)),
  total      smallint    not null check (total between 0 and 500),
  created_at timestamptz not null default now(),
  primary key (round_id, player_id)
);
create index if not exists hazedle_plays_created_at on public.hazedle_plays (created_at);

alter table public.hazedle_plays enable row level security;
-- No policies: anon can't touch the table directly.
revoke all on public.hazedle_plays from anon, authenticated;

-- Score distribution and counts. p_total (optional) adds how many scored below it.
create or replace function public.hazedle_stats(p_round text, p_total int default null)
returns json
language sql
stable
security definer
set search_path = public
as $$
  with
    rnd as (select total from hazedle_plays where round_id = p_round),
    recent as (select total from hazedle_plays where created_at > now() - interval '30 days'),
    today as (
      select * from hazedle_plays
      where (created_at at time zone 'Asia/Singapore')::date = (now() at time zone 'Asia/Singapore')::date
    )
  select json_build_object(
    'round_players', (select count(*) from rnd),
    'round_below',   (select count(*) from rnd where total < p_total),
    'round_hist',    (select json_agg((select count(*) from rnd where least(total / 10, 49) = b) order by b) from generate_series(0, 49) b),
    'recent_players',(select count(*) from recent),
    'recent_below',  (select count(*) from recent where total < p_total),
    'recent_hist',   (select json_agg((select count(*) from recent where least(total / 10, 49) = b) order by b) from generate_series(0, 49) b),
    'today_players', (select count(distinct player_id) from today)
  );
$$;

-- Records a finished round (once per device per round) and returns the stats.
create or replace function public.hazedle_submit(p_round text, p_player uuid, p_scores int[])
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  starts timestamptz;
  t int;
begin
  starts := to_timestamp(p_round, 'YYYY-MM-DD-HH24')::timestamp at time zone 'Asia/Singapore';
  -- Only the live round (or the one just before it, for slow finishers).
  if starts > now() + interval '1 hour' or starts < now() - interval '12 hours' then
    raise exception 'round % is not open', p_round;
  end if;
  t := (select sum(s) from unnest(p_scores) s);
  insert into hazedle_plays (round_id, player_id, scores, total)
  values (p_round, p_player, p_scores::smallint[], t)
  on conflict (round_id, player_id) do nothing;
  return hazedle_stats(p_round, t);
end;
$$;

revoke all on function public.hazedle_stats(text, int) from public;
revoke all on function public.hazedle_submit(text, uuid, int[]) from public;
grant execute on function public.hazedle_stats(text, int) to anon, authenticated;
grant execute on function public.hazedle_submit(text, uuid, int[]) to anon, authenticated;
