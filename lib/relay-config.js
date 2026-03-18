import { randomUUID } from "node:crypto";

export function normalizeNonEmpty(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

export function normalizeAgentList(value) {
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

export function normalizeUserRecord(value, existing) {
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

export function normalizeChannelRecord(channelId, value, existing) {
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
  const users = usersInput.map((user) => normalizeUserRecord(user, undefined)).filter(Boolean);

  return {
    channelId: normalizedChannelId,
    label,
    secret,
    tokenParam,
    users,
  };
}

export function ensureRelayConfigShape(value) {
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

export function isRelayConfigEmpty(config) {
  return Object.keys(config?.channels ?? {}).length === 0;
}
