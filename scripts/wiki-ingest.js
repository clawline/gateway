#!/usr/bin/env node
/**
 * Wiki Ingest — 每日 Cron
 *
 * 从 Supabase cl_messages 读取过去 24h 的消息，
 * 按 channel 分组，调 LLM 编译成结构化 Wiki 文档，
 * 输出到 ~/.openclaw/wiki/daily/YYYY-MM-DD-{channel}.md
 *
 * 用法:
 *   node scripts/wiki-ingest.js              # 默认过去 24h
 *   node scripts/wiki-ingest.js --date 2026-04-05   # 指定日期
 *   node scripts/wiki-ingest.js --dry-run    # 预览不写文件
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// ─── Load .env file ────────────────────────────────────────────

const envFile = path.join(__dirname, ".env.wiki-ingest");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val; // don't override existing
  }
}

// ─── Config ────────────────────────────────────────────────────

const CONFIG = {
  // Supabase (PostgREST via Kong)
  supabaseUrl: process.env.SUPABASE_URL || "http://localhost:8000",
  supabaseKey:
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.RELAY_SUPABASE_SERVICE_ROLE_KEY ||
    "",

  // Azure OpenAI
  azureEndpoint:
    process.env.AZURE_OPENAI_ENDPOINT ||
    "https://resley-sweden-ext.openai.azure.com",
  azureApiKey: process.env.AZURE_OPENAI_API_KEY || "",
  azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o",
  azureApiVersion: process.env.AZURE_API_VERSION || "2024-06-01",

  // Wiki output
  wikiRoot: path.join(
    process.env.HOME || "/home/resley",
    ".openclaw/wiki/daily"
  ),

  // Thresholds
  minMessages: 5, // 少于 N 条消息的 channel 不编译
  maxTokensPerGroup: 80000, // 超过则截断
};

// ─── LLM System Prompt ────────────────────────────────────────

const SYSTEM_PROMPT = `你是一个知识库编辑，负责将每日对话记录编译成结构化的 Wiki 文档。

## 输入
你会收到一天内某个 agent/channel 的完整对话记录。

## 输出要求
- 输出 Markdown 格式
- 提取有价值的信息：技术决策、问题解决方案、配置变更、架构讨论、待办事项
- 忽略闲聊、打招呼、重复确认等无信息量内容
- 按主题分组，每个主题一个二级标题（##）
- 每个主题下包含：背景、结论/决策、关键细节
- 如有待办事项或未解决问题，单独列出
- 保留关键的代码片段、命令、配置值
- 日期标注在文档顶部

## 风格
- 简洁，不啰嗦
- 陈述事实，不加主观评价
- 中英文混用（技术术语保留英文）`;

// ─── Args ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const dateIdx = args.indexOf("--date");
const TARGET_DATE = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : null;

// ─── Helpers ───────────────────────────────────────────────────

function todayCST() {
  const now = new Date();
  // CST = UTC+8
  const cst = new Date(now.getTime() + 8 * 3600 * 1000);
  return cst.toISOString().slice(0, 10);
}

function yesterdayCST() {
  const now = new Date();
  const cst = new Date(now.getTime() + 8 * 3600 * 1000 - 86400 * 1000);
  return cst.toISOString().slice(0, 10);
}

/**
 * HTTP JSON request helper (works with both http and https)
 */
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const body = options.body ? JSON.stringify(options.body) : null;
    const parsed = new URL(url);

    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || (body ? "POST" : "GET"),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, data, raw: true });
          }
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Supabase ──────────────────────────────────────────────────

async function fetchMessages(dateStr) {
  // dateStr = "YYYY-MM-DD", 查这一天 CST 00:00 ~ 23:59:59
  const startUTC = new Date(`${dateStr}T00:00:00+08:00`).toISOString();
  const endUTC = new Date(`${dateStr}T23:59:59+08:00`).toISOString();

  const url =
    `${CONFIG.supabaseUrl}/rest/v1/cl_messages` +
    `?created_at=gte.${startUTC}&created_at=lte.${endUTC}` +
    `&order=created_at.asc` +
    `&limit=5000`;

  const res = await fetchJSON(url, {
    headers: {
      apikey: CONFIG.supabaseKey,
      Authorization: `Bearer ${CONFIG.supabaseKey}`,
    },
  });

  if (res.status !== 200) {
    throw new Error(
      `Supabase query failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`
    );
  }

  return Array.isArray(res.data) ? res.data : [];
}

// ─── Group messages by channel ─────────────────────────────────

function groupByChannel(messages) {
  const groups = {};
  for (const msg of messages) {
    const key = msg.channel_id || "unknown";
    if (!groups[key]) groups[key] = [];
    groups[key].push(msg);
  }
  return groups;
}

// ─── Format messages for LLM ───────────────────────────────────

function formatMessagesForLLM(messages, channelId, dateStr) {
  const lines = [`# ${channelId} — ${dateStr}`, ""];

  for (const msg of messages) {
    const time = new Date(msg.created_at).toLocaleTimeString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
    });
    const sender = msg.sender_id || "unknown";
    const dir = msg.direction === "outbound" ? "[bot]" : "";
    const content = (msg.content || "").trim();
    if (!content) continue;

    lines.push(`[${time}] ${sender}${dir}: ${content}`);
  }

  return lines.join("\n");
}

