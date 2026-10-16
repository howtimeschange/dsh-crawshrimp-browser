import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'

import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import * as browserPlugin from '../lib/index.js'
import { TOOL_NAMES } from '../lib/index.js'

const chromePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean).find(existsSync)

const phaseScript = `;(async () => {
  const phase = window.__CRAWSHRIMP_PHASE__
  const file = document.querySelector('#upload')?.files?.[0]
  if (phase === 'main') return {
    success: true,
    data: [{ phase }],
    meta: {
      action: 'upload',
      paths: ['inputs/source.txt'],
      selector: '#upload',
      shared_key: 'upload',
      next_phase: 'download',
    },
  }
  if (phase === 'download') return {
    success: true,
    data: [{ phase, uploadedName: file?.name || '', uploadedSize: file?.size || 0 }],
    meta: {
      action: 'download_urls',
      url: '/download',
      filename: 'export.csv',
      expectedMime: 'text/csv',
      shared_key: 'download',
      next_phase: 'complete',
    },
  }
  return {
    success: true,
    data: [{ phase, shared: window.__CRAWSHRIMP_SHARED__ }],
    meta: { action: 'complete' },
  }
})()`

test('real plugin script_run executes phase upload and download capabilities', { skip: !chromePath && process.platform !== 'darwin' }, async t => {
  const csv = 'sku,qty\nA,3\n'
  const server = createServer((request, response) => {
    if (request.url === '/download') {
      response.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="export.csv"',
      })
      response.end(csv)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <title>Phase transfer fixture</title>
      <main><input id="upload" type="file"></main>`)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => server.close(() => resolve())))

  const adapterRoot = await mkdtemp(join(tmpdir(), 'dsh-browser-phase-adapter-'))
  const workspaceDir = await mkdtemp(join(tmpdir(), 'dsh-browser-phase-workspace-'))
  t.after(async () => {
    await rm(adapterRoot, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
  })
  await mkdir(join(adapterRoot, 'phase-fixture'))
  await mkdir(join(workspaceDir, 'inputs'))
  await writeFile(join(workspaceDir, 'inputs', 'source.txt'), 'phase upload fixture\n')
  await writeFile(join(adapterRoot, 'phase-fixture', 'transfer.js'), phaseScript)
  await writeFile(join(adapterRoot, 'phase-fixture', 'manifest.yaml'), stringify({
    id: 'phase-fixture',
    name: 'Phase transfer fixture',
    version: '1.0.0',
    entry_url: `http://127.0.0.1:${server.address().port}/`,
    tasks: [{ id: 'transfer', name: 'Transfer', script: 'transfer.js' }],
  }))

  const ctx = new Context()
  t.after(async () => {
    if (ctx.fiber.uid !== null) await ctx.fiber.dispose()
  })
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  ctx.provide('approval', { effectivePolicy: () => 'ask', request: async () => 'allowed-once' })

  await ctx.plugin(Tools)
  await ctx.plugin(browserPlugin, {
    executablePath: chromePath,
    channel: 'chrome',
    headless: true,
    previewEnabled: false,
    adapterRoots: [adapterRoot],
    workspaceDir,
    scriptTimeoutMs: 30000,
  })

  const execution = {
    callId: 'phase-capabilities-integration',
    name: TOOL_NAMES.scriptRun,
    arguments: { adapter_id: 'phase-fixture', task_id: 'transfer' },
    agent: { id: 'phase-capabilities-agent', session: {} },
    signal: new AbortController().signal,
  }
  const response = await ctx.tools.execute(execution)
  assert.equal(response.isError, false, JSON.stringify(response).slice(0, 2000))
  const result = JSON.parse(response.content[0].text)
  assert.equal(result.success, true)
  assert.deepEqual(result.data.slice(0, 2), [
    { phase: 'main' },
    { phase: 'download', uploadedName: 'source.txt', uploadedSize: 21 },
  ])
  const final = result.data.at(-1)
  assert.equal(final.phase, 'complete')
  assert.equal(final.shared.upload.receipt.filename, 'source.txt')
  assert.equal(final.shared.upload.receipt.bytes, 21)
  assert.equal(final.shared.download.receipt.filename, 'export.csv')
  assert.equal(final.shared.download.receipt.mime, 'text/csv')
  assert.equal(final.shared.download.receipt.bytes, Buffer.byteLength(csv))
  const downloaded = await readFile(join(workspaceDir, final.shared.download.receipt.path), 'utf8')
  assert.equal(downloaded, csv)
})
