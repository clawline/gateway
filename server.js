import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import { readFile, writeFile, mkdir, access, unlink, readdir, stat } from "node:fs/promises";
import { dirname, join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  createRelayConfigStore,
  isRelayConfigEmpty,
  loadSeedConfigFromEnv,
} from "./lib/relay-config-store.js";
import {
  normalizeChannelRecord,
  normalizeNonEmpty,
  normalizeUserRecord,
} from "./lib/relay-config.js";

const baseDir = dirname(fileURLToPath(import.meta.url));
const relayStore = createRelayConfigStore({ baseDir });
const configPath = relayStore.configPath;
const publicDir = join(baseDir, "public");
const MIME_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff" };
const host = process.env.RELAY_HOST || "0.0.0.0";
const port = Number(process.env.RELAY_PORT || 19080);
const adminToken = normalizeNonEmpty(process.env.RELAY_ADMIN_TOKEN) || (() => {
  const generated = randomUUID().replace(/-/g, "");
  console.warn("[relay] ⚠️  RELAY_ADMIN_TOKEN not set, generated random admin token:");
  console.warn(`[relay]    ${generated}`);
  console.warn("[relay]    Set RELAY_ADMIN_TOKEN env var to use a fixed token.");
  return generated;
})();
const publicBaseUrl = normalizeNonEmpty(process.env.RELAY_PUBLIC_BASE_URL);

// ── Media upload/download ──
const mediaDir = join(baseDir, "media");
const MEDIA_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MEDIA_MIME_MAP = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".json": "application/json", ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".xml": "application/xml",
  ".zip": "application/zip", ".gz": "application/gzip",
};

// Ensure media directory exists
await mkdir(mediaDir, { recursive: true });

// Periodic cleanup of expired media files (runs every hour)
setInterval(async () => {
  try {
    const files = await readdir(mediaDir);
    const now = Date.now();
    for (const file of files) {
      try {
        const filePath = join(mediaDir, file);
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > MEDIA_TTL_MS) {
          await unlink(filePath);
          console.log(`[media] cleaned up expired file: ${file}`);
        }
      } catch {}
    }
  } catch (err) {
    console.error("[media] cleanup error:", err);
  }
}, 60 * 60 * 1000);

// Logto JWT verification
const logtoEndpoint = normalizeNonEmpty(process.env.LOGTO_ENDPOINT) || "https://logto.dr.restry.cn";
const logtoResource = normalizeNonEmpty(process.env.LOGTO_API_RESOURCE) || "https://gateway.clawlines.net/api";
const jwks = createRemoteJWKSet(new URL(`${logtoEndpoint}/oidc/jwks`));
const pluginBackendUrl =
  normalizeNonEmpty(process.env.RELAY_PLUGIN_BACKEND_URL) || `ws://127.0.0.1:${port}/backend`;

// ── Security: CORS allowlist (dynamic from config, env fallback) ──
const envCorsOrigins = (() => {
  const raw = normalizeNonEmpty(process.env.CORS_ALLOWED_ORIGINS);
  if (!raw) return null;
  return raw.split(",").map(o => o.trim()).filter(Boolean);
})();

function getCorsAllowedOrigins() {
  // Dynamic config takes priority: relay settings from cl_settings table
  const fromRelaySettings = relaySettingsCache?.corsAllowedOrigins;
  if (fromRelaySettings && fromRelaySettings.length > 0) return fromRelaySettings;
  // Then env var
  if (envCorsOrigins) return envCorsOrigins;
  // Default: allow the public base URL origin if configured
  if (publicBaseUrl) {
    try { return [new URL(publicBaseUrl).origin]; } catch {}
  }
  return null; // same-origin only
}

function isOriginAllowed(origin) {
  if (!origin) return true; // same-origin requests have no Origin header
  const allowed = getCorsAllowedOrigins();
  if (!allowed) return true; // no allowlist configured = allow all (auth protects endpoints)
  return allowed.includes(origin);
}

// ── Security: timing-safe compare ──
function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare against self to avoid timing leak on length
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// ── Security: per-IP rate limiting (token bucket) ──
const httpRateLimits = new Map(); // ip -> { tokens, lastRefill }
const HTTP_RATE_LIMIT = 100; // requests per minute
const HTTP_RATE_INTERVAL = 60_000;

function checkHttpRateLimit(ip) {
  const now = Date.now();
  let bucket = httpRateLimits.get(ip);
  if (!bucket) {
    bucket = { tokens: HTTP_RATE_LIMIT - 1, lastRefill: now };
    httpRateLimits.set(ip, bucket);
    return true;
  }
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= HTTP_RATE_INTERVAL) {
    bucket.tokens = HTTP_RATE_LIMIT - 1;
    bucket.lastRefill = now;
    return true;
  }
  if (bucket.tokens > 0) {
    bucket.tokens--;
    return true;
  }
  return false;
}

// WebSocket per-connection message rate limiting
const WS_MSG_RATE_LIMIT = 30; // messages per minute
const WS_MSG_RATE_INTERVAL = 60_000;

function checkWsMsgRateLimit(rateBucket) {
  const now = Date.now();
  if (now - rateBucket.lastRefill >= WS_MSG_RATE_INTERVAL) {
    rateBucket.tokens = WS_MSG_RATE_LIMIT - 1;
    rateBucket.lastRefill = now;
    return true;
  }
  if (rateBucket.tokens > 0) {
    rateBucket.tokens--;
    return true;
  }
  return false;
}

// ── Security: per-IP connection limits ──
const connectionsPerIp = new Map(); // ip -> count
const MAX_CONNECTIONS_PER_IP = 50;

function trackIpConnection(ip) {
  const count = connectionsPerIp.get(ip) || 0;
  if (count >= MAX_CONNECTIONS_PER_IP) return false;
  connectionsPerIp.set(ip, count + 1);
  return true;
}

function untrackIpConnection(ip) {
  const count = connectionsPerIp.get(ip) || 0;
  if (count <= 1) connectionsPerIp.delete(ip);
  else connectionsPerIp.set(ip, count - 1);
}

// Periodic cleanup of rate limit buckets (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of httpRateLimits) {
    if (now - bucket.lastRefill > HTTP_RATE_INTERVAL * 5) httpRateLimits.delete(ip);
  }
}, 5 * 60_000);

const server = createServer();
const backendWss = new WebSocketServer({ noServer: true, maxPayload: 10485760 });
const clientWss = new WebSocketServer({ noServer: true, maxPayload: 10485760 });

const backends = new Map();
const backendPresence = new Map();

// D1+D2: split client state into two maps so iteration is by-construction safe.
//
// realClients — live WebSocket clients. ws is always non-null and OPEN-ish
// (close handler removes the entry before the socket dies).
//   connectionId -> { ws, channelId, chatId, userId }
//
// apiSessions — pooled HTTP /api/chat sessions. One session per
// (channelId, chatId, agentId); each session holds the in-flight requests
// keyed by inbound messageId. No `ws` field — never iterated as a WS.
//   sessionId -> { sessionId, channelId, chatId, agentId, userId,
//                  requests: Map<messageId, { resolve, reject, timer, replyEvents }>,
//                  idleTimer }
//
// apiAgentListSessions — short-lived /api/agents probes. Independent of
// apiSessions because agent.list isn't a message path (no replyTo, no pool).
//   sessionId -> { channelId, requestId, resolve, reject, timer }
const realClients = new Map();
const apiSessions = new Map();
const apiAgentListSessions = new Map();

let relayConfig = {
  version: 1,
  channels: {},
};

// ── Thread ID normalization ──
// ACP threads use clawline-thread-{UUID} format; strip the prefix for cl_threads.id consistency.
function normalizeThreadId(threadId) {
  if (!threadId) return threadId;
  const match = threadId.match(/^clawline-thread-(.+)$/);
  return match ? match[1] : threadId;
}

// ── Message persistence (sync with dead-letter fallback) ──

const MESSAGE_TYPES_TO_PERSIST = new Set([
  'message.receive', 'message.send',
]);

const PERSIST_MAX_RETRIES = 2;
const PERSIST_RETRY_DELAY_MS = 1000;
const DEAD_LETTER_PATH = join(baseDir, 'data', 'persist-failures.jsonl');

function buildPersistRow(channelId, event, direction, senderId) {
  const data = event.data || event;
  const threadId = normalizeThreadId(data.threadId || null);
  return {
    channel_id: channelId,
    sender_id: senderId || data.senderId || null,
    agent_id: data.agentId || null,
    message_id: data.messageId || null,
    content: data.content || data.text || null,
    content_type: data.contentType || data.messageType || 'text',
    direction,
    media_url: data.mediaUrl || null,
    parent_id: data.parentId || data.replyTo || null,
    thread_id: threadId,
    meta: data.meta ? JSON.stringify(data.meta) : null,
    timestamp: data.timestamp || Date.now(),
  };
}

/**
 * ADD-BACK #7: HTTP idempotency check.
 *
 * Look up cl_messages for an existing inbound with this messageId. If found,
 * also look up its outbound reply (parent_id = messageId, direction = outbound).
 *
 * Returns:
 *   null            — never seen this messageId, proceed normally
 *   { kind: 'cached', outbound: row } — both seen; caller can serve cached reply
 *   { kind: 'in_flight' }             — inbound persisted but reply not yet
 *
 * Best-effort: on any DB error returns null so the caller falls through to
 * normal processing (idempotency is a nice-to-have, not a correctness gate
 * — the underlying ON CONFLICT in cl_messages still prevents duplicate rows).
 */
async function checkIdempotency(channelId, messageId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !messageId) return null;
  try {
    const inRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_messages?channel_id=eq.${encodeURIComponent(channelId)}&message_id=eq.${encodeURIComponent(messageId)}&direction=eq.inbound&select=id&limit=1`,
      { headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` } }
    );
    if (!inRes.ok) return null;
    const inRows = await inRes.json();
    if (!Array.isArray(inRows) || inRows.length === 0) return null;
    const outRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_messages?channel_id=eq.${encodeURIComponent(channelId)}&parent_id=eq.${encodeURIComponent(messageId)}&direction=eq.outbound&select=message_id,content,agent_id,timestamp&limit=1`,
      { headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` } }
    );
    if (!outRes.ok) return { kind: 'in_flight' };
    const outRows = await outRes.json();
    if (Array.isArray(outRows) && outRows.length > 0) {
      return { kind: 'cached', outbound: outRows[0] };
    }
    return { kind: 'in_flight' };
  } catch {
    return null;
  }
}

/**
 * Persist a message to Supabase synchronously (awaitable).
 * Retries inline up to PERSIST_MAX_RETRIES times.
 * On final failure, writes to dead-letter file on disk.
 * Returns true if persisted successfully, false otherwise.
 * Also updates thread metadata when the message belongs to a thread.
 */
