> 这是实现前的源码审计记录。当前实现与使用方式以仓库 README 为准；下述“待实现”描述保留审计时点语义。

# DSH 浏览器插件实时网页预览审计

审计日期：2026-10-16

## 结论

可以在 `dsh-crawshrimp-browser` 内实现与抓虾 Harness 相同的“实时网页画面 + 直接交互”体验。可复用的核心是 Chromium CDP 的画面合成和输入协议，不能复用的是抓虾的 Electron 主进程、`9222` 全局 target 发现、抓虾后端会话授权和资源面板。

实现应继续归在 `browser` 插件中：浏览器打开、页面动作、便携脚本、预览和输入共享同一个页面所有权模型。把 URL 重新放进 iframe 只能打开一个新的页面，无法保留自动化页面的 cookie、上下文、滚动位置和当前 DOM 状态，也不能实现“看见的页面就是 Agent 正在操作的页面”。

## 抓虾 Harness 当前实现

### 1. 主进程建立一条 target 级 CDP 流

抓虾的 [agentBrowser.js](<https://github.com/howtimeschange/crawshrimp-harness/blob/main/app/src/agentBrowser.js>) 在主进程中访问本机 CDP `/json`，只选择 `type === "page"` 且带 `webSocketDebuggerUrl` 的 target（49-66 行）。每个 target 只登记一条流，启动期间也保留 websocket 引用，方便用户在连接尚未完成时取消（182-223、252-266、324-336 行）。

连接成功后按以下顺序初始化：

1. `Page.enable`；
2. `Emulation.setFocusEmulationEnabled({ enabled: true })`，让后台或被遮挡的页面继续产生可见画面；
3. 读取 `Page.getLayoutMetrics`，取得 CSS viewport；
4. 建立 target 状态、输入会话和主 frame id；
5. 优先调用 `Page.startScreencast({ format: "jpeg", quality: 75, maxWidth: 1920, maxHeight: 1440, everyNthFrame: 1 })`。

这些步骤见 `agentBrowser.js:307-335`。合成流收到 `Page.screencastFrame` 后立即发送 `Page.screencastFrameAck`，再把 JPEG data 转成 `data:image/jpeg;base64,...` 发给渲染端；宽高从 frame metadata 的 `deviceWidth/deviceHeight/pageScaleFactor/offsetTop` 计算（`agentBrowser.js:82-96`）。ACK 不能省略，否则 CDP 会因为未确认的帧发生背压。

如果 `Page.startScreencast` 不可用，抓虾保留 800ms 定时器，使用 `Page.captureScreenshot({ format: "jpeg", quality: 55, fromSurface: true })`。截图回退还会读取布局、限制 clip 和缩放；每五次读取 `location.href`，兼容没有触发 `frameNavigated` 的 SPA history/hash 导航（`agentBrowser.js:337-404`）。合成流同样使用定时器读取 URL 和恢复错误状态，但不会重复截图。

页面导航通过 `Page.frameNavigated` 和 `Page.navigatedWithinDocument` 更新地址栏。连接、断开、连续三次捕获失败和恢复会发送状态事件；渲染端销毁、页面关闭或调用 stop 时清理定时器、输入状态和 websocket（`agentBrowser.js:98-116、136-170、229-266、397-407`）。旧 websocket 的迟到帧和错误不会覆盖新建立的同 target 流。

### 2. 输入链路是受限的 CDP 命令集合

主进程只接受 `kind` 事件，不接受任意 CDP 方法。 [browserInput.js](<https://github.com/howtimeschange/crawshrimp-harness/blob/main/app/src/browserInput.js>) 对坐标、viewport 边界、修饰键、按钮、滚轮距离、点击次数、文本长度、键码、key/code 长度和编辑命令做校验（3-38 行），再映射为：

- 鼠标移动、按下、释放和滚轮 → `Input.dispatchMouseEvent`；
- `rawKeyDown/keyUp` → `Input.dispatchKeyEvent`；
- 文本、粘贴和提交的 IME 文本 → `Input.insertText`；
- release → 对仍按住的按钮和按键发送补偿释放。

输入按 target 串行排队，最多允许 64 个待处理事件；发送前记录按键/按钮状态，因为超时并不能证明远端没有应用命令。stream 关闭、窗口失焦、输入桥报错和组件销毁都会清理队列并强制 release（`browserInput.js:41-81`）。每一个实际输入前再次发送 focus emulation，避免旧 CDP session 失焦后把输入发到不可见控件（`agentBrowser.js:108-123`）。

### 3. 渲染器把一条流变成可嵌入、可交互的网页窗口

[AgentBrowserPanel.vue](<https://github.com/howtimeschange/crawshrimp-harness/blob/main/app/src/renderer/components/agent/AgentBrowserPanel.vue>) 用图片承载远端画面，在图片上覆盖 pointer/wheel 事件，并用隐藏 textarea 接收键盘、剪贴板和 IME（78-117、204-287 行）。图片真实像素与 DOM 显示尺寸之间的比例由 `browserPoint` 换算，输入仍以远端 viewport 坐标发送；pointer capture 确保拖动、滚动和按住按钮跨越组件边界后仍能释放。

同一个 target 可能同时出现在资源面板的缩略/紧凑视图和完整窗口。[browserPreviewStreams.js](<https://github.com/howtimeschange/crawshrimp-harness/blob/main/app/src/renderer/utils/browserPreviewStreams.js>) 为每个 target 维护 owners、consumers、最新 frame/status 和串行 start/stop 队列；多个组件复用一条 CDP 流，组件交接时回放最新帧，最后一个 owner 离开才停止（1-71 行）。窗口本身支持右侧停靠、浮窗、最小化、最大化和拖动调整大小（`AgentBrowserPanel.vue:1-126、315-430`）。

### 4. 抓虾后端负责页面归属和自动跟随

Electron IPC 只是传输层：`app/src/main.js:2721-2729` 注册 start/stop/list/state/input/native，`app/src/preload.js:534-549` 暴露受限 API 和 frame/status 监听。页面归属由后端另外维护：MCP 工具从 run grant 中取得 `tab_id`，只广播绑定页面的 `browser.activity`（`core/agent/mcp_gateway.py:2494-2521`）；服务层再按 session 的 active grant 过滤 live tabs（`core/agent/service.py:1375-1448`）。资源 API 对页面新建、选择、关闭分别校验 runtime session，关闭时广播 `browser.page.closed`（`core/agent/api.py:1302-1344`）。

因此抓虾的“自动弹出/自动跟随”不是单靠 CDP 实现的，而是由 **run → grant → tab_id → session resource → renderer panel** 这一整条归属链驱动。DSH 插件应复刻归属语义，不能把抓虾的全局 `/json` target 列表直接搬进插件。

## DSH 当前浏览器包能复用什么

当前 [browser/lib/index.js](../lib/index.js) 已具备可复用的页面边界：

- `BrowserManager` 为每个 DSH agent session 建立独立 `BrowserContext`；
- 每个 context 的页面登记在该 session 的 `state.pages`，`browser_pages` 只返回这一 session 的页面；
- `cdpEndpoint` 仅是 Playwright 的浏览器连接方式，插件仍创建自己的 context，不接管已有 context/page（`lib/index.js:8-13、191-207、210-265、317-344`）；
- `crawshrimp_browser_open/navigate/click/fill/select/press/close` 已有独立的动作与 DSH 原生审批；`observe/wait/screenshot/pages` 是只读面；
- `ScriptsRuntime` 复用 `BrowserManager` 的浏览器连接，但每次脚本运行创建新的 isolated context/page，运行结束关闭（`lib/scripts/runtime.js:195-228、284-310`）。

这意味着预览可以直接绑定 Playwright 的 `Page`，不需要重新打开 URL，也不需要抓虾后端。Chromium 下可以从 `BrowserContext` 对页面创建 CDP session，监听 `Page.screencastFrame` 并调用 `Page.screencastFrameAck`；页面输入则通过同一个 session 发送受限 `Input.*` 命令。无法使用 screencast 时，调用 Playwright `page.screenshot()` 作为回退。

当前尚未具备的部分是：

1. server/runtime 到 DSH client 的帧和输入通道；
2. 右侧预览 tab 或 pane；
3. 每页一个可复用的 preview stream registry；
4. script run 临时 page 的资源登记和 run 关联；
5. 页面关闭、CDP 重连、client 离开和 lease 到期时的统一清理。

## 建议的 DSH 设计

### 1. 在 browser 包内新增 PreviewManager

不要另拆一个“预览插件”。在 `browser` 包内增加独立模块（例如 `lib/preview/manager.js`），但让它只使用 `BrowserManager` 提供的 page/context，不自己发现全局浏览器 target。

每个预览记录至少包含：

```text
sessionId      DSH agent session 的稳定标识
pageId         BrowserManager 登记的页面标识
runId          当前工具调用或脚本运行的标识；无运行时使用页面 owner lease
ownerLease     client 订阅和输入的短时凭证
viewport       远端 CSS viewport 宽高
lastFrame      最近一帧及其序号/时间戳
status         connecting | connected | error | disconnected | closed
```

`sessionId + pageId + runId` 是最小的归属键。每个 session 的 context 已经隔离；`pageId` 防止同 session 多页面串流；`runId` 防止一个旧 run 在页面复用或脚本结束后继续接收/发送输入。若同一个页面由多轮工具使用，run 结束后应更新 lease，而不是永久开放输入。

PreviewManager 应提供四个内部操作：

- `registerPage(session, page)`：由 `BrowserManager.open` 或页面创建路径登记；监听 page close、导航和 context close；
- `subscribe(session, pageId, runId)`：校验 owner/lease，启动或复用该 page 的 CDP stream，并返回最新 metadata；
- `input(session, pageId, runId, event)`：校验 lease 后按受限 schema 转成 CDP 输入；
- `release(session, pageId, runId)`：取消订阅、强制 release，并在最后一个 consumer 离开后停止 screencast。

### 2. 脚本页面必须显式选择是否可预览

当前脚本 page 是短生命周期、未登记的临时资源。若用户只要结果，不需要预览；若用户要求看脚本执行过程，`ScriptsRuntime` 应在 `openBrowser()` 后登记该 page，生成一个 `runId`，在脚本完成/失败/取消时注销。

脚本预览与交互页面必须保持两种明确模式：

- **独立脚本预览**：脚本使用自己的 context/page，预览只绑定该 `runId`，不会暴露交互页面的 cookie 或 DOM；脚本结束后 stream 和 page 一起关闭。
- **交互页面预览**：只绑定 `BrowserManager.state.pages` 中的页面，供 `browser_open/navigate/click/...` 使用；脚本不能静默接管它。

如果未来支持脚本暂停后的人工接管，插件需要显式记录控制交接及同一 `runId`。用户主动点击接管可作为人工操作入口；Agent 发起的动作继续遵循 DSH 原生审批。读取画面的订阅本身不授予输入控制权。

### 3. 使用本地、会话认证的双向通道

抓虾的 Electron IPC 在 DSH 中可替换为同一 browser 包注册的宿主通信通道。DSH 已提供 client 扩展及 `webServer`/upgrade 注册面，无需启动抓虾服务或独立预览服务。首版本地模式使用宿主 loopback 连接，建议的逻辑 WebSocket 路径为：

```text
GET /plugins/crawshrimp-browser/preview/:sessionId/:pageId
```

握手时校验 DSH client session 和 `ownerLease`。服务端是唯一持有 CDP session 的一侧，向 client 推送：

- `meta`：pageId、runId、URL、viewport、状态、frame sequence；
- `frame`：JPEG 二进制或有界 base64 JPEG；
- `closed/error`：页面关闭、连接断开或预览失败。

client 向服务端只发送结构化 `input` 和 `release` 消息。不要把 CDP websocket URL、`/json` 返回、Chrome 9222 端口或任意 CDP method 暴露到 client。已核对的 DSH client 连接服务提供 `openWebSocket`；具体宿主认证和通道授权仍需在实现阶段接入并测试。

### 4. 画面和输入的实现规则

沿用抓虾当前实现体现的处理语义，并在 DSH 中重新验收：

1. 连接后 `Page.enable`、focus emulation、viewport 读取，再启动 `Page.startScreencast`；
2. 每个 `Page.screencastFrame` 必须 ACK，并丢弃已经替换的旧 stream 帧；
3. cap 最大宽高和 JPEG quality；只保留最新一帧，慢 client 不阻塞 CDP；
4. screencast 失败时按固定间隔截图，并在连续失败达到阈值后发 error；新帧恢复后清除错误；
5. URL 用 frame navigation 事件更新，SPA history/hash 通过有界轮询或 Playwright navigation 事件兜底；
6. pointer 坐标按照 frame 的 CSS viewport 与 DOM 图片的 contain 缩放换算；超出 viewport 的事件拒绝；
7. 只接受 mouse/wheel/key/text/release，验证按钮、修饰键、键码、滚轮距离和文本上限；
8. 输入 per page 串行，达到队列上限时 fail closed；client blur、失焦、断开、取消和 lease 到期都发送补偿释放；
9. 不确定的输入超时不能自动重放，用户需要重新观察或重新操作。

### 5. 页面列表和 client 体验

browser 工具的 `pages` 已有 session 过滤，预览 UI 可以从同一份页面资源生成列表：一个 page 一个预览窗口，多个 UI consumer 共享一条 stream。第一版建议先实现右侧 sidebar tab：

- 当前 session 的 page 列表；
- URL、标题、连接状态和最近活动 page；
- 实时画面和鼠标/滚轮/键盘交互；
- 手动刷新、停止预览、重新连接；
- 页面关闭后移除资源，不自动回退到别的 session/page。

浮窗、紧凑缩略图和自动跟随可以在基础通道稳定后复用同一个 client stream registry；这些是 UI 布局能力，不应复制 CDP 连接。

## 安全和边界

- 预览帧可能包含登录态、订单和个人信息，只能发给拥有对应 DSH session 的 client。
- `pageId`、`sessionId`、`runId` 和 lease 必须在服务端再次校验，不能信任 client 自己上报的组合。
- 只允许 plugin 自己创建的 context/page；`cdpEndpoint` 连接的外部浏览器也不能让插件遍历和接管已有 context/page。
- 输入权限与读取画面权限分离；只读预览不自动获得点击、输入、导航权限。
- 首版本地模式复用 loopback 宿主，需要 DSH 会话认证；不得把 CDP URL、Chrome profile、cookie、storage state 或抓虾 runtime token放进帧消息。
- 页面关闭、脚本终止、context close、插件 unload、client disconnect 和 lease expiry 必须汇聚到同一个清理路径。
- 不使用 iframe 重新打开原 URL 作为实现方案，因为它会脱离真实的 Playwright context/page。

## 分阶段落地和验证

### P0：交互页面预览

1. 在 `browser/lib/preview/` 实现 CDP screencast、截图回退、输入校验、stream registry 和 lease；
2. 在 `BrowserManager` 的页面创建/关闭路径登记 page，输出 session/page metadata；
3. 在 DSH client 注册右侧预览 tab 和本地双向通道；
4. 先覆盖 open、navigate、click、fill、press、scroll、关闭和断线恢复。

### P1：脚本运行预览

1. 给 `ScriptsRuntime` 的临时 context/page 增加显式 `preview: true` 或用户触发的 preview lease；
2. 生成并传递 `runId`，把临时 page 登记为 session resource；
3. 脚本终态、取消和超时清理 page、stream、lease；
4. 在 UI 中把脚本页面标注为“脚本运行页面”，避免误认为交互页面。

### 必须通过的测试

- 合成 Chromium 页面上能收到 screencast frame，且每帧都有 ACK；静态页面仍能完成状态/URL更新；screencast 失败时截图回退；
- 两个 DSH session 同时打开页面时，任何一个 client 都看不到另一个 session 的 page，也不能向另一个 page 发输入；
- 同 page 的缩略视图和完整面板共享一条 stream，最后一个 consumer 离开才停止；旧 websocket 的迟到 frame/status 不得覆盖新连接；
- 输入坐标、滚轮、键码、文本长度和未知事件被拒绝；按住鼠标/键盘后 client 断开、页面关闭、取消和超时都能释放；
- 交互 page 与脚本临时 page 的 `pageId/runId` 不冲突；脚本结束后资源列表和 stream 无残留；
- 在真实 DSH 插件加载器下运行 `npm run check`、`npm test`、`npm pack --dry-run`，并用本地合成页面完成一次端到端交互。测试不得访问真实电商账号或提交真实订单。

## 当前判断

实时预览在 DSH browser 插件中可行，而且核心协议不复杂：**BrowserManager 持有真实 page，PreviewManager 持有该 page 的 CDP stream，DSH client 订阅受认证的本地通道，输入沿受限 schema 返回同一 page**。真正需要补强的是页面/脚本资源登记、session/page/run 归属和 client 传输层；抓虾的 Electron IPC、全局 CDP target 列表和抓虾后端授权不能作为 DSH 插件的依赖。

## DSH 扩展接口补充

同包前端、右侧面板、WebSocket 和现有 browser 缺口的具体官方类型与行号，见 [DSH 接入评估](live-preview-dsh.zh-CN.md)。本次仅完成源码审计与设计，未加入预览实现，也未执行真实商家流程。

本次运行了抓虾现有的 `browserInput.test.js`、`agentBrowserInteractive.test.js`、渲染端 `browserInput.test.js` 与 `browserPreviewStreams.test.js`：共 **21/21 通过**。覆盖focus ACK、输入边界/顺序/释放、坐标映射和共享流生命周期；这些是协议及组件逻辑测试，不替代DSH预览的真实浏览器端到端验收。
