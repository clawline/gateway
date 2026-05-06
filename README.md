> ⚠️ **DEPRECATED** — moved to https://github.com/clawline/platform/tree/main/apps/gateway on 2026-05-06

# relay-gateway

`relay-gateway` 是一个独立的 WebSocket 中转服务，同时也是一个简单的 relay 管理台。

用途：

- OpenClaw 插件以 `connectionMode: "relay"` 主动连接网关的 `/backend`
- 第三方客户端连接网关的 `/client`
- 网关负责服务器列表、用户/token 管理、backend 鉴权，以及 JSON 帧转发
- 当某个 channel 在网关里配置了用户列表后，客户端 token 认证由网关完成，插件会信任网关下发的已认证用户身份

## 启动

```bash
npm install
RELAY_PORT=3021 \
RELAY_SUPABASE_URL=https://your-project-ref.supabase.co \
RELAY_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
npm start
```

默认情况下，网关会把 `cl_channels` 和 `cl_channel_users` 作为主存储，并在启动时从 Supabase 读取配置。
如果没有配置 Supabase，则会回退到本地 `data/relay-config.json` 文件存储，便于本地开发或临时兜底。

首次接入 Supabase 时，先把 [`supabase/schema.sql`](supabase/schema.sql) 的内容复制到 Supabase SQL Editor 执行一次。

如果这是公网入口，推荐不要直接把 `RELAY_PORT` 暴露出去，而是让 `relay-gateway`
只监听本机回环地址，再由 Caddy/Nginx 提供 `https://` 和 `wss://`：

```bash
npm install
RELAY_HOST=127.0.0.1 \
RELAY_PORT=3021 \
RELAY_SUPABASE_URL=https://your-project-ref.supabase.co \
RELAY_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
RELAY_ADMIN_TOKEN=replace-me \
npm start
```

## 数据迁移

如果当前还在使用本地 `data/relay-config.json`，先完成表结构创建，再执行一次性迁移：

```bash
RELAY_SUPABASE_URL=https://your-project-ref.supabase.co \
RELAY_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
npm run migrate:supabase
```

也可以显式指定旧配置文件路径：

```bash
RELAY_SUPABASE_URL=https://your-project-ref.supabase.co \
RELAY_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
node scripts/migrate-relay-config-to-supabase.js /path/to/relay-config.json
```

迁移脚本会把 JSON 配置同步到 Supabase，使数据库成为后续运行时的主数据源。本地 JSON 文件仍可保留作备份或 fallback。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RELAY_HOST` | `0.0.0.0` | 监听地址 |
| `RELAY_PORT` | `19080` | 监听端口 |
| `RELAY_SUPABASE_URL` | - | Supabase 项目 URL，例如 `https://your-project-ref.supabase.co` |
| `RELAY_SUPABASE_SERVICE_ROLE_KEY` | - | 服务端使用的 Supabase service role key，只能放在后端环境变量，不能暴露给前端 |
| `RELAY_CHANNELS_JSON` | `{}` | 当主存储为空时的种子配置，兼容旧格式 `{"channel-id":{"secret":"xxx"}}` |
| `RELAY_CONFIG_PATH` | `./data/relay-config.json` | 本地 fallback / 迁移输入文件路径；未配置 Supabase 时也作为主存储 |
| `RELAY_ADMIN_TOKEN` | - | 可选管理台/API 管理 token |
| `RELAY_PUBLIC_BASE_URL` | - | 对外展示给管理页和客户端的公共入口 URL |
| `RELAY_PLUGIN_BACKEND_URL` | `ws://127.0.0.1:<RELAY_PORT>/backend` | 管理页里展示给 OpenClaw 插件的 backend 地址，默认指向本机回环 |
| `LOGTO_ENDPOINT` | `https://logto.dr.restry.cn` | Logto OIDC endpoint |
| `LOGTO_API_RESOURCE` | `https://gateway.clawlines.net/api` | Logto JWT audience/resource |

仓库根目录提供了可复制的环境变量模板：[`.env.example`](.env.example)。

## 接入路径

- backend: `ws://host:port/backend`
- client: `ws://host:port/client?channelId=<channelId>&chatId=<chatId>&agentId=<agentId>&token=<token>`
- health: `http://host:port/healthz`
- admin UI: `http://host:port/admin`
- admin API: `http://host:port/api/state`

如果前面挂了 TLS 反向代理，则第三方客户端应该改用：

