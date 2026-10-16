import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'

import { ScriptsError } from '../lib/scripts/errors.js'
import { ScriptsRuntime } from '../lib/scripts/runtime.js'

const script = ';(async () => { return { success: true, data: [], meta: {} } })()'

async function fixture(t, behavior, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-phases-'))
  const workspaceDir = await mkdtemp(join(tmpdir(), 'dsh-browser-phase-artifacts-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
  })
  const adapterDir = join(root, 'fixture')
  await mkdir(adapterDir)
  await writeFile(join(adapterDir, 'manifest.yaml'), stringify({
    id: 'fixture',
    name: 'Fixture',
    version: '1.0.0',
    entry_url: 'http://fixture.test/',
    tasks: [{ id: 'task', name: 'Task', script: 'task.js' }],
  }))
  await writeFile(join(adapterDir, 'task.js'), script)

  const calls = []
  const page = {
    async goto() {},
    async reload(options) { calls.push({ kind: 'reload', options }) },
    async close() { calls.push({ kind: 'page-close' }) },
    async evaluate(_source, payload) {
      calls.push({ kind: 'evaluate', ...payload })
      return behavior(payload)
    },
  }
  const context = {
    async newPage() { return page },
    async close() { calls.push({ kind: 'context-close' }) },
  }
  const runtime = new ScriptsRuntime({}, { ...config, adapterRoots: [root], workspaceDir }, {
    async createIsolatedContext() { return context },
  })
  return { runtime, calls }
}

function execution(signal = new AbortController().signal) {
  return { agent: { id: 'phase-test-agent', session: {} }, signal, callId: 'phase-test-call' }
}

test('phase globals and shared state cross phases and pages', async (t) => {
  const { runtime, calls } = await fixture(t, ({ page, phase, shared }) => {
    if (page === 1 && phase === 'main') return { success: true, data: [{ phase }], meta: { action: 'next_phase', next_phase: 'detail', shared: { cursor: 'A' } } }
    if (page === 1) return { success: true, data: [{ phase, cursor: shared.cursor }], meta: { action: 'complete', has_more: true, shared: { cursor: 'B' } } }
    return { success: true, data: [{ page, phase, cursor: shared.cursor }], meta: { action: 'complete', has_more: false } }
  })

  const result = await runtime.run({ adapter_id: 'fixture', task_id: 'task', max_pages: 2 }, execution())
  assert.deepEqual(result.data, [
    { phase: 'main' },
    { phase: 'detail', cursor: 'A' },
    { page: 2, phase: 'main', cursor: 'B' },
  ])
  assert.deepEqual(calls.filter((call) => call.kind === 'evaluate').map(({ page, phase, shared }) => ({ page, phase, shared })), [
    { page: 1, phase: 'main', shared: {} },
    { page: 1, phase: 'detail', shared: { cursor: 'A' } },
    { page: 2, phase: 'main', shared: { cursor: 'B' } },
  ])
})

test('reload_page reloads the isolated page before the next phase', async (t) => {
  const { runtime, calls } = await fixture(t, ({ phase }) => phase === 'main'
    ? { success: true, data: [], meta: { action: 'reload_page', next_phase: 'after_reload' } }
    : { success: true, data: [{ phase }], meta: { action: 'complete' } })
  const result = await runtime.run({ adapter_id: 'fixture', task_id: 'task' }, execution())
  assert.deepEqual(result.data, [{ phase: 'after_reload' }])
  assert.equal(calls.filter((call) => call.kind === 'reload').length, 1)
})

test('phase limit, unsupported action, abort, and cancellation fail closed', async (t) => {
  const looping = await fixture(t, () => ({ success: true, data: [], meta: { action: 'next_phase', next_phase: 'loop' } }), { maxPhases: 2 })
  await assert.rejects(looping.runtime.run({ adapter_id: 'fixture', task_id: 'task' }, execution()), (error) => error instanceof ScriptsError && error.code === 'PHASE_LIMIT')

  const unsupported = await fixture(t, () => ({ success: true, data: [], meta: { action: 'teleport' } }))
  await assert.rejects(unsupported.runtime.run({ adapter_id: 'fixture', task_id: 'task' }, execution()), (error) => error instanceof ScriptsError && error.code === 'UNSUPPORTED_ACTION')

  const aborted = await fixture(t, () => ({ success: true, data: [{ partial: true }], meta: { action: 'abort', reason: 'stop here' } }))
  await assert.rejects(aborted.runtime.run({ adapter_id: 'fixture', task_id: 'task' }, execution()), (error) => error instanceof ScriptsError && error.code === 'SCRIPT_ABORTED' && error.message === 'stop here')

  const controller = new AbortController()
  const cancelled = await fixture(t, () => {
    controller.abort()
    return { success: true, data: [], meta: { action: 'complete' } }
  })
  await assert.rejects(cancelled.runtime.run({ adapter_id: 'fixture', task_id: 'task' }, execution(controller.signal)), (error) => error instanceof ScriptsError && error.code === 'ABORTED')
})

