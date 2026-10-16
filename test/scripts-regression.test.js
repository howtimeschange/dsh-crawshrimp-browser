import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'

import { BrowserManager, Config, TOOL_NAMES } from '../lib/index.js'
import { ScriptsError } from '../lib/scripts/errors.js'
import { discoverAdapters } from '../lib/scripts/manifest.js'
import { ScriptsRuntime } from '../lib/scripts/runtime.js'
import * as browserPlugin from '../lib/index.js'

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))

let server
let baseUrl

before(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <title>DSH scripts regression fixture</title>
      <main><h1>Fixture product</h1>
      <table><tr><th>name</th><th>price</th></tr><tr><td>shirt</td><td>39</td></tr></table>
      <p id="interactive">interactive page remains available</p></main>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

const successScript = `;(async () => {
  const params = window.__PARAMS__ || {}
  const rows = [...document.querySelectorAll('table tr')].map((row) => [...row.cells].map((cell) => cell.textContent.trim()))
  return { success: true, data: [{ title: document.title, rows, label: params.label || '' }], meta: { source: location.href } }
})()`

const failureScript = `;(async () => {
  return { success: false, data: [], meta: { error: 'fixture failed' } }
})()`

const unsupportedActionScript = `;(async () => {
  return { success: true, data: [], meta: { action: 'next_phase', next_phase: 'other' } }
})()`

const cancellableScript = `;(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5000))
  return { success: true, data: [{ completed: true }], meta: {} }
})()`

async function tempDir(t, prefix = 'dsh-browser-scripts-regression-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function createAdapter(root, {
  id = 'fixture-adapter',
  tasks = [{ id: 'read-table', name: 'Read table', script: 'read-table.js', source: successScript }],
  entryUrl = baseUrl,
  manifest = {},
} = {}) {
  const adapter = join(root, id)
  await mkdir(adapter, { recursive: true })
  const manifestTasks = []
  for (const task of tasks) {
    await writeFile(join(adapter, task.script), task.source)
    manifestTasks.push({
      id: task.id,
      name: task.name,
      script: task.script,
      ...(task.manifest || {}),
    })
  }
  await writeFile(join(adapter, 'manifest.yaml'), stringify({
    id,
    name: `${id} fixture`,
    version: '1.0.0',
    entry_url: entryUrl,
    ...manifest,
    tasks: manifestTasks,
  }))
  return adapter
}

function browserConfig(extra = {}) {
  return Config({
    ...(chromePath ? { executablePath: chromePath } : {}),
    channel: 'chrome',
    headless: true,
    actionTimeoutMs: 5000,
    navigationTimeoutMs: 5000,
    ...extra,
  })
}

function execution(agent = { id: 'scripts-regression-agent', session: {} }, signal = new AbortController().signal) {
  return { agent, signal, callId: `scripts-regression-${Math.random().toString(16).slice(2)}` }
}

