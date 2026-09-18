import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PmsContextStore } from '../context/pms-context-store.ts'
import type { PmsIntegrationClient } from '../client/PmsIntegrationClient.ts'
import type { PmsTaskListQuery } from '../types.ts'

export function registerTaskListTool(ctx: Context, client: PmsIntegrationClient, contextStore: PmsContextStore): void {
  ctx.tools.register(defineTool({
    name: 'pms_task_list',
    description: 'Read authoritative PMS tasks for a project or current project context. Use this for questions about due dates, assignees, status, or priority.',
    parameters: {
      projectId: { type: 'integer', description: 'PMS project id. Omit only when a current PMS project context is available.' },
      nodeId: { type: 'integer', description: 'Optional PMS node id.' },
      due: { type: 'string', enum: ['today', 'overdue', 'upcoming', 'all'], description: 'Optional due-date filter.' },
      status: { type: 'string', description: 'Optional PMS task status filter.' },
      page: { type: 'integer', description: '1-based page number.' },
      pageSize: { type: 'integer', description: 'Number of tasks to return.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args, exec) => {
      const sessionId = exec.agent?.id
      const locator = contextStore.get(sessionId)
      const projectId = args.projectId ?? locator?.projectId
      if (projectId === undefined) throw new Error('pms_task_list requires projectId or a current PMS project context')
      const nodeId = args.nodeId ?? locator?.nodeId
      const input: PmsTaskListQuery = { projectId }
      if (nodeId !== undefined) input.nodeId = nodeId
      if (args.due !== undefined) input.due = args.due
      if (args.status !== undefined) input.status = args.status
      if (args.page !== undefined) input.page = args.page
      if (args.pageSize !== undefined) input.pageSize = args.pageSize
      return client.tasks(input, exec.signal, sessionId)
    },
    isConcurrencySafe: () => true,
  }))
}
