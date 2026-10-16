# Migrate standalone Scripts to Browser 0.2.0

All webpage work is maintained in `dsh-crawshrimp-browser`: interactive page actions, login state, portable scripts, parameters and pagination. The old `dsh-crawshrimp-scripts` repository is retired; its 0.1.0 history and release remain available. There is no standalone Scripts 0.2.0 release and Browser does not depend on the old package.

## Upgrade an existing DSH profile

1. Copy your explicit adapter roots, artifact workspace, private login-state path and browser configuration into the `crawshrimp-browser` profile row. Keep the same `workspaceDir` to retain access to previous artifacts.
2. Remove the old package, then install or upgrade Browser:

```sh
dsh plugin --profile ecommerce remove -w dsh-crawshrimp-scripts
dsh plugin --profile ecommerce add -w github:howtimeschange/dsh-crawshrimp-browser#v0.2.0
dsh --profile ecommerce --dump-config
```

3. Remove any custom profile row named `crawshrimp-scripts` / `dsh-crawshrimp-scripts` from your overlay. Keep only the Browser row below; if Browser was already installed, merge your options into that existing row.

```yaml
- id: crawshrimp-browser
  name: dsh-crawshrimp-browser
  config:
    channel: chrome
    headless: true
    adapterRoots:
      - /absolute/path/to/adapters
    workspaceDir: /absolute/path/to/existing/artifacts-workspace
    storageStatePath: /absolute/path/to/private/state.json
    scriptTimeoutMs: 120000
    maxPages: 1
```

Omit `storageStatePath` if no exported login state is needed. `CHROME_PATH` is not automatically consumed by the plugin; set `executablePath` explicitly or through a profile expression if using a custom executable. Browser 0.2.0 uses the same browser connection for interactive sessions and scripts, with a separate context for every session and script run. Runs never adopt interactive or pre-existing merchant pages.

## Tool/config mapping

| Scripts 0.1.0 | Browser 0.2.0 |
| --- | --- |
| `crawshrimp_scripts_list` | `crawshrimp_browser_script_list` |
| `crawshrimp_scripts_run` | `crawshrimp_browser_script_run` |
| No offline validator | `crawshrimp_browser_script_validate` |
| `browserChannel` | `channel` (`chrome` or `chromium`) |
| `timeoutMs` | `scriptTimeoutMs` |
| `adapterRoots`, `workspaceDir` | Same names; copy explicit values |
| `executablePath`, `cdpEndpoint`, `storageStatePath` | Same names; use absolute local file paths |
| `maxScriptBytes`, `maxOutputBytes` | Same names |
| Default `~/.dsh-crawshrimp-scripts` workspace | Default `~/.dsh-crawshrimp-browser`; set the old path explicitly if needed |

Update saved prompts and workflows to the new tool names. Portable manifests and async-IIFE scripts remain supported. Declared parameters and task entry URLs are now validated; unsupported backend actions receive migration diagnostics. `max_pages` bounds pagination at 1–100 pages and a remaining `has_more` at that bound is an error. A script returning `success:false` produces a real tool failure. Script execution follows native DSH permissions: Full Access (`danger-full-access` + `never`) runs automatically; other combinations require native approval. A restricted `never` policy still rejects the call.

中文：页面脚本已合并到浏览器包。先迁移 adapterRoots、workspaceDir、storageStatePath 等配置，再移除旧插件并安装 Browser 0.2.0。`browserChannel` 改为 `channel`，`timeoutMs` 改为 `scriptTimeoutMs`；工具名前缀按上表替换。原产物和登录文件不会自动搬迁或删除；旧仓库保留历史，停止独立更新。
