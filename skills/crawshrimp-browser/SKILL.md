---
name: crawshrimp-browser
description: 当 Agent 需要通过 DSH 抓虾浏览器插件观察、操作、登录或复用网页流程时使用；适用于当前会话自有的 Playwright 页面和便携页面脚本，不依赖抓虾后端。
---

# 抓虾浏览器 Skill

这个 Skill 把抓虾的“先观察、再操作、再核验、最后沉淀流程”带到
`dsh-crawshrimp-browser`。插件为每个 DSH agent session 创建自己的
Playwright `BrowserContext`，页面、cookie 和登录态只属于该 session。`cdpEndpoint`
只是可选的连接方式；插件不会扫描、接管或复用外部浏览器已经存在的 context/page，
也不要求抓虾服务、固定的 9222 端口、Python 脚本或其他后端。

## 真实工具契约

先记住 `pageId`，再在同一 session 中复用它。`crawshrimp_browser_observe` 返回的
`ref` 只在这一次观察结果有效；页面导航、重渲染或再次观察后必须重新观察。

| 工具 | 用途 | 审批 |
| --- | --- | --- |
| `crawshrimp_browser_open` | 新建插件自有页面并打开 `http(s)` URL | 原生权限映射 |
| `crawshrimp_browser_pages` | 列出当前 session 自有页面 | 只读 |
| `crawshrimp_browser_navigate` | 导航一个自有页面 | 原生权限映射 |
| `crawshrimp_browser_observe` | 读取有上限的正文、标题、URL 和可操作元素 | 只读 |
| `crawshrimp_browser_click` | 按 `ref` 或 CSS selector 点击 | 原生权限映射 |
| `crawshrimp_browser_fill` | 向 `ref` 或 CSS selector 填入文本 | 原生权限映射 |
| `crawshrimp_browser_select` | 选择 HTML `option` 的 `value` | 原生权限映射 |
| `crawshrimp_browser_press` | 发送 Playwright 按键或 `Modifier+Key` 快捷键 | 原生权限映射 |
| `crawshrimp_browser_wait` | 等待 selector 可见/隐藏或等待有上限的文本 | 只读 |
| `crawshrimp_browser_screenshot` | 获取当前自有页面的有大小上限 PNG | 只读 |
| `crawshrimp_browser_close` | 关闭一个自有页面 | 原生权限映射 |
| `crawshrimp_browser_script_list` | 发现 adapter 及其任务 | 只读 |
| `crawshrimp_browser_script_validate` | 离线校验任务和参数 | 只读，不启动浏览器 |
| `crawshrimp_browser_script_run` | 在隔离 context/page 中运行一个便携脚本并保存 JSON artifact | 原生权限映射 |

需要具体页面目标时，优先传 `observe` 的 `ref`；只有没有稳定 ref 或页面本身要求
使用稳定选择器时才传 `selector`。`press` 没有目标时作用于页面键盘。`wait` 接受
`selector` 或 `text` 二选一，`screenshot` 的 `fullPage` 只用于确实需要整页证据的场景。

## 网页操作循环

1. 先把请求归类为 `read`（读取/汇总）、`operate`（筛选、翻页、填充、打开详情）或
   `flow`（跨页、跨弹窗的重复流程）。先调用 `pages` 了解当前 session，必要时调用
   `open`；不要假设页面已经存在，也不要打开新的外部浏览器来绕过 session 归属。
2. 每次页面进入、导航或关键状态变化后调用 `observe`，记录 URL、标题、正文中的结果、
   表格行和可操作元素。先读业务约束、登录状态、数量/比例/禁用态，再做写操作。
3. 使用最小的一步动作：`click`、`fill`、`select` 或 `press`。填充字段不等于提交；
   点击提交、发布、删除、购买、支付、发送或保存前，必须得到该次外部副作用的明确授权。
4. 每一步都设置可观察的停止条件，并用 `wait`、再次 `observe`、`pages`、截图或页面
   结果核验。不要把“点击成功”当成业务成功；跨页操作还要核对 URL、返回数据和页面读回。
