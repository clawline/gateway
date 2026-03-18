import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ensureRelayConfigShape,
  normalizeAgentList,
  normalizeChannelRecord,
  normalizeNonEmpty,
  normalizeUserRecord,
} from "./relay-config.js";

const TABLE_CHANNELS = "cl_channels";
const TABLE_CHANNEL_USERS = "cl_channel_users";

function normalizeSupabaseUrl(value) {
  const url = normalizeNonEmpty(value);
  if (!url) {
    return undefined;
  }
  return url.replace(/\/+$/, "");
}

function toPgQueryUrl(supabaseUrl) {
  return `${supabaseUrl}/pg/query`;
}

// Escape a value for SQL inline use (simple approach for trusted internal values)
function escapeSqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    // For JSONB arrays, stringify and escape
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  // String value - escape single quotes
  return `'${String(value).replace(/'/g, "''")}'`;
}

function coerceStoredAllowAgents(value) {
  if (Array.isArray(value)) {
    return normalizeAgentList(value);
  }
  if (typeof value === "string") {
    try {
      return coerceStoredAllowAgents(JSON.parse(value));
    } catch {
      return normalizeAgentList(value);
    }
  }
  return undefined;
}

async function readJsonConfigFile(configPath) {
  try {
    const persisted = await readFile(configPath, "utf8");
    return ensureRelayConfigShape(JSON.parse(persisted));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return ensureRelayConfigShape({});
    }
    throw error;
  }
}

async function writeJsonConfigFile(configPath, relayConfig) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(relayConfig, null, 2)}\n`, "utf8");
}

function buildSupabaseStore({ supabaseUrl, supabaseServiceRoleKey }) {
  const restBaseUrl = `${supabaseUrl}/pg/rest/v1`;
  const projectHost = new URL(supabaseUrl).host;

  const defaultHeaders = {
    apikey: supabaseServiceRoleKey,
    authorization: `Bearer ${supabaseServiceRoleKey}`,
    "content-type": "application/json",
  };

  async function restFetch(path, options = {}) {
    const response = await fetch(`${restBaseUrl}${path}`, {
      ...options,
      headers: { ...defaultHeaders, ...options.headers },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `PostgREST ${options.method ?? "GET"} ${path} failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
      );
    }

    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return response.json();
    }
    return null;
  }

  async function loadConfig() {
    const [channelRows, userRows] = await Promise.all([
      restFetch(`/${TABLE_CHANNELS}?select=channel_id,label,secret,token_param&order=channel_id`),
      restFetch(`/${TABLE_CHANNEL_USERS}?select=channel_id,id,sender_id,chat_id,token,allow_agents,enabled&order=channel_id,sender_id`),
    ]);

    const relayConfig = ensureRelayConfigShape({});

    for (const row of channelRows ?? []) {
      const channel = normalizeChannelRecord(
        row.channel_id,
        {
          label: row.label,
          secret: row.secret,
          tokenParam: row.token_param,
          users: [],
        },
        undefined,
      );
      relayConfig.channels[channel.channelId] = channel;
    }

    for (const row of userRows ?? []) {
      const channel = relayConfig.channels[row.channel_id];
      if (!channel) {
        continue;
      }

      channel.users.push(
        normalizeUserRecord(
          {
            id: row.id,
            senderId: row.sender_id,
            chatId: row.chat_id,
            token: row.token,
            allowAgents: coerceStoredAllowAgents(row.allow_agents),
            enabled: row.enabled,
          },
          undefined,
        ),
      );
    }

    return relayConfig;
  }

  async function upsertChannel(channel) {
    await restFetch(`/${TABLE_CHANNELS}`, {
      method: "POST",
      headers: {
        prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        channel_id: channel.channelId,
        label: channel.label ?? null,
        secret: channel.secret ?? null,
        token_param: channel.tokenParam ?? "token",
      }),
    });
  }

  async function deleteChannel(channelId) {
    const rows = await restFetch(
      `/${TABLE_CHANNELS}?channel_id=eq.${encodeURIComponent(channelId)}`,
      {
        method: "DELETE",
        headers: { prefer: "return=representation" },
      },
    );

    return Array.isArray(rows) && rows.length > 0;
  }

  async function upsertUser(channelId, user) {
    await restFetch(`/${TABLE_CHANNEL_USERS}`, {
      method: "POST",
      headers: {
        prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        channel_id: channelId,
        id: user.id ?? user.senderId,
        sender_id: user.senderId,
        chat_id: user.chatId ?? null,
        token: user.token ?? null,
        allow_agents: user.allowAgents ?? null,
        enabled: user.enabled !== false,
      }),
    });
  }

  async function deleteUser(channelId, senderId) {
    const rows = await restFetch(
      `/${TABLE_CHANNEL_USERS}?channel_id=eq.${encodeURIComponent(channelId)}&sender_id=eq.${encodeURIComponent(senderId)}`,
      {
        method: "DELETE",
        headers: { prefer: "return=representation" },
      },
    );

    return Array.isArray(rows) && rows.length > 0;
  }

  async function replaceConfig(nextConfig) {
    const currentConfig = await loadConfig();

    for (const channel of Object.values(nextConfig.channels)) {
      await upsertChannel(channel);
    }

    for (const channel of Object.values(nextConfig.channels)) {
      const currentUsers = new Set(
        (currentConfig.channels[channel.channelId]?.users ?? []).map((user) => user.senderId),
      );
      const nextUsers = new Set(channel.users.map((user) => user.senderId));

      for (const user of channel.users) {
        await upsertUser(channel.channelId, user);
      }

      for (const senderId of currentUsers) {
        if (!nextUsers.has(senderId)) {
          await deleteUser(channel.channelId, senderId);
        }
      }
    }

    for (const currentChannelId of Object.keys(currentConfig.channels)) {
      if (!Object.prototype.hasOwnProperty.call(nextConfig.channels, currentChannelId)) {
        await deleteChannel(currentChannelId);
      }
    }
  }

  return {
    kind: "supabase",
    configPath: `supabase://${projectHost}/public/${TABLE_CHANNELS},${TABLE_CHANNEL_USERS}`,
    async loadConfig() {
      return loadConfig();
    },
    async replaceConfig(nextConfig) {
      await replaceConfig(nextConfig);
    },
    async upsertChannel(channel) {
      await upsertChannel(channel);
    },
    async deleteChannel(channelId) {
      return deleteChannel(channelId);
    },
    async upsertUser(channelId, user) {
      await upsertUser(channelId, user);
    },
    async deleteUser(channelId, senderId) {
      return deleteUser(channelId, senderId);
    },
  };
}

