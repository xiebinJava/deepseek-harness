import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PmsIntegrationClient } from '../client/PmsIntegrationClient.ts'

export function registerProjectListTool(ctx: Context, client: PmsIntegrationClient): void {
  ctx.tools.register(defineTool({
    name: 'pms_project_list',
    description: 'Read the authoritative PMS project list visible to the current user. Use priority=3 for urgent projects. Never invent project status or priority values.',
    parameters: {
      page: { type: 'integer', description: '1-based page number.' },
      pageSize: { type: 'integer', description: 'Number of projects to return, bounded by PMS.' },
      keyword: { type: 'string', description: 'Optional project name or code search.' },
      status: { type: 'integer', description: 'PMS status code, when the user explicitly asks for one.' },
      view: { type: 'string', description: 'Optional PMS view such as ALL or MINE.' },
      projectLevel: { type: 'integer', description: 'Optional project level code.' },
      currentNodeKey: { type: 'string', description: 'Optional current-node filter.' },
      priority: { type: 'integer', enum: [0, 1, 2, 3], description: 'Optional priority: 0 low, 1 medium, 2 high, 3 urgent.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args, exec) => client.projects(args, exec.signal, exec.agent?.id),
    isConcurrencySafe: () => true,
  }))
}