5. 任务完成后记录所用页面、目标、参数、结果和失败原因。重复使用的流程再沉淀为 adapter
   脚本，而不是继续堆叠脆弱的坐标点击。

当前插件只暴露上表工具。它没有抓虾旧版的通用 CDP 请求抓取、下载管理、PDF/标签处理、
任意 JS evaluate、脚本暂停或运行中脚本人工混控接口；不要调用、假设或宣传这些能力。需要
这些功能时，先把需求拆成现有页面工具能验证的读取/操作，或明确记录为后续插件能力。

## 登录和实时预览

页面需要登录时，优先让用户在 DSH Web 的真实预览中完成登录：用户点击“接管操作”，在
该插件自有页面中完成登录，再点击“恢复 Agent”。接管是一次明确的页面级操作，不需要为
每次鼠标移动、滚动或按键重复询问；接管期间 Agent 的写操作会被拒绝，归还后才继续。
也可以在 profile 中配置私有的 `storageStatePath`，但不要读取、输出或提交 cookie、token
和 storage-state 内容。`headless: false` 只表示可以看见插件自己的浏览器窗口；它不会把
用户已有 Chrome 页面变成插件页面。

实时预览显示的是插件真实 Playwright page 的画面。交互页面可以在面板中接管输入；脚本
运行页带有运行标识，仅允许观看，不能由人工向脚本页注入输入。脚本结束、失败或取消后，
脚本页和预览资源会清理，交互页面保持独立。

动作遵循 DSH 当前会话的原生权限。用户选择“完全权限”（宿主解析出
`sandboxPolicy.resolve({ session }).mode === 'danger-full-access'` 且
`approval.effectivePolicy(session) === 'never'`）时，插件把它视为持续授权，工具会自动
执行，不再发起额外审批。其他组合仍走原生审批：受限模式下的 `never` 会拒绝；
`danger-full-access` 与 `ask` 组合仍会询问。不要只凭一个 `never` 推断允许或拒绝，
也不要看到原生通用提示就不尝试工具；以实际权限组合和工具返回为准。没有可验证的
原生权限服务时保持失败关闭。用户已授权当前具体操作时，不重复请求对话确认；
完全权限也不扩大用户任务范围或授权未要求的业务副作用。

## 便携脚本和流程沉淀

先用 `crawshrimp_browser_script_list` 找到 adapter/task，再用
`crawshrimp_browser_script_validate` 校验参数和脚本，最后才调用
`crawshrimp_browser_script_run`。脚本每次在新的隔离 BrowserContext 和 page 中运行，默认
只运行一个页面；需要翻页时用 `max_pages`，上限由插件限制。

manifest 只使用当前插件支持的字段：`id`、`name`、`version`、`description`、`author`、
`entry_url`、`skip_auth`、`trigger: { type: manual }`、`tasks`，以及任务支持的文本、
数字、选项、复选框和日期参数。脚本必须是返回
`{ success, data, meta }` 的 async IIFE。运行时提供这些页面脚本全局变量：

- `window.__PARAMS__` 与 `window.__CRAWSHRIMP_PARAMS__`：同一份 JSON 参数；
- `window.__CRAWSHRIMP_PAGE__`：当前页序号；
- `window.__CRAWSHRIMP_PHASE__`：当前阶段名；
- `window.__CRAWSHRIMP_SHARED__`：可由 `meta.shared` 传递的 JSON 状态。

用 `meta.has_more: true` 请求下一页；脚本只能完成自己的页面脚本逻辑，不能依赖抓虾
后端、桌面文件选择器、模型链、CDP 动作或本地调度。脚本结果会写入配置的 workspace，
工具返回 `data`、`meta` 和相对 workspace 的 `artifact` 路径。脚本页面的预览始终是只读
观看；脚本执行遵循相同原生权限映射，并按实际副作用判断是否在用户授权范围内。

把一个成功流程沉淀为 adapter 时，保留入口 URL、参数定义、登录前置条件、每一步的可观测
读回和停止条件，并在提交 manifest 前再次运行 `script_validate`。不要把一次性的真实
账号、cookie、token、私有 URL 或无证据的商家成功写入脚本或文档。
