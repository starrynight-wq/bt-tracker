# bt-tracker

一个可部署的 BitTorrent Tracker，可运行在 **Cloudflare Workers** 或 **Replit/Node.js** 上。

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🌐 **HTTP/HTTPS Tracker** | 标准 `/announce` 和 `/scrape` 接口，返回标准 bencode 响应 |
| 👥 **Peer 联邦聚合** | 配置多个外部 tracker，客户端 announce 时自动向上游查询并将返回的有效 peer 与本地 peer 去重合并 |
| 🖥️ **网页管理面板** | `/dashboard` 提供可视化管理：统计卡片、外部 tracker 列表、种子列表、用量提醒 |
| 🔔 **用量提醒 (Alerts)** | 可为 `peers` / `torrents` / `announces` / `scrapes` 设定阈值，超过时通过 Webhook 或日志通知 |
| 📦 **导入/导出** | 管理后台支持 JSON 格式的种子/peer 状态导出与导入（支持 `?merge=false`） |
| 💾 **持久化** | Cloudflare KV（Worker）或 JSON 文件（Replit/Node） |
| 🚀 **一键部署** | 支持 Replit 一键部署和 Cloudflare Workers 一键部署 |

## 项目结构

```
bt-tracker/
├── public/
│   └── dashboard.html      # 网页管理面板（单文件，无需构建）
├── src/
│   ├── bencode.js          # bencode 编解码（Node + Cloudflare Worker 通用）
│   ├── store.js            # 存储层：MemoryStore / FileStore（Node 文件） / KvStore（CF KV）
│   ├── tracker.js          # Tracker 核心：announce/scrape/stats/admin/外部合并/提醒
│   ├── server.js           # Node.js HTTP 服务器入口（Replit）
│   ├── worker.js           # Cloudflare Worker 入口（CLI 部署用）
│   └── worker-bundle.js    # 单文件 Worker 打包（Cloudflare 网页控制台部署用，无需 CLI）
├── .replit                 # Replit 运行配置
├── package.json            # Node 入口 (npm start → src/server.js)
├── wrangler.toml           # Cloudflare Workers 部署配置
└── README.md               # 本文件
```

---

## 🚀 一键部署

### 方案一：Replit（推荐，最简单）

Replit 是最快的上手方式，无需安装任何工具，在浏览器里即可完成部署。

#### 步骤

