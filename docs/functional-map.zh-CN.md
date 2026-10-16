# DSH / Crawshrimp 功能型插件路线图（v3）

审计日期：2026-10-16

## 读法与维护基线

本路线图按“用户要完成什么工作”分类，而不是按 transport、provider、CLI 或内部 helper 拆仓库。审计只读检查了 `core/`、`sdk/`、`skills/`、`integrations/deepseek-harness/`，以及现有插件目录；源码证据证明有可复用实现线索，不等于跨平台、真实账号、外部供应商或生产环境已经验收。

长期维护基线固定为三个包：`browser`、`data`、`office`。现有 `scripts` 包的便携页面脚本、参数、翻页和 artifact 能力作为迁移来源并入 `browser`，不再作为独立的未来维护插件。Probe 是 `browser` 的页面证据功能；Artifact/provenance/redaction/packaging 是 `browser`、`data`、`office` 共享的交付能力；PDF、标签、模板和渲染归 `office`，都不另起技术小包。

以下优先级只表示功能落地顺序。任何写入、外发、浏览器动作和桌面动作都遵循 DSH 原生权限（完全权限自动执行，其他组合保留审批）；公开插件不携带公司 endpoint、私有 seller script、商家账号或凭证。

## 功能地图

| 优先级 | 用户工作 / 功能归属 | 当前状态与源码证据 | 目标边界与下一步 |
|---|---|---|---|
| **P0** | **网页打开、观察、交互、登录态、便携脚本与翻页 → `browser`** | 现有浏览器包已提供独立 Playwright `BrowserContext`、页面观察/动作/截图和审批：`dsh-crawshrimp-plugins/browser/README.zh-CN.md:3-28,77-94`。已并入 browser 的脚本能力包含 manifest、参数、shared state、受限翻页、artifact 和 approval：`dsh-crawshrimp-plugins/browser/lib/scripts/`。 | 维护一个 browser 工作面：页面动作、用户选定的 storage state、便携脚本、参数和分页统一由浏览器运行时管理；页面探查、网络与下载/导出证据在同一工作面按后续路线接入。会话和脚本任务分别使用隔离上下文，共用审批与产物合同。原 `scripts` 仓库保留历史并提供迁移说明；不再发展为第三个 web 包。 |
| **P0** | **页面探查、网络证据、下载/导出证据 → `browser` 内功能** | Web skill 已定义 `browser_observe`、有界 request capture、只读 eval、动作读回和脚本发布顺序：`integrations/deepseek-harness/skills/web-automation-skill/SKILL.md:24-34,48-75`。探查产物包括 `page-map.json`、`dom.json`、`network.json`、`endpoints.json`、`framework.json`、`strategy.json`、`recommendations.json`：`integrations/deepseek-harness/skills/web-automation-skill/references/crawshrimp-probe-workflow.md:22-73`。 | 把 Probe、network capture、下载稳定性和脱敏证据作为 browser 的功能组，不建 probe repo。复用现有 Playwright/CDP transport，不另起第二套动作层；固定快照引用生命周期、敏感字段规则、页面变化和截断状态。 |
| **P0（已实现并验收）** | **观看 Agent 操作网页、实时预览与人工交互 → `browser` 内界面** | browser 0.2.0 在同一包内提供 `PreviewManager`、CDP Screencast/截图回退、受限输入和 DSH 客户端面板：`browser/lib/preview/manager.js`、`browser/lib/preview/input.js`、`browser/lib/preview/transport.js`、`browser/lib/client.js`。宿主通过认证 WebSocket `/crawshrimp-browser/preview` 推送真实 Playwright Page 画面；页面按 session/page/run 归属，接管后 Agent 写操作受阻，脚本临时页只读。包级 37 项测试通过，真实已登录 DSH Agent 已加载同包 Skill，完成按 ref 观察/输入/点击和脚本执行；Web UI 顶部横向标签、中文输入、滚动、接管/恢复已截图验收。 | 继续在同一 browser 包内维护顶部网页标签和实时预览，内置 crawshrimp-browser Skill；完全权限按原生双条件持续授权执行，其他模式保留原生审批。Probe、network capture 和 download/export evidence 仍是后续功能，不计入 0.2.0 已实现范围。 |
| **P0** | **跨模块产物验真、来源关联、脱敏与交付包 → 共享能力** | 本地文件验证、脱敏、原子写入和事件/归档线索已有实现：`core/agent/artifact_delivery.py:9-77`、`core/agent/redaction.py:31-82`、`core/atomic_file.py:80-169`；视频服务也已有 snapshot/archive 产物：`core/ai_video_generation_service.py:1882-2007`。 | 做成 browser/data/office 可调用的 manifest、hash、revision、输入/输出关联和 redacted package 约定，或各包内的共享模块；不提出独立 Artifact 插件。不同包仍可保留自己的工作区、大小上限和审批，但交付字段应可互读。 |
| **P0/P1** | **商品表读取、清洗、筛选、汇总、报告数据与 CSV/XLSX 输出 → `data`** | 当前 data 包已覆盖 JSON/CSV/XLSX 预览、profile、转换与导出：`dsh-crawshrimp-plugins/data/README.zh-CN.md:5-14,46-71`；路径隔离、输入界限、表格解析和导出见 `dsh-crawshrimp-plugins/data/lib/tables.js:66-185`；声明式 filter/dedupe/sort/select/rename 见 `dsh-crawshrimp-plugins/data/lib/transform.js:21-104`。 | `data` 负责记录、表格和报告数据，不负责网页登录、页面动作、OOXML 版式或媒体生成。下一步是稳定 schema/质量状态、接入共享 provenance manifest、保留空结果表头与完整输出的可复核关系；不要把通用 Artifact 另拆成包。 |
| **P1** | **Word/PPT 生成与读取、PDF/标签拆分、模板、渲染和视觉复核 → `office`** | office 包当前负责 DOCX/PPTX、Markdown 子集、文本读取和 OOXML 校验：`dsh-crawshrimp-plugins/office/README.zh-CN.md:1-3,29-43,69-88`。渲染、页图、contact sheet、revision/hash 和结构审计线索已有：`core/office/render.py:28-119`、`core/office/preview.py:13-267`、`core/office/validate.py:10-80`。标签/PDF 处理已有：`core/amazon_label_splitter.py:24-188,225-297`、`core/shenhui_pdf_screenshot.py:89-115,391-522,598-674,909-966`。 | 将 PDF、Amazon 标签、图片打包、模板和 LibreOffice/PyMuPDF/Pillow 渲染作为 office 的扩展工作流，不建 PDF/label repo。保留 `visual: not_run`、已渲染但未人工/模型验收和 revision 不匹配等真实状态；Office COM、宏和任意 Python 执行仍不属于包。 |
| **P0/P1（可选新家族）** | **原生桌面应用、窗口、AX/UIA、受控键鼠和读回 → `desktop`** | Computer Use 已有平台分层和执行闭环：`integrations/deepseek-harness/skills/crawshrimp-computer-use/SKILL.md:34-79`；Python CLI/后端分发：`integrations/deepseek-harness/skills/crawshrimp-computer-use/scripts/computer_use.py:29-163,177-300`、`integrations/deepseek-harness/skills/crawshrimp-computer-use/scripts/cu/flows.py:1-120`、`integrations/deepseek-harness/skills/crawshrimp-computer-use/scripts/cu/common.py:17-199`、`integrations/deepseek-harness/skills/crawshrimp-computer-use/scripts/native/mac.swift`、`integrations/deepseek-harness/skills/crawshrimp-computer-use/scripts/cu/windows.py`。 | 这是与网页任务真正不同的可选顶层家族：新插件只做原生应用、窗口、AX/UIA 和系统级权限边界，不接管 browser 页面，也不依赖抓虾后端。先做 doctor/probe/observe/act/flow、取消、焦点、用户接管和 unknown 收据；OS 权限与跨平台验收量足够大时再独立发布。 |
| **P1（可选新家族）** | **图像/视频生产、provider 路由、本地素材选择、审核与编辑 → `media`** | 图像 provider 和视觉兼容线索：`core/image_providers.py:17-108,190-282`、`core/one_xm_image.py:126-260`、`integrations/deepseek-harness/scripts/glm-vision.mjs:215-340`、`integrations/deepseek-harness/scripts/office-vision.mjs:4-80`、`integrations/deepseek-harness/scripts/deepseek-flash.mjs:4-33`。图像/视频生成和结果物化：`core/ai_image_service.py` 的 `select_model_key`、`build_*_payload`、`_download_outputs`、`_generation_snapshot`、`materialize_*`，以及 `core/ai_video_generation_service.py:929-1128,1223-1562,1568-2007,3306-3524`。素材目录/审核：`core/bala_ai_video_materials.py:51-228,279-316`、`core/bala_ai_video_review.py:137-220,223-334,410-501`。 | 按媒体工作任务组织 provider/vision adapter、输入 manifest、下载校验、poster/events/archive、本地素材 batch、缩略图、选择和审核；不要按 DeepSeek/GLM/其他 provider 或单个技术 helper 拆仓库。真实供应商、费用、网络、ffmpeg 和人工/模型审核仍需逐项验收。 |
| **P2（条件成立才建）** | **商品、订单、库存与发布运营 → `business` 业务适配家族** | 现有平台 CLI 已体现目录、计划等任务边界：`skills/cli/semir-yunpan-cli/src/image-catalog.ts:21-158`、`skills/cli/semir-yunpan-cli/src/image-plan.ts:10-150`；自动化策略和收据线索见 `core/automation_program.py:25-124`、`core/automation_program_proofs.py:24-71`。 | 只有当“业务任务”本身需要独立权限、数据模型、回执和生命周期时才形成家族；平台特定 CLI 只是可插拔 adapter，不能因为实现语言、云盘或某个 endpoint 就单独拆包。私有账号、内部 API 和 seller script 保持在用户自有集成层。 |
| **不拆分** | **调度、后台作业、工作流、会话搜索与历史归档 → DSH 原生能力** | 当前 DSH `0.2.1-alpha.4` 已有 `dsh-schedule`、`dsh-jobs`、`dsh-tool-jobs`、`dsh-workflow`、`dsh-tool-workflow`、`dsh-session`、JSONL persistence、session search/query、attachment 和 output-retention；集成层已有 `integrations/deepseek-harness/scripts/session-archive.mjs:4-81`、`integrations/deepseek-harness/scripts/history-search.mjs:3-18`。 | 不建通用 scheduler/workflow/history wrapper。领域插件只产生自己的 policy/receipt，并通过稳定的 DSH tool/approval 接口接入；平台化 CLI carrier 也不改变这一归属。 |

