-- Rooms: every message belongs to a room (lowercase letters, digits, dashes).
alter table public.messages add column if not exists room text not null default 'general';
do $$ begin
  alter table public.messages add constraint messages_room_check check (room ~ '^[a-z0-9-]{1,32}$');
exception when duplicate_object then null;
end $$;
create index if not exists messages_room_created_idx on public.messages (room, created_at desc);

-- Random 1-to-1 text: a matchmaking queue like the video one (no direct table access; only via functions).
create table if not exists public.text_queue (
  id text primary key,
  created_at timestamptz not null default now()
);
alter table public.text_queue enable row level security;

create or replace function public.find_text_match(my_id text) returns text
language plpgsql security definer set search_path = public as $$
declare other text;
begin
  if my_id is null or char_length(my_id) > 64 then raise exception 'bad id'; end if;
  delete from text_queue where created_at < now() - interval '25 seconds' or id = my_id;
  select id into other from text_queue where id <> my_id
    order by created_at for update skip locked limit 1;
  if other is not null then
    delete from text_queue where id = other;
    return other;
  end if;
  insert into text_queue(id) values (my_id);
  return null;
end $$;

create or replace function public.leave_text_queue(my_id text) returns void
language sql security definer set search_path = public as $$
  delete from text_queue where id = my_id;
$$;