- backend: `ws://127.0.0.1:18080/backend`（仅插件所在机器本地使用）
- client: `wss://relay.example.com/client?channelId=<channelId>&token=<token>`
- admin UI: `https://relay.example.com/admin`
- admin API: `https://relay.example.com/api/state`

## 插件侧配置示例

```yaml
channels:
  clawline:
    enabled: true
    connectionMode: "relay"
    relay:
      url: "ws://relay.example.com:19080/backend"
      channelId: "demo"
      secret: "replace-me"
      instanceId: "openclaw-sg-1"
```

## Docker 部署

镜像采用两阶段构建：先编译 admin 前端，再打包精简的 production 镜像。

### 构建

```bash
docker build -t relay-gateway .
```

### 运行

```bash
docker run -d \
  --name relay-gateway \
  -p 19080:19080 \
  -e RELAY_ADMIN_TOKEN=replace-me \
  -e RELAY_SUPABASE_URL=https://your-project-ref.supabase.co \
  -e RELAY_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
  relay-gateway
```

如果容器场景仍想保留本地 fallback，可额外挂载 `/app/data` 并设置 `RELAY_CONFIG_PATH=/app/data/relay-config.json`。

### 搭配 Caddy 反代

让容器只暴露到宿主机回环地址，由外层 Caddy 提供 TLS：

```bash
docker run -d \
  --name relay-gateway \
  -p 127.0.0.1:18080:19080 \
  -e RELAY_ADMIN_TOKEN=replace-me \
  -e RELAY_PUBLIC_BASE_URL=https://relay.example.com \
  -e RELAY_SUPABASE_URL=https://your-project-ref.supabase.co \
  -e RELAY_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
  relay-gateway
```

### 环境变量

容器支持与直接运行相同的环境变量（见上方"环境变量"一节），常用的：

| 变量 | 容器默认值 | 说明 |
|------|-----------|------|
| `RELAY_ADMIN_TOKEN` | 自动生成（打印到日志） | **强烈建议手动设置** |
| `RELAY_PORT` | `19080` | 容器内监听端口，一般无需修改 |
| `RELAY_PUBLIC_BASE_URL` | - | 设置后管理页展示的连接地址会使用此 URL |
| `RELAY_SUPABASE_URL` | - | Supabase 项目 URL |
| `RELAY_SUPABASE_SERVICE_ROLE_KEY` | - | Supabase service role key |
| `RELAY_CONFIG_PATH` | `/app/data/relay-config.json` | 本地 fallback / 迁移文件路径 |

## Caddy TLS 示例

建议让 `relay-gateway` 只监听 `127.0.0.1:18080`，再由 Caddy 申请证书并反代。

仓库里提供了一个模板文件：

- `Caddyfile.example`

最小 Caddyfile 形态如下：

```caddyfile
{
  email ops@example.com
}

relay.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:18080
}
```

这样做之后：

- 第三方页面如果本身是 `https://`，就应该连接 `wss://relay.example.com/client?...`
- OpenClaw 插件仍然连本机 `ws://127.0.0.1:18080/backend`
- 外部网络不再需要直接访问裸露的 `18080`

## 运行说明

- `channelId` 用于把某一组客户端路由到同一个插件实例
- `secret` 只用于 backend 鉴权，客户端不需要知道
- 如果某个 channel 没有在网关里配置 users，relay 会继续把原始查询串透传给插件，兼容旧的“插件自己校验 token”模式
- 如果某个 channel 在网关里配置了 users，客户端 token 会先在网关校验，然后网关把已认证用户身份传给插件
- 如果第三方页面本身运行在 `https://`，客户端入口必须改成 `wss://`，否则浏览器会直接拦截 Mixed Content
- 管理台当前支持：
  - 展示服务器列表、backend 在线状态、实例 ID、当前 client 数
  - 新增/编辑/删除 channel
  - 为 channel 配置 `tokenParam`
  - 新增/编辑/删除用户、token、固定 `chatId`、`allowAgents`

## 管理页前端开发

管理页是一个标准的 React + Vite + shadcn/ui 项目，源码在 `admin-new/`。

```bash
# 安装管理页依赖
cd admin-new && npm install

# 开发模式（自动代理 /api 到 localhost:19080）
npm run dev

# 类型检查
npx tsc --noEmit

# 生产构建
npm run build
```

技术栈：

- React 19 + TypeScript
- Vite 6
- Tailwind CSS v4 + shadcn/ui
- lucide-react 图标
- qrcode（生成连接二维码）

开发时先在另一个终端启动 relay-gateway 服务，管理页 dev server 会把 `/api` 代理到 `http://localhost:19080`。
