-- Matchmaking queue for random video chat (no direct table access; only via functions)
create table if not exists public.video_queue (
  id text primary key,
  created_at timestamptz not null default now()
);
alter table public.video_queue enable row level security;

create table if not exists public.video_reports (
  id bigint generated always as identity primary key,
  reporter text not null,
  reported text not null,
  created_at timestamptz not null default now()
);
alter table public.video_reports enable row level security;

-- Atomically pair with a waiting user (returns their id) or join the queue (returns null).
create or replace function public.find_match(my_id text) returns text
language plpgsql security definer set search_path = public as $$
declare other text;
begin
  if my_id is null or char_length(my_id) > 64 then raise exception 'bad id'; end if;
  delete from video_queue where created_at < now() - interval '25 seconds' or id = my_id;
  select id into other from video_queue where id <> my_id
    order by created_at for update skip locked limit 1;
  if other is not null then
    delete from video_queue where id = other;
    return other;
  end if;
  insert into video_queue(id) values (my_id);
  return null;
end $$;

create or replace function public.leave_queue(my_id text) returns void
language sql security definer set search_path = public as $$
  delete from video_queue where id = my_id;
$$;

create or replace function public.report_peer(reporter text, reported text) returns void
language sql security definer set search_path = public as $$
  insert into video_reports(reporter, reported)
  select left(reporter, 64), left(reported, 64);
$$;
