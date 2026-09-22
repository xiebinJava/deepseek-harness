import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { PmsIntegrationClient, PmsIntegrationError } from './client/PmsIntegrationClient.ts'
import { PmsContextStore } from './context/pms-context-store.ts'
import { Config, resolveConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import type { PmsAgentContract, PmsCapabilities, PmsContextLocator, PmsViewer } from './types.ts'
import { registerProjectDetailTool } from './tools/project-detail.ts'
import { registerProjectListTool } from './tools/project-list.ts'
import { registerTaskListTool } from './tools/task-list.ts'
import { registerPeopleListTool } from './tools/people-list.ts'
import { registerPmsQueryTool } from './tools/query.ts'
import { registerPmsCommandTools } from './tools/command.ts'
import { PmsContextController } from './remote.ts'
import { PmsAuthStore } from './auth/pms-auth-store.ts'
import { PmsSsoCredentials, type BrowserIdentityLike } from './auth/pms-sso-credentials.ts'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

export { Config }
export type * from './types.ts'
export { PmsIntegrationClient, PmsIntegrationError } from './client/PmsIntegrationClient.ts'
export type { PmsIntegrationClientOptions } from './client/PmsIntegrationClient.ts'
export { PmsContextStore } from './context/pms-context-store.ts'
export { PmsAuthStore } from './auth/pms-auth-store.ts'
export { PmsContextController } from './remote.ts'
export { pmsSessionTags } from './context/pms-session-tags.ts'
export {
  DEFAULT_PMS_API_PREFIX, DEFAULT_PMS_BASE_URL, DEFAULT_PMS_TIMEOUT_MS, resolveConfig,
  type PmsRuntimeMode, type ResolvedConfig,
} from './config.ts'

export const name = 'dsh-pms'
export const inject = ['tools', 'systemPrompt']

/** `tools: ['*']` mounts every tool the current PMS delegation publishes. */
export const ALL_TOOLS = '*'

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const parentClient = ctx.get('pmsIntegrationClient')
  const parentContextStore = ctx.get('pmsContextStore')
  const parentAuthStore = ctx.get('pmsAuthStore')

  if (resolved.mode === 'agent') {
    if (parentClient === undefined || parentContextStore === undefined || parentAuthStore === undefined) {
      throw new Error('dsh-pms: agent mode requires a host-mode dsh-pms bridge')
    }
    registerAgentCapabilities(ctx, parentClient, parentContextStore, resolved.agentId,
      resolveAllowedTools(resolved))
    return
  }

  const authStore = parentAuthStore ?? new PmsAuthStore()
  // A plain conversation has no PMS page to bridge an auth code, so the host
  // hands the client the SSO-derived, persisted PMS session instead.
  const browserIdentity = ctx.get('browserIdentity' as never) as BrowserIdentityLike | undefined
  const credentialSeam = ctx.get('credentials' as never) as CredentialProvider | undefined
  const ssoCredentials = parentClient === undefined
    ? new PmsSsoCredentials({
      baseUrl: resolved.baseUrl,
      apiPrefix: resolved.apiPrefix,
      serviceKey: resolved.serviceKey,
      ...(credentialSeam === undefined ? {} : { credentials: credentialSeam }),
      ...(browserIdentity === undefined ? {} : { identity: browserIdentity }),
    })
    : undefined
  const client = parentClient ?? new PmsIntegrationClient({
    ...resolved,
    authStore,
    ...(ssoCredentials === undefined ? {} : { credentials: ssoCredentials }),
  })
  const contextStore = parentContextStore ?? new PmsContextStore()
  if (parentClient === undefined) ctx.provide('pmsIntegrationClient', client)
  if (parentContextStore === undefined) ctx.provide('pmsContextStore', contextStore)
  if (parentAuthStore === undefined) ctx.provide('pmsAuthStore', authStore)
  ctx.plugin(PmsContextController)
  if (resolved.mode === 'host') return

  registerAgentCapabilities(ctx, client, contextStore, resolved.agentId, resolveAllowedTools(resolved))
}

/**
 * Tool mounting is driven by config plus what PMS publishes, never by a list
 * baked into this plugin: `['*']` (or an empty list in legacy full mode) mounts
 * everything the delegation publishes, and PMS still fails closed per tool.
 */
function resolveAllowedTools(resolved: ResolvedConfig): readonly string[] | undefined {
  if (resolved.tools.includes(ALL_TOOLS)) return undefined
  if (resolved.tools.length === 0) return undefined
  return resolved.tools
}

