import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { ScriptsError } from './errors.js'

export const SCRIPT_TOOL_NAMES = Object.freeze({
  list: 'crawshrimp_browser_script_list',
  validate: 'crawshrimp_browser_script_validate',
  run: 'crawshrimp_browser_script_run',
})

const triggerSchema = {
  type: 'object',
  properties: { type: { type: 'string' } },
  required: ['type'],
  additionalProperties: false,
}

const paramSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    label: { type: 'string' },
    required: { type: 'boolean' },
    default: {},
    min: { type: 'number' },
    max: { type: 'number' },
    options: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['id', 'type', 'label', 'required'],
  additionalProperties: false,
}

const listInputSchema = {
  type: 'object',
  properties: { adapter_id: { type: 'string' } },
  additionalProperties: false,
}

const listOutputSchema = {
  type: 'object',
  properties: {
    adapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          version: { type: 'string' },
          description: { type: 'string' },
          author: { type: 'string' },
          entry_url: { type: 'string' },
          skip_auth: { type: 'boolean' },
          trigger: triggerSchema,
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                adapter_id: { type: 'string' },
                adapter_name: { type: 'string' },
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                script: { type: 'string' },
                entry_url: { type: 'string' },
                params_declared: { type: 'boolean' },
                params: { type: 'array', items: paramSchema },
                skip_auth: { type: 'boolean' },
                trigger: triggerSchema,
              },
              required: ['adapter_id', 'adapter_name', 'id', 'name', 'description', 'script', 'entry_url', 'params_declared', 'params', 'skip_auth', 'trigger'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'name', 'version', 'description', 'author', 'entry_url', 'skip_auth', 'trigger', 'tasks'],
        additionalProperties: false,
      },
    },
  },
  required: ['adapters'],
  additionalProperties: false,
}

const validateInputSchema = {
  type: 'object',
  properties: {
    adapter_id: { type: 'string' },
    task_id: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
  },
  required: ['adapter_id', 'task_id'],
  additionalProperties: false,
}

const validateOutputSchema = {
  type: 'object',
  properties: {
    valid: { type: 'boolean' },
    diagnostics: {
      type: 'array',
      items: {
        type: 'object',
        properties: { code: { type: 'string' }, message: { type: 'string' } },
        required: ['code', 'message'],
        additionalProperties: false,
      },
    },
    adapter_id: { type: 'string' },
    task_id: { type: 'string' },
    entry_url: { type: 'string' },
    schema: { type: 'array', items: paramSchema },
    params: { type: 'object', additionalProperties: true },
    globals: { type: 'array', items: { type: 'string' } },
  },
  required: ['valid', 'diagnostics'],
  additionalProperties: false,
}

const runInputSchema = {
  type: 'object',
  properties: {
    adapter_id: { type: 'string' },
    task_id: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
    max_pages: { type: 'integer', minimum: 1, maximum: 100 },
    max_phases: { type: 'integer', minimum: 1, maximum: 200 },
  },
  required: ['adapter_id', 'task_id'],
  additionalProperties: false,
}

const runOutputSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: { type: 'array', items: {} },
    meta: { type: 'object', additionalProperties: true },
    artifact: {
      type: 'object',
      properties: { path: { type: 'string' }, bytes: { type: 'integer' } },
      required: ['path', 'bytes'],
      additionalProperties: false,
    },
  },
  required: ['success', 'data', 'meta', 'artifact'],
  additionalProperties: false,
}

function mcpResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

export function createScriptToolDefinitions(ctx, runtime) {
  return [
    createMcpToolDefinition(ctx, {
      name: SCRIPT_TOOL_NAMES.list,
      rawName: SCRIPT_TOOL_NAMES.list,
      description: 'List portable Crawshrimp script adapters and their declared tasks.',
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
      call: async (args) => mcpResult(await runtime.list(args)),
    }),
    createMcpToolDefinition(ctx, {
      name: SCRIPT_TOOL_NAMES.validate,
      rawName: SCRIPT_TOOL_NAMES.validate,
      description: 'Validate a portable Crawshrimp task and its parameters without native approval or browser startup.',
      inputSchema: validateInputSchema,
      outputSchema: validateOutputSchema,
      call: async (args) => mcpResult(await runtime.validate(args)),
    }),
    createMcpToolDefinition(ctx, {
      name: SCRIPT_TOOL_NAMES.run,
      rawName: SCRIPT_TOOL_NAMES.run,
      description: 'Run one portable Crawshrimp page script in a new isolated browser context. Uses the native DSH permission preset: automatic in Full Access, otherwise native approval before page JavaScript runs.',
      inputSchema: runInputSchema,
      outputSchema: runOutputSchema,
      call: async (args, execution) => {
        const result = await runtime.run(args, execution)
        if (result.success === false) {
          const reason = typeof result.meta?.error === 'string' && result.meta.error.trim()
            ? result.meta.error.trim()
            : 'portable page script returned success: false'
          throw new ScriptsError('SCRIPT_DECLARED_FAILURE', reason, { result })
        }
        return mcpResult(result)
      },
    }),
  ]
}
