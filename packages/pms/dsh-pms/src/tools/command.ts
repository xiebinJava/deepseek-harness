import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PmsIntegrationClient } from '../client/PmsIntegrationClient.ts'
import type {
  PmsCapabilities,
  PmsCommandPreviewRequest,
  PmsCommandResult,
  PmsContextLocator,
  PmsJsonObject,
  PmsOperationBinding,
} from '../types.ts'
import type { PmsContextStore } from '../context/pms-context-store.ts'

const COMMANDS = [
  'member.add', 'member.remove',
  'node.complete', 'node.owner.update', 'node.rollback', 'node.schedule.update',
  'project.archive', 'project.create', 'project.delete',
  'project.update',
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
    execute: async (args, exec) => {
      const locator = contextStore.get(exec.agent?.id)
      // Fail closed before any PMS call when this node has no usable contract.
      const binding = requireOperationBinding(locator, contextStore.getContract(exec.agent?.id))
      const capabilities = await client.capabilities(exec.signal, exec.agent?.id)
      const request = buildPreviewRequest(
        args,
        binding,
        acceptedArguments(capabilities, args.command),
        locator,
      )
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
  const locator = contextStore.get(exec.agent?.id)
  const contractState = contextStore.getContract(exec.agent?.id)
  const binding = requireOperationBinding(locator, contractState)
  const result = await client.executeOperation(
    args.operationId,
    args.idempotencyKey ?? stableIdempotencyKey(args.operationId),
    exec.signal,
    exec.agent?.id,
    binding,
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
}, binding: PmsOperationBinding, declared: ReadonlySet<string> | undefined,
locator: PmsContextLocator | undefined): PmsCommandPreviewRequest {
  const requestedContextId = args.contextId?.trim()
  const requestedContextVersion = args.contextVersion?.trim()
  if ((requestedContextId !== undefined && requestedContextId !== binding.contextId)
    || (requestedContextVersion !== undefined && requestedContextVersion !== binding.contextVersion)) {
    throw new Error('PMS 写操作上下文必须绑定当前项目和节点')
  }
  // Only fill the current PMS page context into the arguments PMS actually
  // declares. Commands such as `project.create` take no project or node, and an
  // injected `projectId` makes PMS reject the whole preview.
  const accepts = (key: string): boolean => declared === undefined || declared.has(key)
  const commandArguments: PmsJsonObject = { ...args.arguments } as PmsJsonObject
  if (commandArguments.projectId === undefined && locator?.projectId !== undefined && accepts('projectId')) {
    commandArguments.projectId = locator.projectId
  }
  if (commandArguments.nodeId === undefined && locator?.nodeId !== undefined && accepts('nodeId')) {
    commandArguments.nodeId = locator.nodeId
  }
  return {
    name: args.command,
    arguments: commandArguments,
    contextId: binding.contextId,
    contextVersion: binding.contextVersion,
    contractId: binding.contractId,
    contractVersion: binding.contractVersion,
  }
}

/**
 * Argument names the PMS capability catalog declares for one command, or
 * `undefined` when PMS did not publish that command in this session.
 */
function acceptedArguments(capabilities: PmsCapabilities, command: string): ReadonlySet<string> | undefined {
  const descriptor = capabilities.commands?.find(item => item.name === command)
  if (descriptor === undefined) return undefined
  const parameters: unknown = descriptor.parameters
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) return undefined
  return new Set(Object.keys(parameters))
}

function requireOperationBinding(
  locator: PmsContextLocator | undefined,
  contractState: ReturnType<PmsContextStore['getContract']>,
): PmsOperationBinding {
  if (contractState?.status !== 'ready' || contractState.contract === undefined) {
    throw new Error('PMS 当前节点契约未加载，禁止执行写入')
  }
  const projectPart = locator?.projectId ?? 'none'
  const nodePart = locator?.nodeId ?? 'none'
  return {
    contextId: `pms:${locator?.pageType ?? 'global'}:${projectPart}:${nodePart}`,
    contextVersion: locator?.contextVersion || 'v1',
    contractId: contractState.contract.contractId,
    contractVersion: contractState.contract.contractVersion,
  }
}
