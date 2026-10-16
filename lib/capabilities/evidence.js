import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { CapabilityError, boundedJson, boundedInt, redact, writeArtifact, workspaceFile, workspaceDirectory } from './common.js'
import { loadAdapter } from '../scripts/manifest.js'
import { ScriptsRuntime } from '../scripts/runtime.js'

const replayable = new Set(['navigate', 'click', 'fill', 'select', 'press', 'request', 'upload', 'download'])
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function owner(agent) {
  if (agent?.session && typeof agent.session === 'object') return agent.session
  if (typeof agent?.id === 'string' && agent.id) return agent.id
  throw new CapabilityError('OWNER_REQUIRED', 'DSH session is required')
}
function substitute(value, params) {
  if (typeof value === 'string') return value.replace(/\{\{([a-zA-Z][\w-]*)\}\}/g, (_, key) => {
    if (!Object.hasOwn(params, key)) throw new CapabilityError('PARAM_REQUIRED', `missing workflow parameter: ${key}`)
    return String(params[key])
  })
  if (Array.isArray(value)) return value.map(item => substitute(item, params))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, params)]))
  return value
}

/** Evidence belongs to an agent session, independently of browser context churn. */
export class BrowserEvidence {
  constructor(config, manager, intelligence, transfers, scripts) {
    Object.assign(this, { config, manager, intelligence, transfers, scripts })
    this.objects = new WeakMap(); this.ids = new Map(); this.draftRuntimes = new Set()
  }
  state(agent) {
    const key = owner(agent), map = typeof key === 'object' ? this.objects : this.ids
    let state = map.get(key)
    if (!state) { state = { entries: [], workflows: new Map(), workflowFiles: new Map(), drafts: new Map() }; map.set(key, state) }
    return state
  }
  record(execution, name, args, result, error) {
    const state = this.state(execution.agent)
    const method = name.replace('crawshrimp_browser_', '')
    // Source and free-form request bodies can contain secrets in unrecognised
    // formats. Keep hashes for those; never persist executable code in journals.
    const safeArgs = { ...args }
    for (const key of ['expression', 'body', 'scripts', 'manifest']) {
      if (Object.hasOwn(safeArgs, key)) { safeArgs[`${key}Hash`] = hash(safeArgs[key]); delete safeArgs[key] }
    }
    let detail = error ? { error: String(error.message || error).slice(0, 500), code: error.code,
      ...(error.code === 'OUTCOME_UNKNOWN' ? { outcome: 'unknown', readbackRequired: true, attemptId: error.attemptId } : {}),
    } : redact(result)
    try { detail = boundedJson(detail, 128 * 1024) } catch { detail = { omitted: 'result exceeds journal size limit', sha256: hash(result) } }
    const entry = boundedJson(redact({ id: randomUUID(), at: new Date().toISOString(), method,
      args: safeArgs, success: !error && result?.success !== false && result?.verified !== false && result?.ok !== false,
      result: detail,
    }), 256 * 1024)
    state.entries.push(entry)
    if (state.entries.length > 300) state.entries.shift()
    return entry
  }
  async journal(args, execution) {
    const entries = this.state(execution.agent).entries.slice(-boundedInt(args.limit, 1, 100, 30))
    const result = { schema: 'crawshrimp.journal/v1', entries }
    if (args.export === true) result.artifact = await writeArtifact(this.config, 'journals', JSON.stringify(result, null, 2), { signal: execution.signal })
    return result
  }
  async verify(page, args, execution) {
    if (!Array.isArray(args.checks) || args.checks.length < 1 || args.checks.length > 30) throw new CapabilityError('CHECKS_INVALID', 'provide 1 to 30 verification checks')
    const results = []
    for (const check of args.checks) {
      execution.signal?.throwIfAborted()
      let actual, passed = false
      if (check.kind === 'file') {
        try { actual = await this.transfers.verifyFile(check, execution.signal); passed = true }
        catch (error) {
          if (!['MIME_MISMATCH', 'HASH_MISMATCH', 'SIZE_MISMATCH', 'MAGIC_MISMATCH'].includes(error.code)) throw error
          actual = { code: error.code, reason: error.message }
        }
      } else if (check.kind === 'response') {
        const entry = this.state(execution.agent).entries.find(item => item.id === check.evidenceId && item.method === 'request' && item.success)
        if (!entry) throw new CapabilityError('EVIDENCE_NOT_FOUND', 'response check needs this session request evidenceId')
        const response = entry.result
        actual = response
        passed = check.status !== undefined && Number(response.status) === Number(check.status)
        if (check.path !== undefined) {
          if (typeof check.path !== 'string' || check.path.length > 300) throw new CapabilityError('CHECK_INVALID', 'invalid JSON field path')
          let value = response.data ?? response.body
          for (const part of check.path.split('.')) value = value && Object.hasOwn(Object(value), part) ? value[part] : undefined
          passed = passed && JSON.stringify(value) === JSON.stringify(check.equals)
        }
      } else if (check.kind === 'url' || check.kind === 'title') {
        actual = check.kind === 'url' ? page.url() : await page.title()
        if (typeof check.includes !== 'string' || !check.includes) throw new CapabilityError('CHECK_INVALID', 'includes must be nonempty')
        passed = actual.includes(check.includes)
      } else if (['text', 'visible', 'count'].includes(check.kind)) {
        if (typeof check.selector !== 'string' || !check.selector || check.selector.length > 1000) throw new CapabilityError('CHECK_INVALID', 'selector required')
        const locator = page.locator(check.selector)
        if (check.kind === 'count') { actual = await locator.count(); passed = Number.isSafeInteger(check.equals) && actual === check.equals }
        else if (check.kind === 'visible') { actual = await locator.first().isVisible(); passed = actual === (check.equals ?? true) }
        else {
          actual = (await locator.first().textContent({ timeout: 5000 }) || '').slice(0, 10000)
          if (check.equals !== undefined) passed = actual === check.equals
          else if (typeof check.includes === 'string' && check.includes) passed = actual.includes(check.includes)
          else throw new CapabilityError('CHECK_INVALID', 'text check requires equals or includes')
        }
      } else throw new CapabilityError('CHECK_INVALID', 'unsupported verification kind')
      results.push(redact({ check, actual, passed }))
    }
    const result = boundedJson({ verified: results.every(item => item.passed), checks: results })
    result.artifact = await writeArtifact(this.config, 'verification', JSON.stringify(result, null, 2), { signal: execution.signal })
    return result
  }
  async workflow(args, execution, invoke) {
    const state = this.state(execution.agent)
    if (args.action === 'list') return { workflows: [...state.workflows.values()].map(({ id, name, origin, steps }) => ({ id, name, origin, stepCount: steps.length })) }
    if (args.action === 'distill') {
      const entries = args.evidenceIds ? args.evidenceIds.map(id => {
        const entry = state.entries.find(item => item.id === id)
        if (!entry) throw new CapabilityError('EVIDENCE_NOT_FOUND', 'evidence does not belong to this session')
        return entry
      }) : state.entries.slice(-60)
      const verificationIndex = entries.findLastIndex(item => item.method === 'verify' && item.result?.verified === true)
      if (verificationIndex < 0) throw new CapabilityError('VERIFICATION_REQUIRED', 'verify actual state before distilling a successful workflow')
      const proven = entries.slice(0, verificationIndex + 1)
      if (proven.some(item => !item.success)) throw new CapabilityError('UNRESOLVED_FAILURE', 'select the successful evidence after repairing failures')
      const actions = proven.filter(item => replayable.has(item.method))
      if (!actions.length) throw new CapabilityError('WORKFLOW_EMPTY', 'no reusable actions in selected evidence')
      const steps = actions.map(item => {
        const input = { ...item.args }; delete input.pageId
        if (input.ref) throw new CapabilityError('STALE_REF', 'distill stable explicit selectors instead of observation refs')
        if (input.bodyHash) throw new CapabilityError('REQUEST_BODY_OMITTED', 'create a parameterized adapter for a request with a body')
        if (JSON.stringify(input).includes('[REDACTED]')) throw new CapabilityError('SECRET_OMITTED', 'parameterize sensitive arguments before reuse')
        return { method: item.method, args: input }
      })
      const pageState = await this.manager.existingSessionFor(execution.agent, execution.signal)
      const record = this.manager.pageFor(pageState, args.pageId)
      const verification = proven[verificationIndex].result.checks.map(item => {
        const check = { ...item.check }
        if (check.kind === 'file') {
          const index = actions.findLastIndex(entry => entry.method === 'download' && (entry.result.path || entry.result.receipt?.path) === check.path)
          if (index >= 0) {
            const receipt = actions[index].result.receipt || actions[index].result
            check.receiptStep = index
            delete check.path
            if (check.expectedSha256 === receipt.sha256) { check.receiptHash = true; delete check.expectedSha256 }
          }
        }
        return check
      })
      if (verification.some(check => check.kind === 'response')) throw new CapabilityError('FRESH_READBACK_REQUIRED', 'use DOM or file readback for a replayable workflow; response evidence IDs expire')
      const flow = { schema: 'crawshrimp.workflow/v1', id: randomUUID(), name: String(args.name || 'Browser workflow').slice(0, 150),
        origin: new URL(record.page.url()).origin, steps, checks: verification, evidenceIds: proven.map(item => item.id), testedAt: new Date().toISOString() }
      state.workflows.set(flow.id, flow)
      const artifact = await writeArtifact(this.config, 'workflows', JSON.stringify(flow, null, 2), { filename: 'workflow.json', signal: execution.signal })
      state.workflowFiles.set(artifact.path, artifact.sha256)
      return { workflow: flow, artifact }
    }
    if (args.action === 'run') {
      let flow = state.workflows.get(args.workflowId)
      if (args.path) {
        const file = await workspaceFile(this.config, args.path, { maxBytes: 512 * 1024 })
        const bytes = await readFile(file.file)
        const fingerprint = createHash('sha256').update(bytes).digest('hex')
        const expected = state.workflowFiles.get(args.path) || args.expectedSha256
        if (!expected || expected !== fingerprint) throw new CapabilityError('WORKFLOW_CHANGED', 'workflow needs its original artifact SHA-256; revalidate an edited file before running')
        flow = JSON.parse(bytes.toString('utf8'))
      }
      if (flow?.schema !== 'crawshrimp.workflow/v1' || !Array.isArray(flow.steps) || flow.steps.length < 1 || flow.steps.length > 100 || !Array.isArray(flow.checks) || !flow.checks.length) throw new CapabilityError('WORKFLOW_INVALID', 'invalid workflow')
      const pageState = await this.manager.existingSessionFor(execution.agent, execution.signal)
      const record = this.manager.pageFor(pageState, args.pageId)
      if (new URL(record.page.url()).origin !== flow.origin) throw new CapabilityError('ORIGIN_MISMATCH', 'workflow requires its tested origin')
      const results = []
      for (const step of flow.steps) {
        execution.signal?.throwIfAborted()
        if (!replayable.has(step.method)) throw new CapabilityError('WORKFLOW_INVALID', 'unsupported workflow step')
        const input = substitute(step.args, args.params || {})
        if (step.method === 'navigate' && new URL(input.url).origin !== flow.origin) throw new CapabilityError('ORIGIN_MISMATCH', 'navigation leaves tested origin')
        const result = await invoke(step.method, { ...input, pageId: record.id }, execution)
        if (result?.success === false || result?.ok === false) throw new CapabilityError('WORKFLOW_STEP_FAILED', 'workflow step did not succeed; read back state before retrying')
        results.push(result)
      }
      const checks = substitute(flow.checks, args.params || {}).map(check => {
        if (check.receiptStep === undefined) return check
        if (!Number.isInteger(check.receiptStep) || check.receiptStep < 0 || check.receiptStep >= results.length || flow.steps[check.receiptStep].method !== 'download') throw new CapabilityError('WORKFLOW_INVALID', 'invalid file receipt binding')
        const receipt = results[check.receiptStep].receipt || results[check.receiptStep]
        const { receiptStep, receiptHash, ...resolved } = check
        return { ...resolved, path: receipt.path, ...(receiptHash ? { expectedSha256: receipt.sha256 } : {}) }
      })
      const verification = await this.verify(record.page, { checks }, execution)
      return { success: verification.verified, steps: results.length, verification }
    }
    throw new CapabilityError('ACTION_INVALID', 'workflow action must be list, distill, or run')
  }
  async adapter(args, execution) {
    const state = this.state(execution.agent)
    if (args.action === 'list') return { drafts: [...state.drafts.values()].map(({ id, manifest, tested }) => ({ id, adapterId: manifest.id, tested })) }
    if (args.action === 'draft') {
      const manifest = boundedJson(args.manifest, 128 * 1024), scripts = boundedJson(args.scripts, this.config.maxScriptBytes)
      if (!manifest || !scripts || Array.isArray(scripts) || typeof scripts !== 'object' || !Object.keys(scripts).length) throw new CapabilityError('ADAPTER_INVALID', 'manifest and script filename/source map required')
      const id = randomUUID(), directory = await workspaceDirectory(this.config, ['drafts', id])
      try {
        await writeFile(join(directory, 'manifest.yaml'), stringify(manifest), { flag: 'wx', mode: 0o600, signal: execution.signal })
        for (const [name, source] of Object.entries(scripts)) {
          if (!/^[a-zA-Z0-9_-]+\.js$/.test(name) || typeof source !== 'string') throw new CapabilityError('ADAPTER_INVALID', 'scripts must use simple .js filenames')
          await writeFile(join(directory, name), source, { flag: 'wx', mode: 0o600, signal: execution.signal })
        }
        await loadAdapter(directory, directory, this.config)
        state.drafts.set(id, { id, directory, manifest, scripts, tested: false, testedTasks: new Set(), fingerprint: hash({ manifest, scripts }) })
        return { draftId: id, valid: true, adapterId: manifest.id, tasks: manifest.tasks.map(task => task.id) }
      } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
    }
    const draft = state.drafts.get(args.draftId)
    if (!draft) throw new CapabilityError('DRAFT_NOT_FOUND', 'draft does not belong to this session')
    if (args.action === 'test') {
      const runtime = new ScriptsRuntime(this.scripts.ctx, { ...this.scripts.config, adapterRoots: [draft.directory] }, this.manager)
      runtime.capabilities = this.scripts.capabilities
      this.draftRuntimes.add(runtime)
      try {
        const result = await runtime.run({ adapter_id: draft.manifest.id, task_id: args.taskId, params: args.params || {}, max_pages: args.max_pages }, execution)
        if (result.success === true) draft.testedTasks.add(args.taskId)
        draft.tested = draft.manifest.tasks.every(task => draft.testedTasks.has(task.id))
        return { draftId: draft.id, tested: draft.tested, result }
      } finally { await runtime.dispose(); this.draftRuntimes.delete(runtime) }
    }
    if (args.action === 'publish') {
      if (!draft.tested) throw new CapabilityError('TEST_REQUIRED', 'all adapter tasks must pass before local publication')
      // Re-read and compare the tested bytes; a local edit invalidates approval.
      const adapter = await loadAdapter(draft.directory, draft.directory, this.config)
      if (adapter.tasks.some(task => task.source !== draft.scripts[task.script])) throw new CapabilityError('DRAFT_CHANGED', 'script changed since test')
      const manifest = await readFile(join(draft.directory, 'manifest.yaml'), 'utf8')
      if (manifest !== stringify(draft.manifest)) throw new CapabilityError('DRAFT_CHANGED', 'manifest changed since test')
      const parent = await workspaceDirectory(this.config, ['adapters'])
      const target = join(parent, draft.manifest.id)
      // mkdir is the no-overwrite reservation, then copy exact tested sources.
      const { mkdir } = await import('node:fs/promises')
      await mkdir(target, { mode: 0o700 })
      try {
        await writeFile(join(target, 'manifest.yaml'), manifest, { flag: 'wx', mode: 0o600, signal: execution.signal })
        for (const [name, source] of Object.entries(draft.scripts)) await writeFile(join(target, name), source, { flag: 'wx', mode: 0o600, signal: execution.signal })
        if (!this.scripts.config.adapterRoots.includes(parent)) this.scripts.config = { ...this.scripts.config, adapterRoots: [...this.scripts.config.adapterRoots, parent] }
        return { published: true, adapterId: draft.manifest.id, path: `adapters/${draft.manifest.id}`, scope: 'local workspace; no remote submission' }
      } catch (error) { await rm(target, { recursive: true, force: true }); throw error }
    }
    throw new CapabilityError('ACTION_INVALID', 'adapter action must be draft, test, publish, or list')
  }
  async dispose() { await Promise.allSettled([...this.draftRuntimes].map(runtime => runtime.dispose())); this.ids.clear(); this.objects = new WeakMap() }
}