## 三个当前维护包的职责

| 包 | 负责的工作 | 近期维护顺序 | 边界 |
|---|---|---|---|
| `browser` | 当前：网页打开、观察、动作、登录态、实时预览/人工接管、便携脚本、参数、翻页。后续：页面探查、网络/下载证据。 | **P0**：吸收 `scripts` 的工具和 manifest，统一 BrowserContext、审批、artifact 和证据 schema；再加入 page probe/network/download 结果。 | 不做原生桌面 AX/UIA；不接管用户已有页面或共享 Chrome profile；不复制 DSH 调度。 |
| `data` | JSON/CSV/XLSX 预览、profile、清洗、筛选、去重、排序、选列、重命名、报告数据和导出。 | **P0/P1**：稳定输入/输出 schema、质量状态、空结果表头和共享 provenance；保持有界、不可覆盖和审批写入。 | 不做网页动作、登录、复杂工作簿编辑、公式/宏执行、版式渲染或媒体生成。 |
| `office` | Word/PPT 生成/读取/校验，以及未来 PDF、标签、模板、渲染、页图和视觉复核。 | **P1**：接入已有 render/preview/validate 线索，先交付 revision 绑定和 `not_run` 语义，再扩展 PDF/标签模板。 | 不把 PDF/标签拆成新包；不执行 Office COM、宏、任意 Python 或未经复核的视觉结论。 |

