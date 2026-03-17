import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const baseDir = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.RELAY_CONFIG_PATH || join(baseDir, "data", "relay-config.json");
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

function normalizeNonEmpty(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function normalizeAgentList(value) {
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => normalizeNonEmpty(item)?.toLowerCase())
      .filter(Boolean);
    if (normalized.includes("*")) {
      return undefined;
    }
    return normalized.length > 0 ? normalized : undefined;
  }

  const text = normalizeNonEmpty(value);
  if (!text) {
    return undefined;
  }

  const normalized = text
    .split(",")
    .map((item) => normalizeNonEmpty(item)?.toLowerCase())
    .filter(Boolean);
  if (normalized.includes("*")) {
    return undefined;
  }
  return normalized.length > 0 ? normalized : undefined;
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

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
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

function ensureRelayConfigShape(value) {
  const output = {
    version: 1,
    channels: {},
  };

  if (!value || typeof value !== "object") {
    return output;
  }

  const inputChannels =
    value.version === 1 && value.channels && typeof value.channels === "object"
      ? value.channels
      : value;

  for (const [channelId, channelValue] of Object.entries(inputChannels)) {
    const normalizedChannel = normalizeChannelRecord(channelId, channelValue, undefined);
    output.channels[channelId] = normalizedChannel;
  }

  return output;
}

function normalizeChannelRecord(channelId, value, existing) {
  const normalizedChannelId = normalizeNonEmpty(channelId);
  if (!normalizedChannelId) {
    throw new Error("channelId is required");
  }

  const source = value && typeof value === "object" ? value : {};
  const secret =
    normalizeNonEmpty(source.secret) ??
    (typeof value === "string" ? normalizeNonEmpty(value) : undefined) ??
    existing?.secret ??
    randomUUID().replace(/-/g, "");

  const tokenParam = normalizeNonEmpty(source.tokenParam) ?? existing?.tokenParam ?? "token";
  const label = normalizeNonEmpty(source.label) ?? existing?.label;
  const usersInput = Array.isArray(source.users) ? source.users : existing?.users ?? [];
  const users = usersInput
    .map((user) => normalizeUserRecord(user, undefined))
    .filter(Boolean);

  return {
    channelId: normalizedChannelId,
    label,
    secret,
    tokenParam,
    users,
  };
}

function normalizeUserRecord(value, existing) {
  const source = value && typeof value === "object" ? value : {};
  const senderId = normalizeNonEmpty(source.senderId) ?? existing?.senderId;
  if (!senderId) {
    throw new Error("senderId is required");
  }

  const token = normalizeNonEmpty(source.token) ?? existing?.token ?? randomUUID().replace(/-/g, "");
  const hasAllowAgents = Object.prototype.hasOwnProperty.call(source, "allowAgents");
  return {
    id: normalizeNonEmpty(source.id) ?? existing?.id ?? senderId,
    senderId,
    chatId: normalizeNonEmpty(source.chatId) ?? existing?.chatId,
    token,
    allowAgents: hasAllowAgents ? normalizeAgentList(source.allowAgents) : existing?.allowAgents,
    enabled: source.enabled === false ? false : existing?.enabled === false ? false : true,
  };
}

async function loadRelayConfig() {
  try {
    const persisted = await readFile(configPath, "utf8");
    relayConfig = ensureRelayConfigShape(JSON.parse(persisted));
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("[relay] failed to read config file:", error);
    }
  }

  const raw = process.env.RELAY_CHANNELS_JSON;
  if (!raw) {
    relayConfig = ensureRelayConfigShape({});
    return;
  }

  try {
    relayConfig = ensureRelayConfigShape(JSON.parse(raw));
    await persistRelayConfig();
  } catch (error) {
    console.error("[relay] failed to parse RELAY_CHANNELS_JSON:", error);
    relayConfig = ensureRelayConfigShape({});
  }
}

async function persistRelayConfig() {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(relayConfig, null, 2)}\n`, "utf8");
}

function requireAdmin(request, response, url) {
  const headerToken = normalizeNonEmpty(request.headers["x-relay-admin-token"]);
  const queryToken = normalizeNonEmpty(url.searchParams.get("adminToken"));
  if (headerToken === adminToken || queryToken === adminToken) {
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
  relayConfig.channels[channelId] = next;
  await persistRelayConfig();

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

  closeBackendChannel(channelId, 1012, "channel removed");
  backendPresence.delete(channelId);
  delete relayConfig.channels[channelId];
  await persistRelayConfig();

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

  if (existingIndex >= 0) {
    channel.users[existingIndex] = nextUser;
  } else {
    channel.users.push(nextUser);
  }

  await persistRelayConfig();

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

  channel.users = nextUsers;
  await persistRelayConfig();

  writeJson(response, 200, {
    ok: true,
    channel: serializeChannel(channel),
    senderId,
  });
}

server.on("request", async (request, response) => {
  const url = parseRequestUrl(request.url || "/");
  const pathname = url.pathname;

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

  if (pathname === "/" || pathname === "/admin") {
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
    if (!requireAdmin(request, response, url)) {
      return;
    }
    await handleAdminState(response);
    return;
  }

  if (pathname === "/api/meta") {
    await handlePublicMeta(response);
    return;
  }

  if (pathname === "/api/channels" && request.method === "POST") {
    if (!requireAdmin(request, response, url)) {
      return;
    }
    try {
      await handleUpsertChannel(request, response);
    } catch (error) {
      writeJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "invalid request",
      });
    }
    return;
  }

  const channelMatch = pathname.match(/^\/api\/channels\/([^/]+)$/);
  if (channelMatch && request.method === "DELETE") {
    if (!requireAdmin(request, response, url)) {
      return;
    }
    const channelId = decodeURIComponent(channelMatch[1]);
    await handleDeleteChannel(response, channelId);
    return;
  }

  const usersMatch = pathname.match(/^\/api\/channels\/([^/]+)\/users$/);
  if (usersMatch && request.method === "POST") {
    if (!requireAdmin(request, response, url)) {
      return;
    }
    const channelId = decodeURIComponent(usersMatch[1]);
    try {
      await handleUpsertUser(request, response, channelId);
    } catch (error) {
      writeJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "invalid request",
      });
    }
    return;
  }

  const userMatch = pathname.match(/^\/api\/channels\/([^/]+)\/users\/([^/]+)$/);
  if (userMatch && request.method === "DELETE") {
    if (!requireAdmin(request, response, url)) {
      return;
    }
    const channelId = decodeURIComponent(userMatch[1]);
    const senderId = decodeURIComponent(userMatch[2]);
    await handleDeleteUser(response, channelId, senderId);
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

server.listen(port, host, () => {
  console.log(`[relay] listening on ${host}:${port}`);
});
