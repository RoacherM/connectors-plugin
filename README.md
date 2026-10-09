# 🔌 DSH 连接器（@local/dsh-connectors）

把外部系统接入 DSH，像 OpenAI / Claude 的 Connectors：每个连接器的工具以 `mcp__<名称>__<工具>` 的形式直接提供给 Agent（包括定时任务的运行会话）。

## 连接器类型
| 类型 | 说明 |
|---|---|
| 邮箱（内置） | IMAP 读/搜/标记/归档 + SMTP 发信。Gmail、QQ、163、Outlook 或任意 IMAP。工具：`search_emails`（支持 `since` 精确到分钟、`gmail_query` 原生 Gmail 搜索语法、`include_body` 批量带正文）、`read_email`、`update_emails`、`send_email`（支持线程内回复）、`list_mailboxes` |
| 远程 MCP | Streamable HTTP（自动回退旧版 SSE）。认证：OAuth 2.1（元数据发现 + 动态注册 + PKCE，回调走 `127.0.0.1:33418`）、自定义请求头，或无 |
| 本地 MCP | stdio 启动任意命令（`npx …`、`uvx …`），使用登录 shell 的 PATH，环境变量存凭据库 |

## 使用：没有表单
配置全部由 Agent 完成，用户只输入一样东西：密钥。

- **在对话里说**「帮我接入 GitHub / Slack / 某个 MCP 服务器」。Agent 调用 `connectors_add` 写好地址、认证方式等全部设置；需要密钥时，对话里的工具卡片弹出**一行输入框**，填完直接存进本地凭据库（不经过对话、Agent 看不到），工具随即继续、确认连接成功。OAuth 服务则显示登录按钮，登录完成后自动继续。等 10 分钟没填，工具先返回，之后可在「连接器」页面的卡片上补填。
- **在「连接器」页面点一下**：Gmail / Outlook / QQ / 163 弹出一行（邮箱地址 + 应用密码）；GitHub 一行（Token）；Notion / Linear 不用输入，卡片上点「在浏览器中登录」。其他服务点「其他服务」到对话里接。
- 卡片等高：身份、状态、一行操作。待填写密钥的卡片把操作行换成输入框；「更换密钥」同理；工具列表在弹窗里看。
- Agent 工具：`connectors_list`、`connectors_add`（`preset` 或 `type/config`，`secret` 只描述要问什么，`ask_secret: true` 换密钥，`exposure` 切换工具提供方式）、`connectors_remove`。

## 工具提供方式：直接提供 / 按需加载
每个连接器有一个 `exposure`，在卡片状态行点一下即可切换（不断开连接）：

| 方式 | 模型看到什么 | 适合 |
|---|---|---|
| `direct`（默认） | 每个工具一个 `mcp__<名称>__<工具>` 定义，随每次请求发送 | 工具少、常用的连接器（如 Gmail） |
| `search` | 不注册单个工具；只要有一个按需连接器，就多出两个小工具：`connector_search`（按关键词排序，返回一行参数签名，小 schema 直接内联，`tools: ["notion/notion-fetch"]` 取完整 schema；`query: "*"` 浏览全部）和 `connector_call`（`{ connector, tool, arguments }`，调用前检查必填参数） | 工具多或 schema 很大的服务（Notion、Linear、GitHub） |

两个通用工具的定义只在按需连接器的集合变化时才重新注册，工具列表变化不会打破请求前缀缓存。`connector_call` 是否可以并发执行跟随目标工具的 `readOnlyHint`。旧记录里的 `deferLoading: true` 视为 `search`。
服务器在 initialize 时给的使用说明（MCP `instructions`）两种模式都会交给模型：**直接提供**的连接器和官方 MCP 客户端一样放进系统提示词（段落 `dsh-connectors:usage-notes`，每个连接器一节，随连接、编辑、切换实时更新）；**按需加载**的则同一个 agent 第一次搜到某个连接器的工具时附在结果前面（最多 8000 字符），之后不再重复；`show_instructions: true` 可重看，说明文本变了视为新说明。`connector_search` 的描述里会标出「有使用说明」的连接器。
例：本机 Cua Driver 作为 `mcp-stdio` 连接器 `cua`（`~/.local/bin/cua-driver mcp`，`search`）接入，替代官方的 `computer-use-cua`（已在 profile 中停用）。
对话里也可以说「把 Notion 改成按需加载」：Agent 调用 `connectors_add { name, exposure }`，只重新注册工具，不重新连接。

## 文档（MCP resources）
服务器列出了给模型读的文档或模板的连接器（直接提供或按需加载都算；连接时统计一次，服务器通知列表变化时重新统计），它的文档通过 `connector_resource` 读取；只要有一个这样的连接器启用，就注册这一个工具（约 0.5 KB）：
- `{ connector }` 列出文档和 URI 模板（`resources/templates/list`；服务器不支持时视为没有模板）；把模板里的 `{变量}` 换成具体值后当作 uri 读取；
- MCP App 界面资源（`ui://…`、`text/html;profile=mcp-app`）是给能渲染界面的客户端用的，不算文档：列表里只计数不列出；一个服务器如果只有这类资源，不算「提供文档」；
- `{ connector, uri }` 分段读，默认每段 2 万字符（`max_chars` 1000–60000），尽量在换行处断开，末尾给出下一段的 `offset`；第一页先给出 Markdown 目录（三级以内）；
- `heading` 只读某一节（标题完全一致优先，否则包含即可），到下一个同级或更高级标题为止；代码块里的 `#` 不算标题；
- 二进制内容只报类型和大小。
透传的使用说明里会补一行，告诉模型说明中的 resources/read、skills/get、`skill://…` 都用这个工具读。例：Cua Driver 的 `skill://cua-driver/SKILL.md` 有 6.8 万字符，第一页附 31 个标题的目录，按标题读一节只要几千字符。

Gmail 用 IMAP + 应用专用密码而不是 OAuth：未发布的 Google OAuth 应用 refresh token 7 天就过期，不适合无人值守的定时任务。

## 数据与安全
- 连接器配置：`~/.dsh/plugin-data/connectors/connectors.json`（不含任何密钥）。
- 密码、请求头、环境变量、OAuth 客户端与令牌：DSH 凭据库 `dsh-connectors/<连接器 id>`。浏览器只写不读，页面只显示「已保存」。
- 断线指数退避重连（最多 8 次）；工具列表变化（`listChanged`）自动同步。

## 开发
```sh
../pnpm-with-node install
node build.mjs     # dist/host.js（依赖全部打包进去）+ client.js
npm test           # 29 项：真实 stdio/HTTP MCP、完整 OAuth（含无动态注册 + client secret）、一行密钥流程、按需加载（检索/调用/切换/使用说明透传）、文档分段读取/模板/界面资源过滤、直接提供时的系统提示词说明、邮箱逻辑、jsdom UI、打包产物
node preview/build.mjs   # 设计预览：preview/index.html（?theme=dark、&card=1、&quick=qq、&tools=1）
```
安装/更新：`plugin_manager install_bundle file:/Users/byronwayne/Desktop/DSH/connectors-plugin`（改代码后先 `node build.mjs`，再移除并重新安装；Host 端模块在同一路径上有缓存，**重启 DSH 后才会载入新的 `dist/host.js`**）。回退：设置 → 插件中停用，再移除 bundle；配置备份在 `~/.dsh/profiles/desktop/*.bak-before-connectors-scheduler`。