## 下一批功能优先级

1. **保持 browser 的统一网页工作面（P0）**：0.2.0 已统一页面动作、登录态、实时预览/人工接管、便携脚本、参数和翻页；后续的 Probe、网络和下载证据继续放在 browser 插件中。`scripts` 保留历史和迁移指引。
2. **让 data 成为可信的记录与报告工作面（P0/P1）**：完成 JSON/CSV/XLSX 的 schema、清洗、质量状态、完整输出和共享 provenance 对齐，让 browser 产物能直接进入 data。
3. **扩展 office 为文档到交付物的工作面（P1）**：把 PDF、标签、模板、渲染和页级复核并入 Office，并保留“已生成/已渲染/已验收”的区别。
4. **按真实任务量决定新家族（P0/P1）**：原生桌面自动化和媒体生产是最清晰的两个可选家族；先用本地 fixture、receipt 和最小依赖矩阵证明边界，再分别接 OS 权限或外部 provider。
5. **业务系统集成保持条件化（P2）**：只有当云盘、卖家后台、库存或发布任务形成独立业务契约时才建立 adapter 家族；不因 provider、CLI 或技术 helper 单独拆包。

## 共享验收与风险

- **源码证据与就绪状态分离**：已有函数、脚本或历史产物不自动证明跨平台、真实账号、供应商可用或生产成功；每个功能都要有本地 fixture、结构化 receipt 和失败状态。
- **Browser**：Playwright/CDP 版本、隔离 context、storage state、页面刷新、短引用和下载时序会漂移；预览、同包 Skill、原生权限映射已通过真实 DSH Agent 和 Web UI 验收；动作按用户选定的原生权限执行，观察、网络和下载证据要有界并脱敏。
- **Data**：输入大小、单元格/列界限、类型语义、路径/软链接和不可覆盖写入要绑定到输出 manifest；空结果也必须保留声明的 schema。
- **Office 与 Media**：LibreOffice、PyMuPDF、Pillow、ffmpeg、字体、模型 provider、网络和费用都需要依赖探测与逐项验收；生成或渲染不等于人工/模型审核完成。
- **Desktop**：macOS 辅助功能/录屏、Windows UIA/UAC、焦点、遮挡、取消和用户接管需要平台矩阵；不修改 TCC/UAC，不自行提权。
- **DSH 与隐私**：调度/历史复用宿主内建 schema；截图、DOM、network、storage state、媒体元数据和 Office 文档默认按敏感数据处理，脱敏未完成时返回阻断状态。
