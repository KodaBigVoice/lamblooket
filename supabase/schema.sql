-- Lamblooket database setup
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- Stores teachers' folders and question sets only. No pupil data is ever stored.

-- Folders: private to the teacher who made them
create table if not exists public.folders (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  created_at  timestamptz not null default now()
);

-- Sets: every teacher can see and play every set; only the owner can change or delete it
create table if not exists public.sets (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  owner_email  text not null default (auth.jwt() ->> 'email'),
  folder_id    uuid references public.folders (id) on delete set null,
  title        text not null default '',
  questions    jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists sets_owner_idx  on public.sets (owner);
create index if not exists sets_folder_idx on public.sets (folder_id);

-- Keep updated_at current
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists sets_touch on public.sets;
create trigger sets_touch before update on public.sets
  for each row execute function public.touch_updated_at();

-- Row Level Security: signed-in teachers only, nothing for anonymous visitors
alter table public.folders enable row level security;
alter table public.sets    enable row level security;

drop policy if exists "own folders" on public.folders;
create policy "own folders" on public.folders
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists "teachers read all sets" on public.sets;
create policy "teachers read all sets" on public.sets
  for select to authenticated
  using (true);

drop policy if exists "teachers add own sets" on public.sets;
create policy "teachers add own sets" on public.sets
  for insert to authenticated
  with check (owner = auth.uid());

drop policy if exists "teachers change own sets" on public.sets;
create policy "teachers change own sets" on public.sets
  for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists "teachers delete own sets" on public.sets;
create policy "teachers delete own sets" on public.sets
  for delete to authenticated
  using (owner = auth.uid());

-- Table access (new tables are not exposed automatically in this project)
revoke all on public.folders, public.sets from anon;
grant select, insert, update, delete on public.folders, public.sets to authenticated;
