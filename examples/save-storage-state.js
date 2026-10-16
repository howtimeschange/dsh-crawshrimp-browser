import { createInterface } from 'node:readline/promises'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const [url, rawOutput] = process.argv.slice(2)
if (!url || !/^https?:\/\//i.test(url) || !rawOutput) {
  console.error('Usage: node examples/save-storage-state.js https://example.com /absolute/path/state.json')
  process.exitCode = 2
} else {
  const output = resolve(rawOutput)
  const launch = { headless: false }
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH
  else launch.channel = 'chrome'
  const browser = await chromium.launch(launch)
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const readline = createInterface({ input: process.stdin, output: process.stdout })
    await readline.question('在打开的浏览器中完成登录后按 Enter 保存状态；文件已存在时不会覆盖：')
    readline.close()
    const state = JSON.stringify(await context.storageState(), null, 2)
    await mkdir(dirname(output), { recursive: true })
    const handle = await open(output, 'wx', 0o600)
    try {
      await handle.writeFile(state, 'utf8')
    } finally {
      await handle.close()
    }
    console.log(`Saved Playwright storage state to ${output}`)
  } finally {
    await browser.close()
  }
}
