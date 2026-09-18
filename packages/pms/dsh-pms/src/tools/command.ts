import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PmsIntegrationClient } from '../client/PmsIntegrationClient.ts'
import type { PmsCommandPreviewRequest, PmsCommandResult, PmsContextLocator, PmsJsonObject } from '../types.ts'
import type { PmsContextStore } from '../context/pms-context-store.ts'

const COMMANDS = [
  'member.add', 'member.remove',
  'node.complete', 'node.owner.update', 'node.rollback', 'node.schedule.update',
  'project.archive', 'project.create', 'project.delete',
  'task.create', 'task.assign', 'task.update',
] as const

/** Register the non-mutating preview and explicitly-confirmed execute halves of PMS writes. */
export function registerPmsCommandTools(
  ctx: Context,
  client: PmsIntegrationClient,
  contextStore: PmsContextStore,
  enabled: { preview?: boolean; execute?: boolean } = { preview: true, execute: true },
): void {
  if (enabled.execute) ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== 'pms_command_execute') return next()
    return Promise.resolve({
      kind: 'ask' as const,
      reason: 'PMS 写操作即将落库。请确认预览中的具体变更后再执行。',
    })
  })

  if (enabled.execute) {
    ctx.on('agent/turn-stopping', ({ agent }) => {
      contextStore.flushRefresh(agent.id)
    })
  }

  if (enabled.preview) ctx.tools.register(defineTool({
    name: 'pms_command_preview',
    description: 'Create a non-mutating PMS change preview. Always preview before a write, show the exact changes and warnings to the user, use Chinese labels for every visible field (for example “名称”“开始日期”“优先级”“操作编号”), and wait for explicit confirmation in a later user message before executing.',
    parameters: {
      command: { type: 'string', enum: [...COMMANDS], required: true, description: 'Allow-listed PMS command.' },
      arguments: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'Command arguments. Current projectId and nodeId are filled from the PMS session tag when omitted.',
      },
      contextId: { type: 'string', description: 'Optional stable context id; derived from the current PMS session when omitted.' },
      contextVersion: { type: 'string', description: 'Optional PMS context version; defaults to the current locator version or v1.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args, exec) => {
      const locator = contextStore.get(exec.agent?.id)
      const request = buildPreviewRequest(args, locator)
      return client.previewCommand(request, exec.signal, exec.agent?.id)
    },
    isConcurrencySafe: () => false,
  }))

  if (enabled.execute) ctx.tools.register(defineTool({
    name: 'pms_command_execute',
    description: 'Execute one previously previewed PMS operation after the user has explicitly confirmed that exact preview. Never invent an operationId and never execute without a confirmed preview from the current conversation. When no idempotencyKey is supplied, the tool derives a stable key from operationId so retries remain idempotent.',
    parameters: {
      operationId: { type: 'string', required: true, description: 'The operationId returned by the latest PMS command preview.' },
      idempotencyKey: { type: 'string', description: 'Optional stable key. When omitted, it is deterministically derived from operationId and reused on retries.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args, exec) => executePmsOperation(client, contextStore, args, exec),
    isConcurrencySafe: () => false,
  }))
}

export async function executePmsOperation(
  client: PmsIntegrationClient,
  contextStore: PmsContextStore,
  args: { operationId: string; idempotencyKey?: string },
  exec: { signal: AbortSignal; agent?: { id?: string } },
): Promise<PmsCommandResult> {
  const result = await client.executeOperation(
    args.operationId,
    args.idempotencyKey ?? stableIdempotencyKey(args.operationId),
    exec.signal,
    exec.agent?.id,
  )
  if (isSuccessfulPmsOperation(result)) {
    contextStore.queueRefresh(exec.agent?.id, refreshScopes(result.refreshScopes), result.operationId)
  }
  return result
}

function stableIdempotencyKey(operationId: string): string {
  return `pms-operation-${operationId}`
}

function isSuccessfulPmsOperation(result: PmsCommandResult): boolean {
  return ['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'OK'].includes(result.status.trim().toUpperCase())
}

function refreshScopes(value: PmsJsonObject[keyof PmsJsonObject] | undefined): string[] {
  if (!Array.isArray(value)) return ['current-page']
  const scopes = value.filter((scope): scope is string => typeof scope === 'string')
  return scopes.length === 0 ? ['current-page'] : scopes
}

function buildPreviewRequest(args: {
  command: string
  arguments: Record<string, unknown>
  contextId?: string
  contextVersion?: string
}, locator: PmsContextLocator | undefined): PmsCommandPreviewRequest {
  const commandArguments: PmsJsonObject = { ...args.arguments } as PmsJsonObject
  if (commandArguments.projectId === undefined && locator?.projectId !== undefined) {
    commandArguments.projectId = locator.projectId
  }
  if (commandArguments.nodeId === undefined && locator?.nodeId !== undefined) {
    commandArguments.nodeId = locator.nodeId
  }
  const projectPart = commandArguments.projectId ?? 'none'
  const nodePart = commandArguments.nodeId ?? 'none'
  return {
    name: args.command,
    arguments: commandArguments,
    contextId: args.contextId?.trim() || `pms:${locator?.pageType ?? 'global'}:${projectPart}:${nodePart}`,
    contextVersion: args.contextVersion?.trim() || locator?.contextVersion || 'v1',
  }
}
