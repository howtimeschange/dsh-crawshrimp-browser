> 这是实现前的源码审计记录。当前实现与使用方式以仓库 README 为准；下述“待实现”描述保留审计时点语义。

# 浏览器实时预览：DSH 接入评估

检查版本：DSH `0.2.1-alpha.4`；日期：2026-10-16。本文件是源码层面的可行性评估，尚未实现或验收预览功能。

## 结论

实时预览和人工交互可以作为现有 `dsh-crawshrimp-browser` 包的界面能力。宿主端继续运行 Playwright、管理页面并提供画面/输入通道，客户端在 DSH 右侧面板显示同一页面的画面。无需抓虾后端，也无需新建预览项目或仓库。

DSH 内置 Browser 面板在 Web 模式使用 iframe，在桌面载体使用独立浏览器 provider；它们不会自动绑定当前插件的 Playwright Page。新预览应使用独立的 `crawshrimp-browser-preview` 面板类型，直接绑定插件拥有的页面，而不在 iframe 里重新打开业务 URL。

## 已核对的官方扩展接口

以下路径相对于 `/tmp/dsh-community-cli/node_modules/@deepseek-ai/`：

| 接口 | 源码证据 | 意义 |
| --- | --- | --- |
| 同包 Host + Client | `dsh-package-manifest/lib/types/types.d.ts:76`；`dsh-client-modules/lib/types/index.d.ts:1` | `package.json` 声明 `dsh.client`，提供 `./client` 导出；Node/前端代码可以放在同一个插件包中。 |
| 自定义右侧标签 | `dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts:75` | `ctx.sidebarRightTabs.register()` 定义自己的面板类型与生命周期。 |
| 面板正文 | `dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts:53` | `sidebar.right.pane.tab` 按插件类型注册正文，属于 session 作用域。 |
| HTTP/WS 路由 | `dsh-host-webserver/lib/types/index.d.ts:34`；`:42`；`:174`；`:181` | 可注册 HTTP 与升级通道；认证、会话归属和连接清理仍需在插件方案中落实。 |
| 客户端连接 | `dsh-client-connection/lib/types/client/index.d.ts:117` | 宿主提供可重连、带认证载体的连接服务和 `openWebSocket`，需按通道协议接入。 |
| 内置 Browser 实现 | `dsh-client-ui-sidebar-browser/lib/client.js:1603`；`:1631` | 展示了类型/正文注册；Web 端选择 `createIframePage`，不等于 Playwright 页面预览。 |

官方 `dsh-agent-preset/skills/cordis-plugin-development/references/ui-plugin.md` 还给出了同包客户端 lazy factory、React 基线模块、槽位和清理约定；前端资源可预构建后随包分发，安装时不必运行构建脚本。

## 当前浏览器包需要补的部分

1. **页面登记**：现有 `BrowserManager` 已按 DSH session 隔离页面；脚本执行另建 context/page。预览要按 `sessionId + pageId` 绑定交互页面，并为短生命周期脚本页补 `runId` 登记和开始/结束事件。
2. **画面通道**：新增每页画面流管理、订阅计数、节流、断线重连、切页清理与最终帧状态。现有 screenshot 工具只返回一次 PNG，没有实时面板。
3. **输入通道**：把面板坐标映射到真实 viewport，支持鼠标、滚轮、按键和中文组合输入；输入必须落在同一页面，并区分用户直接操作和 Agent 工具动作。
4. **控制状态**：观察与人工接管分开，明确页面正在由谁控制；人工接管时避免 Agent 与用户同时写入页面。Agent 动作继续保留 DSH 原生审批。
5. **同包前端**：在 `lib/client.js` 和包内界面资源中提供地址/标题、页签、实时画面、连接状态、接管/恢复控制。CLI 场景下保留原工具能力，界面作为可选增强。

## 实现验收边界

先用本地合成页面验证画面连续更新、表单输入、滚动、缩放坐标、中文输入、多页切换、会话隔离、脚本页生命周期、取消/断线/卸载清理和控制交接。真实商家账号、远程部署与多用户认证应单独验收。源码可行性不代表这些行为已经通过运行测试。