function registerAgentCapabilities(
  ctx: Context,
  client: PmsIntegrationClient,
  contextStore: PmsContextStore,
  agentId: string,
  allowedTools?: readonly string[],
): void {
  const enabled = (tool: string): boolean => allowedTools === undefined || allowedTools.includes(tool)
  if (allowedTools !== undefined && allowedTools.length === 0) return
  const scopedClient = allowedTools === undefined ? client : client.scopedToTools(allowedTools)
  ctx.systemPrompt.section({
    name: 'tool:pms',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW') + 1,
    text: PMS_PROMPT,
  })
  const ensureContract = async (sessionId: string | undefined, signal?: AbortSignal): Promise<string> => {
    let locator = contextStore.get(sessionId)
    try {
      locator = await resolveCurrentNodeLocator(scopedClient, contextStore, locator, signal, sessionId)
    } catch (error) {
      const message = `PMS 当前节点无法解析，禁止执行写入，请先恢复项目上下文查询。错误：${error instanceof Error ? error.message : String(error)}`
      contextStore.setContract(sessionId, { status: 'unavailable', errorCode: 'PMS_CURRENT_NODE_UNAVAILABLE', errorMessage: message })
      return message
    }
    const nodeKey = locator?.currentNodeKey
    // Without a page node the Agent still runs under the workflow's entry
    // contract: global actions such as project creation must not be blocked just
    // because the user asked from the launcher instead of a project page.
    const wantedNodeKey = nodeKey ?? PROJECT_LIST_NODE_KEY
    try {
      // PMS publishes which workflow nodes each contract covers, so a new node
      // contract never needs a matching edit in this plugin.
      const capabilities = await scopedClient.capabilities(signal, sessionId)
      const contractTarget = resolveContractTarget(capabilities, wantedNodeKey, agentId)
      if (contractTarget === undefined) {
        const message = `PMS 当前节点没有已注册契约（节点：${nodeKey}）。禁止执行写入，请先补充节点契约。`
        contextStore.setContract(sessionId, { status: 'unavailable', errorCode: 'PMS_NODE_CONTRACT_NOT_REGISTERED', errorMessage: message })
        return message
      }
      const contract = await scopedClient.getAgentContract(
        contractTarget.agentId, contractTarget.contractKey, signal, sessionId)
      if (nodeKey !== undefined && !contract.workflowNodeKeys.includes(nodeKey)) {
        throw new Error(`契约节点不匹配：${contract.contractKey} 未绑定 ${nodeKey}`)
      }
      const previous = contextStore.getContract(sessionId)
      const sameContract = previous?.contract?.contractId === contract.contractId
        && previous.contract.contractVersion === contract.contractVersion
      const loadedAt = sameContract && previous.loadedAt !== undefined
        ? previous.loadedAt
        : new Date().toISOString()
      contextStore.setContract(sessionId, { status: 'ready', contract, loadedAt })
      return renderContractPrompt(contract, locator, loadedAt, capabilities)
    } catch (error) {
      // A missing PMS login is not a contract problem: say what the user must do
      // instead of reporting a contract failure that looks like a system fault.
      if (error instanceof PmsIntegrationError && error.code === 'PMS_AUTH_REQUIRED') {
        const message = 'PMS 登录态不可用：请从 DSH 右侧的「PMS 业务工作区」打开 PMS 后再操作，'
          + '普通对话无法代表你的 PMS 账号。'
        contextStore.setContract(sessionId, { status: 'unavailable', errorCode: 'PMS_AUTH_REQUIRED', errorMessage: message })
        return message
      }
      const message = `PMS 当前节点契约加载失败（节点：${nodeKey}）。禁止执行写入，请先恢复契约服务后重试。错误：${error instanceof Error ? error.message : String(error)}`
      contextStore.setContract(sessionId, { status: 'unavailable', errorCode: 'PMS_AGENT_CONTRACT_UNAVAILABLE', errorMessage: message })
      return message
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (!enabled('pms_command_preview') && !enabled('pms_command_execute')) return assembled
    return withContractPrompt(assembled, await ensureContract(context.agent?.id, context.signal))
  })
  if (enabled('pms_project_list')) registerProjectListTool(ctx, scopedClient)
  if (enabled('pms_project_get')) registerProjectDetailTool(ctx, scopedClient, contextStore)
  if (enabled('pms_task_list')) registerTaskListTool(ctx, scopedClient, contextStore)
  if (enabled('pms_people_list')) registerPeopleListTool(ctx, scopedClient)
  if (enabled('pms_query')) registerPmsQueryTool(ctx, scopedClient)
  if (enabled('pms_command_preview') || enabled('pms_command_execute')) {
    registerPmsCommandTools(ctx, scopedClient, contextStore, {
      preview: enabled('pms_command_preview'),
      execute: enabled('pms_command_execute'),
      // Writes never depend on the prompt having been assembled first: a tool
      // call loads the node contract on demand instead of failing closed.
      ensureContract: async (sessionId, signal) => { await ensureContract(sessionId, signal) },
    })
  }
}

