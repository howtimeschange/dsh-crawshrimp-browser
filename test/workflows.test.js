import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

const chromePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync)

test('native DSH API-first, verify, journal, distill/reuse and draft-test-publish workflow', { skip: !chromePath }, async t => {
  let quantity = 1
  const server = createServer(async (req, res) => {
    if (req.url === '/api/export') { res.setHeader('content-type', 'text/csv'); res.end(`sku,quantity\nA,${quantity}\n`); return }
    if (req.url.startsWith('/api/item')) {
      if (req.method === 'POST') { let text = ''; for await (const part of req) text += part; quantity = JSON.parse(text).quantity }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ quantity, token: 'must-not-leak' })); return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<title>电商工作流演示</title><label>数量<input id="quantity" value="${quantity}"></label><button id="save">保存</button><p id="status">ready</p><script>
      window.shopClient = { load: () => fetch('/api/item').then(r=>r.json()) };
      document.querySelector('#save').onclick=async()=>{const data=await fetch('/api/item',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quantity:Number(document.querySelector('#quantity').value)})}).then(r=>r.json());document.querySelector('#status').textContent='已保存 '+data.quantity;};
      fetch('/api/item');</script>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  const workspaceDir = await mkdtemp(join(tmpdir(), 'dsh-workflow-'))
  t.after(() => rm(workspaceDir, { recursive: true, force: true }))
  const ctx = new Context()
  t.after(async () => { if (ctx.fiber.uid !== null) await ctx.fiber.dispose() })
  let approvals = 0
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  ctx.provide('approval', { effectivePolicy: () => 'never', request: async () => { approvals++; return 'rejected' } })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) })
  await ctx.plugin(Tools)
  await ctx.plugin(plugin, { executablePath: chromePath, workspaceDir, previewEnabled: false })
  const agent = { id: 'owner', session: {} }, other = { id: 'other', session: {} }
  const call = async (name, args, who = agent, error = false) => {
    const result = await ctx.tools.execute({ callId: `flow-${Math.random()}`, name: `crawshrimp_browser_${name}`, arguments: args, agent: who, signal: new AbortController().signal })
    assert.equal(result.isError, error, JSON.stringify(result).slice(0, 1500))
    return error ? result : JSON.parse(result.content[0].text)
  }
  const opened = await call('open', { url })
  const pageId = opened.pageId
  const probe = await call('probe', { pageId })
  assert.ok(probe.artifact.path)
  assert.ok(probe.pageModel.modules.some(module => module.name === 'shopClient' && module.methods.includes('load')))
  const requested = await call('request', { pageId, url: '/api/item', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { quantity: 3 } })
  assert.equal(quantity, 3)
  assert.equal(requested.status, 200)
  assert.ok(!JSON.stringify(requested).includes('must-not-leak'))
  const apiVerified = await call('verify', { pageId, checks: [{ kind: 'response', evidenceId: requested.evidenceId, status: 200, path: 'quantity', equals: 3 }] })
  assert.equal(apiVerified.verified, true)
  const fill = await call('fill', { pageId, selector: '#quantity', value: '7' })
  const click = await call('click', { pageId, selector: '#save' })
  await call('wait', { pageId, text: '已保存 7' })
  const verified = await call('verify', { pageId, checks: [{ kind: 'text', selector: '#status', equals: '已保存 7' }] })
  assert.equal(verified.verified, true)
  const distilled = await call('workflow', { pageId, action: 'distill', name: '更新数量并回读', evidenceIds: [fill.evidenceId, click.evidenceId, verified.evidenceId] })
  assert.equal(distilled.workflow.steps.length, 2)
  const replayed = await call('workflow', { pageId, action: 'run', path: distilled.artifact.path })
  assert.equal(replayed.success, true)
  const download = await call('download', { pageId, url: '/api/export', filename: 'products.csv', expectedMime: 'text/csv' })
  const fileVerified = await call('verify', { pageId, checks: [{ kind: 'file', path: download.path, expectedSha256: download.sha256, minBytes: 1, expectedMime: 'text/csv' }] })
  assert.equal(fileVerified.verified, true)
  const exportFlow = await call('workflow', { pageId, action: 'distill', evidenceIds: [download.evidenceId, fileVerified.evidenceId] })
  quantity = 9
  const exportedAgain = await call('workflow', { pageId, action: 'run', path: exportFlow.artifact.path })
  assert.equal(exportedAgain.success, true)
  const freshPath = exportedAgain.verification.checks[0].check.path
  assert.notEqual(freshPath, download.path)
  assert.match(await readFile(join(workspaceDir, freshPath), 'utf8'), /A,9/)
  const badFile = await call('verify', { pageId, checks: [{ kind: 'file', path: freshPath, expectedSha256: '0'.repeat(64) }] })
  assert.equal(badFile.verified, false)
  await writeFile(join(workspaceDir, exportFlow.artifact.path), JSON.stringify({ ...exportFlow.workflow, name: 'edited' }))
  await call('workflow', { pageId, action: 'run', path: exportFlow.artifact.path }, agent, true)
  quantity = 7
  const journal = await call('journal', { export: true, limit: 100 })
  assert.ok(journal.entries.length > 6)
  assert.ok(!JSON.stringify(journal).includes('must-not-leak'))
  assert.deepEqual((await call('journal', {}, other)).entries, [])
  await call('probe', { pageId }, other, true)
  await call('request', { pageId, url: 'https://example.org/' }, agent, true)
  const manifest = { id: 'proven-shop', name: '商品数量读取', version: '1.0.0', entry_url: url, tasks: [{ id: 'read', name: '读取', script: 'read.js', params: [] }] }
  const scripts = { 'read.js': `;(async () => { const response=await fetch('/api/item'); const item=await response.json(); return {success:item.quantity===7,data:[{quantity:item.quantity}],meta:{}} })()` }
  const draft = await call('adapter', { action: 'draft', manifest, scripts })
  await call('adapter', { action: 'publish', draftId: draft.draftId }, agent, true)
  await call('adapter', { action: 'test', draftId: draft.draftId, taskId: 'read' }, other, true)
  const tested = await call('adapter', { action: 'test', draftId: draft.draftId, taskId: 'read' })
  assert.equal(tested.tested, true)
  const published = await call('adapter', { action: 'publish', draftId: draft.draftId })
  assert.equal(published.published, true)
  assert.equal((await call('script_list', {})).adapters[0].id, manifest.id)
  const run = await call('script_run', { adapter_id: manifest.id, task_id: 'read' })
  assert.equal(run.data[0].quantity, 7)
  assert.deepEqual((await call('pages', {})).pages.map(page => page.pageId), [pageId])
  assert.equal(approvals, 0)
  const raw = await readFile(join(workspaceDir, journal.artifact.path), 'utf8')
  assert.ok(!raw.includes('must-not-leak'))
})

