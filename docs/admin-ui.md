# 管理后台（Admin UI）

## 概述

Relay Gateway 内置一套 Web 管理后台，基于 React 19 + TypeScript + Vite + Tailwind CSS + shadcn/ui 构建。

管理后台通过 Logto SSO 单点登录鉴权，登录后可管理 channel、用户、多节点 relay 等。

---

## 访问地址

| 部署方式 | URL |
|---------|-----|
| 本地开发 | `http://localhost:19080/admin` |
| 生产（HTTPS） | `https://relay.example.com/admin` |

Admin UI 的静态资源由 Relay Gateway 服务进程直接提供（从 `public/` 目录），无需额外的静态文件服务器。

---

## 登录鉴权

管理后台使用 **Logto SSO** 进行身份认证：

- 登录页面展示 `SIGN_IN_WITH_SSO` 按钮
- 点击后跳转到 Logto 认证页面
- 认证成功后回调到 `/callback`，自动跳转回管理页面
- 登录后，Admin UI 使用 Logto JWT Bearer Token 调用管理 API

Logto 配置（内置于前端代码中）：

| 配置项 | 值 |
|-------|-----|
| Logto Endpoint | `https://logto.dr.restry.cn` |
| App ID | `anbr9zjc6bgd8099ecnx3` |
| API Resource | `https://gateway.clawlines.net/api` |

---

## 功能说明

### 1. 总览面板（Relay Gateway）

顶部面板显示：

- **网关名称**和公共 URL
- **Channel 总数** / **Backend 在线数** / **Client 连接数**
- **运行状态**（RUNNING / DEGRADED）
  - DEGRADED：有 channel 但无 backend 在线

数据每 30 秒自动刷新，也可手动点击 Refresh 按钮。

### 2. 多 Relay 节点管理

管理后台支持管理多个 Relay Gateway 实例：

- 顶部有 **Relay 节点选择器**，可切换当前操作的 relay 节点
- 点击齿轮图标打开 **Relay Nodes 设置面板**
  - 查看所有已注册节点（名称、URL、token 状态）
  - 新增 / 编辑 / 删除节点
  - 节点注册信息同步存储到 Supabase（`cl_relay_nodes` 表）和浏览器 localStorage

### 3. Channel 管理

左侧面板展示所有 channel，支持：

- **查看** channel 列表（显示 label、channelId、backend 在线状态、client 数、user 数）
- **新增 Channel**：点击 `NEW_CHANNEL` 按钮
  - 自动生成随机 channelId（水果名称）和 label（带 emoji）
  - 自动生成 32 位 hex secret
  - 展开 Advanced 可自定义所有字段
- **编辑 Channel**：修改 label、secret 等
- **删除 Channel**：删除后自动断开相关 backend 和 client 连接
- **查看插件配置**：点击齿轮图标，弹出插件接入配置 JSON（可直接复制到 OpenClaw 配置文件中）

插件配置示例（弹窗内容）：

```json
{
  "channels": {
    "clawline": {
      "enabled": true,
      "connectionMode": "relay",
      "relay": {
        "url": "wss://relay.example.com/backend",
        "channelId": "demo",
        "secret": "channel-secret",
        "instanceId": "openclaw-demo-a1b2c3d4"
      }
    }
  }
}
```

### 4. 用户管理

右侧面板展示当前选中 channel 的用户列表：

- **用户表格**：显示 Sender ID、Token（脱敏）、状态（ONLINE/OFFLINE）、Chat ID
- **新增用户**：点击 `ADD_USER` 按钮
  - 自动生成随机 senderId（动物名称）和 32 位 hex token
  - 展开 Advanced 可配置 chatId、token、allowAgents、enabled
- **编辑用户**：修改 chatId、token、allowAgents、enabled
- **删除用户**：立即失效对应的连接参数
- **生成连接二维码**：点击 QR 码图标，弹出：
  - 连接信息摘要（节点、用户、token）
  - 二维码（`openclaw://connect?...` 协议链接）
  - 完整 URL（可复制）

### 5. 诊断报告

在 Relay Nodes 设置面板底部，点击 `RUN_DIAGNOSTIC` 可生成诊断报告：

- 检查配置路径、公共 URL、backend URL
- 列出所有 channel 状态、backend 连接状态、实例 ID
- 以日志格式展示，`INFO` / `WARN` / `ERR` 分级高亮

---

## 前端开发

Admin UI 源码位于 `admin/` 目录。

### 技术栈

| 技术 | 版本 |
|------|------|
| React | 19 |
| TypeScript | ~5.8 |
| Vite | 6 |
| Tailwind CSS | 4 |
| @logto/react | 4 |
| lucide-react | 图标库 |
| framer-motion / motion | 动画 |
| react-router-dom | 7 |
| react-qr-code | 二维码 |

### 开发模式

```bash
cd admin
npm install
npm run dev
```

开发服务器默认端口 3000，自动代理 `/api` 到 `http://localhost:19080`（需要先在另一个终端启动 relay-gateway）。

### 生产构建

```bash
cd admin
npm run build
```

构建产物输出到 `public/` 目录，由 relay-gateway 主进程直接提供。

Docker 构建时会自动执行此过程（见 Dockerfile 两阶段构建）。

### 环境变量

Admin UI 的环境变量在 `admin/.env` 中配置：

| 变量 | 说明 |
|------|------|
| `LOGTO_APP_ID` | Logto 应用 ID |
| `LOGTO_API_RESOURCE` | Logto API Resource URL |