1. **创建 Replit**
   - 打开 [Replit](https://replit.com/) 并登录。
   - 点击 **“+ Create Repl”**。
   - 选择模板：**Node.js**。
   - Repl 名称任意填写，例如 `bt-tracker`。

2. **上传文件**
   - 将本项目的所有文件上传到该 Repl（或通过 Git 导入）。
   - 确保文件结构如下（关键文件）：
     ```
     .replit
     package.json
     src/server.js
     src/store.js
     src/tracker.js
     src/bencode.js
     public/dashboard.html
     ```

3. **运行**
   - Replit 会自动检测 `.replit` 配置，执行 `npm start` → `node src/server.js`。
   - 点击右侧 **“Run”** 按钮，等待控制台输出：
     ```
     [tracker] listening on http://0.0.0.0:3000
     ```
   - 点击弹出的浏览器窗口，即可访问 Tracker。
   - 管理面板地址：`https://你的-repl-name.你的-用户名.repl.co/dashboard`

4. **持久化数据**
   - 数据自动保存到 `data/` 目录的 JSON 文件（`torrents.json`、`trackers.json`、`alerts.json`）。
   - Replit 免费版的文件系统在 Repl 重启后通常会保留，但建议定期通过 `/admin/export` 备份。

#### 环境变量（可选）

在 Replit 左侧 **Secrets** 或 `.replit` 的 `[env]` 段中设置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 监听端口 |
| `TRACKER_INTERVAL` | `1800` | Announce 间隔（秒） |
| `TRACKER_MIN_INTERVAL` | `900` | 最小 announce 间隔（秒） |
| `TRACKER_ID` | `bt-tracker` | Tracker 标识 |
| `TORRENTS_PATH` | `data/torrents.json` | 种子数据文件路径 |
| `TRACKERS_PATH` | `data/trackers.json` | 外部 tracker 配置文件路径 |

---

### 方案二：Cloudflare Workers（适合生产/全球边缘）

Cloudflare Workers 将你的 Tracker 部署到全球边缘节点，访问速度快，且 KV 存储天然持久化。

提供 **两种部署方式**：方式 A 使用 Cloudflare 网页控制台（无需安装任何工具，推荐新手）；方式 B 使用 Wrangler CLI（适合熟悉命令行的用户）。

---

#### 方式 A：通过 Cloudflare 网页控制台部署（无需 CLI，推荐）

无需安装 Node.js、Wrangler 或任何命令行工具，全部在浏览器中完成。

**前置要求**
- 注册 [Cloudflare](https://dash.cloudflare.com/) 账号

**步骤**

1. **创建三个 KV 命名空间**
   - 登录 Cloudflare 控制台：https://dash.cloudflare.com/
   - 进入左侧导航：**Workers & Pages** → **KV**
   - 点击 **“创建命名空间”**，依次创建三个，名称为：
     - `BT_TORRENTS`
     - `BT_TRACKERS`
     - `BT_ALERTS`
   - 创建完成后，记下每个命名空间的 **ID**（在命名空间详情页可查看）。

2. **创建 Worker 并粘贴代码**
   - 进入 **Workers & Pages** → **创建应用程序** → **创建 Worker**
   - 给 Worker 命名（例如 `bt-tracker`），选择免费子域，点击 **“部署”**
   - 在代码编辑器中，**删除所有默认代码**，将 `src/worker-bundle.js` 的完整内容粘贴进去
   - 点击 **“部署”** 按钮

3. **绑定 KV 命名空间**
   - 在 Worker 详情页，进入 **设置** → **绑定变量**
   - 点击 **“添加变量”**，添加三个绑定：
     | 变量名 | KV 命名空间 |
     |--------|-------------|
     | `BT_TORRENTS` | BT_TORRENTS |
     | `BT_TRACKERS` | BT_TRACKERS |
     | `BT_ALERTS` | BT_ALERTS |
   - 保存后，Worker 会自动重新部署。

4. **设置环境变量（可选）**
   - 仍在 **设置** → **变量** → **环境变量**（或“变量”页签）中，可添加：
     | 变量名 | 值 | 说明 |
     |--------|-----|------|
     | `BT_INTERVAL` | `1800` | Announce 间隔（秒） |
     | `BT_MIN_INTERVAL` | `900` | 最小 announce 间隔（秒） |
     | `BT_TRACKER_ID` | `bt-tracker` | Tracker 标识 |
   - 不填则使用默认值。

5. **访问 Tracker**
   - Worker 部署成功后，控制台会显示类似 `https://bt-tracker.<你的子域>.workers.dev` 的 URL
   - 管理面板：`https://<你的-worker-domain>.workers.dev/dashboard`
   - Tracker 接口：`https://<你的-worker-domain>.workers.dev/announce?...`

---

#### 方式 B：使用 Wrangler CLI 部署（命令行方式）

**前置要求**
- 注册 [Cloudflare](https://dash.cloudflare.com/) 账号
- 安装 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install/)：
  ```bash
  npm install -g wrangler
  wrangler login
  ```

**步骤**

1. **创建 KV 命名空间**
   ```bash
   wrangler kv:namespace create "BT_TORRENTS"
   wrangler kv:namespace create "BT_TRACKERS"
   wrangler kv:namespace create "BT_ALERTS"
   ```

   每条命令会输出类似：
   ```
   🌀 Created namespace with title "bt-tracker-BT_TORRENTS" and id "abc123def456"
   ```

2. **编辑 `wrangler.toml`**
   将步骤 1 中返回的 ID 填入对应位置：

   ```toml
   name = "bt-tracker"
   main = "src/worker.js"
   compatibility_date = "2024-01-01"
   compatibility_flags = ["nodejs_compat"]

   [vars]
   BT_INTERVAL = "1800"
   BT_MIN_INTERVAL = "900"
   BT_TRACKER_ID = "bt-tracker"

   [[kv_namespaces]]
   binding = "BT_TORRENTS"
   id = "abc123def456"      # <-- 替换为 BT_TORRENTS 的 ID
   preview_id = "abc123def456-preview"

   [[kv_namespaces]]
   binding = "BT_TRACKERS"
   id = "def456ghi789"      # <-- 替换为 BT_TRACKERS 的 ID
   preview_id = "def456ghi789-preview"

   [[kv_namespaces]]
   binding = "BT_ALERTS"
   id = "ghi789jkl012"      # <-- 替换为 BT_ALERTS 的 ID
   preview_id = "ghi789jkl012-preview"
   ```

   > ⚠️ `id` 和 `preview_id` 都需要填。preview_id 通常在创建命令输出的 `preview_id` 字段中；如果没有，可以再运行一次 `wrangler kv:namespace create` 查看，或在 Cloudflare 仪表板的 **Workers & Pages → KV** 中手动创建并绑定。

3. **部署**
   ```bash
   wrangler deploy
   ```

   部署成功后会输出一个类似 `https://bt-tracker.<subdomain>.workers.dev` 的 URL。

4. **访问管理面板**
   ```
   https://你的-worker-domain.workers.dev/dashboard
   ```

5. **通过 Cloudflare 仪表板绑定 KV（可选）**
   如果不想手动编辑 `wrangler.toml`，也可以在 Cloudflare 仪表板中：
   - 进入 **Workers & Pages** → 你的 Worker → **设置** → **绑定变量**
   - 添加三个 KV 命名空间绑定，变量名分别为 `BT_TORRENTS`、`BT_TRACKERS`、`BT_ALERTS`

---


## 🖥️ 本地开发 / Docker 部署

### 本地运行（Node.js）

```bash
# 克隆或下载项目
git clone <你的仓库地址>
cd bt-tracker

# 安装依赖（本项目无外部依赖，可跳过）
npm install

# 启动
npm start
# 或
node src/server.js

# 访问
# http://localhost:3000/announce?...
# http://localhost:3000/dashboard
```

### Docker 部署（可选）

创建 `Dockerfile`：

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
```

构建并运行：

```bash
docker build -t bt-tracker .
docker run -d -p 3000:3000 --name bt-tracker bt-tracker
```

使用 Docker Compose：

```yaml
version: '3'
services:
  bt-tracker:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - PORT=3000
      - TRACKER_INTERVAL=1800
```

---

## 📖 API 接口

### Tracker 端点

#### `GET /announce`

标准 BitTorrent announce 请求。

| 参数 | 类型 | 说明 |
|------|------|------|
| `info_hash` | string | 种子哈希（20 字节，十六进制或原始） |
| `peer_id` | string | 客户端 ID（20 字节） |
| `ip` | string | 客户端 IP |
| `port` | integer | 客户端端口 |
| `uploaded` | integer | 已上传字节数 |
| `downloaded` | integer | 已下载字节数 |
| `left` | integer | 剩余字节数 |
| `event` | string | `started` / `stopped` / `completed` / 空 |
| `compact` | 0/1 | 是否使用 compact peer 列表（推荐 1） |
| `numwant` | integer | 希望返回的 peer �量上限 |

响应（bencoded）：
```
d8:completei<数量>e10:incompletei<数量>e8:intervali<秒数>e12:min intervali<秒数>e5:peers<...>e
```

#### `GET /scrape?info_hash=...`

返回一个或所有种子的抓取信息（完整数、不完整数、下载总数）。

#### `GET /stats`

返回 JSON 格式的运行时统计：
```json
{
  "ok": true,
  "trackerId": "bt-tracker",
  "interval": 1800,
  "stats": { "announces": 123, "scrapes": 45, "errors": 0, "startedAt": 1700000000000 },
  "torrents": 5,
  "peers": 12,
  "complete": 3,
  "incomplete": 9,
  "trackers": 2,
  "uptime": 3600000
}
```

### 管理端点（JSON）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/admin/trackers` | 列出所有外部 tracker |
| `POST` | `/admin/trackers` | 添加外部 tracker `{url, enabled?, note?}` |
| `PATCH` | `/admin/trackers/<url>` | 修改外部 tracker `{enabled?, note?}` |
| `DELETE` | `/admin/trackers/<url>` | 删除外部 tracker |
| `GET` | `/admin/alerts` | 列出所有提醒规则 |
| `POST` | `/admin/alerts` | 添加提醒规则 |
| `PATCH` | `/admin/alerts/<id>` | 修改提醒规则 |
| `DELETE` | `/admin/alerts/<id>` | 删除提醒规则 |
| `GET` | `/admin/export` | 导出所有种子/peer 状态为 JSON |
| `POST` | `/admin/import` | 导入种子/peer 状态（`?merge=false` 跳过已存在） |

#### 提醒规则字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 提醒唯一标识，如 `peers-high` |
| `metric` | string | 监控指标：`peers` / `torrents` / `announces` / `scrapes` |
| `threshold` | number | 阈值 |
| `comparison` | string | 比较方式：`gt` / `gte` / `lt` / `lte` / `eq` |
| `enabled` | boolean | 是否启用 |
| `webhookUrl` | string | Webhook 通知地址（可选） |
| `email` | string | 联系邮箱（仅写入日志，可选） |
| `cooldownMs` | number | 触发冷却时间（毫秒，默认 3600000 = 1 小时） |

#### curl 示例

```bash
# 添加上游 tracker
curl -X POST http://你的-tracker/admin/trackers \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://tracker.example.com:6969/announce","enabled":true,"note":"公共上游"}'

# 启用/禁用外部 tracker
curl -X PATCH http://你的-tracker/admin/trackers/http%3A%2F%2Ftracker.example.com%3A6969%2Fannounce \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'

# 添加提醒：peer 数大于 100 时触发 Webhook
curl -X POST http://你的-tracker/admin/alerts \
  -H 'Content-Type: application/json' \
  -d '{"id":"peers-high","metric":"peers","threshold":100,"comparison":"gt","webhookUrl":"https://你的-webhook/alert","cooldownMs":300000}'

# 导出备份
curl http://你的-tracker/admin/export > backup.json

# 导入恢复
curl -X POST http://你的-tracker/admin/import -H 'Content-Type: application/json' --data @backup.json
```

### 网页管理面板

访问 `http://你的-tracker/dashboard`：

- **统计卡片**：种子数、Peer 数、上报次数、抓取次数、外部 tracker 数、运行时间
- **外部 tracker 管理**：添加、启用/禁用、删除上游 tracker
- **用量提醒**：添加/编辑/删除提醒规则，查看最后触发时间
- **种子列表**：查看所有已记录种子的 info hash、peer 数、完成数、时间

面板会自动轮询刷新数据（统计 15 秒、tracker 和提醒 30 秒）。

---

## 🔧 原理说明

### 外部 tracker 联邦

当客户端发起 `/announce` 时，Tracker 会：

1. 将本地 peer 记录/更新；
2. 向所有**启用**的外部 tracker 发起相同的 announce 请求（超时 8 秒，避免死上游阻塞）；
3. 解码上游返回的 bencode 响应，提取 compact peer 列表；
4. 按 `ip:port` 去重，与本地 peer 合并；
5. 按 `numwant` 截断后返回给客户端。

### 用量提醒

每次 `/announce` 或 `/scrape` 请求完成后，Tracker 会异步评估所有启用的提醒规则：

- 比较当前指标值与阈值；
- 若触发且超过冷却时间，则向 `webhookUrl` POST 通知 JSON 负载，并在服务端日志中记录；
- 若配置了 `email`，会在日志中输出提醒信息（实际发邮件需自行接入邮件服务）。

### 存储与持久化

- **Replit/Node**：`FileStore` 将数据写入 `data/` 目录下的 JSON 文件，内存缓存 + 定期刷盘（1 秒延迟 + 30 秒周期）。
- **Cloudflare Workers**：`KvStore` 将数据写入三个 KV 命名空间（`BT_TORRENTS`、`BT_TRACKERS`、`BT_ALERTS`），键前缀为 `bt:`。

---

## ⚠️ 注意事项

1. **外部 tracker 超时**：Node 环境下外部请求超时约 8 秒，Cloudflare Workers 使用默认超时；死上游不会阻塞客户端响应。
2. **Peer TTL**：默认 30 分钟，长时间未 announce 的 peer 会在选择时被过滤。
3. **Cloudflare KV 限制**：单个值上限 25 MB，适合中小规模 tracker；大规模使用建议自行扩展存储层。
4. **安全性**：当前版本的管理接口没有鉴权，建议在生产环境前通过 Cloudflare Access、Replit 权限或反向代理增加访问控制。
5. **IPv6**：当前 compact peer 仅支持 IPv4，IPv6 peer 会被过滤。

---

## 📄 许可证

MIT