import type { Context } from '@deepseek-ai/cordis'
import { PmsIntegrationClient } from './client/PmsIntegrationClient.ts'
import { PmsContextStore } from './context/pms-context-store.ts'
import { Config, resolveConfig } from './config.ts'
import { registerProjectDetailTool } from './tools/project-detail.ts'
import { registerProjectListTool } from './tools/project-list.ts'
import { registerTaskListTool } from './tools/task-list.ts'
import { registerPmsQueryTool } from './tools/query.ts'
import { registerPmsCommandTools } from './tools/command.ts'
import { PmsContextController } from './remote.ts'
import { PmsAuthStore } from './auth/pms-auth-store.ts'

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
  type PmsRuntimeMode,
} from './config.ts'

export const name = 'dsh-pms'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const parentClient = ctx.get('pmsIntegrationClient')
  const parentContextStore = ctx.get('pmsContextStore')
  const parentAuthStore = ctx.get('pmsAuthStore')

  if (resolved.mode === 'agent') {
    if (parentClient === undefined || parentContextStore === undefined || parentAuthStore === undefined) {
      throw new Error('dsh-pms: agent mode requires a host-mode dsh-pms bridge')
    }
    registerAgentCapabilities(ctx, parentClient, parentContextStore, resolved.tools.length === 0 ? undefined : resolved.tools)
    return
  }

  const authStore = parentAuthStore ?? new PmsAuthStore()
  const client = parentClient ?? new PmsIntegrationClient({
    ...resolved,
    authStore,
  })
  const contextStore = parentContextStore ?? new PmsContextStore()
  if (parentClient === undefined) ctx.provide('pmsIntegrationClient', client)
  if (parentContextStore === undefined) ctx.provide('pmsContextStore', contextStore)
  if (parentAuthStore === undefined) ctx.provide('pmsAuthStore', authStore)
  ctx.plugin(PmsContextController)
  if (resolved.mode === 'host') return

  registerAgentCapabilities(ctx, client, contextStore, resolved.mode === 'full' && resolved.tools.length === 0 ? undefined : resolved.tools)
}

function registerAgentCapabilities(
  ctx: Context,
  client: PmsIntegrationClient,
  contextStore: PmsContextStore,
  allowedTools?: readonly string[],
): void {
  const enabled = (tool: string): boolean => allowedTools === undefined || allowedTools.includes(tool)
  if (allowedTools !== undefined && allowedTools.length === 0) return
  ctx.systemPrompt.section({
    name: 'tool:pms',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW') + 1,
    text: PMS_PROMPT,
  })
  const scopedClient = allowedTools === undefined ? client : client.scopedToTools(allowedTools)
  if (enabled('pms_project_list')) registerProjectListTool(ctx, scopedClient)
  if (enabled('pms_project_get')) registerProjectDetailTool(ctx, scopedClient, contextStore)
  if (enabled('pms_task_list')) registerTaskListTool(ctx, scopedClient, contextStore)
  if (enabled('pms_query')) registerPmsQueryTool(ctx, scopedClient)
  if (enabled('pms_command_preview') || enabled('pms_command_execute')) {
    registerPmsCommandTools(ctx, scopedClient, contextStore, {
      preview: enabled('pms_command_preview'),
      execute: enabled('pms_command_execute'),
    })
  }
}

const PMS_PROMPT = [
  'PMS read tools are authoritative queries for the current user; PMS write tools are allow-listed commands.',
  'A PMS page context is only a locator, not business data; call the relevant PMS tool before answering facts.',
  'Use pms_project_list for project list questions, pms_project_get for one project, and pms_task_list for task questions.',
  'Use pms_query for broader allow-listed project or task filters; the PMS backend is the authoritative source.',
  'For a write request, first call pms_command_preview. Explain every proposed change and warning, then wait for an explicit confirmation in a later user message. Only then call pms_command_execute with the exact returned operationId.',
  'Never call pms_command_execute in the same turn as preview, never invent an operationId, and never treat a vague request as confirmation.',
  '向用户展示 PMS 数据时，所有可见字段标签必须使用中文。尤其是写操作预览，统一输出“实体/动作、名称、开始日期、结束日期、优先级、项目等级、描述、项目类型、流程模板、组织单元、警告、操作编号、过期时间、刷新范围”等中文标签；不得把 priority、projectLevel、description、projectTypeId、workflowTemplateVersionId、orgUnitId、operationId、expiresAt、refreshScopes 直接作为用户可见的字段名。技术标识符可以在中文标签后保留原始值。',
  'If required project, node, task, assignee, or date information is missing, ask the user instead of guessing.',
  'For urgent project questions, pass priority=3; do not infer urgency from status or from a truncated page.',
  'When the requested result is not limited to the visible page, request pageSize=100 and continue through pagination.totalPage before summarizing.',
  'Do not invent project, node, task, status, priority, assignee, or due-date values. If PMS is unavailable, say so explicitly.',
  'Do not use historical messages as current-project facts after a project or node context change.',
].join('\n')
