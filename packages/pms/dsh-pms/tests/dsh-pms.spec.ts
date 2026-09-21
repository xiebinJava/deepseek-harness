import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as DshPms from '@deepseek-ai/dsh-pms'
import { PmsIntegrationClient } from '@deepseek-ai/dsh-pms'
import { PmsContextStore } from '../src/context/pms-context-store.ts'
import { pmsSessionTags } from '../src/context/pms-session-tags.ts'
import { executePmsOperation } from '../src/tools/command.ts'
import type { PmsAgentContract } from '../src/types.ts'

const activeContexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of activeContexts.splice(0)) await ctx.fiber.dispose()
})

function response(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ code: 200, msg: '操作成功', data, requestId: 'req-1' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function requestBody(body: BodyInit | null | undefined): string | undefined {
  return typeof body === 'string' ? body : undefined
}

function kickoffContract(): PmsAgentContract {
  return {
    contractId: 'pms-project-assistant/project-kickoff', agentId: 'project_assistant',
    contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
    required: true, locale: 'zh-CN', principalRole: 'PMS 项目经理', specializedAgents: [],
    readCapabilities: ['项目上下文'], readToolBindings: { 'project-context': 'pms_project_get' },
    writeCommands: ['project.create'], confirmationPolicies: { 'project.create': 'preview-and-confirm' },
    entryConditions: ['首个节点'], inputs: ['项目基本信息'], missingInputRules: ['不得猜测'],
    executionSteps: ['读取状态'], completionCriteria: ['必填字段完整'],
    failureStrategies: ['鉴权失败即停止'], terminationConditions: ['用户未确认'],
    contentSha256: 'e'.repeat(64),
  }
}

function markWriteReady(store: PmsContextStore, sessionId: string): void {
  store.setContract(sessionId, { status: 'ready', contract: kickoffContract() })
}

describe('PmsIntegrationClient', () => {
  it('fetches and caches a versioned Agent contract through the internal bridge', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_project_get'], scopes: ['pms:query:read'], pageTypes: [],
        queries: [], commands: [], agentContracts: [{
          agentId: 'project_assistant', contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
          endpoint: '/integration/dsh/v1/agent-contracts/{agentId}/{contractKey}',
          scope: 'pms:query:read', required: true,
        }],
      }))
      .mockResolvedValueOnce(response({
        contractId: 'pms-project-assistant/project-kickoff', agentId: 'project_assistant',
        contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
        required: true, locale: 'zh-CN', principalRole: 'PMS 项目经理', specializedAgents: [],
        readCapabilities: ['项目上下文'], readToolBindings: { 'project-context': 'pms_project_get' },
        writeCommands: ['project.create'], confirmationPolicies: { 'project.create': 'preview-and-confirm' },
        entryConditions: ['首个节点'], inputs: ['项目基本信息'], missingInputRules: ['不得猜测'],
        executionSteps: ['读取状态'], completionCriteria: ['必填字段完整'],
        failureStrategies: ['鉴权失败即停止'], terminationConditions: ['用户未确认'],
        contentSha256: 'a'.repeat(64),
      }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token',
      agentId: 'project_assistant', dshSessionId: 'session-1', requestTimeoutMs: 1000,
      fetchImpl, requestIdFactory: () => 'request-1',
    })

    const first = await client.getAgentContract('project_assistant', 'project-kickoff', undefined, 'session-1')
    const second = await client.getAgentContract('project_assistant', 'project-kickoff', undefined, 'session-1')

    expect(first.contractVersion).toBe('1.0.0')
    expect(second.contentSha256).toBe('a'.repeat(64))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [contractUrl, contractInit] = fetchImpl.mock.calls[1]!
    expect(requestUrl(contractUrl)).toBe(
      'http://pms.test/api/integration/dsh/v1/agent-contracts/project_assistant/project-kickoff')
    expect(contractInit?.headers).toMatchObject({
      'X-PMS-AI-Delegation': 'short-token',
      'X-DSH-Tool': 'pms_agent_contract',
    })
  })

  it('rejects a contract response whose identity does not match capability discovery', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_project_get'], scopes: ['pms:query:read'], pageTypes: [],
        queries: [], commands: [], agentContracts: [{
          agentId: 'project_assistant', contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
          endpoint: '/integration/dsh/v1/agent-contracts/{agentId}/{contractKey}',
          scope: 'pms:query:read', required: true,
        }],
      }))
      .mockResolvedValueOnce(response({
        contractId: 'pms-project-assistant/other', agentId: 'other_agent',
        contractKey: 'other-contract', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
        required: true, locale: 'zh-CN', principalRole: '错误契约', specializedAgents: [],
        readCapabilities: ['项目上下文'], readToolBindings: { 'project-context': 'pms_project_get' },
        writeCommands: ['project.create'], confirmationPolicies: { 'project.create': 'preview-and-confirm' },
        entryConditions: ['首个节点'], inputs: ['项目基本信息'], missingInputRules: ['不得猜测'],
        executionSteps: ['读取状态'], completionCriteria: ['必填字段完整'],
        failureStrategies: ['鉴权失败即停止'], terminationConditions: ['用户未确认'],
        contentSha256: 'd'.repeat(64),
      }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token',
      agentId: 'project_assistant', requestTimeoutMs: 1000, fetchImpl,
    })

    await expect(client.getAgentContract('project_assistant', 'project-kickoff')).rejects.toThrow(
      'PMS Agent contract identity mismatch',
    )
  })

  it('discovers command metadata and exposes preview/execute through the DSH facade', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        version: 'v1',
        tools: ['pms_project_list', 'pms_command_preview', 'pms_command_execute'],
        scopes: ['pms:project:read', 'pms:task:write', 'pms:command:preview', 'pms:command:execute'],
        pageTypes: ['project-detail'],
        queries: [],
        commands: [{
          name: 'task.create',
          description: '创建任务',
          access: 'write',
          risk: 'medium',
          requiresConfirmation: true,
          scopes: ['pms:task:write'],
          parameters: {},
          supportsPreview: true,
          supportsExecute: true,
          refreshScopes: ['project-detail'],
        }],
      }))
      .mockResolvedValueOnce(response({ operationId: 'op-1', command: 'task.create', warnings: [], changes: [] }))
      .mockResolvedValueOnce(response({ operationId: 'op-1', status: 'SUCCEEDED', message: '任务已创建' }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token', requestTimeoutMs: 1000,
      fetchImpl, requestIdFactory: () => 'request-1',
    })

    const capabilities = await client.capabilities()
    await client.previewCommand({
      name: 'task.create',
      arguments: { projectId: 22, nodeId: 7, title: '测试任务' },
      contextId: 'project-detail:22:7',
      contextVersion: 'v1',
    })
    await client.executeOperation('op-1', 'idem-1')

    expect(capabilities.commands?.[0]?.name).toBe('task.create')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const [previewUrl, previewInit] = fetchImpl.mock.calls[1]!
    expect(requestUrl(previewUrl)).toBe('http://pms.test/api/integration/dsh/v1/commands/preview')
    expect(previewInit?.method).toBe('POST')
    expect(JSON.parse(requestBody(previewInit?.body) ?? '')).toEqual({
      name: 'task.create',
      arguments: { projectId: 22, nodeId: 7, title: '测试任务' },
      contextId: 'project-detail:22:7',
      contextVersion: 'v1',
    })
    const [executeUrl, executeInit] = fetchImpl.mock.calls[2]!
    expect(requestUrl(executeUrl)).toBe('http://pms.test/api/integration/dsh/v1/operations/op-1/execute')
    expect(executeInit?.method).toBe('POST')
    expect(JSON.parse(requestBody(executeInit?.body) ?? '')).toEqual({ idempotencyKey: 'idem-1' })
    expect(new Headers(executeInit?.headers).get('X-PMS-AI-Delegation')).toBe('short-token')
  })

  it('queries the unified PMS read endpoint with a bounded resource request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_query'], scopes: ['pms:project:read'], pageTypes: [],
        queries: [{ resource: 'projects', description: '项目', fields: [], filters: [], scopes: ['pms:project:read'], maxPageSize: 100 }],
        commands: [],
      }))
      .mockResolvedValueOnce(response({ resource: 'projects', authoritative: true, data: { projects: [] } }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token', requestTimeoutMs: 1000,
      fetchImpl, requestIdFactory: () => 'request-1',
    })

    await client.query({ resource: 'projects', filters: { priority: 3 }, page: 1, pageSize: 100 })

    const [url, init] = fetchImpl.mock.calls[1]!
    expect(requestUrl(url)).toBe('http://pms.test/api/integration/dsh/v1/query')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(requestBody(init?.body) ?? '')).toEqual({
      resource: 'projects', filters: { priority: 3 }, page: 1, pageSize: 100,
    })
  })

  it('registers a write preview tool that fills project context from the current PMS tag', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_command_preview'],
        scopes: ['pms:task:write', 'pms:command:preview'], pageTypes: ['project-detail'],
        queries: [], commands: [{
          name: 'task.create', description: '创建任务', access: 'write', risk: 'medium',
          requiresConfirmation: true, scopes: ['pms:task:write', 'pms:command:preview'],
          parameters: {
            projectId: { type: 'integer', required: true },
            nodeId: { type: 'integer', required: true },
            title: { type: 'string', required: true },
          },
          supportsPreview: true, supportsExecute: true, refreshScopes: [],
        }],
      }))
      .mockResolvedValueOnce(response({
        operationId: 'op-create-1', command: 'task.create', warnings: [],
        changes: [{ entity: 'task', action: 'create', projectId: 22, nodeId: 7, title: '测试任务' }],
      }))
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token', requestTimeoutMs: 1000,
    })
    const pmsPrompt = (await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:pms')
    expect(pmsPrompt?.text).toContain('所有可见字段标签必须使用中文')
    expect(pmsPrompt?.text).toContain('操作编号')
    const store = ctx.get('pmsContextStore') as PmsContextStore
    store.set('session-1', {
      pageType: 'project-detail', projectId: 22, nodeId: 7, currentNodeKey: 'kickoff', contextVersion: 'pms-v1',
    })
    const contract: PmsAgentContract = {
      contractId: 'pms-project-assistant/project-kickoff', agentId: 'project_assistant',
      contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0', required: true,
      locale: 'zh-CN', principalRole: 'PMS 项目经理', specializedAgents: [],
      readCapabilities: ['项目上下文'], readToolBindings: { 'project-context': 'pms_project_get' },
      writeCommands: ['task.create'], confirmationPolicies: { 'task.create': 'preview-and-confirm' },
      entryConditions: ['节点已进入'], inputs: ['任务名称'], missingInputRules: ['不得猜测'],
      executionSteps: ['读取状态', '创建任务'], completionCriteria: ['任务字段完整'],
      failureStrategies: ['鉴权失败即停止'], terminationConditions: ['用户未确认'], contentSha256: 'd'.repeat(64),
    }
    store.setContract('session-1', { status: 'ready', contract })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('preview-call'),
      name: 'pms_command_preview',
      arguments: { command: 'task.create', arguments: { title: '测试任务' } },
      agent: { id: 'session-1' } as never,
    })

    expect(result.isError).toBe(false)
    const [, init] = fetchMock.mock.calls[1]!
    expect(JSON.parse(requestBody(init?.body) ?? '')).toEqual({
      name: 'task.create',
      arguments: { title: '测试任务', projectId: 22, nodeId: 7 },
      contextId: 'pms:project-detail:22:7',
      contextVersion: 'pms-v1',
      contractId: 'pms-project-assistant/project-kickoff',
      contractVersion: '1.0.0',
    })
  })

  it('honors the PMS parameter contract instead of injecting the current project into every command', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_command_preview'],
        scopes: ['pms:project:write', 'pms:command:preview'], pageTypes: ['project-detail'],
        queries: [], commands: [{
          name: 'project.create', description: '创建项目', access: 'write', risk: 'medium',
          requiresConfirmation: true, scopes: ['pms:project:write', 'pms:command:preview'],
          parameters: { name: { type: 'string', required: true } },
          supportsPreview: true, supportsExecute: true, refreshScopes: [],
        }],
      }))
      .mockResolvedValueOnce(response({
        operationId: 'op-create-project', command: 'project.create', warnings: [], changes: [],
      }))
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token', requestTimeoutMs: 1000,
    })
    const store = ctx.get('pmsContextStore') as PmsContextStore
    store.set({ pageType: 'project-detail', projectId: 22, nodeId: 7, currentNodeKey: 'kickoff', contextVersion: 'pms-v1' })
    store.setContract(undefined, {
      status: 'ready',
      contract: {
        contractId: 'pms-project-assistant/project-kickoff', agentId: 'project_assistant',
        contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
        required: true, locale: 'zh-CN', principalRole: 'PMS 项目经理', specializedAgents: [],
        readCapabilities: ['项目上下文'], readToolBindings: { 'project-context': 'pms_project_get' },
        writeCommands: ['project.create'], confirmationPolicies: { 'project.create': 'preview-and-confirm' },
        entryConditions: ['首个节点'], inputs: ['项目名称'], missingInputRules: ['不得猜测'],
        executionSteps: ['读取状态'], completionCriteria: ['项目已创建'],
        failureStrategies: ['鉴权失败即停止'], terminationConditions: ['用户未确认'],
        contentSha256: '1'.repeat(64),
      },
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('preview-project-create'),
      name: 'pms_command_preview',
      arguments: { command: 'project.create', arguments: { name: '新项目' } },
    })

    expect(result.isError).toBe(false)
    const [, init] = fetchMock.mock.calls[1]!
    expect(JSON.parse(requestBody(init?.body) ?? '')).toEqual({
      name: 'project.create',
      arguments: { name: '新项目' },
      contextId: 'pms:project-detail:22:7',
      contextVersion: 'pms-v1',
      contractId: 'pms-project-assistant/project-kickoff',
      contractVersion: '1.0.0',
    })
  })

  it('fails closed for execution when no DSH approval channel is composed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_command_execute'],
        scopes: ['pms:command:execute'], pageTypes: [], queries: [], commands: [],
      }))
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token', requestTimeoutMs: 1000,
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('execute-call'),
      name: 'pms_command_execute',
      arguments: { operationId: 'op-1' },
      agent: { id: 'session-1' } as never,
    })

    expect(result.isError).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  it('blocks a project-detail write preview when the current node contract is unavailable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token', requestTimeoutMs: 1000,
    })
    const store = ctx.get('pmsContextStore') as PmsContextStore
    store.set('session-1', {
      pageType: 'project-detail', route: '/projects/22', projectId: 22, nodeId: 7,
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('contract-required-preview'),
      name: 'pms_command_preview',
      arguments: { command: 'project.create', arguments: { name: '不应执行' } },
      agent: { id: 'session-1' } as never,
    })

    expect(result.isError).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  it('blocks a project-detail write execution when the current node contract is unavailable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token', requestTimeoutMs: 1000,
    })
    const store = ctx.get('pmsContextStore') as PmsContextStore
    store.set('session-1', { pageType: 'project-detail', projectId: 22, nodeId: 7 })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('contract-required-execute'),
      name: 'pms_command_execute',
      arguments: { operationId: 'op-stale' },
      agent: { id: 'session-1' } as never,
    })

    expect(result.isError).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  it('blocks writes without a contract even when the PMS page locator is absent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token', requestTimeoutMs: 1000,
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('contract-required-without-locator'),
      name: 'pms_command_preview',
      arguments: { command: 'project.create', arguments: { name: '不应执行' } },
      agent: { id: 'session-1' } as never,
    })

    expect(result.isError).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  it('calls the versioned read-only facade with the delegation header and query parameters', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        version: 'v1',
        tools: ['pms_project_list'],
        scopes: ['pms:project:read'],
        pageTypes: ['project-list'],
      }))
      .mockResolvedValueOnce(response({ contextId: 'project-list' }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test',
      apiPrefix: '/api',
      accessToken: 'short-token',
      dshSessionId: 'browser-session',
      agentId: 'project_assistant',
      agentVersion: 'sha256:v1',
      workspaceType: 'pms',
      requestTimeoutMs: 1000,
      fetchImpl,
      requestIdFactory: () => 'request-1',
    })

    await client.projects({ page: 2, pageSize: 25, keyword: '智能', priority: 3 })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [capabilitiesInput] = fetchImpl.mock.calls[0]!
    expect(requestUrl(capabilitiesInput)).toBe('http://pms.test/api/integration/dsh/v1/capabilities')
    const [input, init] = fetchImpl.mock.calls[1]!
    expect(requestUrl(input)).toBe('http://pms.test/api/integration/dsh/v1/projects?page=2&pageSize=25&keyword=%E6%99%BA%E8%83%BD&priority=3')
    expect(init?.headers).toMatchObject({
      'X-PMS-AI-Delegation': 'short-token',
      'X-Request-Id': 'request-1',
      'X-DSH-Session-Id': 'browser-session',
      'X-DSH-Agent-Id': 'project_assistant',
      'X-DSH-Agent-Version': 'sha256:v1',
      'X-DSH-Workspace': 'pms',
      'X-DSH-Tool': 'pms_project_list',
    })
  })

  it('fails closed when a delegation token is missing', async () => {
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', requestTimeoutMs: 1000,
      fetchImpl: vi.fn(),
    })

    await expect(client.capabilities()).rejects.toMatchObject({
      status: 401,
      code: 'PMS_AUTH_REQUIRED',
    })
  })

  it('exchanges a PMS user token server-side and never sends the user token to the facade', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        token: 'exchanged-token',
        expiresInSeconds: 120,
        audience: 'dsh-pms',
        scopes: ['pms:project:read', 'pms:task:read', 'pms:query:read', 'pms:workspace:embed'],
      }))
      .mockResolvedValueOnce(response({
        version: 'v1',
        tools: ['pms_project_list'],
        scopes: ['pms:project:read'],
        pageTypes: ['project-list'],
      }))
      .mockResolvedValueOnce(response({ contextId: 'project-list' }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test',
      apiPrefix: '/api',
      pmsUserToken: 'pms-user-token',
      serviceKey: 'dsh-service-key',
      dshSessionId: 'dsh-session-1',
      agentId: 'project_assistant',
      allowLegacyUserTokenExchange: true,
      requestTimeoutMs: 1000,
      fetchImpl,
      requestIdFactory: () => 'request-1',
    })

    await client.projects()

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const [exchangeUrl, exchangeInit] = fetchImpl.mock.calls[0]!
    expect(requestUrl(exchangeUrl)).toBe('http://pms.test/api/integration/dsh/v1/token')
    expect(exchangeInit?.method).toBe('POST')
    expect(exchangeInit?.headers).toMatchObject({
      Authorization: 'Bearer pms-user-token',
      'X-DSH-Service-Key': 'dsh-service-key',
    })
    expect(JSON.parse(requestBody(exchangeInit?.body) ?? '')).toEqual({
      dshSessionId: 'dsh-session-1',
      agentId: 'project_assistant',
      scopes: [
        'pms:project:read', 'pms:task:read', 'pms:query:read',
        'pms:task:write', 'pms:command:preview', 'pms:command:execute',
        'pms:workflow:write',
        'pms:project:write',
        'pms:workspace:embed',
      ],
    })

    const [capabilitiesUrl] = fetchImpl.mock.calls[1]!
    expect(requestUrl(capabilitiesUrl)).toBe('http://pms.test/api/integration/dsh/v1/capabilities')
    const [facadeUrl, facadeInit] = fetchImpl.mock.calls[2]!
    expect(requestUrl(facadeUrl)).toBe('http://pms.test/api/integration/dsh/v1/projects')
    expect(facadeInit?.headers).toMatchObject({ 'X-PMS-AI-Delegation': 'exchanged-token' })
    expect(new Headers(facadeInit?.headers).get('Authorization')).toBeNull()
  })

})

