import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
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
  // Dynamic config takes priority, then env var, then auto-derive from publicBaseUrl
  const fromConfig = relayConfig?.settings?.corsAllowedOrigins;
  if (fromConfig && fromConfig.length > 0) return fromConfig;
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
const clientConnections = new Map();

let relayConfig = {
  version: 1,
  channels: {},
};

// ── Message persistence (async, fire-and-forget) ──

const MESSAGE_TYPES_TO_PERSIST = new Set([
  'message.receive', 'message.send',
]);

function persistMessage(channelId, event, direction, senderId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !event) return;

  const eventType = event.type || '';
  if (!MESSAGE_TYPES_TO_PERSIST.has(eventType)) return;

  const data = event.data || event;
  const row = {
    channel_id: channelId,
    sender_id: senderId || data.senderId || null,
    agent_id: data.agentId || null,
    message_id: data.messageId || null,
    content: data.content || data.text || null,
    content_type: data.contentType || data.messageType || 'text',
    direction,
    media_url: data.mediaUrl || null,
    parent_id: data.parentId || data.replyTo || null,
    meta: data.meta ? JSON.stringify(data.meta) : null,
    timestamp: data.timestamp || Date.now(),
  };

  fetch(`${supabaseUrl}/pg/rest/v1/cl_messages`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      authorization: `Bearer ${supabaseKey}`,
      'content-type': 'application/json',
      prefer: 'return=minimal,resolution=ignore-duplicates',
    },
    body: JSON.stringify(row),
  }).catch((err) => {
    console.warn(`[messages] persist failed: ${err.message}`);
  });
}

// ── Thread operations (Supabase CRUD) ──

function broadcastToChannel(channelId, event, excludeConnectionId) {
  for (const [connId, client] of clientConnections) {
    if (client.channelId === channelId && connId !== excludeConnectionId && client.ws.readyState === WebSocket.OPEN) {
      sendJson(client.ws, event);
    }
  }
}

async function handleThreadCreate(connectionId, channelId, data, senderId) {
  const supabaseUrl = process.env.RELAY_SUPABASE_URL;
  const supabaseKey = process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY;
  const client = clientConnections.get(connectionId);
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
  const client = clientConnections.get(connectionId);
  if (!client) return;

  if (!supabaseUrl || !supabaseKey) {
    sendJson(client.ws, { type: 'thread.get', data: { error: 'Database not configured' } });
    return;
  }

  const threadId = data?.threadId;
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

    const thread = mapThreadRow(threadRow);

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
  const client = clientConnections.get(connectionId);
  if (!client) return;

  if (!supabaseUrl || !supabaseKey) {
    sendJson(client.ws, { type: 'thread.list', data: { error: 'Database not configured' } });
    return;
  }

  const filterChannelId = data?.channelId || channelId;
  const status = data?.status || 'active';
  const participantId = data?.participantId || null;
  const page = Math.max(1, parseInt(data?.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(data?.pageSize, 10) || 20));
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
    const threads = threadRows.map(mapThreadRow);

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
    const cfg = await relayStore.loadConfig();
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
  try {
    ws.close(code, reason);
  } catch {
    ws.terminate();
  }
}

