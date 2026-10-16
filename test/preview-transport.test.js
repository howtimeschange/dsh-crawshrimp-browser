import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import WebSocket from 'ws'
import { installPreviewTransport, PREVIEW_PATH } from '../lib/preview/transport.js'

class Mailbox {
  constructor(socket) {
    this.messages = []
    this.listeners = new Set()
    socket.on('message', data => {
      this.messages.push(JSON.parse(data.toString()))
      for (const listener of this.listeners) listener()
    })
  }
  async take(predicate) {
    const read = () => {
      const index = this.messages.findIndex(predicate)
      return index < 0 ? undefined : this.messages.splice(index, 1)[0]
    }
    const ready = read()
    if (ready) return ready
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error('Preview response timed out')) }, 2500)
      const check = () => {
        const message = read()
        if (!message) return
        clearTimeout(timer); this.listeners.delete(check); resolve(message)
      }
      this.listeners.add(check)
    })
  }
}

async function fixture(t, options = {}) {
  let route
  const changes = new Set(), controls = new Map(), subscriptions = new Map(), inputs = []
  const ownerPeer = { principal: { kind: 'owner' }, signal: new AbortController().signal }
  const pages = new Map([
    ['a', [{ pageId: 'a1', kind: 'interactive', title: 'A original', url: 'http://fixture/a' }, { pageId: 'a2', kind: 'interactive', title: 'A latest', url: 'http://fixture/a2' }]],
    ['b', [{ pageId: 'b1', kind: 'interactive', title: 'B secret', url: 'http://fixture/b' }]],
  ])
  const check = (session, pageId) => {
    if (!pages.get(session)?.some(page => page.pageId === pageId)) throw new Error('Page does not belong to this session')
  }
  const preview = {
    list: session => (pages.get(session) || []).map(page => ({ ...page, control: controls.has(page.pageId) ? 'human' : 'agent', status: 'connected', busy: false })),
    onChange: listener => { changes.add(listener); return () => changes.delete(listener) },
    async subscribe(session, pageId, listener) {
      check(session, pageId)
      subscriptions.set(listener, pageId)
      listener({ type: 'frame', pageId, dataUrl: 'data:image/jpeg;base64,AA==', width: 1280, height: 900, sequence: 1, ts: Date.now() })
      return async () => { subscriptions.delete(listener) }
    },
    async claimControl(session, pageId, owner) {
      check(session, pageId)
      if (controls.has(pageId) && controls.get(pageId) !== owner) throw new Error('Controlled by another client')
      controls.set(pageId, owner)
    },
    async releaseControl(owner, pageId) {
      for (const [id, heldBy] of controls) if (heldBy === owner && (!pageId || pageId === id)) controls.delete(id)
    },
    async input(session, pageId, owner, event) {
      check(session, pageId)
      if (controls.get(pageId) !== owner) throw new Error('Not controlled')
      if (event?.kind === 'arbitrary-cdp') return { ok: false, error: 'Unsupported input' }
      inputs.push({ pageId, event }); return { ok: true }
    },
  }
  const server = createServer((_req, res) => { res.writeHead(404).end() })
  server.on('upgrade', (req, socket, head) => {
    if (req.url === route?.path) route.handler(req, socket, head)
    else socket.destroy()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const ctx = {
    connection: { admit: request => {
      if (request.headers.origin !== 'http://trusted.local') return { rejection: 403 }
      if (request.headers.cookie !== 'owner=yes') return { rejection: 401 }
      return { peer: request.headers['x-test-non-owner'] ? { ...ownerPeer, principal: { kind: 'api' } } : ownerPeer }
    } },
    webServer: { registerUpgrade: value => { route = value; return () => { route = undefined } } },
  }
  const dispose = installPreviewTransport(ctx, preview, options)
  const sockets = []
  t.after(async () => {
    await dispose()
    for (const socket of sockets) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  const url = `ws://127.0.0.1:${server.address().port}${PREVIEW_PATH}`
  async function connect(session = 'a') {
    const socket = new WebSocket(url, { headers: { origin: 'http://trusted.local', cookie: 'owner=yes' } })
    sockets.push(socket)
    const mailbox = new Mailbox(socket)
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'hello', sessionId: session }))
    const initial = await mailbox.take(message => message.type === 'pages')
    return { socket, mailbox, initial, send: message => socket.send(JSON.stringify(message)) }
  }
  return { url, connect, dispose, controls, subscriptions, inputs, route: () => route }
}

test('preview WebSocket rejects anonymous, wrong-origin and non-owner callers before upgrade', async t => {
  const f = await fixture(t)
  for (const [headers, status] of [
    [{ origin: 'http://trusted.local' }, 401],
    [{ origin: 'http://untrusted.local', cookie: 'owner=yes' }, 403],
    [{ origin: 'http://trusted.local', cookie: 'owner=yes', 'x-test-non-owner': 'yes' }, 403],
  ]) {
    const socket = new WebSocket(f.url, { headers })
    await new Promise((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => { assert.equal(response.statusCode, status); response.resume(); socket.terminate(); resolve() })
      socket.on('error', () => {})
      socket.once('open', () => { socket.terminate(); reject(new Error('Unauthorized upgrade accepted')) })
    })
  }
})

