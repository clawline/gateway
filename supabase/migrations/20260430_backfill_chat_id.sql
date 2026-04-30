-- Add cl_messages.chat_id and backfill historical rows.
--
-- Why: gateway buildPersistRow never wrote chat_id, and the schema never had
-- the column. /api/messages/sync therefore could not filter by chat, leaking
-- other chats' history into a single chat view. Fix 1 starts writing chat_id;
-- this migration adds the column and backfills the existing rows.
--
-- Backfill rule: prefer meta->>'chatId' when present; fall back to sender_id
-- (matches gateway L3309 default chatId resolution: senderId is the default).
-- This is a best-effort retro-tag; it will misclassify rows where the user
-- chatted under multiple distinct chatIds with the same senderId. Going
-- forward (post-Fix 1), chat_id is written authoritatively.
--
-- Idempotent: safe to re-run. ALTER uses IF NOT EXISTS, backfill targets only
-- chat_id IS NULL rows, index uses IF NOT EXISTS.

-- 1. Add column.
alter table public.cl_messages add column if not exists chat_id text;

-- 2. Add (channel_id, chat_id, timestamp desc) index used by /api/messages/sync.
create index if not exists cl_messages_chat_ts_idx
  on public.cl_messages (channel_id, chat_id, timestamp desc);

-- 3. Dry-run: count rows that would be touched. Run this first to see impact.
--    select count(*) from public.cl_messages where chat_id is null;

-- 4. Backfill from meta->>'chatId' first (authoritative if present).
update public.cl_messages
set chat_id = meta->>'chatId'
where chat_id is null
  and meta is not null
  and meta ? 'chatId'
  and length(coalesce(meta->>'chatId', '')) > 0;

-- 5. Fallback: sender_id (matches default chatId resolution in gateway).
update public.cl_messages
set chat_id = sender_id
where chat_id is null
  and sender_id is not null
  and length(sender_id) > 0;

-- 6. Verification (post-run): how many rows still have null chat_id?
--    select count(*) from public.cl_messages where chat_id is null;
--    Rows remaining will be ones with no senderId and no meta.chatId — usually
--    system/agent-emitted persist-only rows. Acceptable to leave null.
