# dsh-crawshrimp-browser

这是一个独立的 DeepSeek Harness（DSH）浏览器插件。它直接使用
`playwright-core`，为每个 DSH 会话创建独立的 Playwright
`BrowserContext`。它不导入抓虾、不调用抓虾 HTTP API，也不会读取或接管已有的
电商页面。

## 能力

插件注册以下工具名：

- `crawshrimp_browser_open`：在新的插件自有页面打开 `http` 或 `https` 地址。
- `crawshrimp_browser_observe`：返回有长度上限的正文和可操作元素引用。
- `crawshrimp_browser_click`：点击观察结果中的引用或 CSS 选择器。
- `crawshrimp_browser_fill`：向观察结果中的引用或 CSS 选择器填入文本。
- `crawshrimp_browser_screenshot`：返回有大小上限的 PNG；纯观察不弹审批。
- `crawshrimp_browser_close`：关闭插件自有页面。

打开、点击、填充、关闭属于浏览器动作，统一经过 DSH 原生审批服务。没有审批
服务时会 fail closed；是否允许调用由 DSH 原生审批策略决定。取消调用会关闭该会话
拥有的页面和上下文；不确定的动作不会自动重试。

## 浏览器前置条件

包内只包含 Playwright 驱动，不包含浏览器二进制文件。请在机器上安装 Chrome 或
Chromium，并配置 `executablePath` 或 `channel`。macOS 默认使用系统 Chrome
（`channel: chrome`）；CI 如果没有 Chrome channel，可通过 `CHROME_PATH` 设置
`executablePath`。也可以设置 `cdpEndpoint`，但插件仍会创建自己的新上下文；卸载
时只断开连接，不关闭外部浏览器。

## 使用 DSH 官方插件加载器安装

仓库按 GitHub 安装方式准备，没有假定已经发布 npm 包：

```sh
dsh plugin --profile demo add -w github:howtimeschange/dsh-crawshrimp-browser#v0.1.0
```

本地验证：

```sh
git clone https://github.com/howtimeschange/dsh-crawshrimp-browser.git
cd dsh-crawshrimp-browser
npm ci
dsh plugin --profile demo add -w .
```

加载器会读取 `package.json` 中的 `dsh.bundle.patch`，并应用包内的
`cordis.patch.yml`。它生成的配置项等价于：

```yaml
- id: crawshrimp-browser
  name: dsh-crawshrimp-browser
  config:
    channel: chrome
    headless: true
```

如需指定浏览器可执行文件，可在 profile overlay 中使用绝对路径：

```yaml
- id: crawshrimp-browser
  name: dsh-crawshrimp-browser
  config:
    executablePath: !!js process.env.CHROME_PATH ?? ''
    channel: chrome
    headless: true
```

`executablePath` 优先于 `channel`；主机提供 Chromium 时可使用
`channel: chromium`。用户管理的 Chrome 可通过 `cdpEndpoint`（例如
`http://127.0.0.1:9222`）连接，但插件不会采用其中已有的上下文或页面。
需要人工登录时可以设置 `headless: false`，登录发生在插件自有的 DSH 会话上下文
中；会话结束时该上下文一并释放，插件不会加载或持久化共享的 Chrome 配置目录。

## 开发验证

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

测试会启动真实的无头 Chrome，并访问本地合成页面；不会访问真实电商站点或账号。
可用 `CHROME_PATH` 覆盖测试使用的 Chrome 路径。
