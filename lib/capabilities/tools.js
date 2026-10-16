import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { existsSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute, sep } from 'node:path'
import { BrowserIntelligence } from './intelligence.js'
import { BrowserTransfers } from './transfers.js'
import { BrowserEvidence } from './evidence.js'
import { redact, writeArtifact, workspacePath, CapabilityError } from './common.js'

export const CAPABILITY_TOOL_NAMES = Object.freeze(Object.fromEntries([
  'probe', 'evaluate', 'request', 'capture_requests', 'upload', 'download', 'verify', 'journal', 'workflow', 'adapter',
].map(name => [name, `crawshrimp_browser_${name}`])))
export const CAPABILITY_ACTIONS = new Set(['evaluate', 'request', 'capture_requests', 'upload', 'download', 'workflow', 'adapter'].map(name => CAPABILITY_TOOL_NAMES[name]))
const str = { type: 'string' }, integer = { type: 'integer' }, object = { type: 'object', additionalProperties: true }
const input = (properties, required = [], page = true) => ({ type: 'object', properties: { ...(page ? { pageId: str } : {}), ...properties }, required, additionalProperties: false })
const definitions = {
  probe: ['Inspect the owned page DOM/framework and endpoint metadata; save a redacted PageModel and API-first strategy bundle.', input({})],
  evaluate: ['Execute JavaScript in the owned page with native approval and a bounded redacted result. Arbitrary code can mutate state; no automatic retry.', input({ expression: str, timeoutMs: integer }, ['expression'])],
  request: ['Make one same-origin authenticated request inside the owned page, with native approval. Return bounded redacted status/data; never automatically retry.', input({ url: str, method: str, headers: object, body: {}, timeoutMs: integer }, ['url'])],
  capture_requests: ['Capture bounded network evidence from this exact owned page, optionally while reloading, clicking or scrolling. Bodies are opt-in and redacted.', input({ durationMs: integer, maxEntries: integer, includeBodies: { type: 'boolean' }, urlIncludes: str, method: str, status: integer, trigger: object })],
  upload: ['Upload workspace-relative files into an owned file input or file chooser; verify file receipts. Native approval required.', input({ paths: { type: 'array', items: str }, selector: str, chooserSelector: str }, ['paths'])],
  download: ['Download from an owned page click/blob or same-origin URL into the workspace, with bounded size and verified file receipt. Native approval required.', input({ url: str, selector: str, filename: str, maxBytes: integer, expectedMime: str, expectedSha256: str, magicHex: str, timeoutMs: integer })],
  verify: ['Read back DOM, URL, title, recorded API response or workspace file state using explicit checks. Save evidence; a click alone is not business success.', input({ checks: { type: 'array', items: object, minItems: 1, maxItems: 30 } }, ['checks'])],
  journal: ['Read this session redacted action and verification evidence; optionally export a private workspace journal.', input({ limit: integer, export: { type: 'boolean' } }, [], false)],
  workflow: ['Distill successful verified actions into a workspace workflow; list or explicitly run it once with fresh readback. File workflows require the original artifact SHA-256; local publication never submits remotely.', input({ action: { enum: ['list', 'distill', 'run'] }, name: str, evidenceIds: { type: 'array', items: str }, workflowId: str, path: str, expectedSha256: str, params: object }, ['action'])],
  adapter: ['Create a portable adapter draft, test tasks in isolated script contexts, then publish the exact tested bytes locally. All tasks must pass; this does not submit anything remotely.', input({ action: { enum: ['list', 'draft', 'test', 'publish'] }, draftId: str, manifest: object, scripts: object, taskId: str, params: object, max_pages: integer }, ['action'], false)],
}

