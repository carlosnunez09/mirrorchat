create table if not exists public.messages (
  id bigint generated always as identity primary key,
  username text not null check (char_length(username) between 1 and 24),
  body text not null check (char_length(body) between 1 and 500),
  is_bot boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

drop policy if exists "anyone can read messages" on public.messages;
create policy "anyone can read messages" on public.messages
  for select using (true);

drop policy if exists "anyone can post messages" on public.messages;
create policy "anyone can post messages" on public.messages
  for insert with check (true);

do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;