function buildFileStore({ configPath }) {
  return {
    kind: "file",
    configPath,
    async loadConfig() {
      return readJsonConfigFile(configPath);
    },
    async replaceConfig(nextConfig) {
      await writeJsonConfigFile(configPath, nextConfig);
    },
    async upsertChannel(channel) {
      const relayConfig = await readJsonConfigFile(configPath);
      relayConfig.channels[channel.channelId] = channel;
      await writeJsonConfigFile(configPath, relayConfig);
    },
    async deleteChannel(channelId) {
      const relayConfig = await readJsonConfigFile(configPath);
      if (!relayConfig.channels[channelId]) {
        return false;
      }
      delete relayConfig.channels[channelId];
      await writeJsonConfigFile(configPath, relayConfig);
      return true;
    },
    async upsertUser(channelId, user) {
      const relayConfig = await readJsonConfigFile(configPath);
      const channel = relayConfig.channels[channelId];
      if (!channel) {
        throw new Error(`channel ${channelId} not found`);
      }
      const existingIndex = channel.users.findIndex((item) => item.senderId === user.senderId);
      if (existingIndex >= 0) {
        channel.users[existingIndex] = user;
      } else {
        channel.users.push(user);
      }
      await writeJsonConfigFile(configPath, relayConfig);
    },
    async deleteUser(channelId, senderId) {
      const relayConfig = await readJsonConfigFile(configPath);
      const channel = relayConfig.channels[channelId];
      if (!channel) {
        return false;
      }
      const nextUsers = channel.users.filter((user) => user.senderId !== senderId);
      if (nextUsers.length === channel.users.length) {
        return false;
      }
      channel.users = nextUsers;
      await writeJsonConfigFile(configPath, relayConfig);
      return true;
    },
  };
}

export function createRelayConfigStore({ baseDir }) {
  const configPath = process.env.RELAY_CONFIG_PATH || join(baseDir, "data", "relay-config.json");
  const supabaseUrl = normalizeSupabaseUrl(process.env.RELAY_SUPABASE_URL);
  const supabaseServiceRoleKey = normalizeNonEmpty(process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY);

  if (supabaseUrl && supabaseServiceRoleKey) {
    return buildSupabaseStore({
      supabaseUrl,
      supabaseServiceRoleKey,
    });
  }

  if (supabaseUrl || supabaseServiceRoleKey) {
    throw new Error(
      "Both RELAY_SUPABASE_URL and RELAY_SUPABASE_SERVICE_ROLE_KEY must be set together to enable Supabase storage.",
    );
  }

  return buildFileStore({ configPath });
}

export async function loadSeedConfigFromEnv() {
  const raw = process.env.RELAY_CHANNELS_JSON;
  if (!raw) {
    return null;
  }

  return ensureRelayConfigShape(JSON.parse(raw));
}

export { ensureRelayConfigShape, isRelayConfigEmpty } from "./relay-config.js";
