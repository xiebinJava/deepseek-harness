import { describe, expect, it, vi } from 'vitest'
import { PmsAuthStore } from '../src/auth/pms-auth-store.ts'
import { PmsIntegrationClient } from '../src/client/PmsIntegrationClient.ts'

function response(data: unknown): Response {
  return new Response(JSON.stringify({ code: 200, msg: '操作成功', data, requestId: 'req-1' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('PMS browser authorization code exchange', () => {
  it('does not fall back to a configured PMS user token when browser delegation is absent', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api',
      pmsUserToken: 'pms-user-token', serviceKey: 'dsh-service-key',
      dshSessionId: 'browser-session', agentId: 'project_assistant',
      requestTimeoutMs: 1000, fetchImpl,
    })

    await expect(client.capabilities()).rejects.toMatchObject({
      status: 401,
      code: 'PMS_AUTH_REQUIRED',
      message: 'PMS 登录态不可用，请重新打开 PMS 工作区',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a browser authorization code issued for a different Agent', async () => {
    const authStore = new PmsAuthStore()
    authStore.set('browser-session', {
      authorizationCode: 'one-time-code', agentId: 'other_agent',
      scopes: ['pms:project:read'], receivedAt: Date.now(),
    })
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', serviceKey: 'dsh-service-key',
      dshSessionId: 'browser-session', agentId: 'project_assistant', authStore,
      requestTimeoutMs: 1000, fetchImpl,
    })

    await expect(client.capabilities()).rejects.toMatchObject({
      status: 403,
      code: 'PMS_AGENT_ID_MISMATCH',
      message: '当前会话 Agent 与 PMS 授权 Agent 不一致，请重新打开 PMS 工作区',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves the backend reason for a forbidden command response', async () => {
    const authStore = new PmsAuthStore()
    authStore.set('browser-session', {
      authorizationCode: 'one-time-code', agentId: 'project_assistant',
      scopes: ['pms:command:preview'], receivedAt: Date.now(),
    })
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        token: 'delegation-token', expiresInSeconds: 120,
        audience: 'dsh-pms', scopes: ['pms:command:preview'],
      }))
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_command_preview'],
        scopes: ['pms:command:preview'], pageTypes: ['project-list'],
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 403, msg: '项目组织不在当前用户的创建范围内', data: null, requestId: 'req-forbidden',
      }), { status: 403, headers: { 'content-type': 'application/json' } }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', serviceKey: 'dsh-service-key',
      dshSessionId: 'browser-session', agentId: 'project_assistant', authStore,
      allowLegacyUserTokenExchange: true,
      requestTimeoutMs: 1000, fetchImpl, requestIdFactory: () => 'request-1',
    })

    await expect(client.previewCommand({
      name: 'project.create', arguments: { name: 'test' },
      contextId: 'project-list', contextVersion: 'v1',
    })).rejects.toMatchObject({
      message: '项目组织不在当前用户的创建范围内', status: 403,
    })
  })

  it('surfaces the PMS request id when a server error is returned', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_query'], scopes: ['pms:query:read'], pageTypes: [],
        queries: [{ resource: 'projects', description: '项目', fields: [], filters: [], scopes: ['pms:query:read'], maxPageSize: 100 }],
        commands: [],
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 500, msg: '系统繁忙，请稍后重试', data: null, requestId: 'req-500',
      }), { status: 500, headers: { 'content-type': 'application/json' } }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token',
      requestTimeoutMs: 1000, fetchImpl,
    })

    await expect(client.query({ resource: 'projects', page: 1, pageSize: 20 })).rejects.toMatchObject({
      status: 500,
      requestId: 'req-500',
      message: '系统繁忙，请稍后重试（请求编号：req-500）',
    })
  })

  it('does not send a PMS user token and forwards the code to the Host-only exchange endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        token: 'browser-exchanged-token', expiresInSeconds: 120,
        audience: 'dsh-pms', scopes: ['pms:project:read'],
      }))
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_project_list'],
        scopes: ['pms:project:read'], pageTypes: ['project-list'],
      }))
      .mockResolvedValueOnce(response({ contextId: 'project-list' }))
    const authStore = new PmsAuthStore()
    authStore.set('browser-session', {
      authorizationCode: 'one-time-code', agentId: 'project_assistant',
      scopes: ['pms:project:read'], receivedAt: Date.now(),
    })
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', serviceKey: 'dsh-service-key',
      dshSessionId: 'browser-session', agentId: 'project_assistant', authStore,
      requestTimeoutMs: 1000, fetchImpl, requestIdFactory: () => 'request-1',
    })

    await client.projects()

    const [exchangeUrl, exchangeInit] = fetchImpl.mock.calls[0]!
    expect(exchangeUrl).toEqual(new URL('http://pms.test/api/integration/dsh/v1/token/exchange'))
    expect(exchangeInit?.headers).toMatchObject({ 'X-DSH-Service-Key': 'dsh-service-key' })
    expect(new Headers(exchangeInit?.headers).get('Authorization')).toBeNull()
    expect(exchangeInit?.body).toBe(JSON.stringify({
      authorizationCode: 'one-time-code', dshSessionId: 'browser-session',
      agentId: 'project_assistant', scopes: ['pms:project:read'],
    }))
    expect(fetchImpl.mock.calls[2]![1]?.headers).toMatchObject({
      'X-PMS-AI-Delegation': 'browser-exchanged-token',
    })
  })

  it('filters effective capabilities by the mounted Agent tool allowlist and current delegation scopes', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response({
      version: 'v1',
      tools: ['pms_project_list', 'pms_command_preview', 'pms_command_execute'],
      scopes: ['pms:project:read', 'pms:command:preview'],
      pageTypes: ['project-list'],
      queries: [],
      commands: [{
        name: 'project.create', description: '创建项目', access: 'write', risk: 'high',
        requiresConfirmation: true, scopes: ['pms:project:write', 'pms:command:preview', 'pms:command:execute'],
        parameters: {}, supportsPreview: true, supportsExecute: true, refreshScopes: [],
      }],
    }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token',
      allowedTools: ['pms_project_list', 'pms_command_preview', 'pms_command_execute'],
      requestTimeoutMs: 1000, fetchImpl,
    })

    await expect(client.capabilities()).resolves.toMatchObject({
      tools: ['pms_project_list'],
      scopes: ['pms:project:read'],
      commands: [],
    })
  })

  it('does not reuse a Host capability snapshot for a narrower Agent facade', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        version: 'v1',
        tools: ['pms_project_list', 'pms_query'],
        scopes: ['pms:project:read'],
        pageTypes: ['project-list'],
        queries: [{ resource: 'projects', description: '项目', fields: [], filters: [], scopes: ['pms:project:read'], maxPageSize: 100 }],
        commands: [],
      }))
      .mockResolvedValueOnce(response({
        version: 'v1',
        tools: ['pms_project_list', 'pms_query'],
        scopes: ['pms:project:read'],
        pageTypes: ['project-list'],
        queries: [{ resource: 'projects', description: '项目', fields: [], filters: [], scopes: ['pms:project:read'], maxPageSize: 100 }],
        commands: [],
      }))
    const host = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token',
      requestTimeoutMs: 1000, fetchImpl,
    })
    await expect(host.capabilities()).resolves.toMatchObject({
      tools: ['pms_project_list', 'pms_query'],
    })

    const scoped = host.scopedToTools(['pms_project_list'])
    await expect(scoped.capabilities()).resolves.toMatchObject({
      tools: ['pms_project_list'],
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects a write call before the network when the current delegation lacks its scope', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response({
      version: 'v1', tools: ['pms_command_preview'], scopes: ['pms:command:preview'], pageTypes: [],
      queries: [], commands: [],
    }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token',
      requestTimeoutMs: 1000, fetchImpl,
    })

    await expect(client.previewCommand({
      name: 'project.create', arguments: { name: '测试' }, contextId: 'project-list', contextVersion: 'v1',
    })).rejects.toMatchObject({
      status: 403,
      code: 'PMS_AGENT_CAPABILITY_FORBIDDEN',
      message: '当前 PMS 用户没有执行该 Agent 能力所需的权限',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refreshes the delegation token once when PMS rejects an expired cached token', async () => {
    const authStore = new PmsAuthStore()
    authStore.set('browser-session', {
      authorizationCode: 'one-time-code', agentId: 'project_assistant',
      scopes: ['pms:project:read'], receivedAt: Date.now(),
    })
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      const call = fetchImpl.mock.calls.length - 1
      if (call === 0) {
        return response({
          token: 'expired-soon-token', expiresInSeconds: 120,
          audience: 'dsh-pms', scopes: ['pms:project:read'],
        })
      }
      if (call === 1) {
        return response({
          version: 'v1', tools: ['pms_project_list'],
          scopes: ['pms:project:read'], pageTypes: ['project-list'],
        })
      }
      if (call === 2) {
        authStore.set('browser-session', {
          authorizationCode: 'fresh-one-time-code', agentId: 'project_assistant',
          scopes: ['pms:project:read'], receivedAt: Date.now(),
        })
        return new Response(JSON.stringify({ code: 401, msg: '未登录或登录已过期', data: null }), { status: 401 })
      }
      if (call === 3) {
        return response({
          token: 'fresh-delegation-token', expiresInSeconds: 120,
          audience: 'dsh-pms', scopes: ['pms:project:read'],
        })
      }
      return response({ contextId: 'project-list', projects: [] })
    })
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', serviceKey: 'dsh-service-key',
      dshSessionId: 'browser-session', agentId: 'project_assistant', authStore,
      requestTimeoutMs: 1000, fetchImpl, requestIdFactory: () => 'request-1',
    })

    await client.projects()

    expect(fetchImpl).toHaveBeenCalledTimes(5)
    expect(fetchImpl.mock.calls[3]![1]?.body).toContain('fresh-one-time-code')
    expect(new Headers(fetchImpl.mock.calls[4]![1]?.headers).get('X-PMS-AI-Delegation'))
      .toBe('fresh-delegation-token')
  })

  it('exchanges a newer browser code once when the previous one has expired', async () => {
    const authStore = new PmsAuthStore()
    authStore.set('browser-session', {
      authorizationCode: 'expired-one-time-code', agentId: 'project_assistant',
      scopes: ['pms:project:read'], receivedAt: 100,
    })
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      const call = fetchImpl.mock.calls.length - 1
      if (call === 0) {
        authStore.set('browser-session', {
          authorizationCode: 'fresh-one-time-code', agentId: 'project_assistant',
          scopes: ['pms:project:read'], receivedAt: 200,
        })
        return new Response(JSON.stringify({
          code: 401, msg: 'PMS_DSH_AUTH_CODE_INVALID', data: null,
        }), { status: 401 })
      }
      if (call === 1) {
        return response({
          token: 'fresh-delegation-token', expiresInSeconds: 120,
          audience: 'dsh-pms', scopes: ['pms:project:read'],
        })
      }
      if (call === 2) {
        return response({
          version: 'v1', tools: ['pms_project_list'],
          scopes: ['pms:project:read'], pageTypes: ['project-list'],
        })
      }
      return response({ contextId: 'project-list', projects: [] })
    })
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', serviceKey: 'dsh-service-key',
      dshSessionId: 'browser-session', agentId: 'project_assistant', authStore,
      authCodeRefreshWaitMs: 100, requestTimeoutMs: 1000, fetchImpl,
      requestIdFactory: () => 'request-1',
    })

    await client.projects()

    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body))).toMatchObject({
      authorizationCode: 'fresh-one-time-code',
    })
    expect(new Headers(fetchImpl.mock.calls[3]![1]?.headers).get('X-PMS-AI-Delegation'))
      .toBe('fresh-delegation-token')
  })

  it('does not treat a service-key failure as an expired browser code', async () => {
    const authStore = new PmsAuthStore()
    authStore.set('browser-session', {
      authorizationCode: 'one-time-code', agentId: 'project_assistant',
      scopes: ['pms:project:read'], receivedAt: 100,
    })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: 403, msg: 'PMS_DSH_SERVICE_AUTH_FAILED', data: null,
    }), { status: 403 }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', serviceKey: 'wrong-key',
      dshSessionId: 'browser-session', agentId: 'project_assistant', authStore,
      authCodeRefreshWaitMs: 1, requestTimeoutMs: 1000, fetchImpl,
    })

    await expect(client.projects()).rejects.toMatchObject({
      status: 403,
      code: 'PMS_DSH_SERVICE_AUTH_FAILED',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