// ─── LLM Call ──────────────────────────────────────────────────

async function callLLM(conversationText) {
  const url =
    `${CONFIG.azureEndpoint}/openai/deployments/${CONFIG.azureDeployment}` +
    `/chat/completions?api-version=${CONFIG.azureApiVersion}`;

  const res = await fetchJSON(url, {
    method: "POST",
    headers: { "api-key": CONFIG.azureApiKey },
    body: {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `以下是今日的对话记录，请编译成结构化 Wiki 文档：\n\n${conversationText}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 4000,
    },
  });

  if (res.status !== 200) {
    throw new Error(
      `LLM call failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`
    );
  }

  const content =
    res.data?.choices?.[0]?.message?.content || "[LLM returned empty]";
  return content.trim();
}

// ─── Generate Wiki page ────────────────────────────────────────

function buildWikiPage(channelId, dateStr, compiledContent) {
  const frontmatter = [
    "---",
    "type: daily-digest",
    `channel: ${channelId}`,
    `date: ${dateStr}`,
    "tags: [daily, auto-generated]",
    `created: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
  ].join("\n");

  return frontmatter + compiledContent + "\n";
}

function writeWikiFile(channelId, dateStr, content) {
  fs.mkdirSync(CONFIG.wikiRoot, { recursive: true });

  // Sanitize channel id for filename
  const safeName = channelId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${dateStr}-${safeName}.md`;
  const filePath = path.join(CONFIG.wikiRoot, filename);

  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const dateStr = TARGET_DATE || yesterdayCST();
  console.log(`📚 Wiki Ingest — ${dateStr}`);
  console.log(`   Supabase: ${CONFIG.supabaseUrl}`);
  console.log(`   LLM: ${CONFIG.azureDeployment} @ ${CONFIG.azureEndpoint}`);
  console.log(`   Output: ${CONFIG.wikiRoot}`);
  console.log(`   Dry run: ${DRY_RUN}`);
  console.log();

  // 1. Fetch messages
  console.log("⏳ Fetching messages from Supabase...");
  let messages;
  try {
    messages = await fetchMessages(dateStr);
  } catch (err) {
    console.error(`❌ Failed to fetch messages: ${err.message}`);
    console.error(
      "   (cl_messages table may not exist yet — Batch 1 dependency)"
    );
    process.exit(1);
  }

  console.log(`   Found ${messages.length} messages`);

  if (messages.length === 0) {
    console.log("ℹ️  No messages found, nothing to ingest.");
    return;
  }

  // 2. Group by channel
  const groups = groupByChannel(messages);
  const channelIds = Object.keys(groups);
  console.log(
    `   Channels: ${channelIds.map((c) => `${c}(${groups[c].length})`).join(", ")}`
  );
  console.log();

  // 3. Process each channel
  let generated = 0;
  let skipped = 0;

  for (const channelId of channelIds) {
    const channelMsgs = groups[channelId];

    if (channelMsgs.length < CONFIG.minMessages) {
      console.log(
        `   ⏭️  ${channelId}: ${channelMsgs.length} msgs (< ${CONFIG.minMessages}, skipped)`
      );
      skipped++;
      continue;
    }

    console.log(
      `   📝 ${channelId}: ${channelMsgs.length} msgs — compiling...`
    );

    // Format conversation text
    const conversationText = formatMessagesForLLM(
      channelMsgs,
      channelId,
      dateStr
    );

    // Truncate if too long (rough estimate: 4 chars ≈ 1 token)
    const estimatedTokens = conversationText.length / 4;
    let textForLLM = conversationText;
    if (estimatedTokens > CONFIG.maxTokensPerGroup) {
      const maxChars = CONFIG.maxTokensPerGroup * 4;
      textForLLM = conversationText.slice(0, maxChars) + "\n\n[... truncated]";
      console.log(
        `      ⚠️  Truncated from ~${Math.round(estimatedTokens)} to ~${CONFIG.maxTokensPerGroup} tokens`
      );
    }

    if (DRY_RUN) {
      console.log(
        `      [dry-run] Would call LLM with ${textForLLM.length} chars`
      );
      console.log(
        `      [dry-run] Preview:\n${textForLLM.slice(0, 300)}...\n`
      );
      generated++;
      continue;
    }

    // Call LLM
    try {
      const compiled = await callLLM(textForLLM);
      const wikiContent = buildWikiPage(channelId, dateStr, compiled);
      const filePath = writeWikiFile(channelId, dateStr, wikiContent);
      console.log(`      ✅ Written to ${filePath}`);
      generated++;
    } catch (err) {
      console.error(`      ❌ Failed: ${err.message}`);
    }
  }

  console.log();
  console.log(
    `🏁 Done — ${generated} generated, ${skipped} skipped (< ${CONFIG.minMessages} msgs)`
  );
}

main().catch((err) => {
  console.error(`💥 Fatal error: ${err.message}`);
  process.exit(1);
});