export function createCapabilityTools(ctx, manager, scripts) {
  const published = join(workspacePath(manager.config), 'adapters')
  if (existsSync(published)) {
    const root = realpathSync(workspacePath(manager.config)), directory = realpathSync(published)
    const distance = relative(root, directory)
    if (distance === '..' || distance.startsWith(`..${sep}`) || isAbsolute(distance)) throw new CapabilityError('PATH_ESCAPE', 'published adapters resolve outside workspace')
    if (!scripts.config.adapterRoots.includes(directory)) scripts.config = { ...scripts.config, adapterRoots: [...scripts.config.adapterRoots, directory] }
  }
  const intel = new BrowserIntelligence(manager.config)
  const transfers = new BrowserTransfers(manager.config)
  const evidence = new BrowserEvidence(manager.config, manager, intel, transfers, scripts)
  const direct = async (method, args, execution) => {
    if (method === 'journal') return evidence.journal(args, execution)
    if (method === 'adapter') return evidence.adapter(args, execution)
    if (method === 'workflow') return evidence.workflow(args, execution, direct)
    const state = await manager.existingSessionFor(execution.agent, execution.signal)
    if (!state) throw new CapabilityError('PAGE_REQUIRED', 'open an owned browser page first')
    const record = manager.pageFor(state, args.pageId)
    return manager.withCancellation(state, record.page, execution.signal, async () => {
      let result
      if (method === 'verify') result = await evidence.verify(record.page, args, execution)
      else if (['upload', 'download'].includes(method)) result = await transfers[method](record.page, args, execution.signal)
      else if (Object.hasOwn(CAPABILITY_TOOL_NAMES, method)) {
        result = await intel[method === 'capture_requests' ? 'capture' : method](record.page, args, execution.signal)
        if (method === 'probe' || method === 'capture_requests') result.artifact = await writeArtifact(manager.config, 'probes', JSON.stringify(redact(result), null, 2), { signal: execution.signal })
      } else if (['navigate', 'click', 'fill', 'select', 'press'].includes(method)) result = await manager[method](args, execution)
      else throw new CapabilityError('ACTION_INVALID', 'unsupported browser action')
      return { ...result, pageId: record.id }
    })
  }
  scripts.capabilities = async (action, page, meta, signal) => {
    const args = meta.args || meta
    const batch = async (items, method) => {
      if (!Array.isArray(items) || !items.length || items.length > 20) throw new CapabilityError('ACTION_INVALID', 'phase items must contain 1 to 20 entries')
      const receipts = []
      for (const item of items) { signal?.throwIfAborted(); receipts.push(await method(item)) }
      return { success: true, items: receipts }
    }
    switch (action) {
      case 'inject_files': case 'file_chooser_upload':
        if (args.items) return batch(args.items, item => transfers.upload(page, { ...item, paths: item.paths || item.files,
          ...(action === 'file_chooser_upload' ? { chooserSelector: item.chooserSelector || item.selector } : {}),
        }, signal))
        return transfers.upload(page, args, signal)
      case 'upload': return transfers.upload(page, args, signal)
      case 'download_urls': case 'download_click': case 'download_clicks':
        if (args.items) return batch(args.items, item => transfers.download(page, item, signal))
        return transfers.download(page, args, signal)
      case 'download': return transfers.download(page, args, signal)
      case 'capture_requests': return intel.capture(page, args, signal)
      default: throw new CapabilityError('UNSUPPORTED_ACTION', `unsupported phase action: ${action}`)
    }
  }
  manager.capabilities = { intel, transfers, evidence, invoke: direct }
  const tools = Object.entries(definitions).map(([method, [description, inputSchema]]) => createMcpToolDefinition(ctx, {
    name: CAPABILITY_TOOL_NAMES[method], rawName: CAPABILITY_TOOL_NAMES[method], description, inputSchema,
    call: async (args, execution) => {
      const run = async () => {
        let result
        try {
          result = await direct(method, args, execution)
          if (method !== 'journal') {
            const entry = evidence.record(execution, CAPABILITY_TOOL_NAMES[method], args, result)
            result = { ...result, evidenceId: entry.id }
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
        } catch (error) {
          if (method !== 'journal') evidence.record(execution, CAPABILITY_TOOL_NAMES[method], args, undefined, error)
          throw error
        }
      }
      const pageAction = CAPABILITY_ACTIONS.has(CAPABILITY_TOOL_NAMES[method]) && !['adapter'].includes(method) && (method !== 'workflow' || args.action !== 'list')
      return pageAction ? manager.withPreviewAutomation(args, execution, run) : run()
    },
  }))
  return tools
}
