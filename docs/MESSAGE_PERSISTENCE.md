# Clawline Gateway — 消息持久化 & Wiki 知识库

## 这是什么？

两个相互关联的功能：

1. **消息持久化** — Gateway 在转发消息时，自动将所有 inbound/outbound 消息存入 Supabase `cl_messages` 表
2. **Wiki 知识库生成** — 定时脚本从 `cl_messages` 读取消息，通过 LLM 生成结构化摘要，输出为 Markdown 文件

## 为什么做这个？

### 背景

我们的 agent 团队每天产生大量对话（需求讨论、技术方案、debug 记录），但这些信息散落在各个聊天窗口中，很快就沉没了。

受 Andrej Karpathy 的 **LLM Knowledge Base** 理念启发：
- 用 Markdown 作为持久化的知识载体（不是向量数据库）
- 透明、人类可读、可维护
- LLM 负责从原始对话中提炼结构化知识

### 解决的问题

| 问题 | 方案 |
|------|------|
| 聊天记录没有持久化，换个环境就丢了 | Gateway 自动存入 Supabase |
| 信息散落在各处，找不到 | 集中存储 + 按 channel 分组 |
| 对话内容是非结构化的，难以检索 | LLM 编译成结构化 Wiki |
| 依赖外部平台（Mattermost 等）的数据 | 在 Gateway 层面直接采集 |

## 架构

```
用户/Agent ←→ [Clawline Client] ←→ [Gateway] ←→ [Backend]
                                       │
                                       ├── 转发消息（实时）
                                       └── persistMessage() ──→ Supabase cl_messages
                                                                      │
                                                            ┌─────────┘
                                                            ▼
                                                   [wiki-ingest.js]
                                                   (定时 cron job)
                                                            │
                                                            ├── 读取 cl_messages
                                                            ├── 按 channel 分组
                                                            ├── 调用 LLM 生成摘要
                                                            └── 输出 → ~/.openclaw/wiki/daily/
```

## 数据表

### cl_messages — 消息记录

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid | 主键，自动生成 |
| channel_id | text | 频道 ID（如 "dora", "CC-OWL"） |
| sender_id | text | 发送者 ID |
| agent_id | text | Agent ID（如适用） |
| message_id | text | 消息唯一 ID |
| content | text | 消息内容 |
| content_type | text | 类型（默认 "text"） |
| direction | text | "inbound" 或 "outbound" |
| media_url | text | 媒体附件 URL |
| parent_id | text | 回复的消息 ID |
| meta | jsonb | 扩展元数据 |
| timestamp | bigint | 消息时间戳（毫秒） |
| created_at | timestamptz | 记录创建时间 |

**去重机制：** `message_id + direction` 唯一索引 — 同一条消息被多个 WS 连接触发时只写入一次。

### cl_settings — 配置存储

| 字段 | 类型 | 说明 |
|------|------|------|
| key | text | 配置键（主键） |
| value | jsonb | 配置值 |
| updated_at | timestamptz | 自动更新的时间戳 |

用于存储 AI 端点、模型名、Prompt 模板等配置，Admin UI 通过 `/api/ai-settings` 读写。

## 部署

### 前置条件
- Supabase 实例（含 PostgREST）
- Node.js 运行环境
- Azure OpenAI API Key（wiki-ingest 使用）

### 步骤

#### 1. 建表
```bash
# 在 Supabase SQL Editor 中执行 scripts/schema.sql
# 或通过 psql：
psql -h <db-host> -U supabase_admin -d postgres -f scripts/schema.sql
```

#### 2. 配置 Gateway
在 Gateway 的 systemd service 或 pm2 环境中添加：
```env
RELAY_SUPABASE_URL=https://your-supabase-url
RELAY_SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

重启 Gateway 后，消息会自动持久化到 `cl_messages`。

#### 3. 配置 Wiki Ingest（可选）
```bash
cd scripts/
cp .env.wiki-ingest.example .env.wiki-ingest
# 编辑 .env.wiki-ingest：
#   SUPABASE_URL — Supabase 地址
#   SUPABASE_SERVICE_ROLE_KEY — 服务端密钥
#   AZURE_OPENAI_ENDPOINT — Azure OpenAI 端点
#   AZURE_OPENAI_DEPLOYMENT — 模型部署名（如 gpt-4o）
#   AZURE_API_VERSION — API 版本
```

#### 4. 运行 / 定时任务
```bash
# 手动运行
node scripts/wiki-ingest.js

# 设置 cron（每天凌晨执行）
# 0 2 * * * cd /path/to/gateway && node scripts/wiki-ingest.js
```

## 文件清单

```
gateway-repo/
├── server.js                              # Gateway 主程序（含 persistMessage）
└── scripts/
    ├── README.md                          # 脚本目录说明
    ├── schema.sql                         # 完整建表 SQL
    ├── wiki-ingest.js                     # Wiki 知识库生成脚本
    ├── .env.wiki-ingest.example           # 环境变量模板
    ├── migrate-messages-table.js          # 早期迁移脚本（参考）
    └── migrate-relay-config-to-supabase.js # 配置迁移脚本（一次性）
```

## 当前状态

- ✅ 消息持久化 — 已上线（relay.restry.cn）
- ✅ 去重机制 — 已部署（唯一索引 + upsert ignore）
- ✅ Wiki Ingest 脚本 — 框架完成，端到端测试通过
- ⏳ Wiki Ingest 定时任务 — 待配置 cron
- ⏳ Wiki 输出对接 Portal — 待开发
