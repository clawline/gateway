# Gateway Scripts

## 概览

这些脚本用于 Clawline Gateway 的数据库管理和知识库生成。

## 文件说明

| 文件 | 用途 |
|------|------|
| `schema.sql` | **数据库建表 SQL** — 包含 `cl_messages` 和 `cl_settings` 两张表的完整定义、索引、触发器。新环境部署时在 Supabase SQL Editor 或 psql 中执行即可。 |
| `wiki-ingest.js` | **Wiki 知识库生成脚本** — 从 `cl_messages` 表读取消息，按 channel 分组，调用 LLM 生成摘要，输出 Markdown 文件。用于每日自动生成团队知识库。 |
| `.env.wiki-ingest.example` | wiki-ingest 的环境变量模板，复制为 `.env.wiki-ingest` 后填入实际值。 |
| `migrate-messages-table.js` | 早期迁移脚本（通过 API 建 cl_messages 表），已被 `schema.sql` 替代，保留作参考。 |
| `migrate-relay-config-to-supabase.js` | 将本地 relay-config.json 迁移到 Supabase 的一次性脚本。 |

## 新环境部署步骤

### 1. 建表
```bash
# 方式 A: Supabase Dashboard → SQL Editor → 粘贴 schema.sql 内容执行
# 方式 B: psql 直连
psql -h <supabase-db-host> -U supabase_admin -d postgres -f scripts/schema.sql
```

### 2. 配置 Gateway 环境变量
在 Gateway 的 systemd/pm2 配置中设置：
```env
RELAY_SUPABASE_URL=https://your-supabase-url
RELAY_SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### 3. 运行 Wiki Ingest（可选）
```bash
cp scripts/.env.wiki-ingest.example scripts/.env.wiki-ingest
# 编辑 .env.wiki-ingest，填入实际的 Supabase 和 Azure OpenAI 信息
node scripts/wiki-ingest.js
```

## 表说明

### cl_messages
存储 Gateway 转发的所有消息（inbound + outbound）。
- `message_id + direction` 有唯一索引，防止多连接重复写入
- Gateway 的 `persistMessage()` 使用 `resolution=ignore-duplicates` 做 upsert

### cl_settings
Gateway 配置的键值存储（如 AI 端点、模型名、Prompt 模板等）。
- Admin UI 通过 `/api/ai-settings` 读写
- `updated_at` 通过触发器自动更新
