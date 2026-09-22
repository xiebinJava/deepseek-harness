import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PmsIntegrationClient } from '../client/PmsIntegrationClient.ts'

/**
 * Person fields (project manager, members, followers) are written by account id,
 * so the Agent needs the same name-to-id lookup the PMS person picker uses.
 */
export function registerPeopleListTool(ctx: Context, client: PmsIntegrationClient): void {
  ctx.tools.register(defineTool({
    name: 'pms_people_list',
    description: 'Look up PMS accounts by name, username, or email. Use it before writing any person field (project manager, member, follower, node owner) so a name becomes a real account id. Only active accounts are returned.',
    parameters: {
      keyword: { type: 'string', description: 'Name, username, or email fragment. Omit to list the first accounts.' },
      limit: { type: 'integer', description: 'Maximum accounts to return (1-50, default 20).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args, exec) => client.people(
      { keyword: args.keyword, limit: args.limit },
      exec.signal,
      exec.agent?.id,
    ),
    isConcurrencySafe: () => true,
  }))
}
