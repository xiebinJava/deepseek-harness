import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PmsIntegrationClient } from '../client/PmsIntegrationClient.ts'
import type { PmsQueryRequest } from '../types.ts'

export function registerPmsQueryTool(ctx: Context, client: PmsIntegrationClient): void {
  ctx.tools.register(defineTool({
    name: 'pms_query',
    description: 'Query an allow-listed PMS resource using authoritative current data. Use projects for project filters and tasks for task filters. Do not invent resource or filter names.',
    parameters: {
      resource: { type: 'string', enum: ['projects', 'tasks'], description: 'PMS resource to query.' },
      filters: { type: 'object', additionalProperties: true, description: 'Resource-specific filters declared by the PMS capability catalog.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Optional allow-listed fields.' },
      page: { type: 'integer', description: '1-based page number.' },
      pageSize: { type: 'integer', description: 'Page size, bounded by PMS.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args, exec) => client.query(args as PmsQueryRequest, exec.signal, exec.agent?.id),
    isConcurrencySafe: () => true,
  }))
}