async function resolveCurrentNodeLocator(
  client: PmsIntegrationClient,
  contextStore: PmsContextStore,
  locator: PmsContextLocator | undefined,
  signal: AbortSignal | undefined,
  sessionId: string | undefined,
): Promise<PmsContextLocator | undefined> {
  if (locator === undefined
      || locator.currentNodeKey !== undefined
      || locator.pageType !== 'project-detail'
      || locator.projectId === undefined) return locator
  const snapshot = await client.project(locator.projectId, locator.nodeId, signal, sessionId)
  const currentNode = snapshot.data.currentNode
  const nodeKey = currentNode !== null
      && typeof currentNode === 'object'
      && !Array.isArray(currentNode)
      && typeof currentNode.nodeKey === 'string'
    ? currentNode.nodeKey
    : undefined
  if (nodeKey === undefined || nodeKey.trim() === '') return locator
  const resolved = { ...locator, currentNodeKey: nodeKey }
  if (sessionId === undefined) contextStore.set(resolved)
  else contextStore.set(sessionId, resolved)
  return resolved
}

const PMS_PROMPT = [
  'PMS read tools are authoritative queries for the current user; PMS write tools are allow-listed commands.',
  'A PMS page context is only a locator, not business data; call the relevant PMS tool before answering facts.',
  'Use pms_project_list for project list questions, pms_project_get for one project, and pms_task_list for task questions.',
  'Use pms_people_list to turn a person\'s name into an account before writing any person field (project manager, member, follower, node owner); never guess an account id.',
  'Use node.field.update to write any node workbench field (requirement-scope, solution-design, plan-resource-risk, development-control, business-acceptance, release-handover, value-review, knowledge-standard, custom-fields); the current node contract lists what is writable.',
  'Use batch.write with an operations list when the user asks for several creates or edits at once (for example ten tasks or a whole team); one preview and one execution covers them all and the batch rolls back as a unit.',
  'Resolve relative people and dates from the contract header: the acting account answers "我/我的", and the published PMS business date answers "今天/明天/本月底". A new project always belongs to the acting account, so never ask the user for their own account.',
  'Never refuse a write just because no PMS page is open: the entry-node contract applies and PMS authorizes each call.',
  'PMS identity comes from the DSH SSO login and is kept for the session, so plain conversations work without opening the PMS panel. If a tool reports PMS 登录态不可用, the user logged out of PMS or the binding expired: ask them to sign in to DSH again (or reopen the「PMS 业务工作区」panel), and never invent data.',
  'Use pms_query for broader allow-listed project or task filters; the PMS backend is the authoritative source.',
  'For a write request, call pms_command_preview and then call pms_command_execute with the returned operationId yourself in the same turn. The caller already holds this account\'s own write authority, so never ask for confirmation and never wait for a later message.',
  'Never invent an operationId. If the preview or the execution reports an error, a rejected value, or a warning the caller must decide on, stop and report that instead of forcing the write.',
  'Keep answers short: lead with the conclusion, default to one to three lines or at most three bullets, and do not restate the request, the rules, or every field a tool returned. Expand only when the user asks, or when reporting a risk or a failure.',
  '向用户展示 PMS 数据或写入结果时，所有可见字段标签必须使用中文（例如“名称”“开始日期”“负责人”“状态”）；不得把 priority、projectLevel、projectTypeId、orgUnitId、operationId 这类技术标识直接当作可见字段名。',
  'If required project, node, task, assignee, or date information is missing, ask the user instead of guessing.',
  'For urgent project questions, pass priority=3; do not infer urgency from status or from a truncated page.',
  'When the requested result is not limited to the visible page, request pageSize=100 and continue through pagination.totalPage before summarizing.',
  'Do not invent project, node, task, status, priority, assignee, or due-date values. If PMS is unavailable, say so explicitly.',
  'Do not use historical messages as current-project facts after a project or node context change.',
  'When the current PMS node has a contract section, treat it as mandatory runtime instructions; if it is unavailable, do not execute PMS writes.',
].join('\n')

/** The entry node contract, used for the project list and for a contextless session. */
const PROJECT_LIST_NODE_KEY = 'kickoff'

