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

/** The generic batch wrapper, whose children need the same page context. */
const BATCH_COMMAND = 'batch.write'

/** Register the non-mutating preview and the execute half of PMS writes. */
export interface PmsCommandToolOptions {
  preview?: boolean
  execute?: boolean
  /**
   * Loads the node contract on demand. A write tool must not depend on the
   * system prompt having been assembled first, so it self-heals instead of
   * reporting "契约未加载".
   */
  ensureContract?: (sessionId: string | undefined, signal?: AbortSignal) => Promise<void>
}

export function registerPmsCommandTools(
  ctx: Context,
  client: PmsIntegrationClient,
  contextStore: PmsContextStore,
  enabled: PmsCommandToolOptions = { preview: true, execute: true },
): void {
  if (enabled.execute) {
    ctx.on('agent/turn-stopping', ({ agent }) => {
      contextStore.flushRefresh(agent.id)
    })
  }

  if (enabled.preview) ctx.tools.register(defineTool({
    name: 'pms_command_preview',
    description: 'Create a non-mutating PMS change preview. Always preview before a write, use Chinese labels for every visible field (for example “名称”“开始日期”“优先级”“项目经理”“关注人”), and then call pms_command_execute with the returned operationId in the same turn — the caller already holds this account\'s own write authority, so do not ask for confirmation and do not wait for a later message.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'PMS command name published by the current PMS session capabilities '
          + '(for example project.update, node.field.update, batch.write). The PMS capability '
          + 'catalog is authoritative: an unpublished name is rejected before any write.',
      },
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
      await ensureReadyContract(contextStore, enabled.ensureContract, exec.agent?.id, exec.signal)
      const locator = contextStore.get(exec.agent?.id)
      // Fail closed before any PMS call when this node has no usable contract.
      const binding = requireOperationBinding(locator, contextStore.getContract(exec.agent?.id))
      const capabilities = await client.capabilities(exec.signal, exec.agent?.id)
      requirePublishedCommand(capabilities, args.command)
      const request = buildPreviewRequest(
        args,
        binding,
        acceptedArguments(capabilities, args.command),
        locator,
        capabilities,
      )
      return client.previewCommand(request, exec.signal, exec.agent?.id)
    },
    isConcurrencySafe: () => false,
  }))

  if (enabled.execute) ctx.tools.register(defineTool({
    name: 'pms_command_execute',
    description: 'Execute one PMS operation that was previewed in this turn. Never invent an operationId and never execute an operation the current conversation has not just previewed. When no idempotencyKey is supplied, the tool derives a stable key from operationId so retries remain idempotent.',
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

/**
 * Commands are published by PMS, never hardcoded here. This keeps the plugin
 * correct when PMS adds a command, and still fails closed for a name the
 * current delegation cannot see.
 */
function requirePublishedCommand(capabilities: PmsCapabilities, command: string): void {
  const published = capabilities.commands ?? []
  if (published.some(item => item.name === command)) return
  const available = published.map(item => item.name).join('、') || '无'
  throw new Error(`PMS 当前会话不支持命令 ${command}；可用命令：${available}`)
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

/**
 * Loads the contract when this session has none yet (for example a write that
 * arrives before any prompt assembly, or after the contract state was cleared).
 */
async function ensureReadyContract(
  contextStore: PmsContextStore,
  ensureContract: PmsCommandToolOptions['ensureContract'],
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (contextStore.getContract(sessionId)?.status === 'ready') return
  if (ensureContract === undefined) return
  await ensureContract(sessionId, signal)
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
locator: PmsContextLocator | undefined,
capabilities: PmsCapabilities): PmsCommandPreviewRequest {
  const requestedContextId = args.contextId?.trim()
  const requestedContextVersion = args.contextVersion?.trim()
  if ((requestedContextId !== undefined && requestedContextId !== binding.contextId)
    || (requestedContextVersion !== undefined && requestedContextVersion !== binding.contextVersion)) {
    throw new Error('PMS 写操作上下文必须绑定当前项目和节点')
  }
  const commandArguments: PmsJsonObject = { ...args.arguments } as PmsJsonObject
  fillPageContext(commandArguments, declared, locator)
  // A batch carries its own commands, so every child gets the page context the
  // same way a direct call would; otherwise the caller has to repeat the project
  // and node on each item.
  if (args.command === BATCH_COMMAND) fillBatchContext(commandArguments, capabilities, locator)
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
 * Fills the current PMS page context into arguments PMS actually declares.
 * Commands such as `project.create` take no project or node, and an injected
 * `projectId` makes PMS reject the whole preview.
 */
function fillPageContext(
  target: PmsJsonObject,
  declared: ReadonlySet<string> | undefined,
  locator: PmsContextLocator | undefined,
): void {
  const accepts = (key: string): boolean => declared === undefined || declared.has(key)
  if (target.projectId === undefined && locator?.projectId !== undefined && accepts('projectId')) {
    target.projectId = locator.projectId
  }
  if (target.nodeId === undefined && locator?.nodeId !== undefined && accepts('nodeId')) {
    target.nodeId = locator.nodeId
  }
}

function fillBatchContext(
  target: PmsJsonObject,
  capabilities: PmsCapabilities,
  locator: PmsContextLocator | undefined,
): void {
  const operations = target.operations
  if (!Array.isArray(operations)) return
  target.operations = operations.map((operation) => {
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) return operation
    const item = operation as { command?: unknown; arguments?: unknown }
    if (typeof item.command !== 'string') return operation
    const childArguments: PmsJsonObject = item.arguments === null
      || typeof item.arguments !== 'object'
      || Array.isArray(item.arguments)
      ? {}
      : { ...(item.arguments as PmsJsonObject) }
    fillPageContext(childArguments, acceptedArguments(capabilities, item.command), locator)
    return { ...item, command: item.command, arguments: childArguments } as PmsJsonObject
  })
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
    // Surface the recorded cause (missing login, unregistered node, load failure)
    // so the reply tells the user what to do instead of a generic refusal.
    throw new Error(contractState?.errorMessage ?? 'PMS 当前节点契约未加载，禁止执行写入')
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
