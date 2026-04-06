-- ============================================================
-- Clawline Gateway — Supabase Database Schema
-- ============================================================
-- Run this SQL in Supabase Dashboard SQL Editor or via psql
-- to set up required tables for Gateway message persistence
-- and AI settings.
--
-- Prerequisites: Supabase project with PostgREST enabled.
-- ============================================================

-- ── cl_messages ─────────────────────────────────────────────
-- Stores all inbound/outbound messages relayed through Gateway.
-- Used by wiki-ingest.js for daily knowledge base generation.

CREATE TABLE IF NOT EXISTS public.cl_messages (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id   text        NOT NULL,
  sender_id    text,
  agent_id     text,
  message_id   text,
  content      text,
  content_type text        NOT NULL DEFAULT 'text',
  direction    text        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  media_url    text,
  parent_id    text,
  meta         jsonb,
  timestamp    bigint      NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS cl_messages_channel_ts_idx
  ON public.cl_messages (channel_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS cl_messages_sender_idx
  ON public.cl_messages (channel_id, sender_id, timestamp DESC);

-- Deduplicate: same message_id + direction = same message
-- (prevents duplicates when multiple WS clients are connected)
CREATE UNIQUE INDEX IF NOT EXISTS cl_messages_msgid_dir_uniq
  ON public.cl_messages (message_id, direction)
  WHERE message_id IS NOT NULL;

-- ── cl_settings ─────────────────────────────────────────────
-- Key-value store for Gateway configuration (AI endpoints, etc.)
-- Admin UI reads/writes via /api/ai-settings endpoint.

CREATE TABLE IF NOT EXISTS public.cl_settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Auto-update timestamp on changes
CREATE OR REPLACE FUNCTION public.cl_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER cl_settings_set_updated_at
  BEFORE UPDATE ON public.cl_settings
  FOR EACH ROW
  EXECUTE FUNCTION cl_set_updated_at();
