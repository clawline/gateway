-- Migration: replace cl_messages unique index with (channel_id, message_id, direction)
-- Date: 2026-04-30
-- Bug: P0-1. Old index `(message_id, direction)` is global across channels;
--      two channels emitting the same client-supplied messageId caused PostgREST
--      to 409 the second insert silently. Gateway treated 409 as success → dropped messages.
-- Fix: scope dedup by channel_id so cross-channel collisions are no longer possible.

begin;

-- Step 1: clean up cross-channel duplicates (older rows kept, newer dropped).
-- This is needed because the new index would otherwise refuse to be created
-- if such rows already exist. Match against the OLD key (message_id, direction)
-- and keep the row with the smallest created_at per group.
with dups as (
  select id,
         row_number() over (
           partition by message_id, direction
           order by created_at asc, id asc
         ) as rn
    from public.cl_messages
   where message_id is not null
)
delete from public.cl_messages m
 using dups d
 where m.id = d.id
   and d.rn > 1
   and exists (
     select 1
       from public.cl_messages other
      where other.message_id = m.message_id
        and other.direction  = m.direction
        and other.channel_id <> m.channel_id
   );

-- Step 2: drop old index, create new scoped index.
drop index if exists public.cl_messages_msgid_dir_uniq;

create unique index if not exists cl_messages_chan_msgid_dir_uniq
  on public.cl_messages (channel_id, message_id, direction)
  where message_id is not null;

commit;
