import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import WebSocket from 'ws'
import * as browser from '../lib/index.js'

const chromePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync)

test('actual tool actions, authenticated preview control and isolated script-page lifetime work together', { skip: !chromePath }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preview-integrated-'))
  let upgrade
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><title>Preview integration</title><input id="name" value="original"><button id="save" onclick="document.querySelector(\'#status\').textContent=document.querySelector(\'#name\').value">Save</button><p id="status">Ready</p><a id="popup" target="_blank" href="/child">Open popup</a>')
  })
  server.on('upgrade', (request, socket, head) => {
    if (request.url === upgrade?.path) upgrade.handler(request, socket, head)
    else socket.destroy()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(root, 'manifest.yaml'), `id: preview-integration\nname: Preview integration\nversion: 1.0.0\nentry_url: ${origin}\ntasks:\n  - id: slow\n    name: Slow script\n    script: slow.js\n`)
  await writeFile(join(root, 'slow.js'), `;(async()=>{document.querySelector('#status').textContent='Script visible';await new Promise(r=>setTimeout(r,10000));return {success:true,data:[],meta:{}}})()`)
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  ctx.provide('approval', { request: async () => 'allowed-once' })
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal }
  ctx.provide('connection', { admit: request => request.headers.cookie === 'test-owner=yes' ? { peer } : { rejection: 401 } })
  ctx.provide('webServer', { registerUpgrade: value => { upgrade = value; return () => { upgrade = undefined } } })
  let fiber, socket, scriptPromise, scriptController
  const messages = [], listeners = new Set()
  async function take(predicate) {
    const read = () => { const i = messages.findIndex(predicate); return i < 0 ? undefined : messages.splice(i, 1)[0] }
    const ready = read(); if (ready) return ready
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Integrated preview event timed out')) }, 8000)
      const check = () => { const m = read(); if (m) { clearTimeout(timer); listeners.delete(check); resolve(m) } }
      listeners.add(check)
    })
  }
  let callId = 0
  const agentA = { id: 'agent-a', session: { id: 'session-a' } }
  const agentB = { id: 'agent-b', session: { id: 'session-b' } }
  const execute = (name, args, agent = agentA, signal = new AbortController().signal) => ctx.tools.execute({ name, arguments: args, agent, callId: `preview-integration-${++callId}`, signal })
  const ok = async (...args) => {
    const r = await execute(...args); assert.equal(r.isError, false, JSON.stringify(r)); return JSON.parse(r.content[0].text)
  }
  const send = value => socket.send(JSON.stringify(value))
  try {
    await ctx.plugin(ToolRuntime)
    fiber = ctx.plugin(browser, { executablePath: chromePath, headless: true, adapterRoots: [root], workspaceDir: root })
    await fiber
    const a = await ok('crawshrimp_browser_open', { url: origin })
    const b = await ok('crawshrimp_browser_open', { url: origin }, agentB)
    assert.ok(upgrade)
    socket = new WebSocket(origin.replace('http:', 'ws:') + upgrade.path, { headers: { cookie: 'test-owner=yes' } })
    socket.on('message', bytes => { messages.push(JSON.parse(bytes.toString())); for (const fn of listeners) fn() })
    await once(socket, 'open')
    send({ type: 'hello', sessionId: 'session-a' })
    const list = await take(m => m.type === 'pages')
    assert.deepEqual(list.pages.map(page => page.pageId), [a.pageId])
    assert.equal(list.pages.some(page => page.pageId === b.pageId), false)
    send({ type: 'subscribe', pageId: a.pageId })
    assert.ok((await take(m => m.type === 'frame' && m.pageId === a.pageId)).dataUrl.startsWith('data:image/jpeg;base64,'))
    send({ type: 'claim', pageId: a.pageId, requestId: 'claim' })
    assert.equal((await take(m => m.requestId === 'claim')).ok, true)
    const blocked = await execute('crawshrimp_browser_fill', { pageId: a.pageId, selector: '#name', value: 'must not write' })
    assert.equal(blocked.isError, true)
    assert.match(JSON.stringify(blocked), /用户接管|human|control/i)
    send({ type: 'release', pageId: a.pageId, requestId: 'release' })
    assert.equal((await take(m => m.requestId === 'release')).ok, true)
    await ok('crawshrimp_browser_fill', { pageId: a.pageId, selector: '#name', value: '中文集成验收' })
    await ok('crawshrimp_browser_click', { pageId: a.pageId, selector: '#save' })
    assert.match((await ok('crawshrimp_browser_observe', { pageId: a.pageId })).text, /中文集成验收/)
    scriptController = new AbortController()
    scriptPromise = execute('crawshrimp_browser_script_run', { adapter_id: 'preview-integration', task_id: 'slow' }, agentA, scriptController.signal)
    const running = await take(m => m.type === 'pages' && m.pages.some(page => page.kind === 'script'))
    const script = running.pages.find(page => page.kind === 'script')
    assert.ok(script.runId)
    send({ type: 'subscribe', pageId: script.pageId })
    assert.ok((await take(m => m.type === 'frame' && m.pageId === script.pageId)).dataUrl)
    send({ type: 'claim', pageId: script.pageId, requestId: 'script-claim' })
    assert.equal((await take(m => m.requestId === 'script-claim')).ok, false)
    scriptController.abort()
    assert.equal((await scriptPromise).isError, true)
    await take(m => m.type === 'pages' && m.pages.every(page => page.kind !== 'script'))
    assert.match((await ok('crawshrimp_browser_observe', { pageId: a.pageId })).text, /中文集成验收/)
    await ok('crawshrimp_browser_click', { pageId: a.pageId, selector: '#popup' })
    const popupList = await take(m => m.type === 'pages' && m.pages.filter(page => page.kind === 'interactive').length === 2)
    const popup = popupList.pages.find(page => page.pageId !== a.pageId)
    assert.ok(popup, 'owned popup was registered for the same DSH session')
    await ok('crawshrimp_browser_close', { pageId: popup.pageId })
    const closing = once(socket, 'close')
    await fiber.dispose(); await closing
    assert.equal(upgrade, undefined)
    assert.equal(ctx.tools.get('crawshrimp_browser_open'), undefined)
  } finally {
    scriptController?.abort(); await scriptPromise?.catch(() => {})
    socket?.terminate()
    await ctx.fiber.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