async function persistMessageAsync(channelId, event, direction, senderId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !event) return true; // no-op if unconfigured

  const eventType = event.type || '';
  if (!MESSAGE_TYPES_TO_PERSIST.has(eventType)) return true;

  const row = buildPersistRow(channelId, event, direction, senderId);

  for (let attempt = 0; attempt <= PERSIST_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${supabaseUrl}/pg/rest/v1/cl_messages`, {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
          'content-type': 'application/json',
          prefer: 'return=minimal,resolution=ignore-duplicates',
        },
        body: JSON.stringify(row),
      });
      if (res.ok || (res.status >= 200 && res.status < 300) || res.status === 409) {
        // On successful persist, update thread metadata if applicable
        if (row.thread_id) {
          const data = event.data || event;
          updateThreadOnNewReply(
            channelId, row.thread_id,
            senderId || data.senderId || null,
            data.messageId || null,
            data.content || data.text || null
          );
        }
        return true; // success or duplicate
      }
      if (res.status < 500) {
        // 4xx — log but don't retry (bad data)
        console.error(`[messages] persist rejected (${res.status}): ${row.message_id}`);
        return false;
      }
      // 5xx — retry
      if (attempt < PERSIST_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, PERSIST_RETRY_DELAY_MS));
      }
    } catch (err) {
      // Network error — retry
      if (attempt < PERSIST_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, PERSIST_RETRY_DELAY_MS));
      }
    }
  }

  // All retries exhausted — write to dead-letter file
  try {
    const dir = dirname(DEAD_LETTER_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(DEAD_LETTER_PATH, JSON.stringify(row) + '\n');
    console.error(`[messages] persist failed, written to dead-letter: ${row.message_id}`);
  } catch (dlErr) {
    console.error(`[messages] persist failed AND dead-letter write failed: ${row.message_id}`, dlErr);
  }
  return false;
}

// On startup: replay dead-letter file
(async function replayDeadLetters() {
  if (!fs.existsSync(DEAD_LETTER_PATH)) return;
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  try {
    const lines = fs.readFileSync(DEAD_LETTER_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return;
    console.log(`[messages] replaying ${lines.length} dead-letter messages`);
    let succeeded = 0;
    const remaining = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        const res = await fetch(`${supabaseUrl}/pg/rest/v1/cl_messages`, {
          method: 'POST',
          headers: {
            apikey: supabaseKey,
            authorization: `Bearer ${supabaseKey}`,
            'content-type': 'application/json',
            prefer: 'return=minimal,resolution=ignore-duplicates',
          },
          body: JSON.stringify(row),
        });
        if (res.ok || res.status === 409) {
          succeeded++;
        } else {
          remaining.push(line);
        }
      } catch {
        remaining.push(line);
      }
    }
    // Rewrite file with only failed items (or delete if empty)
    if (remaining.length === 0) {
      fs.unlinkSync(DEAD_LETTER_PATH);
    } else {
      fs.writeFileSync(DEAD_LETTER_PATH, remaining.join('\n') + '\n');
    }
    console.log(`[messages] dead-letter replay: ${succeeded} succeeded, ${remaining.length} remaining`);
  } catch (err) {
    console.error('[messages] dead-letter replay error:', err);
  }
})();

// Pre-load relay settings (CORS etc.) so they're available before the first request
void loadRelaySettings().then((s) => {
  if (s.corsAllowedOrigins?.length > 0) {
    console.log(`[settings] loaded CORS origins from DB: ${s.corsAllowedOrigins.join(', ')}`);
  }
}).catch(() => {});

/**
 * Update thread metadata when a new reply message is persisted.
 *
 * D9: deleted the per-thread mutex (`_threadUpdateChain`) and the
 * SELECT → +1 → PATCH dance. reply_count is no longer written here —
 * handleThreadGet / handleThreadList compute it on demand via
 * `prefer: count=exact, Range: 0-0` against cl_messages (ADD-BACK #1).
 * That removes the race entirely (5 concurrent replies can't undercount
 * a value that's never stored). last_reply_at + participant_ids stay
 * because they don't need atomic counting.
 */
async function updateThreadOnNewReply(channelId, threadId, senderId, messageId, content) {
  threadId = normalizeThreadId(threadId);
  if (!threadId) return;
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  try {
    // 1. Fetch current thread (only to check status + read existing participants)
    const getRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_threads?id=eq.${encodeURIComponent(threadId)}&select=status,participant_ids&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
        },
      }
    );
    const threads = await getRes.json();
    if (!threads.length) return;
    const thread = threads[0];

    // Skip if thread is deleted
    if (thread.status === 'deleted') return;

    // 2. Build update payload — no reply_count, computed on demand by readers.
    const now = new Date().toISOString();
    const participantIds = Array.isArray(thread.participant_ids)
      ? thread.participant_ids
      : JSON.parse(thread.participant_ids || '[]');

    if (senderId && !participantIds.includes(senderId)) {
      participantIds.push(senderId);
    }

    const updateRow = {
      last_reply_at: now,
      participant_ids: JSON.stringify(participantIds),
      updated_at: now,
    };

    // 3. Update the thread
    const patchRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_threads?id=eq.${encodeURIComponent(threadId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
          'content-type': 'application/json',
          prefer: 'return=representation',
        },
        body: JSON.stringify(updateRow),
      }
    );
    const updatedRows = await patchRes.json();
    if (!updatedRows.length) return;
    const updatedThread = updatedRows[0];

    // 4. Compute reply_count on demand for the broadcast — readers will recount,
    // but the broadcast carries an authoritative number so listeners don't have
    // to re-query immediately.
    const replyCount = await countThreadReplies(threadId);

    // 5. Broadcast thread.updated to all channel subscribers
    broadcastToChannel(channelId, {
      type: 'thread.updated',
      data: { thread: { ...mapThreadRow(updatedThread), replyCount } },
    });

    // 6. Broadcast thread.new_reply to all channel subscribers
    const preview = (content || '').substring(0, 100);
    broadcastToChannel(channelId, {
      type: 'thread.new_reply',
      data: {
        threadId,
        messageId: messageId || null,
        senderId: senderId || null,
        preview,
      },
    });
  } catch (err) {
    console.warn(`[threads] metadata update failed for thread ${threadId}: ${err.message}`);
  }
}

/**
 * ADD-BACK #1: count reply messages for a thread on demand.
 * Uses PostgREST `prefer: count=exact` + tiny range so we get the count
 * without paying for the row data. Index on cl_messages.thread_id makes
 * this a single sub-millisecond lookup.
 */
async function countThreadReplies(threadId) {
  threadId = normalizeThreadId(threadId);
  if (!threadId) return 0;
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return 0;
  try {
    const res = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_messages?thread_id=eq.${encodeURIComponent(threadId)}&select=message_id`,
      {
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
          prefer: 'count=exact',
          range: '0-0',
        },
      }
    );
    if (!res.ok) return 0;
    const cr = res.headers.get('content-range');
    if (!cr) return 0;
    const m = cr.match(/\/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

// ── Thread operations (Supabase CRUD) ──

/**
 * Send `event` to every real WebSocket client on (channelId, chatId), optionally
 * excluding one connectionId (the originator). Single source of truth for sibling
 * fan-out — replaces 4 near-identical inline loops in different message paths
 * (D11, reliability-v2 plan).
 *
 * D1+D2: iterates realClients only — entries are guaranteed to have a non-null
 * live ws (close handler removes the entry). No isApi / null-ws guards needed.
 */
function fanOut(channelId, chatId, event, excludeConnectionId) {
  for (const [id, c] of realClients) {
    if (id === excludeConnectionId) continue;
    if (c.channelId !== channelId) continue;
    if (c.chatId !== chatId) continue;
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    sendJson(c.ws, event);
  }
}

/**
 * Channel-wide broadcast (e.g. thread.updated). Same scope as fanOut, no
 * chatId filter.
 */
function broadcastToChannel(channelId, event, excludeConnectionId) {
  for (const [id, c] of realClients) {
    if (id === excludeConnectionId) continue;
    if (c.channelId !== channelId) continue;
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    sendJson(c.ws, event);
  }
}

async function handleThreadCreate(connectionId, channelId, data, senderId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  const client = realClients.get(connectionId);
  if (!client) return;

  if (!supabaseUrl || !supabaseKey) {
    sendJson(client.ws, { type: 'thread.create', data: { error: 'Database not configured' } });
    return;
  }

  const parentMessageId = data?.parentMessageId;
  if (!parentMessageId) {
    sendJson(client.ws, { type: 'thread.create', data: { error: 'parentMessageId is required' } });
    return;
  }

  const threadId = randomUUID();
  const now = new Date().toISOString();
  const row = {
    id: threadId,
    channel_id: channelId,
    parent_message_id: parentMessageId,
    creator_id: senderId || 'unknown',
    title: data.title || null,
    status: 'active',
    type: 'user',
    created_at: now,
    updated_at: now,
    last_reply_at: null,
    reply_count: 0,
    participant_ids: JSON.stringify([senderId].filter(Boolean)),
  };

  try {
    const res = await fetch(`${supabaseUrl}/pg/rest/v1/cl_threads`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        authorization: `Bearer ${supabaseKey}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[threads] create failed: ${res.status} ${errText}`);
      sendJson(client.ws, { type: 'thread.create', data: { error: 'Failed to create thread' } });
      return;
    }

    const [created] = await res.json();
    const thread = mapThreadRow(created);

    // Respond to requesting client
    sendJson(client.ws, { type: 'thread.create', data: { requestId: data.requestId, thread } });

    // Broadcast thread.updated to all channel subscribers
    broadcastToChannel(channelId, { type: 'thread.updated', data: { thread } }, connectionId);
  } catch (err) {
    console.error(`[threads] create error: ${err.message}`);
    sendJson(client.ws, { type: 'thread.create', data: { error: 'Internal error' } });
  }
}

async function handleThreadGet(connectionId, channelId, data, userId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  const client = realClients.get(connectionId);
  if (!client) return;

  if (!supabaseUrl || !supabaseKey) {
    sendJson(client.ws, { type: 'thread.get', data: { error: 'Database not configured' } });
    return;
  }

  const threadId = normalizeThreadId(data?.threadId);
  if (!threadId) {
    sendJson(client.ws, { type: 'thread.get', data: { error: 'threadId is required' } });
    return;
  }

  try {
    // Fetch thread
    const threadRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_threads?id=eq.${encodeURIComponent(threadId)}&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!threadRes.ok) {
      sendJson(client.ws, { type: 'thread.get', data: { requestId: data.requestId, error: 'Failed to fetch thread' } });
      return;
    }

    const threadRows = await threadRes.json();
    if (!threadRows.length) {
      sendJson(client.ws, { type: 'thread.get', data: { requestId: data.requestId, error: 'Thread not found' } });
      return;
    }

    const threadRow = threadRows[0];
    if (threadRow.status === 'deleted') {
      sendJson(client.ws, { type: 'thread.get', data: { requestId: data.requestId, error: 'Thread not found' } });
      return;
    }

    // ADD-BACK #1: reply_count computed on demand from cl_messages.
    const replyCount = await countThreadReplies(threadId);
    const thread = { ...mapThreadRow(threadRow), replyCount };

    // Fetch last 20 messages in thread
    const messagesRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_messages?thread_id=eq.${encodeURIComponent(threadId)}&order=timestamp.desc&limit=20`,
      {
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    let messages = [];
    if (messagesRes.ok) {
      const msgRows = await messagesRes.json();
      messages = msgRows.reverse().map(mapMessageRow);
    }

    // Compute unread count
    let unreadCount = 0;
    if (userId) {
      const readRes = await fetch(
        `${supabaseUrl}/pg/rest/v1/cl_thread_read_status?user_id=eq.${encodeURIComponent(userId)}&thread_id=eq.${encodeURIComponent(threadId)}&limit=1`,
        {
          headers: {
            apikey: supabaseKey,
            authorization: `Bearer ${supabaseKey}`,
          },
        }
      );

      if (readRes.ok) {
        const readRows = await readRes.json();
        if (readRows.length && readRows[0].last_read_at) {
          // Count messages created after the user's last read timestamp
          const lastReadAt = readRows[0].last_read_at;
          const countRes = await fetch(
            `${supabaseUrl}/pg/rest/v1/cl_messages?thread_id=eq.${encodeURIComponent(threadId)}&created_at=gt.${encodeURIComponent(lastReadAt)}&select=message_id`,
            {
              headers: {
                apikey: supabaseKey,
                authorization: `Bearer ${supabaseKey}`,
                prefer: 'count=exact',
              },
            }
          );
          if (countRes.ok) {
            const contentRange = countRes.headers.get('content-range');
            if (contentRange) {
              const match = contentRange.match(/\/(\d+)/);
              if (match) unreadCount = parseInt(match[1], 10);
            }
          }
        } else {
          // No read status — all replies are unread
          unreadCount = thread.replyCount;
        }
      } else {
        unreadCount = thread.replyCount;
      }
    }

    sendJson(client.ws, {
      type: 'thread.get',
      data: {
        requestId: data.requestId,
        thread,
        messages,
        unreadCount,
      },
    });
  } catch (err) {
    console.error(`[threads] get error: ${err.message}`);
    sendJson(client.ws, { type: 'thread.get', data: { requestId: data.requestId, error: 'Internal error' } });
  }
}

async function handleThreadList(connectionId, channelId, data, userId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  const client = realClients.get(connectionId);
  if (!client) return;

  if (!supabaseUrl || !supabaseKey) {
    sendJson(client.ws, { type: 'thread.list', data: { error: 'Database not configured' } });
    return;
  }

  const filterChannelId = data?.channelId || channelId;
  const status = data?.status || 'active';
  const participantId = data?.participantId || null;
  const page = Math.max(1, parseInt(data?.page, 10) || 1);
  // Accept both `pageSize` (canonical) and `limit` (documented alias). Without either,
  // default to 20. Cap at 100 to prevent unbounded queries.
  const requestedSize = data?.pageSize ?? data?.limit ?? 20;
  const pageSize = Math.min(100, Math.max(1, parseInt(requestedSize, 10) || 20));
  const offset = (page - 1) * pageSize;

  try {
    // Build query filters
    let queryFilters = `channel_id=eq.${encodeURIComponent(filterChannelId)}`;

    // Status filter: 'all' returns everything except deleted, specific status matches exactly
    if (status === 'all') {
      queryFilters += `&status=neq.deleted`;
    } else {
      queryFilters += `&status=eq.${encodeURIComponent(status)}`;
    }

    // Participant filter: check if participantId is in the participant_ids jsonb array
    if (participantId) {
      queryFilters += `&participant_ids=cs.${encodeURIComponent(JSON.stringify([participantId]))}`;
    }

    // Fetch threads with count
    const threadsRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_threads?${queryFilters}&order=last_reply_at.desc.nullslast,created_at.desc&offset=${offset}&limit=${pageSize}`,
      {
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
          prefer: 'count=exact',
        },
      }
    );

    if (!threadsRes.ok) {
      const errText = await threadsRes.text();
      console.error(`[threads] list failed: ${threadsRes.status} ${errText}`);
      sendJson(client.ws, { type: 'thread.list', data: { requestId: data.requestId, error: 'Failed to list threads' } });
      return;
    }

    // Parse total count from content-range header
    let total = 0;
    const contentRange = threadsRes.headers.get('content-range');
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)/);
      if (match) total = parseInt(match[1], 10);
    }

    const threadRows = await threadsRes.json();
    const threadsBase = threadRows.map(mapThreadRow);

    // ADD-BACK #1: compute reply_count on demand for each thread, in parallel.
    // Each query is index-served (cl_messages.thread_id) and tiny (count only).
    const threads = await Promise.all(
      threadsBase.map(async (t) => ({ ...t, replyCount: await countThreadReplies(t.id) })),
    );

    // Compute unread count for each thread if we have a userId
    const threadsWithUnread = await Promise.all(
      threads.map(async (thread) => {
        let unreadCount = 0;
        if (userId && thread.replyCount > 0) {
          try {
            const readRes = await fetch(
              `${supabaseUrl}/pg/rest/v1/cl_thread_read_status?user_id=eq.${encodeURIComponent(userId)}&thread_id=eq.${encodeURIComponent(thread.id)}&limit=1`,
              {
                headers: {
                  apikey: supabaseKey,
                  authorization: `Bearer ${supabaseKey}`,
                },
              }
            );
            if (readRes.ok) {
              const readRows = await readRes.json();
              if (readRows.length && readRows[0].last_read_at) {
                const lastReadAt = readRows[0].last_read_at;
                const countRes = await fetch(
                  `${supabaseUrl}/pg/rest/v1/cl_messages?thread_id=eq.${encodeURIComponent(thread.id)}&created_at=gt.${encodeURIComponent(lastReadAt)}&select=message_id`,
                  {
                    headers: {
                      apikey: supabaseKey,
                      authorization: `Bearer ${supabaseKey}`,
                      prefer: 'count=exact',
                    },
                  }
                );
                if (countRes.ok) {
                  const cr = countRes.headers.get('content-range');
                  if (cr) {
                    const m = cr.match(/\/(\d+)/);
                    if (m) unreadCount = parseInt(m[1], 10);
                  }
                }
              } else {
                unreadCount = thread.replyCount;
              }
            } else {
              unreadCount = thread.replyCount;
            }
          } catch {
            unreadCount = thread.replyCount;
          }
        }
        return { ...thread, unreadCount };
      })
    );

    sendJson(client.ws, {
      type: 'thread.list',
      data: {
        requestId: data.requestId,
        threads: threadsWithUnread,
        total,
      },
    });
  } catch (err) {
    console.error(`[threads] list error: ${err.message}`);
    sendJson(client.ws, { type: 'thread.list', data: { requestId: data.requestId, error: 'Internal error' } });
  }
}

async function handleThreadUpdate(connectionId, channelId, data, senderId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  const client = realClients.get(connectionId);
  if (!client) return;

  if (!supabaseUrl || !supabaseKey) {
    sendJson(client.ws, { type: 'thread.update', data: { error: 'Database not configured' } });
    return;
  }

  const threadId = normalizeThreadId(data?.threadId);
  if (!threadId) {
    sendJson(client.ws, { type: 'thread.update', data: { error: 'threadId is required' } });
    return;
  }

  try {
    // Fetch current thread to validate status transition
    const getRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_threads?id=eq.${encodeURIComponent(threadId)}&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!getRes.ok) {
      sendJson(client.ws, { type: 'thread.update', data: { requestId: data.requestId, error: 'Failed to fetch thread' } });
      return;
    }

    const rows = await getRes.json();
    if (!rows.length || rows[0].status === 'deleted') {
      sendJson(client.ws, { type: 'thread.update', data: { requestId: data.requestId, error: 'Thread not found' } });
      return;
    }

    const currentStatus = rows[0].status;

    // Validate status transition if status change requested
    if (data.status && data.status !== currentStatus) {
      const allowedTransitions = {
        active: ['archived', 'locked'],
        archived: ['active'],
        locked: ['active'],
      };
      const allowed = allowedTransitions[currentStatus] || [];
      if (!allowed.includes(data.status)) {
        sendJson(client.ws, {
          type: 'thread.update',
          data: { requestId: data.requestId, error: `Cannot transition from '${currentStatus}' to '${data.status}'` },
        });
        return;
      }
    }

    // Build patch object
    const patch = { updated_at: new Date().toISOString() };
    if (data.title !== undefined) patch.title = data.title;
    if (data.status) patch.status = data.status;

    const updateRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_threads?id=eq.${encodeURIComponent(threadId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
          'content-type': 'application/json',
          prefer: 'return=representation',
        },
        body: JSON.stringify(patch),
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error(`[threads] update failed: ${updateRes.status} ${errText}`);
      sendJson(client.ws, { type: 'thread.update', data: { requestId: data.requestId, error: 'Failed to update thread' } });
      return;
    }

    const [updated] = await updateRes.json();
    const thread = mapThreadRow(updated);

    // Respond to requesting client
    sendJson(client.ws, { type: 'thread.update', data: { requestId: data.requestId, thread } });

    // Broadcast thread.updated to all channel subscribers
    broadcastToChannel(channelId, { type: 'thread.updated', data: { thread } }, connectionId);
  } catch (err) {
    console.error(`[threads] update error: ${err.message}`);
    sendJson(client.ws, { type: 'thread.update', data: { requestId: data.requestId, error: 'Internal error' } });
  }
}

