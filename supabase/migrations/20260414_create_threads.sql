-- Migration: Create cl_threads and cl_thread_read_status tables
-- Date: 2026-04-14
-- Story: US-001

-- ── Thread table ────────────────────────────────────────────────────

create table if not exists public.cl_threads (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null,
  parent_message_id text not null,
  creator_id text not null,
  title text,
  status text not null default 'active'
    check (status in ('active', 'archived', 'locked', 'deleted')),
  type text not null default 'user'
    check (type in ('user', 'acp')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_reply_at timestamptz,
  reply_count int not null default 0,
  participant_ids jsonb not null default '[]'
);

create index if not exists cl_threads_channel_status_idx
  on public.cl_threads (channel_id, status);

-- Reuse the existing cl_set_updated_at trigger function
drop trigger if exists cl_threads_set_updated_at on public.cl_threads;
create trigger cl_threads_set_updated_at
before update on public.cl_threads
for each row
execute function public.cl_set_updated_at();

-- ── Thread read status table ────────────────────────────────────────

create table if not exists public.cl_thread_read_status (
  user_id text not null,
  thread_id uuid not null references public.cl_threads(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  last_read_message_id text,
  primary key (user_id, thread_id)
);

-- ── Add thread_id column to cl_messages ─────────────────────────────

alter table public.cl_messages
  add column if not exists thread_id uuid;

create index if not exists cl_messages_thread_id_idx
  on public.cl_messages (thread_id);
