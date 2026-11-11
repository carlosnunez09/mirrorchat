-- MirrorChat needs no tables for matchmaking/signaling: that runs entirely on
-- Supabase Realtime (Presence + Broadcast), which works out of the box with the anon key.
--
-- The only table is an insert-only abuse report log you review in the dashboard.

create table if not exists public.reports (
  id bigint generated always as identity primary key,
  reporter text not null check (char_length(reporter) <= 64),
  reported text not null check (char_length(reported) <= 64),
  reason text not null check (char_length(reason) <= 100),
  created_at timestamptz not null default now()
);

alter table public.reports enable row level security;

drop policy if exists "anyone can file a report" on public.reports;
create policy "anyone can file a report" on public.reports
  for insert with check (true);
-- No select/update/delete policies => anon users can't read reports back.
