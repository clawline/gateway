# API 参考

## 鉴权方式

Relay Gateway 支持三种鉴权方式，管理 API 需要其中之一：

| 方式 | 适用场景 | 说明 |
|------|---------|------|
| Admin Token (Header) | 管理 API、媒体上传 | `X-Relay-Admin-Token: <RELAY_ADMIN_TOKEN>` |
| Admin Token (Query) | 管理 API（快速测试） | `?adminToken=<RELAY_ADMIN_TOKEN>` |
| Logto JWT Bearer | 管理 API、媒体上传 | `Authorization: Bearer <jwt>` — JWT 由 Logto OIDC 签发，audience 为 `LOGTO_API_RESOURCE` |

媒体上传 API 额外支持：

| 方式 | 说明 |
|------|------|
| Channel Secret | `X-Channel-Secret: <channel-secret>` — 用 channel 的 secret 鉴权 |
| Channel User Token | Bearer token 或 query param 匹配任一 channel 用户的 token |

---

## REST API

### GET /healthz

健康检查端点，**无需鉴权**。

**响应：**

```json
{
  "ok": true,
  "backendCount": 1,
  "clientCount": 3,
  "channels": [
    {
      "channelId": "demo",
      "label": "🍎 Demo",
      "backendConnected": true,
      "clientCount": 3,
      "instanceId": "openclaw-sg-1"
    }
  ],
  "timestamp": 1711100000000
}
```

---

### GET /api/meta

公开元信息端点，**无需鉴权**。

**响应：**

```json
{
  "ok": true,
  "adminAuthEnabled": true,
  "publicBaseUrl": "https://relay.example.com",
  "pluginBackendUrl": "ws://127.0.0.1:19080/backend",
  "timestamp": 1711100000000
}
```

---

### GET /api/state

获取完整的 relay 状态，**需要管理鉴权**。

**响应：**

```json
{
  "ok": true,
  "configPath": "supabase://xxx.supabase.co/public/cl_channels,cl_channel_users",
  "adminAuthEnabled": true,
  "publicBaseUrl": "https://relay.example.com",
  "pluginBackendUrl": "ws://127.0.0.1:19080/backend",
  "channels": [
    {
      "channelId": "demo",
      "label": "🍎 Demo",
      "secret": "abc123...",
      "secretMasked": "abc1***ef12",
      "tokenParam": "token",
      "userCount": 2,
      "users": [
        {
          "id": "user1",
          "senderId": "user1",
          "chatId": null,
          "token": "xxx...",
          "allowAgents": null,
          "enabled": true
        }
      ],
      "backendConnected": true,
      "clientCount": 1,
      "instanceId": "openclaw-sg-1",
      "lastConnectedAt": 1711100000000,
      "lastDisconnectedAt": null
    }
  ],
  "stats": {
    "backendCount": 1,
    "clientCount": 1
  },
  "timestamp": 1711100000000
}
```

---

### POST /api/channels

创建或更新 channel，**需要管理鉴权**。

**请求体：**

```json
{
  "channelId": "demo",
  "label": "🍎 Demo",
  "secret": "optional-custom-secret"
}
```

- `channelId`（必填）：channel 唯一标识
- `label`（可选）：显示名称
- `secret`（可选）：backend 鉴权密钥，不填则自动生成

**响应：**

```json
{
  "ok": true,
  "channel": { /* 完整 channel 对象 */ }
}
```

---

### DELETE /api/channels/:channelId

删除 channel 及其所有用户，断开相关 backend 和 client 连接。**需要管理鉴权**。

**响应：**

```json
{
  "ok": true,
  "channelId": "demo"
}
```

---

### POST /api/channels/:channelId/users

为指定 channel 创建或更新用户，**需要管理鉴权**。

**请求体：**

```json
{
  "senderId": "alice",
  "chatId": "optional-fixed-chat-id",
  "token": "optional-custom-token",
  "allowAgents": ["agent1", "agent2"],
  "enabled": true
}
```

