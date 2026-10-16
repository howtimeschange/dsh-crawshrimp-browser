import { randomUUID } from 'node:crypto'
import { link, mkdir, open, realpath, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { discoverAdapters, PORTABLE_GLOBALS, publicAdapter, publicTask, validateTaskParams } from './manifest.js'
import { ScriptsError } from './errors.js'

const DEFAULTS = Object.freeze({
  adapterRoots: [],
  workspaceDir: join(homedir(), '.dsh-crawshrimp-browser'),
  scriptTimeoutMs: 120000,
  maxScriptBytes: 512 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
  maxPages: 1,
})

const MAX_PARAMS_BYTES = 1 * 1024 * 1024

function expandPath(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  return resolve(text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text)
}

function positiveBound(value, label, { min, max, fallback }) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ScriptsError('CONFIG_INVALID', `${label} must be an integer from ${min} to ${max}`)
  return number
}

export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULTS, ...(raw || {}) }
  const adapterRoots = Array.isArray(config.adapterRoots) ? config.adapterRoots.map(expandPath).filter(Boolean) : []
  const workspaceDir = expandPath(config.workspaceDir) || DEFAULTS.workspaceDir
  return Object.freeze({
    adapterRoots,
    workspaceDir,
    scriptTimeoutMs: positiveBound(config.scriptTimeoutMs, 'scriptTimeoutMs', { min: 1000, max: 1800000, fallback: DEFAULTS.scriptTimeoutMs }),
    maxScriptBytes: positiveBound(config.maxScriptBytes, 'maxScriptBytes', { min: 1024, max: 4 * 1024 * 1024, fallback: DEFAULTS.maxScriptBytes }),
    maxOutputBytes: positiveBound(config.maxOutputBytes, 'maxOutputBytes', { min: 1024, max: 16 * 1024 * 1024, fallback: DEFAULTS.maxOutputBytes }),
    maxPages: positiveBound(config.maxPages, 'maxPages', { min: 1, max: 100, fallback: DEFAULTS.maxPages }),
  })
}

function assertObjectParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScriptsError('PARAMS_INVALID', 'params must be a JSON object')
  let encoded
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new ScriptsError('PARAMS_INVALID', 'params must be JSON-serializable and must not be circular')
  }
  if (encoded === undefined) throw new ScriptsError('PARAMS_INVALID', 'params must be a JSON object')
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PARAMS_BYTES) throw new ScriptsError('PARAMS_TOO_LARGE', `params exceed ${MAX_PARAMS_BYTES} bytes`)
  return JSON.parse(encoded)
}

function assertCallArgs(args, required) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ScriptsError('ARGS_INVALID', 'tool arguments must be a JSON object')
  for (const key of required) if (typeof args[key] !== 'string' || !args[key].trim()) throw new ScriptsError('ARGS_INVALID', `${key} is required`)
}

function jsonBytes(value, label) {
  let encoded
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new ScriptsError('NON_JSON_RESULT', `${label} must be JSON-serializable and must not be circular`)
  }
  if (encoded === undefined) throw new ScriptsError('NON_JSON_RESULT', `${label} must be JSON-serializable`)
  return { encoded, bytes: Buffer.byteLength(encoded, 'utf8') }
}

async function closeQuietly(value) {
  try {
    if (value) await value.close()
  } catch {}
}

function pathInside(base, candidate) {
  const distance = relative(base, candidate)
  return distance === '' || (distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance))
}

async function createArtifactDirectory(workspaceReal, adapterId, taskId) {
  let current = workspaceReal
  for (const part of ['artifacts', adapterId, taskId]) {
    const candidate = join(current, part)
    try {
      await mkdir(candidate)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new ScriptsError('ARTIFACT_WRITE_FAILED', `cannot create artifact directory: ${error.message}`)
    }
    let resolved
    try {
      resolved = await realpath(candidate)
      const info = await stat(resolved)
      if (!info.isDirectory()) throw new Error('path is not a directory')
    } catch (error) {
      if (error instanceof ScriptsError) throw error
      throw new ScriptsError('ARTIFACT_WRITE_FAILED', `cannot inspect artifact directory: ${error.message}`)
    }
    if (!pathInside(workspaceReal, resolved)) throw new ScriptsError('ARTIFACT_WRITE_FAILED', 'artifact directory resolves outside workspaceDir')
    current = resolved
  }
  return current
}