describe('dsh-pms tools and context', () => {
  it('injects the current kickoff contract as a tracked system-prompt section', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_project_get'], scopes: ['pms:query:read'], pageTypes: [],
        queries: [], commands: [], agentContracts: [{
          agentId: 'project_assistant', contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
          endpoint: '/integration/dsh/v1/agent-contracts/{agentId}/{contractKey}',
          scope: 'pms:query:read', required: true,
        }],
      }))
      .mockResolvedValueOnce(response({
        contractId: 'pms-project-assistant/project-kickoff', agentId: 'project_assistant',
        contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
        required: true, locale: 'zh-CN', principalRole: 'PMS 项目经理', specializedAgents: [],
        readCapabilities: ['项目上下文'], readToolBindings: { 'project-context': 'pms_project_get' },
        writeCommands: ['project.create'], confirmationPolicies: { 'project.create': 'preview-and-confirm' },
        entryConditions: ['首个节点'], inputs: ['项目基本信息'], missingInputRules: ['不得猜测'],
        executionSteps: ['读取状态'], completionCriteria: ['必填字段完整'],
        failureStrategies: ['鉴权失败即停止'], terminationConditions: ['用户未确认'],
        contentSha256: 'b'.repeat(64),
      }))
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      mode: 'full', tools: ['pms_command_preview'],
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token',
      agentId: 'project_assistant', requestTimeoutMs: 1000,
    })
    const store = ctx.get('pmsContextStore') as PmsContextStore
    store.set({
      pageType: 'project-detail', route: '/projects/22', projectId: 22, nodeId: 7,
      currentNodeKey: 'kickoff', contextVersion: 'pms-v1',
    })

    const firstAssembly = await ctx.systemPrompt.assemble()
    const secondAssembly = await ctx.systemPrompt.assemble()
    const contractPrompt = firstAssembly.sections.find(section => section.name === 'pms:agent-contract')
    const secondContractPrompt = secondAssembly.sections.find(section => section.name === 'pms:agent-contract')
    expect(contractPrompt?.text).toContain('pms-project-assistant/project-kickoff')
    expect(contractPrompt?.text).toContain('契约版本：1.0.0')
    expect(contractPrompt?.text).toContain('内容摘要：' + 'b'.repeat(64))
    expect(secondContractPrompt?.text).toBe(contractPrompt?.text)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('injects the kickoff contract on the PMS project list for project creation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_project_list', 'pms_command_preview'], scopes: ['pms:project:read', 'pms:command:preview', 'pms:query:read'], pageTypes: ['project-list'],
        queries: [], commands: [], agentContracts: [{
          agentId: 'project_assistant', contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
          endpoint: '/integration/dsh/v1/agent-contracts/{agentId}/{contractKey}', scope: 'pms:query:read', required: true,
        }],
      }))
      .mockResolvedValueOnce(response({
        contractId: 'pms-project-assistant/project-kickoff', agentId: 'project_assistant', contractKey: 'project-kickoff',
        workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0', required: true, locale: 'zh-CN', principalRole: 'PMS 项目经理',
        specializedAgents: [], readCapabilities: ['项目上下文'], readToolBindings: { 'project-list': 'pms_project_list' },
        writeCommands: ['project.create'], confirmationPolicies: { 'project.create': 'preview-and-confirm' },
        entryConditions: ['项目列表'], inputs: ['项目基本信息'], missingInputRules: ['不得猜测'], executionSteps: ['读取状态'],
        completionCriteria: ['项目已创建'], failureStrategies: ['鉴权失败即停止'], terminationConditions: ['用户未确认'],
        contentSha256: 'f'.repeat(64),
      }))
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      mode: 'full', tools: ['pms_command_preview'],
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token',
      agentId: 'project_assistant', requestTimeoutMs: 1000,
    })
    const store = ctx.get('pmsContextStore') as PmsContextStore
    store.set({ pageType: 'project-list', route: '/projects' })
    store.set('project_assistant', { pageType: 'project-list', route: '/projects' })
    const assembly = await ctx.systemPrompt.assemble()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(assembly.sections.map(section => section.name)).toContain('pms:agent-contract')
  })

  it('resolves the real current node key from the authoritative project snapshot', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_project_get'], scopes: ['pms:project:read', 'pms:query:read'], pageTypes: [],
        queries: [], commands: [], agentContracts: [{
          agentId: 'project_assistant', contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
          endpoint: '/integration/dsh/v1/agent-contracts/{agentId}/{contractKey}',
          scope: 'pms:query:read', required: true,
        }],
      }))
      .mockResolvedValueOnce(response({
        contextId: 'project-detail:22:7', pageType: 'project-detail', route: '/projects/22',
        projectId: 22, nodeId: 7, capturedAt: '2026-09-21T00:00:00Z', version: 'pms-v1',
        data: { currentNode: { nodeKey: 'kickoff', name: '项目立项与启动' } },
      }))
      .mockResolvedValueOnce(response({
        contractId: 'pms-project-assistant/project-kickoff', agentId: 'project_assistant',
        contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
        required: true, locale: 'zh-CN', principalRole: 'PMS 项目经理', specializedAgents: [],
        readCapabilities: ['项目上下文'], readToolBindings: { 'project-context': 'pms_project_get' },
        writeCommands: ['project.create'], confirmationPolicies: { 'project.create': 'preview-and-confirm' },
        entryConditions: ['首个节点'], inputs: ['项目基本信息'], missingInputRules: ['不得猜测'],
        executionSteps: ['读取状态'], completionCriteria: ['必填字段完整'],
        failureStrategies: ['鉴权失败即停止'], terminationConditions: ['用户未确认'],
        contentSha256: 'c'.repeat(64),
      }))
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token',
      agentId: 'project_assistant', requestTimeoutMs: 1000,
    })
    const store = ctx.get('pmsContextStore') as PmsContextStore
    store.set({ pageType: 'project-detail', route: '/projects/22', projectId: 22, nodeId: 7 })

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'pms:agent-contract')?.text)
      .toContain('当前节点：kickoff')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps PMS tools and prompt out of a host-only composition', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      mode: 'host',
      baseUrl: 'http://pms.test',
      apiPrefix: '/api',
      accessToken: 'short-token',
      requestTimeoutMs: 1000,
    })

    expect(ctx.tools.schemas().some(schema => schema.name.startsWith('pms_'))).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:pms')).toBe(false)
    expect(ctx.get('pmsContextStore')).toBeDefined()
    expect(ctx.get('pmsAuthStore')).toBeDefined()
  })

  it('adds PMS tools and prompt only for an explicit agent composition', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      mode: 'host',
      baseUrl: 'http://pms.test',
      apiPrefix: '/api',
      accessToken: 'short-token',
      requestTimeoutMs: 1000,
    })
    await ctx.plugin(DshPms, {
      mode: 'agent',
      baseUrl: 'http://pms.test',
      apiPrefix: '/api',
      accessToken: 'short-token',
      requestTimeoutMs: 1000,
    })

    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'pms_project_list', 'pms_project_get', 'pms_task_list', 'pms_query',
      'pms_command_preview', 'pms_command_execute',
    ])
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).toContain('tool:pms')
  })

  it('mounts only the tools explicitly allowed by the selected Agent', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      mode: 'host',
      baseUrl: 'http://pms.test',
      apiPrefix: '/api',
      accessToken: 'short-token',
      requestTimeoutMs: 1000,
    })
    await ctx.plugin(DshPms, {
      mode: 'agent',
      baseUrl: 'http://pms.test',
      apiPrefix: '/api',
      accessToken: 'short-token',
      tools: ['pms_query'],
      requestTimeoutMs: 1000,
    })

    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['pms_query'])
  })

  it('does not expose PMS tools in a generic host composition', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      mode: 'host', baseUrl: 'http://pms.test', apiPrefix: '/api',
      accessToken: 'short-token', requestTimeoutMs: 1000,
    })

    await expect(ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('generic-pms-call'),
      name: 'pms_project_list',
      arguments: {},
    })).resolves.toMatchObject({ isError: true })
  })

  it('registers read-only tools and routes task queries through the current project tag', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        version: 'v1',
        tools: ['pms_task_list'],
        scopes: ['pms:task:read'],
        pageTypes: ['project-detail'],
      }))
      .mockResolvedValueOnce(response({ total: 1, tasks: [] }))
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      baseUrl: 'http://pms.test',
      apiPrefix: '/api',
      accessToken: 'short-token',
      requestTimeoutMs: 1000,
    })
    const store = ctx.get('pmsContextStore') as PmsContextStore
    store.set({ pageType: 'project-detail', projectId: 22, nodeId: 7 })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('task-call'),
      name: 'pms_task_list',
      arguments: { due: 'today' },
    })

    expect(result.isError).toBe(false)
    const [url, init] = fetchMock.mock.calls[1]!
    expect(requestUrl(url)).toBe('http://pms.test/api/integration/dsh/v1/projects/22/tasks?nodeId=7&due=today')
    expect(init?.method).toBe('GET')
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([
      'pms_project_list', 'pms_project_get', 'pms_task_list', 'pms_query',
      'pms_command_preview', 'pms_command_execute',
    ])
  })

  it('keeps project and node as session tags rather than session identity', () => {
    expect(pmsSessionTags({ pageType: 'project-detail', projectId: 22, nodeId: 7 }))
      .toEqual(['pms:page:project-detail', 'pms:project:22', 'pms:node:7'])
  })

  it('isolates the current PMS locator by DSH session', () => {
    const store = new PmsContextStore()
    store.set('session-a', { pageType: 'project-detail', projectId: 22, nodeId: 7 })
    store.set('session-b', { pageType: 'project-detail', projectId: 24, nodeId: 3 })

    expect(store.get('session-a')).toEqual({ pageType: 'project-detail', projectId: 22, nodeId: 7 })
    expect(store.get('session-b')).toEqual({ pageType: 'project-detail', projectId: 24, nodeId: 3 })

    store.clear('session-a')
    expect(store.get('session-a')).toBeUndefined()
    expect(store.get('session-b')).toEqual({ pageType: 'project-detail', projectId: 24, nodeId: 3 })
  })

  it('records a refresh signal only after a successful PMS write', async () => {
    const store = new PmsContextStore()
    markWriteReady(store, 'session-1')
    const client = {
      executeOperation: vi.fn()
        .mockResolvedValueOnce({
          operationId: 'op-1',
          status: 'SUCCEEDED',
          refreshScopes: ['project-detail'],
        })
        .mockResolvedValueOnce({
          operationId: 'op-2',
          status: 'FAILED',
          refreshScopes: ['project-detail'],
        }),
    } as unknown as PmsIntegrationClient

    await executePmsOperation(client, store, { operationId: 'op-1', idempotencyKey: 'idem-1' }, {
      signal: new AbortController().signal,
      agent: { id: 'session-1' },
    } as never)
    expect(store.getRefresh('session-1', 0)).toBeUndefined()
    store.flushRefresh('session-1')
    const signal = store.getRefresh('session-1', 0)
    expect(signal).toMatchObject({
      revision: 1,
      requestId: 'op-1',
      scopes: ['project-detail'],
    })

    await executePmsOperation(client, store, { operationId: 'op-2', idempotencyKey: 'idem-2' }, {
      signal: new AbortController().signal,
      agent: { id: 'session-1' },
    } as never)
    store.flushRefresh('session-1')
    expect(store.getRefresh('session-1', 1)).toBeUndefined()
  })

  it('binds an executed write to the current PMS context and contract', async () => {
    const store = new PmsContextStore()
    store.set('session-bound', {
      pageType: 'project-detail', projectId: 22, nodeId: 7, currentNodeKey: 'kickoff', contextVersion: 'pms-v7',
    })
    store.setContract('session-bound', {
      status: 'ready',
      contract: {
        contractId: 'pms-project-assistant/project-kickoff', agentId: 'project_assistant',
        contractKey: 'project-kickoff', workflowNodeKeys: ['kickoff'], contractVersion: '1.0.0',
        required: true, locale: 'zh-CN', principalRole: 'PMS 项目经理', specializedAgents: [],
        readCapabilities: ['项目上下文'], readToolBindings: { 'project-context': 'pms_project_get' },
        writeCommands: ['project.create'], confirmationPolicies: { 'project.create': 'preview-and-confirm' },
        entryConditions: ['首个节点'], inputs: ['项目基本信息'], missingInputRules: ['不得猜测'],
        executionSteps: ['读取状态'], completionCriteria: ['必填字段完整'],
        failureStrategies: ['鉴权失败即停止'], terminationConditions: ['用户未确认'],
        contentSha256: 'e'.repeat(64),
      },
    })
    const executeOperation = vi.fn().mockResolvedValue({
      operationId: 'op-bound', status: 'SUCCEEDED', refreshScopes: [],
    })
    const client = { executeOperation } as unknown as PmsIntegrationClient

    await executePmsOperation(client, store, { operationId: 'op-bound' }, {
      signal: new AbortController().signal,
      agent: { id: 'session-bound' },
    } as never)

    expect(executeOperation).toHaveBeenCalledWith(
      'op-bound', 'pms-operation-op-bound', expect.anything(), 'session-bound', {
        contextId: 'pms:project-detail:22:7', contextVersion: 'pms-v7',
        contractId: 'pms-project-assistant/project-kickoff', contractVersion: '1.0.0',
      },
    )
  })

  it('queues multiple successful PMS writes as one refresh batch', async () => {
    const store = new PmsContextStore()
    markWriteReady(store, 'session-batch-execute')
    const client = {
      executeOperation: vi.fn()
        .mockResolvedValueOnce({ operationId: 'op-task-1', status: 'SUCCEEDED', refreshScopes: ['project-list'] })
        .mockResolvedValueOnce({ operationId: 'op-task-2', status: 'SUCCEEDED', refreshScopes: ['project-detail', 'project-list'] }),
    } as unknown as PmsIntegrationClient
    const exec = {
      signal: new AbortController().signal,
      agent: { id: 'session-batch-execute' },
    } as never

    await executePmsOperation(client, store, { operationId: 'op-task-1' }, exec)
    await executePmsOperation(client, store, { operationId: 'op-task-2' }, exec)

    expect(store.getRefresh('session-batch-execute', 0)).toBeUndefined()
    const signal = store.flushRefresh('session-batch-execute')
    expect(signal).toMatchObject({
      revision: 1,
      scopes: ['project-list', 'project-detail'],
    })
  })

  it('reuses a deterministic idempotency key when an execute call is retried', async () => {
    const store = new PmsContextStore()
    markWriteReady(store, 'session-retry')
    const client = {
      executeOperation: vi.fn()
        .mockResolvedValueOnce({ operationId: 'op-retry-1', status: 'FAILED' })
        .mockResolvedValueOnce({ operationId: 'op-retry-1', status: 'SUCCEEDED' }),
    } as unknown as PmsIntegrationClient
    const exec = {
      signal: new AbortController().signal,
      agent: { id: 'session-retry' },
    } as never

    await executePmsOperation(client, store, { operationId: 'op-retry-1' }, exec)
    await executePmsOperation(client, store, { operationId: 'op-retry-1' }, exec)

    expect(client.executeOperation).toHaveBeenNthCalledWith(
      1, 'op-retry-1', 'pms-operation-op-retry-1', expect.anything(), 'session-retry', {
        contextId: 'pms:global:none:none', contextVersion: 'v1',
        contractId: 'pms-project-assistant/project-kickoff', contractVersion: '1.0.0',
      },
    )
    expect(client.executeOperation).toHaveBeenNthCalledWith(
      2, 'op-retry-1', 'pms-operation-op-retry-1', expect.anything(), 'session-retry', {
        contextId: 'pms:global:none:none', contextVersion: 'v1',
        contractId: 'pms-project-assistant/project-kickoff', contractVersion: '1.0.0',
      },
    )
  })

  it('keeps refresh signals isolated between DSH sessions', () => {
    const store = new PmsContextStore()
    store.requestRefresh('session-a', ['project-list'], 'refresh-a')
    expect(store.getRefresh('session-a', 0)?.scopes).toEqual(['project-list'])
    expect(store.getRefresh('session-b', 0)).toBeUndefined()
  })

  it('coalesces refresh scopes until a batch is flushed', () => {
    const store = new PmsContextStore()

    store.queueRefresh('session-batch', ['project-list'], 'op-1')
    expect(store.getRefresh('session-batch', 0)).toBeUndefined()

    store.queueRefresh('session-batch', ['project-detail', 'project-list'], 'op-2')
    const signal = store.flushRefresh('session-batch')

    expect(signal).toMatchObject({
      revision: 1,
      scopes: ['project-list', 'project-detail'],
    })
    expect(store.getRefresh('session-batch', 0)).toMatchObject({
      revision: 1,
      scopes: ['project-list', 'project-detail'],
    })
    expect(store.flushRefresh('session-batch')).toBeUndefined()
  })

  it('flushes queued writes when the PMS Agent turn stops', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token', requestTimeoutMs: 1000,
    })
    const store = ctx.get('pmsContextStore') as PmsContextStore
    store.queueRefresh('session-turn', ['project-list'], 'op-1')
    store.queueRefresh('session-turn', ['project-detail'], 'op-2')

    ctx.emit('agent/turn-stopping', {
      agent: { id: 'session-turn' } as never,
      turn: 1,
      signal: new AbortController().signal,
    })

    expect(store.getRefresh('session-turn', 0)).toMatchObject({
      revision: 1,
      scopes: ['project-list', 'project-detail'],
    })
    expect(store.flushRefresh('session-turn')).toBeUndefined()
  })

  it('uses the tool agent id to select the PMS locator', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        version: 'v1', tools: ['pms_task_list'], scopes: ['pms:task:read'], pageTypes: ['project-detail'],
      }))
      .mockResolvedValueOnce(response({ total: 1, tasks: [] }))
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      baseUrl: 'http://pms.test', apiPrefix: '/api', accessToken: 'short-token', requestTimeoutMs: 1000,
    })
    const store = ctx.get('pmsContextStore') as PmsContextStore
    store.set('session-a', { pageType: 'project-detail', projectId: 22, nodeId: 7 })
    store.set('session-b', { pageType: 'project-detail', projectId: 24, nodeId: 3 })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('task-call-session-b'),
      name: 'pms_task_list',
      arguments: { due: 'today' },
      agent: { id: 'session-b' } as never,
    })

    expect(result.isError).toBe(false)
    expect(requestUrl(fetchMock.mock.calls[1]![0])).toContain('/projects/24/tasks?nodeId=3&due=today')
  })
})