test('page limit and shared size remain independent guards', async (t) => {
  const pages = await fixture(t, ({ page }) => ({
    success: true,
    data: [{ page }],
    meta: { action: 'complete', has_more: true, shared: { page } },
  }))
  await assert.rejects(pages.runtime.run({ adapter_id: 'fixture', task_id: 'task', max_pages: 1 }, execution()), (error) => error instanceof ScriptsError && error.code === 'PAGINATION_LIMIT')

  const large = await fixture(t, () => ({
    success: true,
    data: [],
    meta: { action: 'complete', shared: { payload: 'x'.repeat(2 * 1024 * 1024) } },
  }))
  await assert.rejects(large.runtime.run({ adapter_id: 'fixture', task_id: 'task' }, execution()), (error) => error instanceof ScriptsError && error.code === 'SHARED_TOO_LARGE')
})

test('capability actions receive page metadata once and merge their result into shared', async (t) => {
  const { runtime, calls } = await fixture(t, ({ phase, shared }) => phase === 'main'
    ? { success: true, data: [], meta: { action: 'upload', files: ['fixture.csv'], shared_key: 'upload_result', next_phase: 'read' } }
    : { success: true, data: [{ shared }], meta: { action: 'complete' } })
  const received = []
  runtime.capabilities = async (action, page, meta, signal) => {
    received.push({ action, page, meta, aborted: signal.aborted })
    return { ok: true, files: meta.files }
  }
  const result = await runtime.run({ adapter_id: 'fixture', task_id: 'task' }, execution())
  assert.deepEqual(result.data, [{ shared: { upload_result: { ok: true, files: ['fixture.csv'] } } }])
  assert.equal(received.length, 1)
  assert.equal(received[0].action, 'upload')
  assert.equal(typeof received[0].page.evaluate, 'function')
  assert.equal(received[0].aborted, false)
})

test('declared failure is terminal and does not execute a phase action', async (t) => {
  const { runtime } = await fixture(t, () => ({
    success: false,
    data: [{ failed: true }],
    meta: { action: 'upload', next_phase: 'must_not_run' },
  }))
  let capabilityCalls = 0
  runtime.capabilities = async () => { capabilityCalls += 1; return { ok: true } }
  const result = await runtime.run({ adapter_id: 'fixture', task_id: 'task' }, execution())
  assert.equal(result.success, false)
  assert.equal(capabilityCalls, 0)
})

test('shared_append appends action results without replacing existing state', async (t) => {
  const { runtime } = await fixture(t, ({ phase, shared }) => phase === 'main'
    ? { success: true, data: [], meta: { action: 'upload', shared: { events: ['before'] }, shared_key: 'events', shared_append: true, next_phase: 'done' } }
    : { success: true, data: [{ events: shared.events }], meta: { action: 'complete' } })
  runtime.capabilities = async () => 'after'
  const result = await runtime.run({ adapter_id: 'fixture', task_id: 'task' }, execution())
  assert.deepEqual(result.data, [{ events: ['before', 'after'] }])
})

test('script output and artifact redact secret-shaped fields after execution', async (t) => {
  const { runtime } = await fixture(t, () => ({
    success: true,
    data: [{ token: 'secret-token', value: 'kept' }],
    meta: { action: 'complete', shared: { token: 'shared-secret' } },
  }))
  const result = await runtime.run({ adapter_id: 'fixture', task_id: 'task' }, execution())
  assert.equal(result.data[0].token, '[REDACTED]')
  assert.equal(result.data[0].value, 'kept')
  assert.equal(result.meta.shared.token, '[REDACTED]')
  const artifact = await readFile(join(runtime.config.workspaceDir, result.artifact.path), 'utf8')
  assert.equal(artifact.includes('shared-secret'), false)
  assert.equal(artifact.includes('secret-token'), false)
})
