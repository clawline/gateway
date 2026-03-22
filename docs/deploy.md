# 部署指南

## 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 22+ | Docker 镜像使用 `node:22-alpine` |
| npm | 随 Node.js | 用于安装依赖 |

运行时依赖极少，仅 `ws`（WebSocket）和 `jose`（JWT 验证）。

---

## 最简启动（本地文件存储）

```bash
git clone <repo-url>
cd relay-gateway
npm install
npm start
```

不配置任何 Supabase 环境变量时，网关自动使用本地 JSON 文件存储：

- 配置文件路径：`./data/relay-config.json`（自动创建）
- 默认监听：`0.0.0.0:19080`
- Admin Token：若未设置 `RELAY_ADMIN_TOKEN`，启动时自动生成随机 token 并打印到控制台

启动后访问 `http://localhost:19080/admin` 即可进入管理后台。

---

## 生产部署：Supabase 持久存储

### 1. 初始化数据库

将 `supabase/schema.sql` 的内容复制到 Supabase SQL Editor 执行一次：

```sql
-- schema.sql 创建以下表和触发器：
-- cl_channels       — Channel 配置表
-- cl_channel_users  — Channel 用户表（外键关联 cl_channels）
-- cl_set_updated_at — 自动维护 updated_at 触发器
```

SQL 文件位置：[`supabase/schema.sql`](../supabase/schema.sql)

### 2. 配置环境变量

```bash
export RELAY_SUPABASE_URL=https://your-project-ref.supabase.co
export RELAY_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

> ⚠️ 两个变量必须同时设置，缺一个会报错退出。

### 3. 启动

```bash
RELAY_HOST=127.0.0.1 \
RELAY_PORT=19080 \
RELAY_ADMIN_TOKEN=your-secret-admin-token \
RELAY_PUBLIC_BASE_URL=https://relay.example.com \
RELAY_SUPABASE_URL=https://your-project-ref.supabase.co \
RELAY_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
npm start
```

### 4. 数据迁移（从本地 JSON 迁到 Supabase）

如果之前用本地文件存储运行过，可一次性迁移：

```bash
RELAY_SUPABASE_URL=https://your-project-ref.supabase.co \
RELAY_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
npm run migrate:supabase
```

也可以指定旧配置文件路径：

```bash
node scripts/migrate-relay-config-to-supabase.js /path/to/relay-config.json
```

---

## HTTPS 配置（Caddy 反代）

生产环境建议让网关只监听本机回环地址，由 Caddy 提供 TLS：

```bash
# 网关监听 127.0.0.1:18080
RELAY_HOST=127.0.0.1 RELAY_PORT=18080 npm start
```

Caddy 配置（参考 [`Caddyfile.example`](../Caddyfile.example)）：

```caddyfile
{
  email ops@example.com
}

relay.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:18080
}
```

配置后的访问路径：

| 用途 | URL |
|------|-----|
| Admin UI | `https://relay.example.com/admin` |
| Client WebSocket | `wss://relay.example.com/client?channelId=...&token=...` |
| Backend WebSocket（插件本机） | `ws://127.0.0.1:18080/backend` |
| Health Check | `https://relay.example.com/healthz` |

---

## Docker 部署

镜像采用两阶段构建：先编译 Admin 前端（admin-new 或 admin 目录），再打包精简的 production 镜像。

### 构建镜像

```bash
docker build -t relay-gateway .
```

### 运行

```bash
docker run -d \
  --name relay-gateway \
  -p 19080:19080 \
  -e RELAY_ADMIN_TOKEN=your-secret-admin-token \
  -e RELAY_SUPABASE_URL=https://your-project-ref.supabase.co \
  -e RELAY_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
  relay-gateway
```

### 搭配 Caddy 反代

容器只暴露到宿主机回环地址：

```bash
docker run -d \
  --name relay-gateway \
  -p 127.0.0.1:18080:19080 \
  -e RELAY_ADMIN_TOKEN=your-secret-admin-token \
  -e RELAY_PUBLIC_BASE_URL=https://relay.example.com \
  -e RELAY_SUPABASE_URL=https://your-project-ref.supabase.co \
  -e RELAY_SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
  relay-gateway
```

### 本地 fallback 挂载

如需保留本地文件存储作为 fallback：

```bash
docker run -d \
  --name relay-gateway \
  -p 19080:19080 \
  -v /host/data:/app/data \
  -e RELAY_CONFIG_PATH=/app/data/relay-config.json \
  relay-gateway
```

Dockerfile 声明了 `VOLUME ["/app/data"]`，容器内默认配置路径为 `/app/data/relay-config.json`。

---

## 环境变量完整列表

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RELAY_HOST` | `0.0.0.0` | 监听地址 |
| `RELAY_PORT` | `19080` | 监听端口 |
| `RELAY_ADMIN_TOKEN` | 自动生成（打印到控制台） | Admin API 鉴权 token，**生产环境强烈建议手动设置** |
| `RELAY_PUBLIC_BASE_URL` | — | 对外公共入口 URL，影响管理页展示和媒体下载链接 |
| `RELAY_PLUGIN_BACKEND_URL` | `ws://127.0.0.1:<port>/backend` | 管理页中展示给 OpenClaw 插件的 backend 连接地址 |
| `RELAY_SUPABASE_URL` | — | Supabase 项目 URL，例如 `https://xxx.supabase.co` |
| `RELAY_SUPABASE_SERVICE_ROLE_KEY` | — | Supabase service role key（仅后端使用，不能暴露给前端） |
| `RELAY_CONFIG_PATH` | `./data/relay-config.json` | 本地 JSON 配置文件路径（无 Supabase 时为主存储） |
| `RELAY_CHANNELS_JSON` | `{}` | 种子配置 JSON，当主存储为空时使用，兼容旧格式 |
| `LOGTO_ENDPOINT` | `https://logto.dr.restry.cn` | Logto OIDC endpoint，用于 JWT 验证 |
| `LOGTO_API_RESOURCE` | `https://gateway.clawlines.net/api` | Logto JWT audience/resource |

环境变量模板文件：[`.env.example`](../.env.example)

---

## Admin API Key 配置

`RELAY_ADMIN_TOKEN` 是所有管理 API 的鉴权凭据：

- **未设置时**：启动自动生成随机 32 位 hex token，打印到控制台日志
- **生产环境**：必须手动设置固定值，否则每次重启 token 都会变

使用方式（详见 [API 参考](./api.md)）：

1. HTTP Header：`X-Relay-Admin-Token: <token>`
2. Query 参数：`?adminToken=<token>`
3. Logto JWT Bearer Token（替代 admin token）

三种方式任选其一即可通过管理 API 鉴权。