async function handleThreadDelete(connectionId, channelId, data, senderId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  const client = realClients.get(connectionId);
  if (!client) return;

  if (!supabaseUrl || !supabaseKey) {
    sendJson(client.ws, { type: 'thread.delete', data: { error: 'Database not configured' } });
    return;
  }

  const threadId = normalizeThreadId(data?.threadId);
  if (!threadId) {
    sendJson(client.ws, { type: 'thread.delete', data: { error: 'threadId is required' } });
    return;
  }

  try {
    // Fetch current thread to verify it exists
    const getRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_threads?id=eq.${encodeURIComponent(threadId)}&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!getRes.ok) {
      sendJson(client.ws, { type: 'thread.delete', data: { requestId: data.requestId, error: 'Failed to fetch thread' } });
      return;
    }

    const rows = await getRes.json();
    if (!rows.length || rows[0].status === 'deleted') {
      sendJson(client.ws, { type: 'thread.delete', data: { requestId: data.requestId, error: 'Thread not found' } });
      return;
    }

    // Soft-delete: set status to 'deleted'
    const patch = {
      status: 'deleted',
      updated_at: new Date().toISOString(),
    };

    const updateRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_threads?id=eq.${encodeURIComponent(threadId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
          'content-type': 'application/json',
          prefer: 'return=representation',
        },
        body: JSON.stringify(patch),
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error(`[threads] delete failed: ${updateRes.status} ${errText}`);
      sendJson(client.ws, { type: 'thread.delete', data: { requestId: data.requestId, error: 'Failed to delete thread' } });
      return;
    }

    const [deleted] = await updateRes.json();
    const thread = mapThreadRow(deleted);

    // Respond to requesting client
    sendJson(client.ws, { type: 'thread.delete', data: { requestId: data.requestId, thread } });

    // Broadcast thread.updated to all channel subscribers
    broadcastToChannel(channelId, { type: 'thread.updated', data: { thread } }, connectionId);
  } catch (err) {
    console.error(`[threads] delete error: ${err.message}`);
    sendJson(client.ws, { type: 'thread.delete', data: { requestId: data.requestId, error: 'Internal error' } });
  }
}

async function handleThreadMarkRead(connectionId, channelId, data, userId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  const client = realClients.get(connectionId);
  if (!client) return;

  if (!supabaseUrl || !supabaseKey) {
    sendJson(client.ws, { type: 'thread.mark_read', data: { error: 'Database not configured' } });
    return;
  }

  const threadId = normalizeThreadId(data?.threadId);
  if (!threadId) {
    sendJson(client.ws, { type: 'thread.mark_read', data: { error: 'threadId is required' } });
    return;
  }
  if (!userId) {
    sendJson(client.ws, { type: 'thread.mark_read', data: { error: 'userId is required' } });
    return;
  }

  try {
    // Upsert into cl_thread_read_status
    const now = new Date().toISOString();
    const upsertRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_thread_read_status`,
      {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
          'content-type': 'application/json',
          prefer: 'return=minimal,resolution=merge-duplicates',
        },
        body: JSON.stringify({
          user_id: userId,
          thread_id: threadId,
          last_read_at: now,
        }),
      }
    );

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.error(`[threads] mark_read upsert failed: ${upsertRes.status} ${errText}`);
      sendJson(client.ws, { type: 'thread.mark_read', data: { error: 'Failed to mark thread as read' } });
      return;
    }

    sendJson(client.ws, { type: 'thread.mark_read', data: { threadId, lastReadAt: now } });

    // TH-3: notify other devices/clients on this channel that read state changed.
    // Carry { threadId, readBy:userId, lastReadAt } so subscribers can update unread
    // badges without re-fetching. Same shape as other thread.updated frames but with
    // a `readState` flag so clients can disambiguate from full thread.updated payloads.
    broadcastToChannel(channelId, {
      type: 'thread.updated',
      data: { threadId, readState: { userId, lastReadAt: now } },
    });
  } catch (err) {
    console.error(`[threads] mark_read error: ${err.message}`);
    sendJson(client.ws, { type: 'thread.mark_read', data: { error: 'Internal error' } });
  }
}

/**
 * Handle thread.search — search messages within a thread by text content.
 * Uses PostgREST ilike for case-insensitive substring matching on cl_messages.content.
 */
async function handleThreadSearch(connectionId, channelId, data, userId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  const client = realClients.get(connectionId);
  if (!client) return;

  if (!supabaseUrl || !supabaseKey) {
    sendJson(client.ws, { type: 'thread.search', data: { error: 'Database not configured' } });
    return;
  }

  const threadId = normalizeThreadId(data?.threadId);
  if (!threadId) {
    sendJson(client.ws, { type: 'thread.search', data: { requestId: data?.requestId, error: 'threadId is required' } });
    return;
  }
  const query = (data?.query || '').trim();
  if (!query) {
    sendJson(client.ws, { type: 'thread.search', data: { requestId: data?.requestId, error: 'query is required' } });
    return;
  }

  try {
    // TH-6: refuse search on deleted threads (no useful results, signals intent error
    // to caller). Allow search on archived/locked — user might want to find old context.
    const tStatusRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_threads?id=eq.${encodeURIComponent(threadId)}&select=status&limit=1`,
      { headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` } }
    );
    const tRows = await tStatusRes.json();
    if (Array.isArray(tRows) && tRows[0]?.status === 'deleted') {
      sendJson(client.ws, { type: 'thread.search', data: { requestId: data?.requestId, error: 'thread is deleted' } });
      return;
    }

    // Search messages in this thread using ilike (case-insensitive substring match)
    const encodedQuery = encodeURIComponent(`*${query}*`);
    const searchRes = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_messages?thread_id=eq.${encodeURIComponent(threadId)}&content=ilike.${encodedQuery}&order=timestamp.asc&limit=50`,
      {
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
          prefer: 'count=exact',
        },
      }
    );

    if (!searchRes.ok) {
      const errText = await searchRes.text();
      console.error(`[threads] search failed: ${searchRes.status} ${errText}`);
      sendJson(client.ws, { type: 'thread.search', data: { requestId: data.requestId, error: 'Search failed' } });
      return;
    }

    const msgRows = await searchRes.json();
    const total = (() => {
      const contentRange = searchRes.headers.get('content-range');
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)/);
        if (match) return parseInt(match[1], 10);
      }
      return msgRows.length;
    })();

    const messages = msgRows.map(mapMessageRow);

    sendJson(client.ws, {
      type: 'thread.search',
      data: {
        requestId: data.requestId,
        query,
        threadId,
        messages,
        total,
      },
    });
  } catch (err) {
    console.error(`[threads] search error: ${err.message}`);
    sendJson(client.ws, { type: 'thread.search', data: { requestId: data.requestId, error: 'Internal error' } });
  }
}

/** Map a Supabase cl_threads row to a camelCase Thread object */
function mapThreadRow(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    parentMessageId: row.parent_message_id,
    creatorId: row.creator_id,
    title: row.title || null,
    status: row.status,
    type: row.type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastReplyAt: row.last_reply_at || null,
    replyCount: row.reply_count ?? 0,
    participantIds: Array.isArray(row.participant_ids) ? row.participant_ids : JSON.parse(row.participant_ids || '[]'),
  };
}

/** Map a Supabase cl_messages row to a camelCase message object */
function mapMessageRow(row) {
  return {
    messageId: row.message_id,
    chatId: row.channel_id,
    senderId: row.sender_id,
    agentId: row.agent_id,
    content: row.content,
    contentType: row.content_type,
    direction: row.direction,
    mediaUrl: row.media_url,
    parentId: row.parent_id,
    threadId: row.thread_id,
    meta: row.meta,
    timestamp: row.timestamp,
    createdAt: row.created_at,
  };
}

// ── Auto-thread creation engine ──

/** Cache of known thread IDs to avoid redundant DB lookups */
const knownThreadIds = new Set();

/**
 * Pending auto-threads: when an auto-thread is created for a user message,
 * the AI response should be routed into the thread.
 * Map<connectionId, Array<{ threadId, parentMessageId, createdAt }>>
/**
 * Create a thread programmatically (no client connection required).
 * Used by auto-thread triggers (delegation, ACP, @mention).
 *
 * D5: removed pendingPush/pendingPeek/pendingShift/pendingClear/markShifted/
 * getRecentlyShifted helpers + their three Maps. The "AI reply auto-routes
 * into the auto-created thread" magic is gone — @mention now only creates
 * the thread (parent stays in main chat); user must explicitly reply inside
 * the thread to address the agent there.
 *
 * Returns { threadId, thread } or null on failure.
 */
async function autoCreateThread(channelId, parentMessageId, creatorId, type, title) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;

  const threadId = randomUUID();
  const now = new Date().toISOString();
  const row = {
    id: threadId,
    channel_id: channelId,
    parent_message_id: parentMessageId,
    creator_id: creatorId || 'system',
    title: title || null,
    status: 'active',
    type: type === 'acp' ? 'acp' : 'user', // DB constraint only allows 'user' | 'acp'
    created_at: now,
    updated_at: now,
    last_reply_at: null,
    reply_count: 0,
    participant_ids: JSON.stringify([creatorId].filter(Boolean)),
  };

  try {
    const res = await fetch(`${supabaseUrl}/pg/rest/v1/cl_threads`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        authorization: `Bearer ${supabaseKey}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[auto-thread] create failed: ${res.status} ${errText}`);
      return null;
    }

    const [created] = await res.json();
    const thread = mapThreadRow(created);
    knownThreadIds.add(threadId);
    console.log(`[auto-thread] created ${type} thread ${threadId} for message ${parentMessageId}`);

    // Broadcast to all channel clients
    broadcastToChannel(channelId, { type: 'thread.updated', data: { thread } });

    return { threadId, thread };
  } catch (err) {
    console.warn(`[auto-thread] create error: ${err.message}`);
    return null;
  }
}

/**
 * Fetch a single thread from Supabase by ID.
 * Used to discover ACP-created threads that gateway didn't create.
 */
async function fetchThreadFromDb(channelId, threadId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;

  try {
    const res = await fetch(
      `${supabaseUrl}/pg/rest/v1/cl_threads?id=eq.${encodeURIComponent(threadId)}&channel_id=eq.${encodeURIComponent(channelId)}&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
        },
      }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a thread ID (possibly from ACP) is known to clients.
 * If the thread exists in DB but not in our cache, broadcast it.
 *
 * D5: removed lastUserMessageId-based ACP parentMessageId repair heuristic.
 * If ACP creates a thread with a non-message parentMessageId, it stays as-is.
 */
async function ensureThreadKnown(channelId, threadId) {
  if (!threadId || knownThreadIds.has(threadId)) return;
  knownThreadIds.add(threadId); // mark early to avoid duplicate fetches

  const row = await fetchThreadFromDb(channelId, threadId);
  if (row) {
    broadcastToChannel(channelId, { type: 'thread.updated', data: { thread: mapThreadRow(row) } });
    console.log(`[auto-thread] discovered ACP thread ${threadId}, broadcast to clients`);
  }
}

// ── AI Settings & LLM helpers ──

const DEFAULT_SUGGESTION_PROMPT = `You are a suggestion generator for a chat interface. Based on the conversation context, generate 3-5 follow-up questions or actions from the USER's perspective (first person).

Rules:
- Write every suggestion as if the user is asking/saying it (first person, e.g. "How do I...", "Can you help me...")
- Predict what the user might want to ask or do next, NOT how the assistant should respond
- Generate exactly 3-5 suggestions, no more, no less
- Each suggestion must be under 25 characters
- Make suggestions relevant, diverse, and actionable
- If the conversation is in Chinese, generate Chinese suggestions; if in English, generate English
- Match the language and tone of the conversation
- Output ONLY a valid JSON array of strings, nothing else

Example output: ["怎么部署?", "有什么替代方案?", "能详细说说吗?"]`;

const DEFAULT_REPLY_DRAFT_PROMPT = `你是用户的私人秘书助手，帮助用户快速回复 AI agent 的消息。用户同时管理多个 AI agent，每个 agent 在执行不同任务（编程、研究、内容创作、运维等）。

你的职责是根据对话上下文，以用户的身份起草一条简洁、精准的回复。

核心规则：
1. 站在用户视角，用第一人称回复
2. 自动检测并匹配对话语言（中文对话用中文回复，英文对话用英文回复）
3. 简洁优先 - 用户在批量处理消息，不需要客套，直奔主题
4. 如果 agent 报告完成了任务 → 确认收到 + 给出下一步指令
5. 如果 agent 提出了问题 → 根据上下文推断最可能的答案，直接回答
6. 如果 agent 遇到错误或阻塞 → 给出排查方向或替代方案
7. 如果 agent 等待确认 → 明确表态同意/拒绝/修改
8. 不要重复 agent 已经说过的内容
9. 只输出回复文本本身，不要加引号、标签或解释`;

const DEFAULT_VOICE_REFINE_PROMPT = `You are a voice message refinement assistant. The user dictated a message via speech recognition, which may contain recognition errors, filler words, repetitions, or awkward phrasing.

Your task:
- Fix speech recognition errors and typos (e.g. homophones, misheard words)
- Remove filler words (嗯、那个、就是、um、uh、like、you know, etc.)
- Remove unnecessary repetitions
- Fix grammar and punctuation
- Improve clarity and readability while preserving the original meaning and intent exactly
- Keep the same language as the input — do NOT translate
- Keep the same tone and register (formal/informal) as the original
- Use the recent conversation history (provided as context) to better understand ambiguous words or references
- Return ONLY the refined text, no explanations, no quotes, no prefixes`;

// Hardcoded defaults — overridable via cl_settings table
const DEFAULT_LLM_ENDPOINT = 'https://resley-east-us-2-resource.openai.azure.com/openai/v1';
const DEFAULT_LLM_MODEL = 'gpt-5.4-mini';

let aiSettingsCache = null;
let aiSettingsCacheTime = 0;
const AI_SETTINGS_CACHE_TTL = 60_000; // 60s

async function loadAiSettings() {
  if (aiSettingsCache && Date.now() - aiSettingsCacheTime < AI_SETTINGS_CACHE_TTL) {
    return aiSettingsCache;
  }
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && supabaseKey) {
    try {
      const res = await fetch(`${supabaseUrl}/pg/rest/v1/cl_settings?key=eq.ai&select=value`, {
        headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` },
      });
      if (res.ok) {
        const rows = await res.json();
        if (rows.length > 0 && rows[0].value) {
          aiSettingsCache = rows[0].value;
          aiSettingsCacheTime = Date.now();
          return aiSettingsCache;
        }
      }
    } catch { /* fall through to defaults */ }
  }
  // No DB override — return empty (callLlm will use hardcoded defaults)
  aiSettingsCache = {};
  aiSettingsCacheTime = Date.now();
  return aiSettingsCache;
}