interface ContractTarget {
  agentId: string
  contractKey: string
}

/**
 * Picks the contract for the node the user is looking at. PMS publishes each
 * contract with the workflow node keys it covers, so this stays correct when a
 * workflow gains a node or a contract is renamed.
 */
function resolveContractTarget(
  capabilities: PmsCapabilities,
  wantedNodeKey: string,
  agentId: string,
): ContractTarget | undefined {
  const published = capabilities.agentContracts?.find(
    contract => contract.required
      && contract.agentId === agentId
      && contract.workflowNodeKeys.includes(wantedNodeKey),
  )
  if (published === undefined) return undefined
  return { agentId: published.agentId, contractKey: published.contractKey }
}

function withContractPrompt(assembly: PromptAssembly, text: string): PromptAssembly {
  return {
    ...assembly,
    sections: [
      ...assembly.sections.filter(section => section.name !== 'pms:agent-contract'),
      { name: 'pms:agent-contract', text },
    ],
  }
}

function renderContractPrompt(
  contract: PmsAgentContract,
  locator: PmsContextLocator | undefined,
  loadedAt: string | undefined,
  capabilities: PmsCapabilities,
): string {
  return [
    '【PMS 节点契约：必读】',
    `契约标识：${contract.contractId}`,
    `契约版本：${contract.contractVersion}`,
    `内容摘要：${contract.contentSha256}`,
    `获取时间：${loadedAt ?? '未记录'}`,
    `当前节点：${locator?.currentNodeKey ?? '未知（未打开 PMS 页面，使用入口节点契约）'}`,
    `当前登录人：${describeViewer(capabilities.viewer)}`,
    `PMS 业务日期（今天）：${capabilities.today ?? '未提供'}`,
    `角色：${contract.principalRole}`,
    `读取能力：${contract.readCapabilities.join('、')}`,
    `读取工具绑定：${JSON.stringify(contract.readToolBindings)}`,
    `可执行写入命令：${contract.writeCommands.join('、')}`,
    ...describeCommandArguments(contract.writeCommands, capabilities),
    `确认策略：${JSON.stringify(contract.confirmationPolicies)}`,
    `入口条件：${contract.entryConditions.join('；')}`,
    `必需输入：${contract.inputs.join('；')}`,
    `缺失信息处理：${contract.missingInputRules.join('；')}`,
    `执行步骤：${contract.executionSteps.join('；')}`,
    `完成标准：${contract.completionCriteria.join('；')}`,
    `失败策略：${contract.failureStrategies.join('；')}`,
    `终止条件：${contract.terminationConditions.join('；')}`,
    '用户说"我/我的"时使用上面的当前登录人；说"今天/明天/本月底"时以上面的 PMS 业务日期为准；',
    '创建项目时负责人与创建人自动是当前登录人，不要向用户索要账号；其它人员字段用 pms_people_list 解析成账号。',
    '以上契约是当前节点的强制工作边界；写入仍需经过预览生成、执行和结果核验，但不需要用户逐次确认——直接执行，并如实汇报结果与警告。',
  ].join('\n')
}

/**
 * PMS publishes each command's argument schema with its capability catalog. The
 * model only sees this prompt, so render the allowed commands with their
 * arguments instead of making it guess parameter names.
 */
function describeCommandArguments(
  writeCommands: readonly string[],
  capabilities: PmsCapabilities,
): string[] {
  const catalog = capabilities.commands ?? []
  const lines: string[] = []
  for (const name of writeCommands) {
    const descriptor = catalog.find(item => item.name === name)
    if (descriptor === undefined) continue
    const parameters: unknown = descriptor.parameters
    const signature = parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters)
      ? Object.entries(parameters as Record<string, unknown>).map(([key, value]) => {
        const required = value !== null && typeof value === 'object' && !Array.isArray(value)
          && (value as { required?: unknown }).required === true
        return required ? `${key}*` : key
      }).join('、')
      : ''
    lines.push(`- ${name}（${descriptor.description}）参数：${signature === '' ? '见命令说明' : signature}（* 为必填）`)
  }
  return lines
}

function describeViewer(viewer: PmsViewer | undefined): string {
  if (viewer === undefined) return '未提供（需要时用 pms_people_list 按姓名或邮箱查询）'
  const parts = [viewer.displayName ?? viewer.username ?? viewer.email ?? `#${viewer.id}`, `id=${viewer.id}`]
  if (viewer.email !== undefined && viewer.email !== '') parts.push(viewer.email)
  return parts.join('，')
}