export class ScriptsRuntime {
  constructor(ctx, rawConfig = {}, browserManager) {
    this.ctx = ctx
    this.config = normalizeConfig(rawConfig)
    this.browserManager = browserManager
    this.active = new Set()
    this.disposed = false
  }

  async dispose() {
    this.disposed = true
    const runs = [...this.active]
    for (const run of runs) run.controller.abort(new ScriptsError('PLUGIN_UNLOADED', 'scripts plugin unloaded'))
    await Promise.allSettled(runs.map((run) => run.promise))
  }

  async list(args = {}) {
    if (this.disposed) throw new ScriptsError('PLUGIN_UNLOADED', 'scripts plugin unloaded')
    const adapters = await discoverAdapters(this.config.adapterRoots, this.config)
    const adapterId = typeof args.adapter_id === 'string' ? args.adapter_id.trim() : ''
    if (adapterId) {
      const adapter = adapters.find((candidate) => candidate.id === adapterId)
      if (!adapter) throw new ScriptsError('ADAPTER_NOT_FOUND', `adapter not found: ${adapterId}`)
      return { adapters: [publicAdapter(adapter)] }
    }
    return { adapters: adapters.map(publicAdapter) }
  }

  async validate(args = {}) {
    if (this.disposed) throw new ScriptsError('PLUGIN_UNLOADED', 'scripts plugin unloaded')
    assertCallArgs(args, ['adapter_id', 'task_id'])
    const adapterId = args.adapter_id.trim()
    const taskId = args.task_id.trim()
    let adapter
    let task
    try {
      const params = assertObjectParams(args.params ?? {})
      const adapters = await discoverAdapters(this.config.adapterRoots, this.config)
      adapter = adapters.find((candidate) => candidate.id === adapterId)
      if (!adapter) throw new ScriptsError('ADAPTER_NOT_FOUND', `adapter not found: ${adapterId}`)
      task = adapter.tasks.find((candidate) => candidate.id === taskId)
      if (!task) throw new ScriptsError('TASK_NOT_FOUND', `task not found: ${adapterId}/${taskId}`)
      const normalizedParams = validateTaskParams(task, params)
      const taskInfo = publicTask(adapter, task)
      return {
        valid: true,
        diagnostics: [],
        adapter_id: adapter.id,
        task_id: task.id,
        entry_url: task.entryUrl,
        schema: taskInfo.params,
        params: normalizedParams,
        globals: [...PORTABLE_GLOBALS],
      }
    } catch (error) {
      return {
        valid: false,
        diagnostics: [{
          code: error?.code || 'VALIDATION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        }],
        ...(adapter && task ? {
          adapter_id: adapter.id,
          task_id: task.id,
          entry_url: task.entryUrl,
          schema: publicTask(adapter, task).params,
          globals: [...PORTABLE_GLOBALS],
        } : {}),
      }
    }
  }

  async run(args, execution) {
    if (this.disposed) throw new ScriptsError('PLUGIN_UNLOADED', 'scripts plugin unloaded')
    assertCallArgs(args, ['adapter_id', 'task_id'])
    const params = assertObjectParams(args.params ?? {})
    const maxPages = positiveBound(args.max_pages, 'max_pages', { min: 1, max: 100, fallback: this.config.maxPages })
    const controller = new AbortController()
    const state = { controller, promise: undefined }
    const promise = this.execute(args.adapter_id.trim(), args.task_id.trim(), params, maxPages, execution, controller.signal)
      .finally(() => this.active.delete(state))
    state.promise = promise
    this.active.add(state)
    return promise
  }

  async execute(adapterId, taskId, params, maxPages, execution, stopSignal) {
    const lifecycleSignal = AbortSignal.any([execution.signal, stopSignal])
    lifecycleSignal.throwIfAborted()
    const adapters = await discoverAdapters(this.config.adapterRoots, this.config)
    lifecycleSignal.throwIfAborted()
    const adapter = adapters.find((candidate) => candidate.id === adapterId)
    if (!adapter) throw new ScriptsError('ADAPTER_NOT_FOUND', `adapter not found: ${adapterId}`)
    const task = adapter.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new ScriptsError('TASK_NOT_FOUND', `task not found: ${adapterId}/${taskId}`)
    const validatedParams = validateTaskParams(task, params)
    lifecycleSignal.throwIfAborted()
    const timeout = AbortSignal.timeout(this.config.scriptTimeoutMs)
    const signal = AbortSignal.any([lifecycleSignal, timeout])
    let context
    let page
    let closePromise
    let unregisterPreview
    const close = async () => {
      if (closePromise) return closePromise
      // An abort can fire while openBrowser is still starting. In that small
      // window the outer variables are empty; do not cache a no-op cleanup or
      // resources returned by a late setup would leak.
      if (!page && !context) return
      closePromise = (async () => {
        await unregisterPreview?.()
        await closeQuietly(page)
        await closeQuietly(context)
      })()
      return closePromise
    }
    const onAbort = () => { void close() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      ({ context, page } = await this.openBrowser(signal))
      signal.throwIfAborted()
      if (this.browserManager.preview) {
        unregisterPreview = this.browserManager.preview.registerPage({
          sessionId: this.browserManager.previewSessionFor(execution.agent),
          pageId: `crb-script-${randomUUID()}`, page, kind: 'script',
          runId: String(execution.callId || randomUUID()),
        })
      }
      await page.goto(task.entryUrl, { waitUntil: 'domcontentloaded', timeout: this.config.scriptTimeoutMs })
      signal.throwIfAborted()
      const allData = []
      let pageShared = {}
      let lastMeta = {}
      let lastSuccess = true
      for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
        signal.throwIfAborted()
        let rawResult
        try {
          rawResult = await page.evaluate(async ({ source, params: pageParams, page, shared }) => {
            // Keep both parameter names as aliases to the same JSON-cloned object,
            // matching the names used by portable DSH and Crawshrimp scripts.
            window.__PARAMS__ = pageParams
            window.__CRAWSHRIMP_PARAMS__ = pageParams
            window.__CRAWSHRIMP_PAGE__ = page
            window.__CRAWSHRIMP_PHASE__ = 'main'
            window.__CRAWSHRIMP_SHARED__ = shared
            return await (0, eval)(source)
          }, {
            source: task.source,
            params: validatedParams,
            page: pageNumber,
            shared: pageShared,
          })
        } catch (error) {
          if (signal.aborted) throw new ScriptsError('ABORTED', 'script execution was cancelled or timed out')
          throw new ScriptsError('SCRIPT_FAILED', `page script failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) throw new ScriptsError('RESULT_INVALID', 'script must return { success, data, meta }')
        if (typeof rawResult.success !== 'boolean' || !Array.isArray(rawResult.data) || !rawResult.meta || typeof rawResult.meta !== 'object' || Array.isArray(rawResult.meta)) {
          throw new ScriptsError('RESULT_INVALID', 'script must return { success: boolean, data: array, meta: object }')
        }
        const meta = rawResult.meta
        const action = Object.hasOwn(meta, 'action') ? meta.action : 'complete'
        if (Object.hasOwn(meta, 'next_phase') || (action !== undefined && action !== 'complete')) {
          throw new ScriptsError('UNSUPPORTED_ACTION', `portable page scripts only support the complete action; received ${String(action ?? 'next_phase')}`)
        }
        if (Object.hasOwn(meta, 'shared')) {
          pageShared = meta.shared && typeof meta.shared === 'object' && !Array.isArray(meta.shared)
            ? meta.shared
            : {}
        }
        allData.push(...rawResult.data)
        lastMeta = meta
        lastSuccess = rawResult.success
        const partial = { success: lastSuccess, data: allData, meta: lastMeta }
        const partialSerialized = jsonBytes(partial, 'script result')
        if (partialSerialized.bytes > this.config.maxOutputBytes) throw new ScriptsError('OUTPUT_TOO_LARGE', `script result exceeds maxOutputBytes (${this.config.maxOutputBytes})`)
        if (!lastSuccess || meta.has_more !== true) break
        if (pageNumber === maxPages) throw new ScriptsError('PAGINATION_LIMIT', `script pagination exceeded maxPages (${maxPages})`)
      }
      const baseResult = { success: lastSuccess, data: allData, meta: lastMeta }
      const serialized = jsonBytes(baseResult, 'script result')
      const artifact = await this.writeArtifact(adapter, task, serialized.encoded, signal)
      return { ...baseResult, artifact }
    } finally {
      signal.removeEventListener('abort', onAbort)
      await close()
    }
  }

  async openBrowser(signal) {
    signal.throwIfAborted()
    let context
    let page
    try {
      if (!this.browserManager || typeof this.browserManager.createIsolatedContext !== 'function') {
        throw new ScriptsError('BROWSER_ISOLATION_UNAVAILABLE', 'browser manager cannot create an isolated script context')
      }
      context = await this.browserManager.createIsolatedContext(signal)
      signal.throwIfAborted()
      page = await context.newPage()
      signal.throwIfAborted()
      return { context, page }
    } catch (error) {
      await closeQuietly(page)
      await closeQuietly(context)
      if (error instanceof ScriptsError) throw error
      if (signal.aborted) throw new ScriptsError('ABORTED', 'browser setup was cancelled')
      throw new ScriptsError('BROWSER_ISOLATION_UNAVAILABLE', `cannot create an isolated script context: ${error.message}`)
    }
  }

  async writeArtifact(adapter, task, encoded, signal) {
    signal.throwIfAborted()
    const workspace = resolve(this.config.workspaceDir)
    await mkdir(workspace, { recursive: true })
    const workspaceReal = await realpath(workspace)
    const outputDirReal = await createArtifactDirectory(workspaceReal, adapter.id, task.id)
    const prefix = `${Date.now()}-${randomUUID()}`
    for (let index = 0; index < 20; index += 1) {
      signal.throwIfAborted()
      const filename = `${prefix}${index ? `-${index}` : ''}.json`
      const target = join(outputDirReal, filename)
      const temp = join(outputDirReal, `.crawshrimp-${randomUUID()}.tmp`)
      let handle
      let linked = false
      try {
        handle = await open(temp, 'wx', 0o600)
        await handle.writeFile(encoded, { encoding: 'utf8', signal })
        await handle.close()
        handle = undefined
        signal.throwIfAborted()
        await link(temp, target)
        linked = true
        signal.throwIfAborted()
        return { path: relative(workspaceReal, target), bytes: Buffer.byteLength(encoded, 'utf8') }
      } catch (error) {
        if (linked) await unlink(target).catch(() => {})
        if (error?.code === 'EEXIST') continue
        if (signal.aborted) throw new ScriptsError('ABORTED', 'script execution was cancelled or timed out')
        throw new ScriptsError('ARTIFACT_WRITE_FAILED', `cannot save JSON artifact: ${error.message}`)
      } finally {
        await handle?.close().catch(() => {})
        await unlink(temp).catch(() => {})
      }
    }
    throw new ScriptsError('ARTIFACT_WRITE_FAILED', 'could not allocate a unique JSON artifact filename')
  }

  async getTask(adapterId, taskId) {
    const adapters = await discoverAdapters(this.config.adapterRoots, this.config)
    const adapter = adapters.find((candidate) => candidate.id === adapterId)
    if (!adapter) throw new ScriptsError('ADAPTER_NOT_FOUND', `adapter not found: ${adapterId}`)
    const task = adapter.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new ScriptsError('TASK_NOT_FOUND', `task not found: ${adapterId}/${taskId}`)
    return publicTask(adapter, task)
  }
}