async function saveAiSettings(updates) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase not configured');

  const current = await loadAiSettings();
  const merged = { ...current, ...updates };

  await fetch(`${supabaseUrl}/pg/rest/v1/cl_settings`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      authorization: `Bearer ${supabaseKey}`,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key: 'ai', value: merged }),
  });

  aiSettingsCache = merged;
  aiSettingsCacheTime = Date.now();
}

// ── Relay Settings (CORS etc.) — persisted to cl_settings key='relay' ──

let relaySettingsCache = null;

async function loadRelaySettings() {
  if (relaySettingsCache) return relaySettingsCache;
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && supabaseKey) {
    try {
      const res = await fetch(`${supabaseUrl}/pg/rest/v1/cl_settings?key=eq.relay&select=value`, {
        headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` },
      });
      if (res.ok) {
        const rows = await res.json();
        if (rows.length > 0 && rows[0].value) {
          relaySettingsCache = rows[0].value;
          return relaySettingsCache;
        }
      }
    } catch { /* fall through to defaults */ }
  }
  relaySettingsCache = {};
  return relaySettingsCache;
}

async function saveRelaySettings(settings) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase not configured');

  await fetch(`${supabaseUrl}/pg/rest/v1/cl_settings`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      authorization: `Bearer ${supabaseKey}`,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key: 'relay', value: settings }),
  });

  relaySettingsCache = settings;
}

function buildFinalPrompt(globalPrompt, userPrompt) {
  const parts = [globalPrompt, userPrompt].filter(Boolean);
  return parts.join('\n\n');
}

async function callLlm(systemPrompt, messages, opts) {
  const settings = await loadAiSettings();

  // DB overrides > env vars > hardcoded defaults
  const endpoint = settings.llmEndpoint || DEFAULT_LLM_ENDPOINT;
  // Per-feature model override: suggestionModel / replyModel / voiceRefineModel > llmModel > default
  const model = (opts.type === 'suggestions' ? settings.suggestionModel : opts.type === 'reply' ? settings.replyModel : opts.type === 'voice-refine' ? settings.voiceRefineModel : null)
    || settings.llmModel || DEFAULT_LLM_MODEL;
  const apiKey = settings.llmApiKey || process.env.AZURE_OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('LLM API key not configured. Set AZURE_OPENAI_API_KEY env var or configure in Admin > AI Settings.');

  const llmMessages = [{ role: 'system', content: systemPrompt }];

  // Voice-refine uses more context (last 20); reply uses last 10; suggestions use last 6
  const contextLimit = opts.type === 'voice-refine' ? 20 : opts.type === 'reply' ? 10 : 6;
  for (const m of messages.slice(-contextLimit)) {
    llmMessages.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.text === 'string' ? m.text.slice(0, 300) : String(m.content || m.text || '').slice(0, 300),
    });
  }

  if (opts.type === 'voice-refine') {
    llmMessages.push({ role: 'user', content: `Refine this voice transcript:\n\n${opts.text}` });
  } else if (opts.type === 'suggestions') {
    llmMessages.push({ role: 'user', content: 'Based on the conversation above, generate 3-5 follow-up suggestions as a JSON array. Output ONLY the JSON array like ["suggestion1", "suggestion2", "suggestion3"], no other text.' });
  } else if (opts.type === 'reply') {
    llmMessages.push({ role: 'user', content: 'Draft a reply to the last assistant message above. Write from the user\'s perspective. Return ONLY the reply text.' });
  }

  // Azure OpenAI endpoint: detect /openai/v1 (new Foundry-style) vs legacy deployment path
  const endpointClean = endpoint.replace(/\/+$/, '');
  let url;
  if (endpointClean.includes('/openai/v1')) {
    // New Azure AI Foundry / openai/v1 style — append /chat/completions directly
    url = `${endpointClean}/chat/completions`;
  } else {
    // Legacy Azure deployment style
    const base = endpointClean.replace(/\/openai\/?$/, '');
    url = `${base}/openai/deployments/${model}/chat/completions?api-version=2025-01-01-preview`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({ model, messages: llmMessages, temperature: 0.7, max_completion_tokens: 512 }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM request failed: ${res.status} ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim() || '';

  if (opts.type === 'suggestions') {
    // Parse JSON array from response
    try {
      const match = content.match(/\[[\s\S]*\]/);
      if (!match) console.warn('[ai] suggestions: no JSON array in response:', content.slice(0, 200));
      return match ? JSON.parse(match[0]).filter(s => typeof s === 'string') : [];
    } catch (e) {
      console.warn('[ai] suggestions: JSON parse failed:', e.message, content.slice(0, 200));
      return [];
    }
  }

  // voice-refine: return plain text
  return content;
}

/** Auth check: allow admin token, Logto JWT, OR channel user token */
async function requireAuthAny(request, response, url) {
  // Try admin auth first
  const headerToken = normalizeNonEmpty(request.headers["x-relay-admin-token"]);
  const queryToken = normalizeNonEmpty(url.searchParams.get("adminToken"));
  if (safeCompare(headerToken, adminToken) || safeCompare(queryToken, adminToken)) return true;
  if (await verifyBearerToken(request)) return true;

  // Try channel user token
  const bearer = normalizeNonEmpty(request.headers["authorization"]?.replace(/^Bearer\s+/, ""));
  const token = queryToken || bearer;
  if (token) {
    let cfg;
    try {
      cfg = await relayStore.loadConfig();
    } catch (err) {
      console.error('[auth] loadConfig failed:', err.message);
      writeJson(response, 503, { ok: false, error: 'auth lookup unavailable' });
      return false;
    }
    if (Object.values(cfg?.channels || {}).some(ch => ch.users?.some(u => safeCompare(u.token, token)))) {
      return true;
    }
  }

  writeJson(response, 401, { ok: false, error: "auth required" });
  return false;
}

function maskSecret(value) {
  const secret = normalizeNonEmpty(value);
  if (!secret) {
    return "";
  }
  if (secret.length <= 8) {
    return `${secret.slice(0, 2)}***`;
  }
  return `${secret.slice(0, 4)}***${secret.slice(-4)}`;
}

function parseRequestUrl(requestUrl) {
  try {
    return new URL(requestUrl, "http://relay.local");
  } catch {
    return new URL("http://relay.local/");
  }
}

const CORS_HEADERS = {
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-relay-admin-token",
  "access-control-max-age": "86400",
};

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' wss: https://logto.dr.restry.cn https://*.openai.azure.com https://api.qrserver.com",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function getCorsHeaders(origin) {
  const headers = { ...CORS_HEADERS, ...SECURITY_HEADERS };
  if (origin && isOriginAllowed(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }
  return headers;
}

function writeJson(response, statusCode, payload) {
  const origin = response.req?.headers?.origin;
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", ...getCorsHeaders(origin) });
  response.end(JSON.stringify(payload));
}

function writeHtml(response, html) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  response.end(html);
}

function closeSocket(ws, code, reason) {
  if (!ws) return; // virtual/api connections have no real WS
  try {
    ws.close(code, reason);
  } catch {
    ws.terminate();
  }
}

function closeClientConnection(connectionId, code = 1000, reason = "closed") {
  const entry = realClients.get(connectionId);
  if (!entry) {
    return;
  }

  realClients.delete(connectionId);
  closeSocket(entry.ws, code, reason);
}

function closeBackendChannel(channelId, code = 1012, reason = "backend replaced") {
  const existing = backends.get(channelId);
  if (!existing) {
    return;
  }

  backends.delete(channelId);
  const presence = backendPresence.get(channelId) ?? {};
  backendPresence.set(channelId, {
    ...presence,
    instanceId: existing.instanceId,
    lastDisconnectedAt: Date.now(),
  });

  for (const [connectionId, client] of realClients.entries()) {
    if (client.channelId !== channelId) {
      continue;
    }
    realClients.delete(connectionId);
    closeSocket(client.ws, code, reason);
  }
  // Reject any in-flight API requests on this channel so callers fail fast.
  for (const [sid, sess] of apiSessions.entries()) {
    if (sess.channelId !== channelId) continue;
    rejectAllApiRequests(sess, `backend channel closed: ${reason}`);
    if (sess.idleTimer) clearTimeout(sess.idleTimer);
    apiSessions.delete(sid);
  }
  for (const [sid, w] of apiAgentListSessions.entries()) {
    if (w.channelId !== channelId) continue;
    try { w.reject(new Error(`backend channel closed: ${reason}`)); } catch {}
    if (w.timer) clearTimeout(w.timer);
    apiAgentListSessions.delete(sid);
  }
  closeSocket(existing.ws, code, reason);
}

function rejectAllApiRequests(sess, errMsg) {
  for (const [, req] of sess.requests) {
    try { req.reject(new Error(errMsg)); } catch {}
    if (req.timer) clearTimeout(req.timer);
  }
  sess.requests.clear();
}

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

async function loadRelayConfig() {
  relayConfig = await relayStore.loadConfig();

  if (!isRelayConfigEmpty(relayConfig)) {
    return;
  }

  try {
    const seedConfig = await loadSeedConfigFromEnv();
    if (!seedConfig) {
      return;
    }
    relayConfig = seedConfig;
    await relayStore.replaceConfig(relayConfig);
  } catch (error) {
    console.error("[relay] failed to parse RELAY_CHANNELS_JSON:", error);
  }
}

async function verifyBearerToken(request) {
  const auth = normalizeNonEmpty(request.headers["authorization"]);
  if (!auth || !auth.startsWith("Bearer ")) {
    return false;
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    return false;
  }
  try {
    await jwtVerify(token, jwks, {
      issuer: `${logtoEndpoint}/oidc`,
      audience: logtoResource,
    });
    return true;
  } catch {
    return false;
  }
}

async function requireAdmin(request, response, url) {
  // Legacy admin token (X-Relay-Admin-Token header or query param)
  const headerToken = normalizeNonEmpty(request.headers["x-relay-admin-token"]);
  const queryToken = normalizeNonEmpty(url.searchParams.get("adminToken"));
  if (safeCompare(headerToken, adminToken) || safeCompare(queryToken, adminToken)) {
    return true;
  }

  // Logto JWT Bearer token
  if (await verifyBearerToken(request)) {
    return true;
  }

  writeJson(response, 401, {
    ok: false,
    error: "admin auth required",
  });
  return false;
}

async function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1024 * 1024) {
        reject(new Error("payload too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

// ── Media helpers ──
function parseRawBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    request.on("data", (chunk) => {
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        reject(new Error("payload too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function inferMimeFromName(name) {
  const ext = "." + (name.split(".").pop() || "").toLowerCase();
  return MEDIA_MIME_MAP[ext] || "application/octet-stream";
}

function parseMultipart(buffer, boundary) {
  const str = buffer.toString("binary");
  const parts = str.split(`--${boundary}`);
  for (const part of parts) {
    if (part.trim() === "" || part.trim() === "--") continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.substring(0, headerEnd);
    if (!headers.includes("filename=")) continue;
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const ctMatch = headers.match(/Content-Type:\s*(\S+)/i);
    const body = part.substring(headerEnd + 4);
    // Remove trailing \r\n
    const cleanBody = body.endsWith("\r\n") ? body.slice(0, -2) : body;
    return {
      buffer: Buffer.from(cleanBody, "binary"),
      filename: filenameMatch?.[1] || "file",
      contentType: ctMatch?.[1] || null,
    };
  }
  return null;
}

function isClientInputError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error instanceof SyntaxError ||
    error.message === "payload too large" ||
    error.message.endsWith("is required")
  );
}

function writeRequestError(response, error) {
  const statusCode = isClientInputError(error) ? 400 : 500;
  if (statusCode === 500) {
    console.error("[relay] request failed:", error);
  }
  writeJson(response, statusCode, {
    ok: false,
    error: error instanceof Error ? error.message : "request failed",
  });
}

function getChannelConfig(channelId) {
  return relayConfig.channels[channelId];
}

function getClientCountByChannel(channelId) {
  let count = 0;
  for (const client of realClients.values()) {
    if (client.channelId === channelId) {
      count += 1;
    }
  }
  return count;
}

function serializeChannel(channel) {
  const backend = backends.get(channel.channelId);
  const presence = backendPresence.get(channel.channelId) ?? {};
  return {
    channelId: channel.channelId,
    label: channel.label,
    secret: channel.secret,
    secretMasked: maskSecret(channel.secret),
    tokenParam: channel.tokenParam ?? "token",
    userCount: channel.users.length,
    users: channel.users,
    backendConnected: Boolean(backend && backend.ws.readyState === WebSocket.OPEN),
    clientCount: getClientCountByChannel(channel.channelId),
    instanceId: backend?.instanceId ?? presence.instanceId,
    lastConnectedAt: presence.lastConnectedAt,
    lastDisconnectedAt: presence.lastDisconnectedAt,
  };
}

function listChannels() {
  return Object.values(relayConfig.channels)
    .sort((left, right) => left.channelId.localeCompare(right.channelId))
    .map((channel) => serializeChannel(channel));
}

function authenticateClientConnection(channelConfig, url) {
  if (!Array.isArray(channelConfig.users) || channelConfig.users.length === 0) {
    return { ok: true };
  }

  const tokenParam = channelConfig.tokenParam || "token";
  const token = normalizeNonEmpty(url.searchParams.get(tokenParam));
  if (!token) {
    return {
      ok: false,
      code: 1008,
      reason: `missing ${tokenParam}`,
    };
  }

  const authUser = channelConfig.users.find((user) => user.enabled !== false && safeCompare(user.token, token));
  if (!authUser) {
    return {
      ok: false,
      code: 1008,
      reason: "invalid token",
    };
  }

  const chatId = normalizeNonEmpty(url.searchParams.get("chatId"));
  if (authUser.chatId && chatId && authUser.chatId !== chatId) {
    return {
      ok: false,
      code: 1008,
      reason: "chatId does not match token binding",
    };
  }

  return {
    ok: true,
    authUser,
  };
}

function extractRelayQuery(channelConfig, url) {
  const tokenParam = channelConfig?.tokenParam || "token";
  return {
    rawQuery: url.search,
    channelId: normalizeNonEmpty(url.searchParams.get("channelId")),
    chatId: normalizeNonEmpty(url.searchParams.get("chatId")),
    agentId: normalizeNonEmpty(url.searchParams.get("agentId")),
    token: normalizeNonEmpty(url.searchParams.get(tokenParam)) ?? normalizeNonEmpty(url.searchParams.get("token")),
  };
}

backendWss.on("connection", (ws) => {
  let boundChannelId;
  let helloTimeout = setTimeout(() => {
    closeSocket(ws, 1008, "missing relay.backend.hello");
  }, 5000);

  ws.on("message", async (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      closeSocket(ws, 1003, "invalid json");
      return;
    }

    if (!boundChannelId) {
      if (frame?.type !== "relay.backend.hello") {
        closeSocket(ws, 1008, "expected relay.backend.hello");
        return;
      }

      const channelId = normalizeNonEmpty(frame.channelId);
      const secret = normalizeNonEmpty(frame.secret);
      const channelConfig = channelId ? getChannelConfig(channelId) : undefined;
      const expectedSecret = normalizeNonEmpty(channelConfig?.secret);

      if (!channelId || !expectedSecret || !secret || !safeCompare(secret, expectedSecret)) {
        sendJson(ws, {
          type: "relay.backend.error",
          message: "backend auth failed",
          timestamp: Date.now(),
        });
        closeSocket(ws, 1008, "backend auth failed");
        return;
      }

      clearTimeout(helloTimeout);
      helloTimeout = null;
      boundChannelId = channelId;

      closeBackendChannel(channelId, 1012, "backend replaced");
      backends.set(channelId, {
        ws,
        channelId,
        instanceId: normalizeNonEmpty(frame.instanceId),
      });
      backendPresence.set(channelId, {
        instanceId: normalizeNonEmpty(frame.instanceId),
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: undefined,
      });

      sendJson(ws, {
        type: "relay.backend.ack",
        channelId,
        timestamp: Date.now(),
      });
      console.log(`[relay] backend connected: ${channelId}`);
      return;
    }

    if (frame?.type === "relay.server.event") {
      const evtType = frame.event?.type || 'unknown';
      const evtThreadId = frame.event?.data?.threadId;
      console.log(`[relay] ← backend ${boundChannelId} sending event to client ${frame.connectionId}: ${evtType}${evtThreadId ? ` threadId=${evtThreadId}` : ''}`);

      // D1+D2: triage by destination type. Order matters — connectionId is unique
      // across all three maps (real WS uses UUID, api uses `api-…`, agentlist uses
      // `api-agentlist-…`), but explicit lookup is clearer than relying on prefixes.
      const real = realClients.get(frame.connectionId);
      if (real && real.channelId === boundChannelId) {
        // ── Auto-thread triggers (backend → real client) ──
        const evt = frame.event;
        const evtData = evt?.data || {};

        if (evt?.type === 'message.send' && !evtData.threadId) {
          const msgId = evtData.messageId || '';
          // Trigger 1: Subagent delegation — channel sets messageId starting with "delegate-"
          if (msgId.startsWith('delegate-') && evtData.agentId) {
            await autoCreateThread(
              boundChannelId, msgId, evtData.senderId || evtData.agentId,
              'auto', `Delegation → ${evtData.agentId}`
            );
          }
        }
        // Trigger 2: ACP thread discovery
        if (evtData.threadId) {
          const normalized = normalizeThreadId(evtData.threadId);
          if (normalized) ensureThreadKnown(boundChannelId, normalized);
        }

        await persistMessageAsync(boundChannelId, frame.event, 'outbound', real.userId);
        sendJson(real.ws, frame.event);
        if (real.chatId) {
          fanOut(boundChannelId, real.chatId, frame.event, frame.connectionId);
        }
        return;
      }

      const sess = apiSessions.get(frame.connectionId);
      if (sess && sess.channelId === boundChannelId) {
        const apiEvent = frame.event;
        if (apiEvent?.data && typeof apiEvent.data === 'object') {
          apiEvent.data = { ...apiEvent.data, meta: { source: 'api', ...(apiEvent.data.meta || {}) } };
        }

        // D3: route message.send strictly by replyTo. Agent missing replyTo = no
        // resolution, the caller's timer trips → 504. No FIFO fallback.
        // Inbound was already persisted + fanned out at /api/chat entry, so
        // here we only handle the outbound ack: persist outbound, fanOut to
        // siblings, resolve the waiting caller.
        let routedToCaller = false;
        if (apiEvent?.type === 'message.send') {
          const replyTo = apiEvent?.data?.replyTo;
          if (replyTo) {
            const req = sess.requests.get(replyTo);
            if (req) {
              await persistMessageAsync(boundChannelId, apiEvent, 'outbound', sess.userId);
              if (sess.chatId) {
                fanOut(boundChannelId, sess.chatId, apiEvent, frame.connectionId);
              }
              req.replyEvents.push(apiEvent);
              clearTimeout(req.timer);
              req.resolve(req.replyEvents);
              sess.requests.delete(replyTo);
              routedToCaller = true;
            }
          }
        }
        if (!routedToCaller) {
          // No matching caller (intermediate stream frame, or message.send without
          // replyTo, or unknown replyTo). Persist outbound + fan out so siblings
          // see whatever the agent emitted.
          await persistMessageAsync(boundChannelId, apiEvent, 'outbound', sess.userId);
          if (sess.chatId) {
            fanOut(boundChannelId, sess.chatId, apiEvent, frame.connectionId);
          }
        }
        return;
      }

      const waiter = apiAgentListSessions.get(frame.connectionId);
      if (waiter && waiter.channelId === boundChannelId) {
        const e = frame.event;
        if (e?.type === 'agent.list' && e?.data?.requestId === waiter.requestId) {
          clearTimeout(waiter.timer);
          waiter.resolve(e.data.agents || []);
          apiAgentListSessions.delete(frame.connectionId);
        }
        return;
      }

      // No live destination — persist for reconnect sync (lastSeen replay path).
      await persistMessageAsync(boundChannelId, frame.event, 'outbound', null);
      return;
    }

    if (frame?.type === "relay.server.persist") {
      console.log(`[relay] ← backend ${boundChannelId} persist-only: ${frame.event?.type || 'unknown'}`);
      await persistMessageAsync(boundChannelId, frame.event, 'outbound', frame.senderId || null);
      return;
    }

    if (frame?.type === "relay.server.reject") {
      const real = realClients.get(frame.connectionId);
      if (real && real.channelId === boundChannelId) {
        realClients.delete(frame.connectionId);
        closeSocket(real.ws, frame.code || 1008, frame.message || "rejected");
        return;
      }
      const sess = apiSessions.get(frame.connectionId);
      if (sess && sess.channelId === boundChannelId) {
        rejectAllApiRequests(sess, `agent rejected: ${frame.message || 'unknown'}`);
        if (sess.idleTimer) clearTimeout(sess.idleTimer);
        apiSessions.delete(frame.connectionId);
        return;
      }
      const waiter = apiAgentListSessions.get(frame.connectionId);
      if (waiter && waiter.channelId === boundChannelId) {
        clearTimeout(waiter.timer);
        try { waiter.reject(new Error(`agent rejected: ${frame.message || 'unknown'}`)); } catch {}
        apiAgentListSessions.delete(frame.connectionId);
      }
      return;
    }

    if (frame?.type === "relay.server.close") {
      const real = realClients.get(frame.connectionId);
      if (real && real.channelId === boundChannelId) {
        realClients.delete(frame.connectionId);
        closeSocket(real.ws, frame.code || 1000, frame.reason || "closed");
        return;
      }
      const sess = apiSessions.get(frame.connectionId);
      if (sess && sess.channelId === boundChannelId) {
        rejectAllApiRequests(sess, `agent closed: ${frame.reason || 'closed'}`);
        if (sess.idleTimer) clearTimeout(sess.idleTimer);
        apiSessions.delete(frame.connectionId);
        return;
      }
      const waiter = apiAgentListSessions.get(frame.connectionId);
      if (waiter && waiter.channelId === boundChannelId) {
        clearTimeout(waiter.timer);
        try { waiter.reject(new Error(`agent closed: ${frame.reason || 'closed'}`)); } catch {}
        apiAgentListSessions.delete(frame.connectionId);
      }
    }
  });

  ws.on("close", () => {
    if (helloTimeout) {
      clearTimeout(helloTimeout);
    }
    if (!boundChannelId) {
      return;
    }
    if (backends.get(boundChannelId)?.ws === ws) {
      backends.delete(boundChannelId);
    }
    const presence = backendPresence.get(boundChannelId) ?? {};
    backendPresence.set(boundChannelId, {
      ...presence,
      lastDisconnectedAt: Date.now(),
    });
    for (const [connectionId, client] of realClients.entries()) {
      if (client.channelId !== boundChannelId) {
        continue;
      }
      realClients.delete(connectionId);
      closeSocket(client.ws, 1012, "backend disconnected");
    }
    // D1+D2: drain in-flight API state for this channel.
    for (const [sid, sess] of apiSessions.entries()) {
      if (sess.channelId !== boundChannelId) continue;
      rejectAllApiRequests(sess, 'backend disconnected');
      if (sess.idleTimer) clearTimeout(sess.idleTimer);
      apiSessions.delete(sid);
    }
    for (const [sid, w] of apiAgentListSessions.entries()) {
      if (w.channelId !== boundChannelId) continue;
      try { w.reject(new Error('backend disconnected')); } catch {}
      if (w.timer) clearTimeout(w.timer);
      apiAgentListSessions.delete(sid);
    }
    console.log(`[relay] backend disconnected: ${boundChannelId}`);
  });

  ws.on("error", (error) => {
    console.error("[relay] backend socket error:", error);
  });
});

/**
 * ADD-BACK #6: replay outbound rows the client missed while disconnected.
 *
 * Client passes lastSeenMessageId on connect; we look up that row's
 * timestamp and replay every outbound row for the same chatId after it,
 * emitting them as message.send frames straight to the new socket.
 *
 * Best-effort: failures are logged and dropped. Cap replay at 200 rows
 * to bound startup time on long-disconnected clients.
 */
async function resendOutboundSinceLastSeen(channelId, chatId, lastSeenMessageId, ws) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !lastSeenMessageId) return;

  const headers = { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` };

  const anchorRes = await fetch(
    `${supabaseUrl}/pg/rest/v1/cl_messages?channel_id=eq.${encodeURIComponent(channelId)}&message_id=eq.${encodeURIComponent(lastSeenMessageId)}&select=timestamp&limit=1`,
    { headers }
  );
  if (!anchorRes.ok) return;
  const anchorRows = await anchorRes.json();
  if (!Array.isArray(anchorRows) || anchorRows.length === 0) return;
  const anchorTs = anchorRows[0].timestamp;

  const rowsRes = await fetch(
    `${supabaseUrl}/pg/rest/v1/cl_messages?channel_id=eq.${encodeURIComponent(channelId)}` +
      `&direction=eq.outbound` +
      `&timestamp=gt.${encodeURIComponent(anchorTs)}` +
      `&select=message_id,sender_id,agent_id,content,content_type,thread_id,parent_id,timestamp,meta` +
      `&order=timestamp.asc&limit=200`,
    { headers }
  );
  if (!rowsRes.ok) return;
  const rows = await rowsRes.json();
  if (!Array.isArray(rows) || rows.length === 0) return;

  console.log(`[resync] replaying ${rows.length} outbound rows for ${chatId} after ${lastSeenMessageId}`);
  for (const r of rows) {
    if (ws.readyState !== WebSocket.OPEN) break;
    sendJson(ws, {
      type: 'message.send',
      data: {
        messageId: r.message_id,
        chatId,
        senderId: r.sender_id,
        agentId: r.agent_id,
        content: r.content,
        contentType: r.content_type,
        threadId: r.thread_id || undefined,
        replyTo: r.parent_id || undefined,
        timestamp: r.timestamp,
        meta: r.meta ? (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta) : undefined,
        resync: true,
      },
    });
  }
}

clientWss.on("connection", (ws, request) => {
  const url = parseRequestUrl(request.url || "/");
  const channelId = normalizeNonEmpty(url.searchParams.get("channelId"));
  if (!channelId) {
    closeSocket(ws, 1008, "missing channelId");
    return;
  }

  const channelConfig = getChannelConfig(channelId);
  if (!channelConfig) {
    closeSocket(ws, 1008, "unknown channelId");
    return;
  }

  const backend = backends.get(channelId);
  if (!backend || backend.ws.readyState !== WebSocket.OPEN) {
    closeSocket(ws, 1013, "backend unavailable");
    return;
  }

  const authResult = authenticateClientConnection(channelConfig, url);
  if (!authResult.ok) {
    closeSocket(ws, authResult.code, authResult.reason);
    return;
  }

  const connectionId = randomUUID();
  const query = extractRelayQuery(channelConfig, url);
  const clientRateBucket = { tokens: WS_MSG_RATE_LIMIT, lastRefill: Date.now() };

  realClients.set(connectionId, {
    ws,
    channelId,
    chatId: query.chatId || '',
    userId: authResult.authUser?.senderId,
  });

  sendJson(backend.ws, {
    type: "relay.client.open",
    connectionId,
    query,
    authUser: authResult.authUser,
    timestamp: Date.now(),
  });

  // ADD-BACK #6: lastSeenMessageId resync. If the client passed
  // lastSeenMessageId on the query, replay outbound rows persisted while it
  // was offline. Single SQL: select rows for this chatId after the row
  // matching lastSeenMessageId, ordered by timestamp.
  const lastSeenMessageId = normalizeNonEmpty(url.searchParams.get('lastSeenMessageId'));
  if (lastSeenMessageId && query.chatId) {
    resendOutboundSinceLastSeen(channelId, query.chatId, lastSeenMessageId, ws)
      .catch((err) => console.warn('[resync] lastSeen resend failed:', err.message));
  }

  ws.on("message", async (raw) => {
    if (!checkWsMsgRateLimit(clientRateBucket)) {
      closeClientConnection(connectionId, 1008, "rate limit exceeded");
      return;
    }
    const currentBackend = backends.get(channelId);
    if (!currentBackend || currentBackend.ws.readyState !== WebSocket.OPEN) {
      closeClientConnection(connectionId, 1012, "backend unavailable");
      return;
    }

    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      closeClientConnection(connectionId, 1003, "invalid json");
      return;
    }

    // Respond to client heartbeat pings directly (don't forward to backend)
    if (event?.type === 'ping') {
      sendJson(ws, { type: 'pong', data: { timestamp: Date.now() } });
      return;
    }

    // Handle thread events directly in gateway (requires Supabase access)
    if (event?.type === 'thread.create') {
      handleThreadCreate(connectionId, channelId, event.data || {}, authResult.authUser?.senderId);
      return;
    }
    if (event?.type === 'thread.get') {
      handleThreadGet(connectionId, channelId, event.data || {}, authResult.authUser?.senderId);
      return;
    }
    if (event?.type === 'thread.list') {
      handleThreadList(connectionId, channelId, event.data || {}, authResult.authUser?.senderId);
      return;
    }
    if (event?.type === 'thread.update') {
      handleThreadUpdate(connectionId, channelId, event.data || {}, authResult.authUser?.senderId);
      return;
    }
    if (event?.type === 'thread.delete') {
      handleThreadDelete(connectionId, channelId, event.data || {}, authResult.authUser?.senderId);
      return;
    }
    if (event?.type === 'thread.mark_read') {
      handleThreadMarkRead(connectionId, channelId, event.data || {}, authResult.authUser?.senderId);
      return;
    }
    if (event?.type === 'thread.search') {
      handleThreadSearch(connectionId, channelId, event.data || {}, authResult.authUser?.senderId);
      return;
    }

    console.log(`[relay] → forwarding client event to backend ${channelId}: ${event?.type || 'unknown'}`);

    // Validate message.receive payload at the boundary (G-45). Without this, malformed
    // events were persisted + broadcast first, then rejected by backend — leaking
    // garbage into cl_messages and to sibling clients.
    if (event?.type === 'message.receive') {
      const d = event.data || {};
      const VALID_MESSAGE_TYPES = ['text', 'image', 'voice', 'audio', 'file'];
      const errors = [];
      if (typeof d.content !== 'string' || d.content.length === 0) errors.push('content is required (non-empty string)');
      if (d.messageType && !VALID_MESSAGE_TYPES.includes(d.messageType)) errors.push(`messageType must be one of ${VALID_MESSAGE_TYPES.join(',')}`);
      // messageType is optional only if the channel infers it; default to 'text' here for back-compat.
      if (!d.messageType) d.messageType = 'text';
      if (errors.length) {
        sendJson(ws, {
          type: 'error',
          data: { code: 'INVALID_PAYLOAD', message: 'Invalid payload for message.receive', details: errors },
        });
        return;
      }
    }

    // ── Auto-thread trigger: @mention detection (client → backend) ──
    // D5: removed lastUserMessageId tracking + thread reply auto-routing.
    // @mention now only creates the thread; user must explicitly reply inside
    // the thread (with threadId on the message) to address the agent there.
    if (event?.type === 'message.receive' && !event.data?.threadId) {
      const content = event.data?.content || event.data?.text || '';
      // Match @word at start of string or after whitespace — excludes emails (user@domain)
      const mentionMatch = content.match(/(^|\s)@(\w+)/);
      if (mentionMatch) {
        const mentionedName = mentionMatch[2];
        const msgId = event.data?.messageId || `mention-${randomUUID()}`;
        if (!event.data.messageId) event.data.messageId = msgId;
        // Create thread with this message as parent — do NOT set threadId on the message itself,
        // because parent messages must stay in the main chat (no threadId).
        await autoCreateThread(
          channelId, msgId, authResult.authUser?.senderId,
          'mention', `@${mentionedName}`
        );
      }
    }
    // ── End @mention trigger ──

    // Inbound persistence invariant (REL-06): persist + fan-out the user's
    // message immediately on accept. Independent of whether the agent later
    // replies. If DB write fails, refuse the message with an error event so
    // the client can retry — never silently forward an unpersisted message.
    if (event?.type === 'message.receive') {
      const senderId = authResult.authUser?.senderId;
      const inboundPersisted = await persistMessageAsync(
        channelId, event, 'inbound', senderId
      );
      if (!inboundPersisted) {
        sendJson(ws, {
          type: 'error',
          data: { code: 'PERSIST_FAILED', message: 'failed to persist inbound message' },
        });
        return;
      }
      const real = realClients.get(connectionId);
      if (real?.chatId) {
        fanOut(
          channelId, real.chatId,
          { type: 'message.send', data: { ...event.data, echo: true } },
          connectionId,
        );
      }
    }

    sendJson(currentBackend.ws, {
      type: "relay.client.event",
      connectionId,
      event,
      timestamp: Date.now(),
    });
  });

  ws.on("close", (code, reason) => {
    realClients.delete(connectionId);
    const currentBackend = backends.get(channelId);
    if (!currentBackend || currentBackend.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    sendJson(currentBackend.ws, {
      type: "relay.client.close",
      connectionId,
      code,
      reason: reason.toString(),
      timestamp: Date.now(),
    });
  });

  ws.on("error", (error) => {
    console.error("[relay] client socket error:", error);
  });
});

async function handleAdminState(response) {
  writeJson(response, 200, {
    ok: true,
    configPath,
    adminAuthEnabled: Boolean(adminToken),
    publicBaseUrl,
    pluginBackendUrl,
    channels: listChannels(),
    stats: {
      backendCount: backends.size,
      clientCount: realClients.size,
    },
    timestamp: Date.now(),
  });
}

/**
 * GET /api/agents — return all agents across all channels with online status + metadata.
 * Requires admin auth. Fetches live agent.list from each connected backend (parallel, 5s timeout).
 */
async function handleAgentList(response) {
  const channels = listChannels();

  // For each channel, if backend is connected, request agent.list.get and wait for response.
  const results = await Promise.all(
    channels.map(async (ch) => {
      const base = {
        channelId: ch.channelId,
        label: ch.label || ch.channelId,
        backendConnected: ch.backendConnected,
        instanceId: ch.instanceId,
        lastConnectedAt: ch.lastConnectedAt,
        lastDisconnectedAt: ch.lastDisconnectedAt,
        agents: [],
      };

      if (!ch.backendConnected) return base;

      const backend = backends.get(ch.channelId);
      if (!backend || backend.ws.readyState !== 1 /* OPEN */) return base;

      // D2: dedicated apiAgentListSessions map — agent.list isn't a message path,
      // doesn't pool, and never receives replyTo. Keeping it out of apiSessions
      // keeps both data structures small and single-purpose.
      const virtualConnId = `api-agentlist-${randomUUID()}`;
      const requestId = `agentlist-${Date.now()}`;

      try {
        const agents = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            apiAgentListSessions.delete(virtualConnId);
            reject(new Error('timeout'));
          }, 5000);

          apiAgentListSessions.set(virtualConnId, {
            channelId: ch.channelId,
            requestId,
            resolve,
            reject,
            timer,
          });

          // Open virtual connection to backend
          sendJson(backend.ws, {
            type: 'relay.client.open',
            connectionId: virtualConnId,
            query: { chatId: 'api-agentlist', agentId: null, token: null },
            authUser: { senderId: 'api', chatId: 'api-agentlist' },
            timestamp: Date.now(),
          });

          // Small delay then send agent.list.get
          setTimeout(() => {
            sendJson(backend.ws, {
              type: 'relay.client.event',
              connectionId: virtualConnId,
              event: { type: 'agent.list.get', data: { requestId } },
              timestamp: Date.now(),
            });
          }, 50);
        });

        return { ...base, agents };
      } catch {
        return { ...base, agents: [], error: 'agent list fetch failed or timed out' };
      } finally {
        apiAgentListSessions.delete(virtualConnId);
        // Close virtual connection on backend
        if (backend.ws.readyState === 1) {
          sendJson(backend.ws, {
            type: 'relay.client.close',
            connectionId: virtualConnId,
            code: 1000,
            reason: 'api agentlist done',
            timestamp: Date.now(),
          });
        }
      }
    })
  );

  writeJson(response, 200, {
    ok: true,
    timestamp: Date.now(),
    channels: results,
  });
}