test('evidence writer refuses symlink escapes and never overwrites files', async t => {
  const { symlink } = await import('node:fs/promises')
  const { writeArtifact, workspaceFile, redact } = await import('../lib/capabilities/common.js')
  const root = await mkdtemp(join(tmpdir(), 'dsh-paths-')), outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })
  await symlink(outside, join(root, 'artifacts'))
  await assert.rejects(writeArtifact({ workspaceDir: root }, 'journal', 'private'), /escapes workspace/)
  await writeFile(join(outside, 'data.txt'), 'outside')
  await symlink(join(outside, 'data.txt'), join(root, 'outside.txt'))
  await assert.rejects(workspaceFile({ workspaceDir: root }, 'outside.txt'), /outside workspace/)
  assert.equal(redact({ Cookie: 'private', nested: { access_token: 'private' } }).nested.access_token, '[REDACTED]')
  for (const text of ['sessionid=PRIVATE_COOKIE; foo=bar', '{"accessToken":"PRIVATE_TOKEN"}', '{"data":"{\\"refreshToken\\":\\"PRIVATE_NESTED\\"}"}', 'https://person:PRIVATE_PASSWORD@example.org/']) {
    assert.ok(!redact(text).includes('PRIVATE_'), redact(text))
  }
  assert.deepEqual(await readdir(outside), ['data.txt'])
})