- `senderId`（必填）：用户唯一标识
- `chatId`（可选）：绑定的 chatId，客户端连接时如果指定了不匹配的 chatId 会被拒绝
- `token`（可选）：不填则自动生成 32 位 hex
- `allowAgents`（可选）：允许使用的 agent 列表，不填或 `["*"]` 表示全部
- `enabled`（可选）：默认 `true`

**响应：**

```json
{
  "ok": true,
  "channel": { /* 完整 channel 对象 */ },
  "user": { /* 创建/更新后的 user 对象 */ }
}
```

---

### DELETE /api/channels/:channelId/users/:senderId

从 channel 中删除用户。**需要管理鉴权**。

**响应：**

```json
{
  "ok": true,
  "channel": { /* 完整 channel 对象 */ },
  "senderId": "alice"
}
```

---

### GET /api/relay-nodes

获取 Relay 节点注册表（存储在 Supabase `cl_relay_nodes` 表中）。**需要管理鉴权**。

未配置 Supabase 时返回空列表：

```json
{ "ok": true, "nodes": [], "source": "none" }
```

已配置 Supabase：

```json
{
  "ok": true,
  "nodes": [
    { "id": "sg-1", "name": "relay-sg", "url": "https://relay-sg.example.com", "adminToken": "xxx" }
  ],
  "source": "supabase"
}
```

---

### POST /api/relay-nodes

创建或更新 Relay 节点注册信息。**需要管理鉴权**，需要 Supabase 配置。

**请求体：**

```json
{
  "id": "sg-1",
  "name": "relay-sg",
  "url": "https://relay-sg.example.com",
  "adminToken": "optional-admin-token"
}
```

- `id`、`name`、`url` 为必填

---

### DELETE /api/relay-nodes/:nodeId

删除 Relay 节点注册信息。**需要管理鉴权**，需要 Supabase 配置。

---

### POST /api/media/upload

上传媒体文件。支持三种上传方式：

#### 1. Multipart 表单上传

```
Content-Type: multipart/form-data; boundary=...
```

请求体中包含文件字段。

#### 2. JSON Base64 上传

```json
{
  "data": "base64-encoded-content-or-data-url",
  "filename": "photo.jpg",
  "mimeType": "image/jpeg"
}
```

#### 3. 裸二进制上传

```
Content-Type: image/png
```

可通过 query 参数 `?filename=photo.png` 指定文件名。

**鉴权方式**（任一即可）：

- Admin Token（header 或 query）
- Logto JWT Bearer
- Channel Secret（`X-Channel-Secret` header）
- Channel User Token（Bearer 或 query）

**限制：**

- 最大文件大小：10 MB
- 文件自动过期：7 天

**响应：**

```json
{
  "ok": true,
  "id": "uuid",
  "fileName": "uuid.jpg",
  "url": "https://relay.example.com/api/media/uuid.jpg",
  "mimeType": "image/jpeg",
  "size": 102400
}
```

---

### GET /api/media/:filename

下载已上传的媒体文件，**无需鉴权**。

支持的 MIME 类型：