async function handlePublicMeta(response) {
  writeJson(response, 200, {
    ok: true,
    adminAuthEnabled: Boolean(adminToken),
    publicBaseUrl,
    pluginBackendUrl,
    timestamp: Date.now(),
  });
}

async function handleUpsertChannel(request, response) {
  const body = await parseJsonBody(request);
  const channelId = normalizeNonEmpty(body.channelId);
  if (!channelId) {
    writeJson(response, 400, { ok: false, error: "channelId is required" });
    return;
  }

  const existing = getChannelConfig(channelId);
  const next = normalizeChannelRecord(channelId, body, existing);
  await relayStore.upsertChannel(next);
  relayConfig.channels[channelId] = next;

  writeJson(response, 200, {
    ok: true,
    channel: serializeChannel(next),
  });
}

async function handleDeleteChannel(response, channelId) {
  if (!getChannelConfig(channelId)) {
    writeJson(response, 404, { ok: false, error: "channel not found" });
    return;
  }

  const deleted = await relayStore.deleteChannel(channelId);
  if (!deleted) {
    writeJson(response, 404, { ok: false, error: "channel not found" });
    return;
  }
  closeBackendChannel(channelId, 1012, "channel removed");
  backendPresence.delete(channelId);
  delete relayConfig.channels[channelId];

  writeJson(response, 200, {
    ok: true,
    channelId,
  });
}

