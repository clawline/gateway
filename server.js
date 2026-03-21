import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, access, unlink, readdir, stat } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
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

const server = createServer();
const backendWss = new WebSocketServer({ noServer: true });
const clientWss = new WebSocketServer({ noServer: true });

const backends = new Map();
const backendPresence = new Map();
const clientConnections = new Map();

let relayConfig = {
  version: 1,
  channels: {},
};

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
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-relay-admin-token",
  "access-control-max-age": "86400",
};

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS });
  response.end(JSON.stringify(payload));
}

function writeHtml(response, html) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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
  if (headerToken === adminToken || queryToken === adminToken) {
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

  const authUser = channelConfig.users.find((user) => user.enabled !== false && user.token === token);
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

      if (!channelId || !expectedSecret || !secret || secret !== expectedSecret) {
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
      sendJson(client.ws, frame.event);
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

  clientConnections.set(connectionId, {
    ws,
    channelId,
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

    console.log(`[relay] → forwarding client event to backend ${channelId}: ${event?.type || 'unknown'}`);
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
    response.writeHead(204, CORS_HEADERS);
    response.end();
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
    let authed = headerToken === adminToken || queryToken === adminToken;
    if (!authed && await verifyBearerToken(request)) authed = true;
    // Allow channel user tokens (Bearer or query) to upload
    if (!authed) {
      const bearer = normalizeNonEmpty(request.headers["authorization"]?.replace(/^Bearer\s+/, ""));
      const token = queryToken || bearer;
      if (token) {
        const cfg = await relayStore.loadConfig();
        if (Object.values(cfg?.channels || {}).some(ch => ch.users?.some(u => u.token === token))) {
          authed = true;
        }
      }
    }
    if (!authed && channelSecret) {
      const relayConfig = await relayStore.loadConfig();
      authed = Object.values(relayConfig?.channels || {}).some(ch => ch.secret === channelSecret);
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
      response.writeHead(200, {
        "content-type": mime,
        "content-length": content.length,
        "cache-control": "public, max-age=86400",
        "access-control-allow-origin": "*",
      });
      response.end(content);
    } catch {
      writeJson(response, 404, { ok: false, error: "file not found" });
    }
    return;
  }

  // Serve static files from public/ (Vite build output)
  const safePath = pathname.replace(/\.\./g, "").replace(/\/\//g, "/");
  const filePath = join(publicDir, safePath);
  try {
    await access(filePath);
    const content = await readFile(filePath);
    const ext = extname(safePath);
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const cacheControl = ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
    response.writeHead(200, { "content-type": mime, "cache-control": cacheControl });
    response.end(content);
    return;
  } catch {}

  writeJson(response, 404, { ok: false, error: "not found" });
});

server.on("upgrade", (request, socket, head) => {
  const url = parseRequestUrl(request.url || "/");
  if (url.pathname === "/backend") {
    backendWss.handleUpgrade(request, socket, head, (ws) => {
      backendWss.emit("connection", ws, request);
    });
    return;
  }

  if (url.pathname === "/client") {
    clientWss.handleUpgrade(request, socket, head, (ws) => {
      clientWss.emit("connection", ws, request);
    });
    return;
  }

  socket.destroy();
});

await loadRelayConfig();
console.log(`[relay] config storage: ${configPath}`);

server.listen(port, host, () => {
  console.log(`[relay] listening on ${host}:${port}`);
});