test('merged manifest validation remains strict about fields, duplicates, traversal, and symlinks', async (t) => {
  const root = await tempDir(t)
  const duplicate = join(root, 'duplicate')
  await mkdir(duplicate, { recursive: true })
  await writeFile(join(duplicate, 'task.js'), successScript)
  await writeFile(join(duplicate, 'manifest.yaml'), `id: duplicate
name: Duplicate
version: 1.0.0
entry_url: ${baseUrl}
tasks:
  - id: same
    name: One
    script: task.js
  - id: same
    name: Two
    script: task.js
`)
  await assert.rejects(discoverAdapters([root]), (error) => error instanceof ScriptsError && error.code === 'DUPLICATE_TASK')
  await rm(duplicate, { recursive: true, force: true })

  const traversal = join(root, 'traversal')
  await mkdir(traversal, { recursive: true })
  await writeFile(join(root, 'outside.js'), successScript)
  await writeFile(join(traversal, 'manifest.yaml'), `id: traversal
name: Traversal
version: 1.0.0
entry_url: ${baseUrl}
tasks:
  - id: escape
    name: Escape
    script: ../outside.js
`)
  await assert.rejects(discoverAdapters([root]), (error) => error instanceof ScriptsError && error.code === 'PATH_ESCAPE')
  await rm(traversal, { recursive: true, force: true })

  const escaped = join(root, 'escaped')
  await mkdir(escaped, { recursive: true })
  await writeFile(join(root, 'secret.js'), successScript)
  await symlink(join(root, 'secret.js'), join(escaped, 'task.js'))
  await writeFile(join(escaped, 'manifest.yaml'), `id: escaped
name: Escaped
version: 1.0.0
entry_url: ${baseUrl}
tasks:
  - id: escape
    name: Escape
    script: task.js
`)
  await assert.rejects(discoverAdapters([root]), (error) => error instanceof ScriptsError && error.code === 'PATH_ESCAPE')
  await rm(escaped, { recursive: true, force: true })

  const unsupported = join(root, 'unsupported')
  await mkdir(unsupported, { recursive: true })
  await writeFile(join(unsupported, 'task.js'), successScript)
  await writeFile(join(unsupported, 'manifest.yaml'), `id: unsupported
name: Unsupported
version: 1.0.0
entry_url: ${baseUrl}
auth: true
tasks:
  - id: task
    name: Task
    script: task.js
`)
  await assert.rejects(discoverAdapters([root]), (error) => error instanceof ScriptsError && error.code === 'UNSUPPORTED_MANIFEST_FIELD')
})

test('merged parameter validation preserves defaults, boundaries, and offline diagnostics', async (t) => {
  const root = await tempDir(t)
  await createAdapter(root, {
    tasks: [{
      id: 'declared',
      name: 'Declared params',
      script: 'declared.js',
      source: successScript,
      manifest: {
        params: [
          { id: 'keyword', type: 'text', label: 'Keyword', required: true },
          { id: 'count', type: 'number', label: 'Count', default: 2, min: 1, max: 5 },
          { id: 'channel', type: 'select', label: 'Channel', default: 'web', options: [{ value: 'web', label: 'Web' }, { value: 'app', label: 'App' }] },
          { id: 'tags', type: 'checkbox', label: 'Tags', options: [{ value: 'new', label: 'New' }, { value: 'sale', label: 'Sale' }] },
          { id: 'day', type: 'date', label: 'Day', default: '2026-10-16' },
        ],
      },
    }],
  })
  const adapters = await discoverAdapters([root])
  assert.equal(adapters[0].tasks[0].entryUrl, `${baseUrl}/`)
  assert.deepEqual(adapters[0].tasks[0].params.map((param) => param.id), ['keyword', 'count', 'channel', 'tags', 'day'])
  const task = adapters[0].tasks[0]
  const runtime = new ScriptsRuntime({}, { adapterRoots: [root], workspaceDir: await tempDir(t) })
  const valid = await runtime.validate({ adapter_id: 'fixture-adapter', task_id: 'declared', params: { keyword: 'shirt', count: 1, channel: 'app', tags: ['new'], day: '2026-10-16' } })
  assert.equal(valid.valid, true)
  assert.deepEqual(valid.params, { keyword: 'shirt', count: 1, channel: 'app', tags: ['new'], day: '2026-10-16' })
  const defaults = await runtime.validate({ adapter_id: 'fixture-adapter', task_id: 'declared', params: { keyword: 'shirt' } })
  assert.equal(defaults.valid, true)
  assert.deepEqual(defaults.params, { keyword: 'shirt', count: 2, channel: 'web', day: '2026-10-16' })
  const upperBoundary = await runtime.validate({ adapter_id: 'fixture-adapter', task_id: 'declared', params: { keyword: 'shirt', count: 5 } })
  assert.equal(upperBoundary.valid, true)
  const belowMinimum = await runtime.validate({ adapter_id: 'fixture-adapter', task_id: 'declared', params: { keyword: 'shirt', count: 0 } })
  assert.equal(belowMinimum.valid, false)
  assert.equal(belowMinimum.diagnostics[0].code, 'PARAMS_OUT_OF_RANGE')
  const missingRequired = await runtime.validate({ adapter_id: 'fixture-adapter', task_id: 'declared', params: {} })
  assert.equal(missingRequired.valid, false)
  assert.equal(missingRequired.diagnostics[0].code, 'PARAMS_REQUIRED')
  assert.equal(task.params[1].default, 2)
})

