-- Basic moderation for public rooms.
-- 1) Rate limit: at most 5 messages per 10 seconds per name (MirrorBot: 30, since every client can trigger it).
-- 2) Banned words: add rows to banned_words and any message containing one is refused. Empty by default.
create table if not exists public.banned_words (
  word text primary key check (char_length(word) between 2 and 40)
);
alter table public.banned_words enable row level security;

create index if not exists messages_username_created_idx on public.messages (username, created_at desc);

create or replace function public.messages_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.messages
        where username = new.username and created_at > now() - interval '10 seconds')
      >= case when new.username = 'MirrorBot' then 30 else 5 end then
    raise exception 'slow down';
  end if;
  if exists (select 1 from public.banned_words w where new.body ilike '%' || w.word || '%') then
    raise exception 'message not allowed';
  end if;
  return new;
end $$;

drop trigger if exists messages_guard on public.messages;
create trigger messages_guard before insert on public.messages
  for each row execute function public.messages_guard();
