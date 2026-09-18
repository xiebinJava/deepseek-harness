import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PmsContextStore } from '../context/pms-context-store.ts'
import type { PmsIntegrationClient } from '../client/PmsIntegrationClient.ts'

export function registerProjectDetailTool(ctx: Context, client: PmsIntegrationClient, contextStore: PmsContextStore): void {
  ctx.tools.register(defineTool({
    name: 'pms_project_get',
    description: 'Read one authoritative PMS project detail snapshot, including nodes, members, and tasks when permitted.',
    parameters: {
      projectId: { type: 'integer', description: 'PMS project id. Omit only when a current PMS project context is available.' },
      nodeId: { type: 'integer', description: 'Optional current node id.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args, exec) => {
      const sessionId = exec.agent?.id
      const locator = contextStore.get(sessionId)
      const projectId = args.projectId ?? locator?.projectId
      if (projectId === undefined) throw new Error('pms_project_get requires projectId or a current PMS project context')
      return client.project(projectId, args.nodeId ?? locator?.nodeId, exec.signal, sessionId)
    },
    isConcurrencySafe: () => true,
  }))
}