test('merged artifact writes remain isolated, unique, and resistant to workspace symlinks', async (t) => {
  const workspace = await tempDir(t)
  const runtime = new ScriptsRuntime({}, { workspaceDir: workspace })
  const signal = new AbortController().signal
  const first = await runtime.writeArtifact({ id: 'fixture-adapter' }, { id: 'read-table' }, '{"value":1}', signal)
  const second = await runtime.writeArtifact({ id: 'fixture-adapter' }, { id: 'read-table' }, '{"value":2}', signal)
  assert.notEqual(first.path, second.path)
  assert.equal(await readFile(join(workspace, first.path), 'utf8'), '{"value":1}')
  assert.equal(await readFile(join(workspace, second.path), 'utf8'), '{"value":2}')

  const escapedWorkspace = await tempDir(t, 'dsh-browser-scripts-outside-')
  const outsideArtifact = join(escapedWorkspace, 'keep.json')
  await writeFile(outsideArtifact, 'keep')
  const workspaceWithSymlink = await tempDir(t)
  await symlink(escapedWorkspace, join(workspaceWithSymlink, 'artifacts'))
  const escapedRuntime = new ScriptsRuntime({}, { workspaceDir: workspaceWithSymlink })
  await assert.rejects(
    escapedRuntime.writeArtifact({ id: 'fixture-adapter' }, { id: 'read-table' }, '{"should_not":"escape"}', signal),
    (error) => error instanceof ScriptsError && error.code === 'ARTIFACT_WRITE_FAILED',
  )
  assert.equal(await readFile(outsideArtifact, 'utf8'), 'keep')
  assert.deepEqual(await readdir(escapedWorkspace), ['keep.json'])
})

test('merged artifact cancellation leaves no temporary publication', async (t) => {
  const workspace = await tempDir(t)
  const runtime = new ScriptsRuntime({}, { workspaceDir: workspace })
  const controller = new AbortController()
  const originalThrowIfAborted = controller.signal.throwIfAborted.bind(controller.signal)
  let checks = 0
  controller.signal.throwIfAborted = () => {
    checks += 1
    if (checks === 3) controller.abort()
    originalThrowIfAborted()
  }
  await assert.rejects(
    runtime.writeArtifact({ id: 'fixture-adapter' }, { id: 'read-table' }, '{"ok":true}', controller.signal),
    (error) => error instanceof ScriptsError && error.code === 'ABORTED',
  )
  const artifactDir = join(workspace, 'artifacts', 'fixture-adapter', 'read-table')
  assert.deepEqual(await readdir(artifactDir), [])
})

test('invalid Playwright storage-state fields do not echo cookie values', { skip: !chromePath && process.platform !== 'darwin' }, async (t) => {
  const directory = await tempDir(t, 'dsh-browser-private-state-')
  const pathname = join(directory, 'state.json')
  const secret = 'PRIVATE_COOKIE_SHOULD_NOT_APPEAR'
  await writeFile(pathname, JSON.stringify({
    cookies: [{
      name: 'fixture',
      value: secret,
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: secret,
    }],
    origins: [],
  }))
  const manager = new BrowserManager(browserConfig({ storageStatePath: pathname }))
  try {
    await assert.rejects(manager.sessionFor({ id: 'invalid-storage-state', session: {} }, new AbortController().signal), error => {
      assert.equal(error.message.includes(secret), false)
      assert.doesNotMatch(error.message, /Unexpected token|PRIVATE_COOKIE_SHOULD_NOT_APPEAR/)
      return true
    })
  } finally {
    await manager.dispose()
  }
})