async function handleUpsertUser(request, response, channelId) {
  const channel = getChannelConfig(channelId);
  if (!channel) {
    writeJson(response, 404, { ok: false, error: "channel not found" });
    return;
  }

  const body = await parseJsonBody(request);
  const senderId = normalizeNonEmpty(body.senderId);
  if (!senderId) {
    writeJson(response, 400, { ok: false, error: "senderId is required" });
    return;
  }

  const existingIndex = channel.users.findIndex((user) => user.senderId === senderId);
  const existingUser = existingIndex >= 0 ? channel.users[existingIndex] : undefined;
  const nextUser = normalizeUserRecord(body, existingUser);

  await relayStore.upsertUser(channelId, nextUser);

  if (existingIndex >= 0) {
    channel.users[existingIndex] = nextUser;
  } else {
    channel.users.push(nextUser);
  }

  writeJson(response, 200, {
    ok: true,
    channel: serializeChannel(channel),
    user: nextUser,
  });
}

async function handleDeleteUser(response, channelId, senderId) {
  const channel = getChannelConfig(channelId);
  if (!channel) {
    writeJson(response, 404, { ok: false, error: "channel not found" });
    return;
  }

  const nextUsers = channel.users.filter((user) => user.senderId !== senderId);
  if (nextUsers.length === channel.users.length) {
    writeJson(response, 404, { ok: false, error: "user not found" });
    return;
  }

  const deleted = await relayStore.deleteUser(channelId, senderId);
  if (!deleted) {
    writeJson(response, 404, { ok: false, error: "user not found" });
    return;
  }
  channel.users = nextUsers;

  writeJson(response, 200, {
    ok: true,
    channel: serializeChannel(channel),
    senderId,
  });
}

