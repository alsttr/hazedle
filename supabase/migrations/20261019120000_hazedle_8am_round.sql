-- Morning round moved from 6am to 8am on 19 Oct 2026 (old 06 ids stay valid).
alter table public.hazedle_plays drop constraint if exists hazedle_plays_round_id_check;
alter table public.hazedle_plays add constraint hazedle_plays_round_id_check
  check (round_id ~ '^\d{4}-\d{2}-\d{2}-(00|06|08|12|18)$');
