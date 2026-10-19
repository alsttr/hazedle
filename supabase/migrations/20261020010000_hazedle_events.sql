-- Visits, starts, shares and clicks from shared links. Written only through hazedle_track,
-- read only through hazedle_dashboard (which needs the owner's key).
create table if not exists public.hazedle_events (
  id         bigserial   primary key,
  at         timestamptz not null default now(),
  player_id  uuid        not null,
  round_id   text,
  type       text        not null check (type in ('visit', 'start', 'share_x', 'share_copy', 'share_native')),
  src        text,       -- for visits: how they arrived ('x', 'copy', 'native' = a shared Hazedle link) …
  ref_host   text        -- … and the referring site, if the browser sent one
);
create index if not exists hazedle_events_at on public.hazedle_events (at);
alter table public.hazedle_events enable row level security;
revoke all on public.hazedle_events from anon, authenticated;

-- Owner key for the dashboard; only its SHA-256 is stored.
create table if not exists public.hazedle_admin (key_sha256 text primary key);
alter table public.hazedle_admin enable row level security;
revoke all on public.hazedle_admin from anon, authenticated;

create or replace function public.hazedle_track(p_player uuid, p_round text, p_type text, p_src text default null, p_ref text default null)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  insert into hazedle_events (player_id, round_id, type, src, ref_host)
  select p_player, left(p_round, 16), p_type,
         case when p_src in ('x', 'copy', 'native') then p_src end,
         left(nullif(p_ref, ''), 80)
  where p_type in ('visit', 'start', 'share_x', 'share_copy', 'share_native');
$$;

create or replace function public.hazedle_dashboard(p_key text)
returns json
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not exists (select 1 from hazedle_admin where key_sha256 = encode(digest(p_key, 'sha256'), 'hex')) then
    raise exception 'not allowed';
  end if;
  return json_build_object(
    'days', (
      select coalesce(json_agg(d order by d.day desc), '[]') from (
        select dd as day,
          coalesce(max(e.visitors), 0) visitors,
          coalesce(max(e.started), 0) started,
          coalesce(max(p.players), 0) players,
          coalesce(max(p.games), 0) games,
          max(p.avg_score) avg_score,
          coalesce(max(e.share_x), 0) share_x,
          coalesce(max(e.share_copy), 0) share_copy,
          coalesce(max(e.share_native), 0) share_native,
          coalesce(max(e.click_ins), 0) click_ins
        from (
          select (at at time zone 'Asia/Singapore')::date as dd from hazedle_events
          union select (created_at at time zone 'Asia/Singapore')::date from hazedle_plays
        ) days
        left join (
          select (at at time zone 'Asia/Singapore')::date d,
            count(distinct player_id) filter (where type = 'visit') visitors,
            count(distinct player_id) filter (where type = 'start') started,
            count(*) filter (where type = 'share_x') share_x,
            count(*) filter (where type = 'share_copy') share_copy,
            count(*) filter (where type = 'share_native') share_native,
            count(*) filter (where type = 'visit' and src is not null) click_ins
          from hazedle_events group by 1
        ) e on e.d = days.dd
        left join (
          select (created_at at time zone 'Asia/Singapore')::date d,
            count(distinct player_id) players, count(*) games, round(avg(total)) avg_score
          from hazedle_plays group by 1
        ) p on p.d = days.dd
        group by days.dd
      ) d
    ),
    'rounds', (
      select coalesce(json_agg(r order by r.round_id desc), '[]') from (
        select round_id, count(*) players, round(avg(total)) avg_score, max(total) best
        from hazedle_plays group by round_id
      ) r
    ),
    'click_sources', (
      select coalesce(json_agg(s order by s.visits desc), '[]') from (
        select coalesce(src, 'direct') src, count(*) visits
        from hazedle_events where type = 'visit' group by 1
      ) s
    ),
    'referrers', (
      select coalesce(json_agg(s order by s.visits desc), '[]') from (
        select ref_host, count(*) visits
        from hazedle_events where type = 'visit' and ref_host is not null group by 1 order by 2 desc limit 15
      ) s
    ),
    'totals', json_build_object(
      'players', (select count(distinct player_id) from hazedle_plays),
      'games', (select count(*) from hazedle_plays),
      'visitors', (select count(distinct player_id) from hazedle_events where type = 'visit'),
      'shares', (select count(*) from hazedle_events where type like 'share_%'),
      'click_ins', (select count(*) from hazedle_events where type = 'visit' and src is not null),
      'tracking_since', (select min(at) from hazedle_events)
    )
  );
end;
$$;

revoke all on function public.hazedle_track(uuid, text, text, text, text) from public;
revoke all on function public.hazedle_dashboard(text) from public;
grant execute on function public.hazedle_track(uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.hazedle_dashboard(text) to anon, authenticated;
