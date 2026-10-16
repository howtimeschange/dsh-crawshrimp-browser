# 抓虾 Harness 浏览器能力对照

2026-10-16 按 Harness 源码审计后迁移。参考基线 `cb791d28b`；插件基线 v0.2.1，新能力集中在同一个 Browser 包。此表描述浏览器工作流覆盖范围，不表示全部 Harness 后端功能都已移植。

| Harness 功能与源码 | 独立 DSH Browser 的实现 |
| --- | --- |
| 浏览器/页面会话：`core/cdp_bridge.py`、`core/browser_session.py` | 每个 DSH session 拥有独立 Playwright context；只操作插件创建的页面，不采用全局 target 扫描 |
| 当前 Skill 的 API 优先策略：`skills/crawshrimp-skill/SKILL.md` | bundled Skill 先理解页面和业务规则，探查 page client/API，再决定请求或 DOM 操作 |
| DOM/框架/网络探查：`core/probe_service.py`、`core/probe_analyzer.py` | probe 输出页面模型/框架线索/端点元数据/策略 bundle；capture_requests 有界采集本页请求证据 |
| 页面 JS 和 API 操作：`core/js_runner.py` | evaluate 与同源 request 使用原生审批及人工接管锁；不自动重试未知结果 |
| 网络脱敏与 bundle | 默认只捕获元数据，响应体显式开启并受限；常见凭证字段脱敏后才输出和落盘 |
| 文件输入/选择器：`core/js_runner.py:1213-1570` | 工作区内文件上传、file chooser；路径、大小及文件回执核验 |
| 下载：`runtime_downloads.py` | 同源认证 URL、点击/blob 下载，限定工作区落盘，大小/MIME/签名/hash 核验和取消清理 |
| 多阶段执行：`phase_runner.py` | phase/page/shared/params、阶段和分页上限、reload/abort、文件/捕获能力 dispatcher |
| 结果核验：`references/verification.md` | DOM、数量、可见性、页面、API 回执业务字段与工作区文件的结构化 verify |
| 日志/沉淀：`knowledge_service.py`、workflow references | session journal、成功证据 distill、同源 workflow 复用、adapter draft/test/publish |
| 实时浏览器：`app/src/agentBrowser.js`、`AgentBrowserPanel.vue` | CDP 实际画面和截图回退；顶部多标签；交互页接管/归还；脚本页只读 |
| 原生权限 | DSH Full Access 持续授权自动执行，其他模式保留原生审批；无权限服务失败关闭 |

## 保留给宿主或其他功能插件

- 全局任务调度、模型链、账户体系、后台任务数据库不随浏览器插件迁移。
- 表格清洗与 Excel/CSV 导出使用 Data；Word/PowerPoint 使用 Office。浏览器的上传下载、网页脚本和探查统一留在 Browser。
- 不采用 Harness 的全局外部 Chrome 页面扫描，不依赖固定 9222、Python 或抓虾后端。
- 不提供任意跨 target CDP、桌面应用控制、运行中脚本人工输入或旧后端专用媒体处理动作。

## 验收原则

真实 Chrome + 本地合成电商页面验证 API 请求、DOM 读回、上传/认证下载、阶段/shared、证据和复用。原生 DSH ToolRuntime 检查 Full Access、会话隔离及插件卸载。演示站通过不等于所有真实商家网站验收；商家业务仍须在已授权账号中核验。

能力参数见 bundled [Skill](../skills/crawshrimp-browser/SKILL.md) 和 [阶段协议](../skills/crawshrimp-browser/references/runtime.md)。
