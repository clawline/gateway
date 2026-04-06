/**
 * Create cl_messages table in Supabase.
 *
 * Usage: RELAY_SUPABASE_URL=... RELAY_SUPABASE_SERVICE_ROLE_KEY=... node scripts/migrate-messages-table.js
 */

const supabaseUrl = process.env.RELAY_SUPABASE_URL;
const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Set RELAY_SUPABASE_URL and RELAY_SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const restBase = `${supabaseUrl}/pg/rest/v1`;
const headers = {
  apikey: supabaseKey,
  authorization: `Bearer ${supabaseKey}`,
  'content-type': 'application/json',
};

async function tableExists(table) {
  const res = await fetch(`${restBase}/${table}?select=id&limit=0`, { headers });
  return res.ok;
}

async function createViaInsert() {
  // Test if table already exists
  if (await tableExists('cl_messages')) {
    console.log('[migrate] cl_messages table already exists — skipping');
    return;
  }

  // PostgREST cannot run DDL. Try the /sql endpoint (Supabase Studio API)
  // or pg/query endpoint
  const sqlEndpoints = [
    `${supabaseUrl}/pg/sql`,
    `${supabaseUrl}/rest/v1/rpc/exec_sql`,
  ];

  const ddl = `
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
  `;

  for (const endpoint of sqlEndpoints) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: ddl }),
      });
      if (res.ok) {
        console.log(`[migrate] cl_messages table created via ${endpoint}`);
        return;
      }
    } catch { /* try next */ }
  }

  console.error('[migrate] Could not create table via API. Please run the following SQL manually:');
  console.log(ddl);
  console.error('\nYou can run this in the Supabase Dashboard SQL editor or via psql.');
  process.exit(1);
}

createViaInsert().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