test('merged script_run surfaces declared failure and rejects unsupported actions', { skip: !chromePath && process.platform !== 'darwin' }, async (t) => {
  const { Context } = await import('@deepseek-ai/cordis')
  const Tools = (await import('@deepseek-ai/dsh-tools')).default
  const root = await tempDir(t)
  const workspace = await tempDir(t)
  await createAdapter(root, {
    tasks: [
      { id: 'declared-failure', name: 'Declared failure', script: 'failure.js', source: failureScript },
      { id: 'unsupported-action', name: 'Unsupported action', script: 'action.js', source: unsupportedActionScript },
    ],
  })
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  ctx.provide('approval', { effectivePolicy: () => 'ask', request: async () => 'allowed-once' })
  const agent = { id: 'merged-script-agent', session: {} }
  try {
    const toolFiber = ctx.plugin(Tools)
    await toolFiber
    const pluginFiber = ctx.plugin(browserPlugin, browserConfig({ adapterRoots: [root], workspaceDir: workspace }))
    await pluginFiber
    const declaredFailure = await ctx.tools.execute({
      callId: 'merged-declared-failure',
      name: TOOL_NAMES.scriptRun,
      arguments: { adapter_id: 'fixture-adapter', task_id: 'declared-failure' },
      agent,
      signal: new AbortController().signal,
    })
    assert.equal(declaredFailure.isError, true, JSON.stringify(declaredFailure))
    assert.match(JSON.stringify(declaredFailure), /fixture failed|SCRIPT_DECLARED_FAILURE/i)
    const unsupportedAction = await ctx.tools.execute({
      callId: 'merged-unsupported-action',
      name: TOOL_NAMES.scriptRun,
      arguments: { adapter_id: 'fixture-adapter', task_id: 'unsupported-action' },
      agent,
      signal: new AbortController().signal,
    })
    assert.equal(unsupportedAction.isError, true, JSON.stringify(unsupportedAction))
    assert.match(JSON.stringify(unsupportedAction), /unsupported action|complete action|UNSUPPORTED_ACTION/i)
    await pluginFiber.dispose()
    await toolFiber.dispose()
  } finally {
    if (ctx.fiber.uid !== null) await ctx.fiber.dispose()
  }
})

test('unloading a script run closes only its isolated context and preserves the interactive page', { skip: !chromePath && process.platform !== 'darwin' }, async (t) => {
  const root = await tempDir(t)
  const workspace = await tempDir(t)
  await createAdapter(root, {
    tasks: [{ id: 'cancellable', name: 'Cancellable', script: 'cancellable.js', source: cancellableScript }],
  })
  const manager = new BrowserManager(browserConfig())
  const agent = { id: 'interactive-agent', session: {} }
  const runtime = new ScriptsRuntime({}, { adapterRoots: [root], workspaceDir: workspace, scriptTimeoutMs: 120000 }, manager)
  try {
    const opened = await manager.open({ url: baseUrl }, execution(agent))
    const pending = runtime.run({ adapter_id: 'fixture-adapter', task_id: 'cancellable' }, execution(agent))
    await new Promise((resolve) => setTimeout(resolve, 100))
    await runtime.dispose()
    await assert.rejects(pending, (error) => error instanceof ScriptsError && ['ABORTED', 'PLUGIN_UNLOADED'].includes(error.code))
    const pages = await manager.pages({}, execution(agent))
    assert.deepEqual(pages.pages.map((page) => page.pageId), [opened.pageId])
    const observed = await manager.observe({ pageId: opened.pageId }, execution(agent))
    assert.match(observed.text, /Fixture product/)
  } finally {
    await runtime.dispose()
    await manager.dispose()
  }
})