test('preview channel binds one session, sends newest owned page first, and reports input rejection truthfully', async t => {
  const f = await fixture(t), a = await f.connect('a'), b = await f.connect('b')
  assert.deepEqual(a.initial.pages.map(page => page.pageId), ['a2', 'a1'])
  assert.deepEqual(b.initial.pages.map(page => page.pageId), ['b1'])
  a.send({ type: 'subscribe', pageId: 'b1' })
  assert.match((await a.mailbox.take(message => message.type === 'error')).message, /belong/)
  a.send({ type: 'hello', sessionId: 'b' })
  assert.match((await a.mailbox.take(message => message.type === 'error')).message, /cannot change/)
  a.send({ type: 'subscribe', pageId: 'a1' })
  assert.equal((await a.mailbox.take(message => message.type === 'frame')).pageId, 'a1')
  a.send({ type: 'input', pageId: 'a1', requestId: 'early', event: { kind: 'text', text: 'wrong' } })
  assert.equal((await a.mailbox.take(message => message.requestId === 'early')).ok, false)
  a.send({ type: 'claim', pageId: 'a1', requestId: 'claim' })
  assert.equal((await a.mailbox.take(message => message.requestId === 'claim')).ok, true)
  a.send({ type: 'input', pageId: 'a1', requestId: 'valid', event: { kind: 'text', text: '中文输入' } })
  assert.equal((await a.mailbox.take(message => message.requestId === 'valid')).ok, true)
  assert.equal(f.inputs[0].event.text, '中文输入')
  a.send({ type: 'input', pageId: 'a1', requestId: 'invalid', event: { kind: 'arbitrary-cdp' } })
  const invalid = await a.mailbox.take(message => message.requestId === 'invalid')
  assert.equal(invalid.ok, false); assert.match(invalid.error, /Unsupported/)
  assert.equal(f.controls.size, 0)
  assert.equal(f.inputs.length, 1)
})

test('disconnect, idle timeout and plugin teardown remove subscriptions and human control', async t => {
  const f = await fixture(t, { idleTimeoutMs: 180 })
  const a = await f.connect('a')
  a.send({ type: 'subscribe', pageId: 'a1' })
  await a.mailbox.take(message => message.type === 'frame')
  a.send({ type: 'claim', pageId: 'a1', requestId: 'claim' })
  await a.mailbox.take(message => message.requestId === 'claim')
  assert.equal(f.controls.size, 1)
  await once(a.socket, 'close')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.controls.size, 0); assert.equal(f.subscriptions.size, 0)
  const b = await f.connect('b')
  const closing = once(b.socket, 'close')
  await f.dispose(); await closing
  assert.equal(f.route(), undefined)
  assert.equal(f.controls.size, 0); assert.equal(f.subscriptions.size, 0)
})
