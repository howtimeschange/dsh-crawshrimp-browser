# 便携运行时

脚本是 async IIFE，返回 `{success:boolean,data:array,meta:object}`。只有手工 trigger 和基本文本、数字、选项、复选框、日期参数可移植。入口 URL 为 http(s)。

每个分页从 `main` 阶段开始；`window.__CRAWSHRIMP_PHASE__` 表示阶段名，`__CRAWSHRIMP_PAGE__` 是从 1 开始的页号。`__PARAMS__` 与 `__CRAWSHRIMP_PARAMS__` 是相同参数对象，`__CRAWSHRIMP_SHARED__` 是上一阶段传来的 JSON 状态。导航后重新注入，不依赖旧 DOM handle。

| meta.action | 语义 |
| --- | --- |
| complete / 省略 | 结束当前页；`has_more:true` 才进入下一页 |
| next_phase | 转入 `next_phase` 指定阶段，不增加页号 |
| reload_page | 重新加载当前页，然后进入 `next_phase`，未指定时保留阶段 |
| abort | 立即失败，reason/error 记录原因，不继续操作 |
| upload / inject_files / file_chooser_upload | `args` 使用上传工具参数，路径相对 workspace |
| download / download_urls / download_clicks | `args` 使用下载工具参数，返回文件回执 |
| capture_requests | `args` 使用网络捕获工具参数，结果为脱敏证据 |

未实现的动作明确失败。不要把 Harness 的任意跨 target CDP、OCR、模型链或系统 Downloads 目录扫描当作可用动作。

`meta.shared` 替换共享对象；能力动作结果放进 `meta.shared_key`（默认 `action_result`）。`shared_append:true` 将结果追加到该键的数组。shared 上限 2 MiB；所有分页累计输出受 `maxOutputBytes` 限制。默认每页最多 20 阶段，可用 `max_phases` 调整到 1–200；分页用 `max_pages`，上限 100。总运行时间受 `scriptTimeoutMs` 限制。失败结果不应触发后续动作。

示例：

```js
;(async () => {
  const phase = window.__CRAWSHRIMP_PHASE__
  if (phase === 'main') return {
    success: true, data: [],
    meta: { action: 'next_phase', next_phase: 'read', shared: { label: window.__PARAMS__.label } }
  }
  const rows = [...document.querySelectorAll('table tr')].map(row => ({ text: row.innerText }))
  return { success: true, data: rows, meta: { action: 'complete', label: window.__CRAWSHRIMP_SHARED__.label } }
})()
```

每次运行创建新的隔离 context 和只读预览。交互页的实时登录态不自动共享；登录型脚本需要配置私有 storage state。取消/超时销毁本次页面与 context，不重放可能已提交的业务写操作。原生 DSH 调用取消负责停止运行，运行中人工混控和宿主定时调度不属于此便携协议。