| 扩展名 | MIME |
|--------|------|
| `.jpg` `.jpeg` | `image/jpeg` |
| `.png` | `image/png` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.svg` | `image/svg+xml` |
| `.mp3` | `audio/mpeg` |
| `.ogg` | `audio/ogg` |
| `.wav` | `audio/wav` |
| `.mp4` | `video/mp4` |
| `.webm` | `video/webm` |
| `.pdf` | `application/pdf` |

响应包含 `Cache-Control: public, max-age=86400` 缓存头。

---

## WebSocket 协议

### /backend — 插件后端连接

OpenClaw 插件作为 backend 连接此端点。

**连接地址：**

```
ws://127.0.0.1:19080/backend
```

#### 握手流程

1. 插件连接 `/backend`
2. 5 秒内必须发送 `relay.backend.hello` 帧
3. 网关验证 channelId + secret
4. 验证通过返回 `relay.backend.ack`
5. 同一 channelId 的旧 backend 连接会被替换断开

#### 消息帧格式

**backend → 网关：**

```json
{
  "type": "relay.backend.hello",
  "channelId": "demo",
  "secret": "channel-secret",
  "instanceId": "openclaw-sg-1"
}
```

```json
{
  "type": "relay.server.event",
  "connectionId": "client-uuid",
  "event": { /* 任意 JSON 事件，转发给客户端 */ }
}
```

```json
{
  "type": "relay.server.reject",
  "connectionId": "client-uuid",
  "code": 1008,
  "message": "reason"
}
```

```json
{
  "type": "relay.server.close",
  "connectionId": "client-uuid",
  "code": 1000,
  "reason": "done"
}
```

**网关 → backend：**

```json
{
  "type": "relay.backend.ack",
  "channelId": "demo",
  "timestamp": 1711100000000
}
```

```json
{
  "type": "relay.backend.error",
  "message": "backend auth failed",
  "timestamp": 1711100000000
}
```

```json
{
  "type": "relay.client.open",
  "connectionId": "client-uuid",
  "query": {
    "rawQuery": "?channelId=demo&token=xxx&chatId=chat1",
    "channelId": "demo",
    "chatId": "chat1",
    "agentId": "agent1",
    "token": "user-token"
  },
  "authUser": {
    "id": "user1",
    "senderId": "user1",
    "chatId": null,
    "token": "xxx",
    "allowAgents": null,
    "enabled": true
  },
  "timestamp": 1711100000000
}
```

```json
{
  "type": "relay.client.event",
  "connectionId": "client-uuid",
  "event": { /* 客户端发送的 JSON 事件 */ },
  "timestamp": 1711100000000
}
```

```json
{
  "type": "relay.client.close",
  "connectionId": "client-uuid",
  "code": 1000,
  "reason": "closed",
  "timestamp": 1711100000000
}
```

---

### /client — 客户端连接

第三方客户端（Web 页面等）连接此端点与 backend 通信。

**连接地址：**

```
wss://relay.example.com/client?channelId=demo&token=user-token&chatId=chat1&agentId=agent1
```

#### Query 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `channelId` | ✅ | 目标 channel |
| `token` | 条件 | 当 channel 配置了用户列表时必填，用于客户端鉴权 |
| `chatId` | 否 | 会话标识，透传给 backend |
| `agentId` | 否 | Agent 标识，透传给 backend |

> 注意：`token` 参数名可以通过 channel 的 `tokenParam` 配置自定义（默认为 `token`）。

#### 连接规则

- `channelId` 不存在 → 立即关闭（code 1008）
- backend 未连接 → 立即关闭（code 1013）
- token 验证失败 → 立即关闭（code 1008）
- 如果 channel 没有配置任何用户，token 不校验，原始 query 透传给 backend

#### 消息格式

客户端和 backend 之间的消息均为 JSON 格式，网关透明转发：

- 客户端发送任意 JSON → 网关包装为 `relay.client.event` 转发给 backend
- backend 发送 `relay.server.event` → 网关提取 `event` 字段转发给客户端

---

## CORS

所有 REST API 端点默认启用 CORS：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: content-type, authorization, x-relay-admin-token
Access-Control-Max-Age: 86400
```

---

## 错误响应

所有 API 错误返回统一格式：

```json
{
  "ok": false,
  "error": "错误描述"
}
```

| HTTP 状态码 | 场景 |
|------------|------|
| 400 | 参数缺失、JSON 解析失败、payload 过大 |
| 401 | 鉴权失败 |
| 404 | channel/user/文件不存在 |
| 413 | 上传文件超过 10 MB 限制 |
| 500 | 服务器内部错误 |