describe('PmsIntegrationClient session token cache', () => {
  it('exchanges separate delegation tokens for separate DSH sessions', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ token: 'token-a', expiresInSeconds: 120, audience: 'dsh-pms', scopes: [] }))
      .mockResolvedValueOnce(response({ version: 'v1', tools: ['pms_project_list'], scopes: ['pms:project:read'], pageTypes: [] }))
      .mockResolvedValueOnce(response({ contextId: 'project-list' }))
      .mockResolvedValueOnce(response({ token: 'token-b', expiresInSeconds: 120, audience: 'dsh-pms', scopes: [] }))
      .mockResolvedValueOnce(response({ version: 'v1', tools: ['pms_project_list'], scopes: ['pms:project:read'], pageTypes: [] }))
      .mockResolvedValueOnce(response({ contextId: 'project-list' }))
    const client = new PmsIntegrationClient({
      baseUrl: 'http://pms.test', apiPrefix: '/api', pmsUserToken: 'user-token', serviceKey: 'service-key',
      agentId: 'project_assistant', allowLegacyUserTokenExchange: true,
      requestTimeoutMs: 1000, fetchImpl, requestIdFactory: () => 'request-1',
    })

    await client.projects({}, undefined, 'session-a')
    await client.projects({}, undefined, 'session-b')

    expect(JSON.parse(requestBody(fetchImpl.mock.calls[0]![1]?.body) ?? '')).toMatchObject({ dshSessionId: 'session-a' })
    expect(JSON.parse(requestBody(fetchImpl.mock.calls[3]![1]?.body) ?? '')).toMatchObject({ dshSessionId: 'session-b' })
    expect(fetchImpl.mock.calls[2]![1]?.headers).toMatchObject({ 'X-PMS-AI-Delegation': 'token-a' })
    expect(fetchImpl.mock.calls[5]![1]?.headers).toMatchObject({ 'X-PMS-AI-Delegation': 'token-b' })
  })
})