server.on("request", async (request, response) => {
  const url = parseRequestUrl(request.url || "/");
  const pathname = url.pathname;

  // CORS preflight
  if (request.method === "OPTIONS") {
    const origin = request.headers.origin;
    response.writeHead(204, getCorsHeaders(origin));
    response.end();
    return;
  }

  // Per-IP HTTP rate limiting
  const clientIp = request.headers["x-forwarded-for"]?.split(",")[0]?.trim() || request.socket.remoteAddress;
  if (!checkHttpRateLimit(clientIp)) {
    writeJson(response, 429, { ok: false, error: "rate limit exceeded" });
    return;
  }

  if (pathname === "/healthz") {
    writeJson(response, 200, {
      ok: true,
      backendCount: backends.size,
      clientCount: realClients.size,
      channels: listChannels().map((channel) => ({
        channelId: channel.channelId,
        label: channel.label,
        backendConnected: channel.backendConnected,
        clientCount: channel.clientCount,
        instanceId: channel.instanceId,
      })),
      timestamp: Date.now(),
    });
    return;
  }

  if (pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (pathname === "/" || pathname === "/admin" || pathname === "/callback") {
    try {
      const html = await readFile(join(publicDir, "index.html"), "utf8");
      writeHtml(response, html);
    } catch (error) {
      console.error("[relay] failed to read admin page:", error);
      writeJson(response, 500, { ok: false, error: "failed to load admin page" });
    }
    return;
  }

  if (pathname === "/api/state") {
    if (!(await requireAdmin(request, response, url))) {
      return;
    }
    await handleAdminState(response);
    return;
  }

  // ── Settings API (admin) — persisted to cl_settings key='relay' ──
  if (pathname === "/api/settings" && request.method === "GET") {
    if (!(await requireAdmin(request, response, url))) return;
    const relaySettings = await loadRelaySettings();
    writeJson(response, 200, {
      ok: true,
      settings: relaySettings,
      _env: { CORS_ALLOWED_ORIGINS: envCorsOrigins },
    });
    return;
  }

  if (pathname === "/api/settings" && request.method === "PUT") {
    if (!(await requireAdmin(request, response, url))) return;
    try {
      const body = JSON.parse(await parseRawBody(request, 64 * 1024));
      const current = await loadRelaySettings();
      // Merge CORS settings
      if (body.corsAllowedOrigins !== undefined) {
        current.corsAllowedOrigins = Array.isArray(body.corsAllowedOrigins)
          ? body.corsAllowedOrigins.map(o => String(o).trim()).filter(Boolean)
          : [];
      }
      await saveRelaySettings(current);
      writeJson(response, 200, { ok: true, settings: current });
    } catch (err) {
      writeJson(response, 400, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  // ── AI Settings API (admin) ──

  if (pathname === "/api/ai-settings" && request.method === "GET") {
    if (!(await requireAdmin(request, response, url))) return;
    try {
      const settings = await loadAiSettings();
      writeJson(response, 200, {
        ok: true,
        llmEndpoint: settings.llmEndpoint || DEFAULT_LLM_ENDPOINT,
        llmApiKey: settings.llmApiKey ? '***configured***' : '',
        llmModel: settings.llmModel || DEFAULT_LLM_MODEL,
        suggestionModel: settings.suggestionModel || '',
        replyModel: settings.replyModel || '',
        replyPrompt: settings.replyPrompt || '',
        voiceRefineModel: settings.voiceRefineModel || '',
        suggestionPrompt: settings.suggestionPrompt || '',
        voiceRefinePrompt: settings.voiceRefinePrompt || '',
      });
    } catch (err) {
      writeJson(response, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (pathname === "/api/ai-settings" && request.method === "PUT") {
    if (!(await requireAdmin(request, response, url))) return;
    try {
      const body = JSON.parse(await parseRawBody(request, 64 * 1024));
      // Don't overwrite llmApiKey if the client sent back the masked placeholder
      if (body.llmApiKey === '***configured***') delete body.llmApiKey;
      await saveAiSettings(body);
      writeJson(response, 200, { ok: true });
    } catch (err) {
      writeJson(response, 400, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  // ── GET /api/messages — message log viewer ──

  if (pathname === "/api/messages" && request.method === "GET") {
    if (!(await requireAdmin(request, response, url))) return;
    const supabaseUrl = process.env.RELAY_SUPABASE_URL;
    const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      writeJson(response, 200, { ok: true, messages: [], total: 0 });
      return;
    }
    try {
      const channelId = url.searchParams.get('channelId') || '';
      const direction = url.searchParams.get('direction') || '';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      const offset = Number(url.searchParams.get('offset')) || 0;

      let filter = `select=id,channel_id,sender_id,agent_id,message_id,content,content_type,direction,media_url,meta,timestamp,created_at&order=timestamp.desc&limit=${limit}&offset=${offset}`;
      if (channelId) filter += `&channel_id=eq.${encodeURIComponent(channelId)}`;
      if (direction === 'inbound' || direction === 'outbound') filter += `&direction=eq.${direction}`;

      const res = await fetch(`${supabaseUrl}/pg/rest/v1/cl_messages?${filter}`, {
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
          prefer: 'count=exact',
        },
      });
      const rows = await res.json();
      const total = Number(res.headers.get('content-range')?.split('/')?.[1] || rows.length);
      writeJson(response, 200, { ok: true, messages: rows, total });
    } catch (err) {
      writeJson(response, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  // ── GET /api/messages/stats — aggregated stats for charts ──

  if (pathname === "/api/messages/stats" && request.method === "GET") {
    if (!(await requireAdmin(request, response, url))) return;
    const supabaseUrl = process.env.RELAY_SUPABASE_URL;
    const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      writeJson(response, 200, { ok: true, hourly: [], models: [], channels: [] });
      return;
    }
    try {
      const headers = { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` };
      // Fetch last 500 messages for stats (covers ~24h for active channels)
      const res = await fetch(`${supabaseUrl}/pg/rest/v1/cl_messages?select=channel_id,direction,content_type,meta,timestamp&order=timestamp.desc&limit=500`, { headers });
      const rows = await res.json();

      // Hourly message counts (last 24h, bucketed by hour)
      const now = Date.now();
      const hourMs = 3600000;
      const hourly = [];
      for (let i = 23; i >= 0; i--) {
        const start = now - (i + 1) * hourMs;
        const end = now - i * hourMs;
        const inH = rows.filter(r => r.timestamp >= start && r.timestamp < end);
        hourly.push({
          hour: new Date(end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }),
          inbound: inH.filter(r => r.direction === 'inbound').length,
          outbound: inH.filter(r => r.direction === 'outbound').length,
        });
      }

      // Model usage (from meta.model on outbound messages)
      const modelCounts = {};
      for (const r of rows) {
        if (r.direction !== 'outbound') continue;
        let model = null;
        try { model = typeof r.meta === 'string' ? JSON.parse(r.meta)?.model : r.meta?.model; } catch { /* skip */ }
        if (model) modelCounts[model] = (modelCounts[model] || 0) + 1;
      }
      const models = Object.entries(modelCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      // Per-channel counts
      const channelCounts = {};
      for (const r of rows) {
        const key = r.channel_id;
        if (!channelCounts[key]) channelCounts[key] = { inbound: 0, outbound: 0 };
        channelCounts[key][r.direction === 'inbound' ? 'inbound' : 'outbound']++;
      }
      const channels = Object.entries(channelCounts)
        .map(([name, c]) => ({ name, ...c }))
        .sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound));

      writeJson(response, 200, { ok: true, hourly, models, channels });
    } catch (err) {
      writeJson(response, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  // ── GET /api/messages/sync — pull missed messages since timestamp (for offline clients) ──
  // Supports both forward sync (after=TS) and backward pagination (before=TS)
  // Optional agentId filter for agent-scoped history

  if (pathname === "/api/messages/sync" && request.method === "GET") {
    if (!(await requireAuthAny(request, response, url))) return;
    const supabaseUrl = process.env.RELAY_SUPABASE_URL;
    const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      writeJson(response, 200, { ok: true, messages: [] });
      return;
    }
    try {
      const channelId = url.searchParams.get('channelId') || '';
      const after = Number(url.searchParams.get('after')) || 0;
      const before = Number(url.searchParams.get('before')) || 0;
      const agentId = url.searchParams.get('agentId') || '';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);

      if (!channelId) {
        writeJson(response, 400, { ok: false, error: 'channelId required' });
        return;
      }

      const SAFE_ID_RE = /^[a-zA-Z0-9._-]+$/;
      if (!SAFE_ID_RE.test(channelId)) {
        writeJson(response, 400, { ok: false, error: 'invalid channelId' });
        return;
      }
      if (agentId && !SAFE_ID_RE.test(agentId)) {
        writeJson(response, 400, { ok: false, error: 'invalid agentId' });
        return;
      }

      // Build PostgREST query
      // When 'before' is provided, fetch newest messages before that timestamp (desc order).
      // When 'after' is provided, fetch oldest messages after that timestamp (asc order).
      const isPagingBack = before > 0 && !after;
      let filter = `select=id,channel_id,sender_id,agent_id,message_id,content,content_type,direction,media_url,thread_id,meta,timestamp`;
      filter += `&order=timestamp.${isPagingBack ? 'desc' : 'asc'}&limit=${limit}`;
      filter += `&channel_id=eq.${encodeURIComponent(channelId)}`;
      if (after > 0) filter += `&timestamp=gt.${after}`;
      if (before > 0) filter += `&timestamp=lt.${before}`;
      if (agentId) filter += `&agent_id=eq.${encodeURIComponent(agentId)}`;

      const res = await fetch(`${supabaseUrl}/pg/rest/v1/cl_messages?${filter}`, {
        headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` },
      });
      let rows = await res.json();
      // When paging backward (desc order), reverse to chronological for the client
      if (isPagingBack && Array.isArray(rows)) rows = rows.reverse();
      const hasMore = Array.isArray(rows) && rows.length >= limit;
      writeJson(response, 200, { ok: true, messages: rows, hasMore });
    } catch (err) {
      writeJson(response, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  // ── POST /api/suggestions — AI-powered follow-up suggestions ──

  if (pathname === "/api/suggestions" && request.method === "POST") {
    if (!(await requireAuthAny(request, response, url))) return;
    try {
      const body = JSON.parse(await parseRawBody(request, 128 * 1024));
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      const mode = body.mode === 'reply' ? 'reply' : 'suggestions';

      const settings = await loadAiSettings();

      if (mode === 'reply') {
        const systemPrompt = buildFinalPrompt(settings.replyPrompt || DEFAULT_REPLY_DRAFT_PROMPT, userPrompt);
        const reply = await callLlm(systemPrompt, messages, { type: 'reply' });
        writeJson(response, 200, { ok: true, mode: 'reply', reply });
      } else {
        const systemPrompt = buildFinalPrompt(
          settings.suggestionPrompt || DEFAULT_SUGGESTION_PROMPT,
          userPrompt,
        );
        const suggestions = await callLlm(systemPrompt, messages, { type: 'suggestions' });
        writeJson(response, 200, { ok: true, mode: 'suggestions', suggestions });
      }
    } catch (err) {
      writeJson(response, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  // ── POST /api/chat — direct API chat (HTTP, no WS needed) ──
  // Injects a virtual connection into the channel, sends the message, and waits for agent reply.
  // Both inbound and outbound messages are persisted with meta.source="api".

  if (pathname === "/api/chat" && request.method === "POST") {
    if (!(await requireAuthAny(request, response, url))) return;
    try {
      const body = JSON.parse(await parseRawBody(request, 128 * 1024));
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
      const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : undefined;
      const senderId = typeof body.senderId === 'string' ? body.senderId.trim() : 'api';

      // chatId resolution:
      // 1. Explicit chatId in request body → use as-is
      // 2. Fallback → senderId
      //
      // NOTE: We no longer borrow chatId from a live WS connection. That pattern caused the
      // virtual API connection to be registered under a different chatId than senderId, breaking
      // the `user:<senderId>` routing that bot.ts uses to deliver outbound replies. All parts of
      // the API path (relay.client.open, inboundEvent, history) must agree on the same chatId so
      // that history.sync returns both inbound and outbound messages together.
      const chatId = (typeof body.chatId === 'string' && body.chatId.trim()) ? body.chatId.trim() : senderId;

      if (!message) {
        writeJson(response, 400, { ok: false, error: 'message is required' });
        return;
      }
      if (!channelId) {
        writeJson(response, 400, { ok: false, error: 'channelId is required' });
        return;
      }
      if (!agentId) {
        writeJson(response, 400, { ok: false, error: 'agentId is required' });
        return;
      }

      const backend = backends.get(channelId);
      if (!backend || backend.ws.readyState !== 1 /* WebSocket.OPEN */) {
        writeJson(response, 503, { ok: false, error: 'channel backend not connected' });
        return;
      }

      // Timeout: priority is body.timeout > query.timeout > env > default 300s.
      // Clamped to [5s, 600s] to prevent silly values + abuse (P0-β).
      const DEFAULT_TIMEOUT_MS = parseInt(process.env.RELAY_API_CHAT_TIMEOUT_MS || '300000', 10);
      const MAX_TIMEOUT_MS = 600_000;
      const MIN_TIMEOUT_MS = 5_000;
      const requestedTimeout = parseInt(body.timeout, 10) || parseInt(url.searchParams.get('timeout'), 10) || DEFAULT_TIMEOUT_MS;
      const TIMEOUT_MS = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, requestedTimeout));
      const POOL_IDLE_MS = 5 * 60_000; // 5 min keep-alive

      // Stable sessionId derived from channel+chat+agent so the same conversation
      // with the same agent reuses the same backend connection, preserving agent
      // context across multiple API calls. agentId is included to avoid cross-agent
      // connection sharing: if multiple agents on the same channel receive parallel
      // API calls, they must each have their own session so that channel-side agent
      // isolation does not buffer/discard replies.
      //
      // D1+D2: pooled apiSessions per (channelId, chatId, agentId).
      // sessionId is the same value we send to the backend as connectionId, so
      // routeBackendEvent's apiSessions.get(frame.connectionId) works directly.
      const sessionId = `api-${channelId}-${chatId}-${agentId}`;
      // ADD-BACK #5: caller-provided messageId. Falls back to a generated one
      // if caller didn't pass one. Same id is used as inbound messageId AND
      // backend replyTo key, so caller can retry/idempotency-check with it.
      const messageId = (typeof body.messageId === 'string' && body.messageId.trim())
        ? body.messageId.trim()
        : `api-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const ts = Date.now();

      // Atomic claim — synchronous get-then-set with no awaits between, so
      // concurrent requests on the same sessionId either reuse an existing
      // session or all observe the same just-created one (no last-writer-wins).
      let sess = apiSessions.get(sessionId);
      let isNewSession = false;
      if (!sess) {
        sess = {
          sessionId,
          channelId,
          chatId,
          agentId,
          userId: senderId,
          requests: new Map(),
          idleTimer: null,
          opening: null, // Promise resolved once relay.client.open + 50ms settle is done
        };
        apiSessions.set(sessionId, sess);
        isNewSession = true;
      }
      if (sess.idleTimer) {
        clearTimeout(sess.idleTimer);
        sess.idleTimer = null;
      }

      // Optional: route the message into a specific thread. If provided, validate it
      // exists + belongs to this channel; otherwise return 400. We do NOT silently
      // fall back to main chat — caller asked for a thread, getting silent re-routing
      // would be surprising (TH-2).
      const requestedThreadId = (typeof body.threadId === 'string' && body.threadId.trim())
        ? body.threadId.trim()
        : (url.searchParams.get('threadId') || '').trim() || null;
      if (requestedThreadId) {
        const supabaseUrl = process.env.RELAY_SUPABASE_URL;
        const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !supabaseKey) {
          writeJson(response, 503, { ok: false, error: 'thread persistence not configured' });
          return;
        }
        try {
          const tRes = await fetch(
            `${supabaseUrl}/pg/rest/v1/cl_threads?id=eq.${encodeURIComponent(requestedThreadId)}&channel_id=eq.${encodeURIComponent(channelId)}&select=id,status&limit=1`,
            { headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` } }
          );
          const rows = await tRes.json();
          if (!Array.isArray(rows) || rows.length === 0) {
            writeJson(response, 400, { ok: false, error: `threadId not found in channel ${channelId}` });
            return;
          }
          if (rows[0].status === 'deleted') {
            writeJson(response, 400, { ok: false, error: 'threadId is deleted' });
            return;
          }
        } catch (err) {
          writeJson(response, 500, { ok: false, error: `thread lookup failed: ${err.message || err}` });
          return;
        }
      }

      // Build inbound event with source:"api" marker
      const inboundEvent = {
        type: 'message.receive',
        data: {
          messageId,
          chatId,
          chatType: 'direct',
          senderId,
          senderName: body.senderName || senderId,
          agentId,  // required — validated above
          messageType: 'text',
          content: message,
          timestamp: ts,
          ...(requestedThreadId ? { threadId: requestedThreadId } : {}),
          meta: { source: 'api' },
        },
      };

      // ADD-BACK #7: idempotency check. If we already saw this messageId and
      // have an outbound reply, return the cached reply with HTTP 200.
      // If inbound exists but no outbound yet, return 409 (caller can retry).
      const idem = await checkIdempotency(channelId, messageId);
      if (idem?.kind === 'cached') {
        writeJson(response, 200, {
          ok: true,
          messageId: idem.outbound.message_id,
          inboundMessageId: messageId,
          content: idem.outbound.content || '',
          agentId: idem.outbound.agent_id || agentId || null,
          chatId,
          timestamp: idem.outbound.timestamp || Date.now(),
          meta: { source: 'api', cached: true },
        });
        return;
      }
      if (idem?.kind === 'in_flight') {
        writeJson(response, 409, {
          ok: false,
          error: 'duplicate messageId still in flight',
          inboundMessageId: messageId,
        });
        return;
      }

      // Inbound persistence invariant (REL-06): a user message is a physical
      // fact. Persist it the moment we accept it, regardless of whether the
      // agent later acks/errors/times out. DB write failure → 500 (do not
      // silently swallow; the caller must know).
      const inboundPersisted = await persistMessageAsync(
        channelId, inboundEvent, 'inbound', senderId
      );
      if (!inboundPersisted) {
        writeJson(response, 500, { ok: false, error: 'failed to persist inbound message' });
        return;
      }
      // Echo inbound to sibling clients on this chatId so other tabs see the
      // user's own message immediately, independent of the agent reply.
      if (chatId) {
        fanOut(
          channelId, chatId,
          { type: 'message.send', data: { ...inboundEvent.data, direction: 'inbound', echo: true } },
        );
      }

      // Set up the per-request promise + register inside the session.
      const replyEvents = [];
      let resolveReply;
      let rejectReply;
      const replyPromise = new Promise((res, rej) => {
        resolveReply = res;
        rejectReply = rej;
      });
      const timer = setTimeout(() => rejectReply(new Error('timeout')), TIMEOUT_MS);

      // Concurrent requests share `sess.opening` — only the first creator opens
      // the backend connection; followers await the same promise.
      if (isNewSession) {
        sess.opening = (async () => {
          sendJson(backend.ws, {
            type: 'relay.client.open',
            connectionId: sessionId,
            query: { chatId, agentId: agentId || null, token: null },
            authUser: { senderId, chatId, allowAgents: agentId ? [agentId] : undefined },
            timestamp: ts,
          });
          await new Promise((r) => setTimeout(r, 50));
        })();
      }
      if (sess.opening) {
        await sess.opening;
      }

      // Register the request — keyed by inbound messageId (matches replyTo on the
      // agent's message.send). Concurrent requests on the same session are safe:
      // each waits for its own replyTo (D3 — no FIFO fallback).
      sess.requests.set(messageId, {
        resolve: resolveReply,
        reject: rejectReply,
        timer,
        replyEvents,
      });

      // Forward the inbound event to backend
      sendJson(backend.ws, {
        type: 'relay.client.event',
        connectionId: sessionId,
        event: inboundEvent,
        timestamp: ts,
      });

      // Wait for reply (or timeout)
      let replyEvts;
      try {
        replyEvts = await replyPromise;
      } finally {
        sess.requests.delete(messageId);
        // Schedule idle close — preserve context for next call on same session.
        if (sess.requests.size === 0) {
          sess.idleTimer = setTimeout(() => {
            apiSessions.delete(sessionId);
            sendJson(backend.ws, {
              type: 'relay.client.close',
              connectionId: sessionId,
              code: 1000,
              reason: 'api idle timeout',
              timestamp: Date.now(),
            });
          }, POOL_IDLE_MS);
        }
      }

      // Extract final message.send event
      const finalEvt = replyEvts.find((e) => e?.type === 'message.send');
      const replyText = finalEvt?.data?.content || '';
      const replyMessageId = finalEvt?.data?.messageId || null;

      writeJson(response, 200, {
        ok: true,
        messageId: replyMessageId,
        // Echo back the inbound messageId we generated. Caller can use it with
        // GET /api/messages/sync?channelId=…&after=<ts> to recover the reply if
        // the HTTP connection drops mid-await (P1-α).
        inboundMessageId: messageId,
        content: replyText,
        agentId: finalEvt?.data?.agentId || agentId || null,
        chatId,
        timestamp: finalEvt?.data?.timestamp || Date.now(),
        meta: { source: 'api' },
      });
    } catch (err) {
      if (err.message === 'timeout') {
        writeJson(response, 504, { ok: false, error: 'agent did not respond within timeout' });
      } else if (err.message?.startsWith('agent rejected') || err.message?.startsWith('agent closed')) {
        writeJson(response, 502, { ok: false, error: err.message });
      } else {
        console.error('[api/chat]', err);
        writeJson(response, 500, { ok: false, error: String(err.message || err) });
      }
    }
    return;
  }

  // ── POST /api/voice-refine — refine voice transcript with AI ──

  if (pathname === "/api/voice-refine" && request.method === "POST") {
    if (!(await requireAuthAny(request, response, url))) return;
    try {
      const body = JSON.parse(await parseRawBody(request, 128 * 1024));
      const text = typeof body.text === 'string' ? body.text : '';
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

      if (!text.trim()) {
        writeJson(response, 400, { ok: false, error: 'text is required' });
        return;
      }

      const settings = await loadAiSettings();
      const systemPrompt = buildFinalPrompt(
        settings.voiceRefinePrompt || DEFAULT_VOICE_REFINE_PROMPT,
        userPrompt,
      );
      const refined = await callLlm(systemPrompt, messages, { type: 'voice-refine', text });
      writeJson(response, 200, { ok: true, refined });
    } catch (err) {
      writeJson(response, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (pathname === "/api/meta") {
    await handlePublicMeta(response);
    return;
  }

  // ── GET /api/agents — all agents across all channels with status + metadata ──
  if (pathname === "/api/agents" && request.method === "GET") {
    if (!(await requireAdmin(request, response, url))) return;
    await handleAgentList(response);
    return;
  }

  // ── Relay Nodes registry (from Supabase cl_relay_nodes) ──
  if (pathname === "/api/relay-nodes" && request.method === "GET") {
    if (!(await requireAdmin(request, response, url))) return;
    const supabaseUrl = process.env.RELAY_SUPABASE_URL;
    const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      writeJson(response, 200, { ok: true, nodes: [], source: "none" });
      return;
    }
    try {
      const res = await fetch(`${supabaseUrl}/pg/rest/v1/cl_relay_nodes?select=id,name,url,admin_token&order=created_at`, {
        headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` },
      });
      const rows = await res.json();
      writeJson(response, 200, { ok: true, nodes: Array.isArray(rows) ? rows.map(r => ({ id: r.id, name: r.name, url: r.url, adminToken: r.admin_token })) : [], source: "supabase" });
    } catch (err) {
      writeJson(response, 500, { ok: false, error: String(err) });
    }
    return;
  }

  if (pathname === "/api/relay-nodes" && request.method === "POST") {
    if (!(await requireAdmin(request, response, url))) return;
    const supabaseUrl = process.env.RELAY_SUPABASE_URL;
    const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      writeJson(response, 400, { ok: false, error: "Supabase not configured" });
      return;
    }
    try {
      const body = await parseJsonBody(request);
      const { id, name: nodeName, url: nodeUrl, adminToken: nodeToken } = body;
      if (!id || !nodeName || !nodeUrl) { writeJson(response, 400, { ok: false, error: "id, name, url required" }); return; }
      await fetch(`${supabaseUrl}/pg/rest/v1/cl_relay_nodes`, {
        method: "POST",
        headers: {
          apikey: supabaseKey, authorization: `Bearer ${supabaseKey}`,
          "content-type": "application/json",
          prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({ id, name: nodeName, url: nodeUrl.replace(/\/+$/, ""), admin_token: nodeToken || "" }),
      });
      writeJson(response, 200, { ok: true });
    } catch (err) {
      writeJson(response, 500, { ok: false, error: String(err) });
    }
    return;
  }

  if (pathname.startsWith("/api/relay-nodes/") && request.method === "DELETE") {
    if (!(await requireAdmin(request, response, url))) return;
    const supabaseUrl = process.env.RELAY_SUPABASE_URL;
    const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      writeJson(response, 400, { ok: false, error: "Supabase not configured" });
      return;
    }
    const nodeId = decodeURIComponent(pathname.split("/").pop());
    try {
      await fetch(`${supabaseUrl}/pg/rest/v1/cl_relay_nodes?id=eq.${encodeURIComponent(nodeId)}`, {
        method: "DELETE",
        headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` },
      });
      writeJson(response, 200, { ok: true });
    } catch (err) {
      writeJson(response, 500, { ok: false, error: String(err) });
    }
    return;
  }

  if (pathname === "/api/channels" && request.method === "POST") {
    if (!(await requireAdmin(request, response, url))) {
      return;
    }
    try {
      await handleUpsertChannel(request, response);
    } catch (error) {
      writeRequestError(response, error);
    }
    return;
  }

  const channelMatch = pathname.match(/^\/api\/channels\/([^/]+)$/);
  if (channelMatch && request.method === "DELETE") {
    if (!(await requireAdmin(request, response, url))) {
      return;
    }
    const channelId = decodeURIComponent(channelMatch[1]);
    await handleDeleteChannel(response, channelId);
    return;
  }

  const usersMatch = pathname.match(/^\/api\/channels\/([^/]+)\/users$/);
  if (usersMatch && request.method === "POST") {
    if (!(await requireAdmin(request, response, url))) {
      return;
    }
    const channelId = decodeURIComponent(usersMatch[1]);
    try {
      await handleUpsertUser(request, response, channelId);
    } catch (error) {
      writeRequestError(response, error);
    }
    return;
  }

  const userMatch = pathname.match(/^\/api\/channels\/([^/]+)\/users\/([^/]+)$/);
  if (userMatch && request.method === "DELETE") {
    if (!(await requireAdmin(request, response, url))) {
      return;
    }
    const channelId = decodeURIComponent(userMatch[1]);
    const senderId = decodeURIComponent(userMatch[2]);
    await handleDeleteUser(response, channelId, senderId);
    return;
  }

  // ── Media upload (POST /api/media/upload) ──
  if (pathname === "/api/media/upload" && request.method === "POST") {
    // Auth: admin token, channel backend secret, or Logto JWT
    const headerToken = normalizeNonEmpty(request.headers["x-relay-admin-token"]);
    const queryToken = normalizeNonEmpty(url.searchParams.get("adminToken"));
    const channelSecret = normalizeNonEmpty(request.headers["x-channel-secret"]);
    let authed = safeCompare(headerToken, adminToken) || safeCompare(queryToken, adminToken);
    if (!authed && await verifyBearerToken(request)) authed = true;
    // Allow channel user tokens (Bearer or query) to upload
    if (!authed) {
      const bearer = normalizeNonEmpty(request.headers["authorization"]?.replace(/^Bearer\s+/, ""));
      const token = queryToken || bearer;
      if (token) {
        try {
          const cfg = await relayStore.loadConfig();
          if (Object.values(cfg?.channels || {}).some(ch => ch.users?.some(u => safeCompare(u.token, token)))) {
            authed = true;
          }
        } catch (err) {
          console.error('[upload-auth] loadConfig failed:', err.message);
          writeJson(response, 503, { ok: false, error: 'auth lookup unavailable' });
          return;
        }
      }
    }
    if (!authed && channelSecret) {
      try {
        const relayConfig = await relayStore.loadConfig();
        authed = Object.values(relayConfig?.channels || {}).some(ch => safeCompare(ch.secret, channelSecret));
      } catch (err) {
        console.error('[upload-auth] loadConfig failed (secret path):', err.message);
        writeJson(response, 503, { ok: false, error: 'auth lookup unavailable' });
        return;
      }
    }
    if (!authed) {
      writeJson(response, 401, { ok: false, error: "auth required" });
      return;
    }

    try {
      const contentType = request.headers["content-type"] || "";
      let fileBuffer;
      let originalName = "file";
      let fileMime = "application/octet-stream";

      if (contentType.includes("multipart/form-data")) {
        // Parse multipart — read raw body and extract first file part
        const raw = await parseRawBody(request, MEDIA_MAX_BYTES);
        const boundary = contentType.split("boundary=")[1]?.trim();
        if (!boundary) { writeJson(response, 400, { ok: false, error: "missing boundary" }); return; }
        const parsed = parseMultipart(raw, boundary);
        if (!parsed) { writeJson(response, 400, { ok: false, error: "no file in multipart body" }); return; }
        fileBuffer = parsed.buffer;
        originalName = parsed.filename || "file";
        fileMime = parsed.contentType || inferMimeFromName(originalName);
      } else if (contentType.includes("application/json")) {
        // JSON body with base64: { data: "base64...", filename?: "...", mimeType?: "..." }
        const raw = await parseRawBody(request, MEDIA_MAX_BYTES * 1.4); // base64 overhead
        const body = JSON.parse(raw.toString("utf-8"));
        if (!body.data) { writeJson(response, 400, { ok: false, error: "missing data field" }); return; }
        const base64 = body.data.replace(/^data:[^;]+;base64,/, "");
        fileBuffer = Buffer.from(base64, "base64");
        originalName = body.filename || "file";
        fileMime = body.mimeType || inferMimeFromName(originalName);
      } else {
        // Raw binary upload
        fileBuffer = await parseRawBody(request, MEDIA_MAX_BYTES);
        originalName = url.searchParams.get("filename") || "file";
        fileMime = contentType || inferMimeFromName(originalName);
      }

      if (fileBuffer.length > MEDIA_MAX_BYTES) {
        writeJson(response, 413, { ok: false, error: `file too large (max ${MEDIA_MAX_BYTES / 1024 / 1024}MB)` });
        return;
      }

      const ext = originalName.includes(".") ? "." + originalName.split(".").pop().toLowerCase() : "";
      const fileId = randomUUID();
      const fileName = fileId + ext;
      await writeFile(join(mediaDir, fileName), fileBuffer);

      const baseUrl = publicBaseUrl || `${request.headers["x-forwarded-proto"] || "https"}://${request.headers.host}`;
      const mediaUrl = `${baseUrl}/api/media/${fileName}`;

      console.log(`[media] uploaded ${fileName} (${fileBuffer.length} bytes, ${fileMime})`);
      writeJson(response, 200, { ok: true, id: fileId, fileName, url: mediaUrl, mimeType: fileMime, size: fileBuffer.length });
    } catch (err) {
      console.error("[media] upload error:", err);
      if (err.message === "payload too large") {
        writeJson(response, 413, { ok: false, error: `file too large (max ${MEDIA_MAX_BYTES / 1024 / 1024}MB)` });
      } else {
        writeJson(response, 500, { ok: false, error: String(err) });
      }
    }
    return;
  }

  // ── Media download (GET /api/media/:filename) ──
  const mediaMatch = pathname.match(/^\/api\/media\/([a-f0-9-]+(?:\.\w+)?)$/);
  if (mediaMatch && request.method === "GET") {
    const fileName = mediaMatch[1];
    const filePath = join(mediaDir, fileName);
    try {
      await access(filePath);
      const content = await readFile(filePath);
      const ext = extname(fileName);
      const mime = MEDIA_MIME_MAP[ext] || "application/octet-stream";
      const isImage = mime.startsWith("image/");
      const headers = {
        "content-type": mime,
        "content-length": content.length,
        "cache-control": "public, max-age=86400",
        ...SECURITY_HEADERS,
      };
      if (!isImage) {
        headers["content-disposition"] = "attachment";
      }
      response.writeHead(200, headers);
      response.end(content);
    } catch {
      writeJson(response, 404, { ok: false, error: "file not found" });
    }
    return;
  }

  // Serve static files from public/ (Vite build output)
  const filePath = resolve(publicDir, pathname.slice(1));
  if (!filePath.startsWith(publicDir)) {
    writeJson(response, 403, { ok: false, error: "forbidden" });
    return;
  }
  try {
    await access(filePath);
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const cacheControl = ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
    response.writeHead(200, { "content-type": mime, "cache-control": cacheControl, ...SECURITY_HEADERS });
    response.end(content);
    return;
  } catch {}

  writeJson(response, 404, { ok: false, error: "not found" });
});

server.on("upgrade", (request, socket, head) => {
  const url = parseRequestUrl(request.url || "/");
  const origin = request.headers.origin;
  const clientIp = request.headers["x-forwarded-for"]?.split(",")[0]?.trim() || request.socket.remoteAddress;

  // WebSocket origin validation (H-2)
  if (origin && !isOriginAllowed(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  // Per-IP connection limit (L-1)
  if (!trackIpConnection(clientIp)) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }

  if (url.pathname === "/backend") {
    backendWss.handleUpgrade(request, socket, head, (ws) => {
      ws._clientIp = clientIp;
      ws.on("close", () => untrackIpConnection(clientIp));
      backendWss.emit("connection", ws, request);
    });
    return;
  }

  if (url.pathname === "/client") {
    clientWss.handleUpgrade(request, socket, head, (ws) => {
      ws._clientIp = clientIp;
      ws.on("close", () => untrackIpConnection(clientIp));
      clientWss.emit("connection", ws, request);
    });
    return;
  }

  untrackIpConnection(clientIp);
  socket.destroy();
});

await loadRelayConfig();
console.log(`[relay] config storage: ${configPath}`);

server.listen(port, host, () => {
  console.log(`[relay] listening on ${host}:${port}`);
});