function closeClientConnection(connectionId, code = 1000, reason = "closed") {
  const entry = clientConnections.get(connectionId);
  if (!entry) {
    return;
  }

  clientConnections.delete(connectionId);
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

  for (const [connectionId, client] of clientConnections.entries()) {
    if (client.channelId !== channelId) {
      continue;
    }
    clientConnections.delete(connectionId);
    closeSocket(client.ws, code, reason);
  }
  closeSocket(existing.ws, code, reason);
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
  for (const client of clientConnections.values()) {
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

  ws.on("message", (raw) => {
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
      console.log(`[relay] ← backend ${boundChannelId} sending event to client ${frame.connectionId}: ${frame.event?.type || 'unknown'}`);
      const client = clientConnections.get(frame.connectionId);
      if (!client || client.channelId !== boundChannelId) {
        return;
      }
      persistMessage(boundChannelId, frame.event, 'outbound', client.userId);
      sendJson(client.ws, frame.event);

      // Broadcast to sibling connections (same channelId + chatId, different connectionId)
      if (client.chatId) {
        for (const [siblingId, sibling] of clientConnections) {
          if (siblingId !== frame.connectionId && sibling.channelId === boundChannelId && sibling.chatId === client.chatId && sibling.ws.readyState === WebSocket.OPEN) {
            sendJson(sibling.ws, frame.event);
          }
        }
      }
      return;
    }

    if (frame?.type === "relay.server.reject") {
      const client = clientConnections.get(frame.connectionId);
      if (!client || client.channelId !== boundChannelId) {
        return;
      }
      clientConnections.delete(frame.connectionId);
      closeSocket(client.ws, frame.code || 1008, frame.message || "rejected");
      return;
    }

    if (frame?.type === "relay.server.close") {
      const client = clientConnections.get(frame.connectionId);
      if (!client || client.channelId !== boundChannelId) {
        return;
      }
      clientConnections.delete(frame.connectionId);
      closeSocket(client.ws, frame.code || 1000, frame.reason || "closed");
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
    for (const [connectionId, client] of clientConnections.entries()) {
      if (client.channelId !== boundChannelId) {
        continue;
      }
      clientConnections.delete(connectionId);
      closeSocket(client.ws, 1012, "backend disconnected");
    }
    console.log(`[relay] backend disconnected: ${boundChannelId}`);
  });

  ws.on("error", (error) => {
    console.error("[relay] backend socket error:", error);
  });
});

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

  clientConnections.set(connectionId, {
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

  ws.on("message", (raw) => {
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

    console.log(`[relay] → forwarding client event to backend ${channelId}: ${event?.type || 'unknown'}`);
    persistMessage(channelId, event, 'inbound', authResult.authUser?.senderId);

    // Broadcast inbound message to sibling connections (so client B sees what client A sent)
    if (query.chatId && (event?.type === 'message.receive')) {
      for (const [siblingId, sibling] of clientConnections) {
        if (siblingId !== connectionId && sibling.channelId === channelId && sibling.chatId === query.chatId && sibling.ws.readyState === WebSocket.OPEN) {
          sendJson(sibling.ws, { type: 'message.send', data: { ...event.data, echo: true } });
        }
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
    clientConnections.delete(connectionId);
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
      clientCount: clientConnections.size,
    },
    timestamp: Date.now(),
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
      clientCount: clientConnections.size,
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

  // ── Settings API (admin) ──
  if (pathname === "/api/settings" && request.method === "GET") {
    if (!(await requireAdmin(request, response, url))) return;
    const config = await relayStore.loadConfig();
    writeJson(response, 200, {
      ok: true,
      settings: config.settings ?? {},
      _env: { CORS_ALLOWED_ORIGINS: envCorsOrigins },
    });
    return;
  }

  if (pathname === "/api/settings" && request.method === "PUT") {
    if (!(await requireAdmin(request, response, url))) return;
    try {
      const body = JSON.parse(await parseRawBody(request, 64 * 1024));
      const config = await relayStore.loadConfig();
      // Merge settings
      if (body.corsAllowedOrigins !== undefined) {
        if (!config.settings) config.settings = {};
        config.settings.corsAllowedOrigins = Array.isArray(body.corsAllowedOrigins)
          ? body.corsAllowedOrigins.map(o => String(o).trim()).filter(Boolean)
          : body.corsAllowedOrigins === null ? undefined : undefined;
      }
      await relayStore.replaceConfig(config);
      relayConfig = config; // update in-memory
      writeJson(response, 200, { ok: true, settings: config.settings });
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
      const chatId = url.searchParams.get('chatId') || '';
      const after = Number(url.searchParams.get('after')) || 0;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);

      if (!channelId) {
        writeJson(response, 400, { ok: false, error: 'channelId required' });
        return;
      }

      let filter = `select=id,channel_id,sender_id,agent_id,message_id,content,content_type,direction,media_url,meta,timestamp&order=timestamp.asc&limit=${limit}`;
      filter += `&channel_id=eq.${encodeURIComponent(channelId)}`;
      if (after > 0) filter += `&timestamp=gt.${after}`;

      const res = await fetch(`${supabaseUrl}/pg/rest/v1/cl_messages?${filter}`, {
        headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` },
      });
      const rows = await res.json();
      writeJson(response, 200, { ok: true, messages: rows });
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
        const cfg = await relayStore.loadConfig();
        if (Object.values(cfg?.channels || {}).some(ch => ch.users?.some(u => safeCompare(u.token, token)))) {
          authed = true;
        }
      }
    }
    if (!authed && channelSecret) {
      const relayConfig = await relayStore.loadConfig();
      authed = Object.values(relayConfig?.channels || {}).some(ch => safeCompare(ch.secret, channelSecret));
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
