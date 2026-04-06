create table if not exists public.cl_channels (
  channel_id text primary key,
  label text,
  secret text not null,
  token_param text not null default 'token',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cl_channel_users (
  channel_id text not null references public.cl_channels(channel_id) on delete cascade,
  sender_id text not null,
  id text not null,
  chat_id text,
  token text not null,
  allow_agents jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (channel_id, sender_id)
);

create index if not exists cl_channel_users_channel_token_idx
  on public.cl_channel_users (channel_id, token);

create or replace function public.cl_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists cl_channels_set_updated_at on public.cl_channels;
create trigger cl_channels_set_updated_at
before update on public.cl_channels
for each row
execute function public.cl_set_updated_at();

drop trigger if exists cl_channel_users_set_updated_at on public.cl_channel_users;
create trigger cl_channel_users_set_updated_at
before update on public.cl_channel_users
for each row
execute function public.cl_set_updated_at();

-- ── Message persistence ──────────────────────────────────────────────

create table if not exists public.cl_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null,
  sender_id text,
  agent_id text,
  message_id text,
  content text,
  content_type text not null default 'text',
  direction text not null check (direction in ('inbound', 'outbound')),
  media_url text,
  parent_id text,
  meta jsonb,
  timestamp bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists cl_messages_channel_ts_idx
  on public.cl_messages (channel_id, timestamp desc);

create index if not exists cl_messages_sender_idx
  on public.cl_messages (channel_id, sender_id, timestamp desc);

-- ── Settings (key-value store for LLM config overrides, global prompts) ──

create table if not exists public.cl_settings (
  key text primary key,
  value jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

drop trigger if exists cl_settings_set_updated_at on public.cl_settings;
create trigger cl_settings_set_updated_at
before update on public.cl_settings
for each row
execute function public.cl_set_updated_at();
