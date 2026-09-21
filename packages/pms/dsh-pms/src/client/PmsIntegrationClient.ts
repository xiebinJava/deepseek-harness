import type {
  PmsApiEnvelope,
  PmsAgentContract,
  PmsCapabilities,
  PmsContextSnapshot,
  PmsCommandPreview,
  PmsCommandPreviewRequest,
  PmsCommandResult,
  PmsOperationBinding,
  PmsProjectListQuery,
  PmsJsonObject,
  PmsQueryRequest,
  PmsQueryResult,
  PmsTaskListQuery,
} from '../types.ts'
import type { PmsAuthCode, PmsAuthStore } from '../auth/pms-auth-store.ts'
import { randomUUID } from 'node:crypto'

export interface PmsIntegrationClientOptions {
  baseUrl: string
  apiPrefix: string
  accessToken?: string
  pmsUserToken?: string
  serviceKey?: string
  dshSessionId?: string
  agentId?: string
  allowedTools?: readonly string[]
  allowLegacyUserTokenExchange?: boolean
  agentVersion?: string
  workspaceType?: string
  authStore?: PmsAuthStore
  /** How long to wait for the browser bridge to publish a replacement code. */
  authCodeRefreshWaitMs?: number
  requestTimeoutMs: number
  fetchImpl?: typeof fetch
  requestIdFactory?: () => string
}

export class PmsIntegrationError extends Error {
  readonly status: number
  readonly code: number | string
  readonly requestId: string | undefined

  constructor(message: string, options: { status: number; code: number | string; requestId?: string }) {
    super(message)
    this.name = 'PmsIntegrationError'
    this.status = options.status
    this.code = options.code
    this.requestId = options.requestId
  }
}

export class PmsIntegrationClient {
  private readonly baseUrl: string
  private readonly apiPrefix: string
  private readonly accessToken: string
  private readonly pmsUserToken: string
  private readonly serviceKey: string
  private readonly dshSessionId: string
  private readonly agentId: string
  private readonly allowedTools: readonly string[] | undefined
  private readonly allowLegacyUserTokenExchange: boolean
  private readonly agentVersion: string
  private readonly workspaceType: string
  private readonly authStore: PmsAuthStore | undefined
  private readonly authCodeRefreshWaitMs: number
  private readonly requestTimeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly requestIdFactory: () => string
  private exchangedTokens = new Map<string, { value: string; expiresAt: number }>()
  private exchangePromises = new Map<string, Promise<string>>()
  private capabilitiesSnapshots = new Map<string, PmsCapabilities>()
  private capabilitiesPromises = new Map<string, Promise<PmsCapabilities>>()
  private agentContractSnapshots = new Map<string, PmsAgentContract>()
  private agentContractPromises = new Map<string, Promise<PmsAgentContract>>()

  constructor(options: PmsIntegrationClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.apiPrefix = `/${options.apiPrefix.replace(/^\/+|\/+$/gu, '')}`
    this.accessToken = options.accessToken?.trim() ?? ''
    this.pmsUserToken = options.pmsUserToken?.trim() ?? ''
    this.serviceKey = options.serviceKey?.trim() ?? ''
    this.dshSessionId = options.dshSessionId?.trim() ?? ''
    this.agentId = options.agentId?.trim() ?? ''
    this.allowedTools = options.allowedTools === undefined
      ? undefined
      : [...new Set(options.allowedTools.map(tool => tool.trim()).filter(Boolean))]
    this.allowLegacyUserTokenExchange = options.allowLegacyUserTokenExchange ?? false
    this.agentVersion = options.agentVersion?.trim() ?? ''
    this.workspaceType = options.workspaceType?.trim() ?? ''
    this.authStore = options.authStore
    this.authCodeRefreshWaitMs = options.authCodeRefreshWaitMs ?? 5_000
    this.requestTimeoutMs = options.requestTimeoutMs
    this.fetchImpl = options.fetchImpl ?? fetch
    this.requestIdFactory = options.requestIdFactory ?? randomUUID
  }

  /**
   * Create a capability-scoped facade for one mounted Agent.
   *
   * The short-lived authorization cache remains shared with the host bridge,
   * while the capability cache stays local to the scoped facade. A scoped
   * Agent must not consume a one-time browser code again, and must not reuse a
   * capability snapshot filtered for a different Agent.
   */
  scopedToTools(allowedTools: readonly string[]): PmsIntegrationClient {
    const scoped = new PmsIntegrationClient({
      baseUrl: this.baseUrl,
      apiPrefix: this.apiPrefix,
      accessToken: this.accessToken,
      pmsUserToken: this.pmsUserToken,
      serviceKey: this.serviceKey,
      dshSessionId: this.dshSessionId,
      agentId: this.agentId,
      allowedTools,
      allowLegacyUserTokenExchange: this.allowLegacyUserTokenExchange,
      agentVersion: this.agentVersion,
      workspaceType: this.workspaceType,
      ...(this.authStore === undefined ? {} : { authStore: this.authStore }),
      authCodeRefreshWaitMs: this.authCodeRefreshWaitMs,
      requestTimeoutMs: this.requestTimeoutMs,
      fetchImpl: this.fetchImpl,
      requestIdFactory: this.requestIdFactory,
    })
    scoped.exchangedTokens = this.exchangedTokens
    scoped.exchangePromises = this.exchangePromises
    scoped.agentContractSnapshots = this.agentContractSnapshots
    scoped.agentContractPromises = this.agentContractPromises
    return scoped
  }

  capabilities(signal?: AbortSignal, sessionId?: string): Promise<PmsCapabilities> {
    return this.ensureCapabilities(signal, sessionId)
  }

  getAgentContract(
    agentId: string,
    contractKey: string,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<PmsAgentContract> {
    const resolvedAgentId = agentId.trim()
    const resolvedContractKey = contractKey.trim()
    if (resolvedAgentId === '' || resolvedContractKey === '') throw new Error('dsh-pms: Agent contract identity is required')
    if (this.agentId !== '' && this.agentId !== resolvedAgentId) throw capabilityForbidden()
    const key = `${this.sessionKey(sessionId)}:${resolvedAgentId}:${resolvedContractKey}`
    const pending = this.agentContractPromises.get(key)
    if (pending !== undefined) return pending
    const request = this.ensureCapabilities(signal, sessionId)
      .then((capabilities) => {
        const descriptor = capabilities.agentContracts?.find(item =>
          item.agentId === resolvedAgentId && item.contractKey === resolvedContractKey)
        if (descriptor === undefined) throw capabilityForbidden()
        const cached = this.agentContractSnapshots.get(key)
        if (cached !== undefined && cached.contractVersion === descriptor.contractVersion) {
          validateContractIdentity(cached, resolvedAgentId, resolvedContractKey, descriptor.contractVersion)
          return cached
        }
        return this.get<PmsAgentContract>(
          `/integration/dsh/v1/agent-contracts/${encodeURIComponent(resolvedAgentId)}/${encodeURIComponent(resolvedContractKey)}`,
          undefined,
          signal,
          sessionId,
        ).then((contract) => {
          validateContractIdentity(contract, resolvedAgentId, resolvedContractKey, descriptor.contractVersion)
          return contract
        })
      })
      .then((contract) => {
        this.agentContractSnapshots.set(key, contract)
        return contract
      })
    const tracked = request.finally(() => this.agentContractPromises.delete(key))
    this.agentContractPromises.set(key, tracked)
    return tracked
  }

  projects(query: PmsProjectListQuery = {}, signal?: AbortSignal, sessionId?: string): Promise<PmsContextSnapshot> {
    return this.withCapability('pms_project_list', signal, sessionId)
      .then(() => this.get<PmsContextSnapshot>('/integration/dsh/v1/projects', query, signal, sessionId))
  }

  project(projectId: number, nodeId?: number, signal?: AbortSignal, sessionId?: string): Promise<PmsContextSnapshot> {
    return this.withCapability('pms_project_get', signal, sessionId)
      .then(() => this.get<PmsContextSnapshot>(
        `/integration/dsh/v1/projects/${encodeURIComponent(String(projectId))}`,
        nodeId === undefined ? undefined : { nodeId },
        signal,
        sessionId,
      ))
  }

  tasks(query: PmsTaskListQuery, signal?: AbortSignal, sessionId?: string): Promise<PmsJsonObject> {
    if (query.projectId === undefined) throw new Error('dsh-pms: projectId is required for pms_task_list')
    return this.withCapability('pms_task_list', signal, sessionId)
      .then(() => this.get<PmsJsonObject>(
        `/integration/dsh/v1/projects/${encodeURIComponent(String(query.projectId))}/tasks`,
        {
          nodeId: query.nodeId,
          due: query.due,
          status: query.status,
          page: query.page,
          pageSize: query.pageSize,
        },
        signal,
        sessionId,
      ))
  }

  query(request: PmsQueryRequest, signal?: AbortSignal, sessionId?: string): Promise<PmsQueryResult> {
    if (request.resource.trim() === '') throw new Error('dsh-pms: resource is required')
    return this.withCapability('pms_query', signal, sessionId)
      .then(() => this.post<PmsQueryResult>('/integration/dsh/v1/query', request, signal, sessionId))
  }

  previewCommand(
    request: PmsCommandPreviewRequest,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<PmsCommandPreview> {
    return this.withCapability('pms_command_preview', signal, sessionId)
      .then(async () => {
        const capabilities = await this.ensureCapabilities(signal, sessionId)
        if (capabilities.commands !== undefined) {
          const command = capabilities.commands.find(item => item.name === request.name)
          if (command === undefined || !command.supportsPreview) throw capabilityForbidden()
        }
        return this.post<PmsCommandPreview>('/integration/dsh/v1/commands/preview', request, signal, sessionId)
      })
  }

  executeOperation(
    operationId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
    sessionId?: string,
    binding?: PmsOperationBinding,
  ): Promise<PmsCommandResult> {
    if (operationId.trim() === '') throw new Error('dsh-pms: operationId is required')
    if (idempotencyKey.trim() === '') throw new Error('dsh-pms: idempotencyKey is required')
    return this.withCapability('pms_command_execute', signal, sessionId)
      .then(() => this.post<PmsCommandResult>(
        `/integration/dsh/v1/operations/${encodeURIComponent(operationId)}/execute`,
        { idempotencyKey, ...(binding ?? {}) },
        signal,
        sessionId,
      ))
  }

  private async get<T>(path: string, query: object | undefined, signal?: AbortSignal, sessionId?: string): Promise<T> {
    return this.request('GET', path, query, undefined, signal, sessionId)
  }

  private async post<T>(path: string, body: object, signal?: AbortSignal, sessionId?: string): Promise<T> {
    return this.request('POST', path, undefined, body, signal, sessionId)
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    query: object | undefined,
    body: object | undefined,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<T> {
    if (path !== '/integration/dsh/v1/capabilities') await this.ensureCapabilities(signal, sessionId)
    let accessToken = await this.resolveAccessToken(signal, sessionId)
    const resolvedSessionId = sessionId?.trim() || this.dshSessionId
    let refreshedAfterUnauthorized = false
    const url = new URL(`${this.apiPrefix}${path}`, `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    while (true) {
      const requestId = this.requestIdFactory()
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort(new Error('PMS request timeout')) }, this.requestTimeoutMs)
      const onAbort = () => { controller.abort(signal?.reason) }
      signal?.addEventListener('abort', onAbort, { once: true })
      const operationId = operationIdOf(path)
      try {
        const response = await this.fetchImpl(url, {
          method,
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            'X-PMS-AI-Delegation': accessToken,
            'X-Request-Id': requestId,
            ...(resolvedSessionId === '' ? {} : { 'X-DSH-Session-Id': resolvedSessionId }),
            ...(this.agentId === '' ? {} : { 'X-DSH-Agent-Id': this.agentId }),
            ...(this.agentVersion === '' ? {} : { 'X-DSH-Agent-Version': this.agentVersion }),
            ...(this.workspaceType === '' ? {} : { 'X-DSH-Workspace': this.workspaceType }),
            'X-DSH-Tool': toolName(path),
            ...(operationId === undefined ? {} : { 'X-DSH-Operation-Id': operationId }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const responseBody = await readEnvelope<T>(response)
        if (!response.ok || responseBody.code !== 200 || responseBody.data === undefined) {
          if (response.status === 401
              && !refreshedAfterUnauthorized
              && this.accessToken === ''
              && this.authStore !== undefined
              && resolvedSessionId !== '') {
            refreshedAfterUnauthorized = true
            this.exchangedTokens.delete(resolvedSessionId)
            accessToken = await this.resolveAccessToken(signal, sessionId)
            continue
          }
          throw new PmsIntegrationError(safeMessage(responseBody, response.status), {
            status: response.status,
            code: responseBody.code,
            requestId: responseBody.requestId ?? requestId,
          })
        }
        return responseBody.data
      } catch (error) {
        if (error instanceof PmsIntegrationError) throw error
        if (controller.signal.aborted) {
          throw new PmsIntegrationError('PMS request was cancelled or timed out', {
            status: 504,
            code: 'PMS_UPSTREAM_TIMEOUT',
            requestId,
          })
        }
        throw new PmsIntegrationError('PMS service is unavailable', {
          status: 503,
          code: 'PMS_UPSTREAM_UNAVAILABLE',
          requestId,
        })
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    }
  }

  private async ensureCapabilities(signal?: AbortSignal, sessionId?: string): Promise<PmsCapabilities> {
    const key = this.sessionKey(sessionId)
    const cached = this.capabilitiesSnapshots.get(key)
    if (cached !== undefined) return cached
    const pending = this.capabilitiesPromises.get(key)
    if (pending !== undefined) return pending
    const request = this.get<PmsCapabilities>('/integration/dsh/v1/capabilities', undefined, signal, sessionId)
      .then((capabilities) => {
        const effective = effectiveCapabilities(capabilities, this.allowedTools)
        this.capabilitiesSnapshots.set(key, effective)
        return effective
      })
      .finally(() => this.capabilitiesPromises.delete(key))
    this.capabilitiesPromises.set(key, request)
    return request
  }

  private sessionKey(sessionId?: string): string {
    return sessionId?.trim() || this.dshSessionId || '__default__'
  }

  private async withCapability(tool: string, signal?: AbortSignal, sessionId?: string): Promise<void> {
    const capabilities = await this.ensureCapabilities(signal, sessionId)
    if (!capabilities.tools.includes(tool)) throw capabilityForbidden()
  }

  private async resolveAccessToken(signal?: AbortSignal, sessionId?: string): Promise<string> {
    if (this.accessToken !== '') return this.accessToken
    const resolvedSessionId = sessionId?.trim() || this.dshSessionId
    const authCode = this.authStore?.get(resolvedSessionId)
    if (authCode !== undefined && resolvedSessionId !== '') {
      if (this.agentId !== '' && authCode.agentId !== this.agentId) {
        throw new PmsIntegrationError(
          '当前会话 Agent 与 PMS 授权 Agent 不一致，请重新打开 PMS 工作区',
          { status: 403, code: 'PMS_AGENT_ID_MISMATCH' },
        )
      }
      const cached = this.exchangedTokens.get(resolvedSessionId)
      if (cached !== undefined && cached.expiresAt - 5000 > Date.now()) return cached.value
      let exchangePromise = this.exchangePromises.get(resolvedSessionId)
      if (exchangePromise === undefined) {
        exchangePromise = this.exchangeAuthorizationCodeWithRefresh(resolvedSessionId, authCode, signal).finally(() => {
          this.exchangePromises.delete(resolvedSessionId)
        })
        this.exchangePromises.set(resolvedSessionId, exchangePromise)
      }
      return exchangePromise
    }
    if (!this.allowLegacyUserTokenExchange
      || this.pmsUserToken === '' || this.serviceKey === '' || resolvedSessionId === '' || this.agentId === '') {
      throw new PmsIntegrationError('PMS 登录态不可用，请重新打开 PMS 工作区', {
        status: 401,
        code: 'PMS_AUTH_REQUIRED',
      })
    }
    const cached = this.exchangedTokens.get(resolvedSessionId)
    if (cached !== undefined && cached.expiresAt - 5000 > Date.now()) return cached.value
    let exchangePromise = this.exchangePromises.get(resolvedSessionId)
    if (exchangePromise === undefined) {
      exchangePromise = this.exchangeToken(resolvedSessionId, signal).finally(() => {
        this.exchangePromises.delete(resolvedSessionId)
      })
      this.exchangePromises.set(resolvedSessionId, exchangePromise)
    }
    return exchangePromise
  }

  private async exchangeAuthorizationCodeWithRefresh(
    dshSessionId: string,
    authCode: PmsAuthCode,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      return await this.exchangeAuthorizationCode(dshSessionId, authCode, signal)
    } catch (error) {
      if (!(error instanceof PmsIntegrationError)
        || error.code !== 'PMS_DSH_AUTH_CODE_INVALID'
        || this.authStore === undefined) throw error

      this.exchangedTokens.delete(dshSessionId)
      const freshAuthCode = await this.authStore.waitForNewer(
        dshSessionId,
        authCode.receivedAt,
        signal === undefined
          ? { timeoutMs: this.authCodeRefreshWaitMs }
          : { timeoutMs: this.authCodeRefreshWaitMs, signal },
      )
      if (freshAuthCode === undefined) {
        throw new PmsIntegrationError(
          'PMS browser authorization code expired; reopen the PMS workspace to refresh the login session',
          error.requestId === undefined
            ? { status: 401, code: 'PMS_AUTH_CODE_REFRESH_REQUIRED' }
            : { status: 401, code: 'PMS_AUTH_CODE_REFRESH_REQUIRED', requestId: error.requestId },
        )
      }
      // The replacement code is also one-time. Exchange it once and let the
      // caller surface the exact failure if the browser session is unavailable.
      return this.exchangeAuthorizationCode(dshSessionId, freshAuthCode, signal)
    }
  }

  private async exchangeAuthorizationCode(
    dshSessionId: string,
    authCode: PmsAuthCode,
    signal?: AbortSignal,
  ): Promise<string> {
    const requestId = this.requestIdFactory()
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error('PMS auth code exchange timeout')) }, this.requestTimeoutMs)
    const onAbort = () => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const url = new URL(`${this.apiPrefix}/integration/dsh/v1/token/exchange`, `${this.baseUrl}/`)
      const response = await this.fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-DSH-Service-Key': this.serviceKey,
          'X-Request-Id': requestId,
          ...(this.agentId === '' ? {} : { 'X-DSH-Agent-Id': this.agentId }),
        },
        body: JSON.stringify({
          authorizationCode: authCode.authorizationCode,
          dshSessionId,
          agentId: authCode.agentId,
          scopes: authCode.scopes,
        }),
      })
      const body = await readEnvelope<{
        token: string
        expiresInSeconds: number
        audience: string
        scopes: string[]
      }>(response)
      if (!response.ok || body.code !== 200 || body.data === undefined) {
        const code = isPmsErrorCode(body.msg) ? body.msg : 'PMS_AUTH_CODE_EXCHANGE_FAILED'
        throw new PmsIntegrationError(safeMessage(body, response.status), {
          status: response.status,
          code,
          requestId: body.requestId ?? requestId,
        })
      }
      if (body.data.audience !== 'dsh-pms' || body.data.token.trim() === '' || body.data.expiresInSeconds <= 0) {
        throw new PmsIntegrationError('PMS returned an invalid delegation token', {
          status: 502,
          code: 'PMS_INVALID_DELEGATION_TOKEN',
          requestId: body.requestId ?? requestId,
        })
      }
      this.exchangedTokens.set(dshSessionId, {
        value: body.data.token,
        expiresAt: Date.now() + body.data.expiresInSeconds * 1000,
      })
      this.capabilitiesSnapshots.delete(dshSessionId)
      return body.data.token
    } catch (error) {
      if (error instanceof PmsIntegrationError) throw error
      if (controller.signal.aborted) {
        throw new PmsIntegrationError('PMS authorization code exchange timed out', {
          status: 504,
          code: 'PMS_UPSTREAM_TIMEOUT',
          requestId,
        })
      }
      throw new PmsIntegrationError('PMS authorization code exchange is unavailable', {
        status: 503,
        code: 'PMS_UPSTREAM_UNAVAILABLE',
        requestId,
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async exchangeToken(dshSessionId: string, signal?: AbortSignal): Promise<string> {
    const requestId = this.requestIdFactory()
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error('PMS token exchange timeout')) }, this.requestTimeoutMs)
    const onAbort = () => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const url = new URL(`${this.apiPrefix}/integration/dsh/v1/token`, `${this.baseUrl}/`)
      const response = await this.fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.pmsUserToken}`,
          'X-DSH-Service-Key': this.serviceKey,
          'X-Request-Id': requestId,
        },
        body: JSON.stringify({
          dshSessionId,
          agentId: this.agentId,
          scopes: [
            'pms:project:read', 'pms:task:read', 'pms:query:read',
            'pms:task:write', 'pms:command:preview', 'pms:command:execute',
            'pms:workflow:write',
            'pms:project:write',
            'pms:workspace:embed',
          ],
        }),
      })
      const body = await readEnvelope<{
        token: string
        expiresInSeconds: number
        audience: string
        scopes: string[]
      }>(response)
      if (!response.ok || body.code !== 200 || body.data === undefined) {
        throw new PmsIntegrationError(safeMessage(body, response.status), {
          status: response.status,
          code: body.code,
          requestId: body.requestId ?? requestId,
        })
      }
      if (body.data.audience !== 'dsh-pms' || body.data.token.trim() === '' || body.data.expiresInSeconds <= 0) {
        throw new PmsIntegrationError('PMS returned an invalid delegation token', {
          status: 502,
          code: 'PMS_INVALID_DELEGATION_TOKEN',
          requestId: body.requestId ?? requestId,
        })
      }
      this.exchangedTokens.set(dshSessionId, {
        value: body.data.token,
        expiresAt: Date.now() + body.data.expiresInSeconds * 1000,
      })
      this.capabilitiesSnapshots.delete(dshSessionId)
      return body.data.token
    } catch (error) {
      if (error instanceof PmsIntegrationError) throw error
      if (controller.signal.aborted) {
        throw new PmsIntegrationError('PMS token exchange was cancelled or timed out', {
          status: 504,
          code: 'PMS_UPSTREAM_TIMEOUT',
          requestId,
        })
      }
      throw new PmsIntegrationError('PMS token exchange is unavailable', {
        status: 503,
        code: 'PMS_UPSTREAM_UNAVAILABLE',
        requestId,
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

async function readEnvelope<T>(response: Response): Promise<PmsApiEnvelope<T>> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { code: response.status, msg: 'Invalid PMS response' }
  }
  if (body === null || typeof body !== 'object') return { code: response.status, msg: 'Invalid PMS response' }
  return body as PmsApiEnvelope<T>
}

function safeMessage<T>(body: PmsApiEnvelope<T>, status: number): string {
  if (status === 401) return 'PMS 授权失败，请重新打开 PMS 工作区或刷新登录状态'
  if (status === 403) {
    const message = body.msg ?? body.message
    if (message === 'PMS_DSH_SERVICE_AUTH_FAILED') return 'DSH 与 PMS 服务鉴权失败，请检查服务配置'
    if (message === 'PMS_DSH_AUTH_CODE_INVALID') return 'PMS 浏览器授权码已失效，请重新打开 PMS 工作区'
    return message ?? 'PMS 权限不足，当前用户无权执行该操作'
  }
  const message = body.msg ?? body.message ?? 'PMS request failed'
  if (status >= 500 && body.requestId !== undefined && !message.includes(body.requestId)) {
    return `${message}（请求编号：${body.requestId}）`
  }
  return message
}

function isPmsErrorCode(value: string | undefined): value is string {
  return value !== undefined && /^PMS_[A-Z0-9_]+$/u.test(value)
}

const TOOL_SCOPES: Readonly<Record<string, string>> = {
  pms_project_list: 'pms:project:read',
  pms_project_get: 'pms:project:read',
  pms_task_list: 'pms:task:read',
  pms_command_preview: 'pms:command:preview',
  pms_command_execute: 'pms:command:execute',
}

function effectiveCapabilities(
  capabilities: PmsCapabilities,
  allowedTools: readonly string[] | undefined,
): PmsCapabilities {
  const serverScopes = new Set(capabilities.scopes)
  const agentTools = allowedTools === undefined ? undefined : new Set(allowedTools)
  const queries = capabilities.queries?.filter(query => query.scopes.every(scope => serverScopes.has(scope)))
  const commands = capabilities.commands?.filter(command => command.scopes.every(scope => serverScopes.has(scope)))
  const agentContracts = capabilities.agentContracts?.filter(contract => serverScopes.has(contract.scope))
  const hasAgentTool = (tool: string): boolean => agentTools === undefined || agentTools.has(tool)
  const hasStaticScope = (tool: string): boolean => {
    const scope = TOOL_SCOPES[tool]
    return scope === undefined || serverScopes.has(scope)
  }
  const tools = capabilities.tools.filter((tool) => {
    if (!hasAgentTool(tool) || !hasStaticScope(tool)) return false
    if (tool === 'pms_query') return queries === undefined || queries.length > 0
    if (tool === 'pms_command_preview') return commands === undefined
      ? true
      : commands.some(command => command.supportsPreview)
    if (tool === 'pms_command_execute') return commands === undefined
      ? true
      : commands.some(command => command.supportsExecute)
    return true
  })
  const effectiveScopes = new Set<string>()
  for (const tool of tools) {
    const scope = TOOL_SCOPES[tool]
    if (scope !== undefined) effectiveScopes.add(scope)
  }
  for (const query of queries ?? []) for (const scope of query.scopes) effectiveScopes.add(scope)
  for (const command of commands ?? []) for (const scope of command.scopes) effectiveScopes.add(scope)
  for (const contract of agentContracts ?? []) effectiveScopes.add(contract.scope)
  return {
    ...capabilities,
    tools,
    scopes: capabilities.scopes.filter(scope => effectiveScopes.has(scope)),
    ...(queries === undefined ? {} : { queries }),
    ...(commands === undefined ? {} : { commands }),
    ...(agentContracts === undefined ? {} : { agentContracts }),
  }
}

function capabilityForbidden(): PmsIntegrationError {
  return new PmsIntegrationError('当前 PMS 用户没有执行该 Agent 能力所需的权限', {
    status: 403,
    code: 'PMS_AGENT_CAPABILITY_FORBIDDEN',
  })
}

function validateContractIdentity(
  contract: PmsAgentContract,
  agentId: string,
  contractKey: string,
  contractVersion: string,
): void {
  if (contract.agentId !== agentId
    || contract.contractKey !== contractKey
    || contract.contractVersion !== contractVersion) {
    throw contractIdentityMismatch()
  }
}

function contractIdentityMismatch(): PmsIntegrationError {
  return new PmsIntegrationError('PMS Agent contract identity mismatch', {
    status: 502,
    code: 'PMS_AGENT_CONTRACT_MISMATCH',
  })
}

function toolName(path: string): string {
  if (path.endsWith('/capabilities')) return 'pms_capabilities'
  if (path.endsWith('/projects')) return 'pms_project_list'
  if (/\/projects\/[^/]+\/tasks$/u.test(path)) return 'pms_task_list'
  if (/\/projects\/[^/]+$/u.test(path)) return 'pms_project_get'
  if (path.endsWith('/query')) return 'pms_query'
  if (/\/agent-contracts\/[^/]+\/[^/]+$/u.test(path)) return 'pms_agent_contract'
  if (path.endsWith('/commands/preview')) return 'pms_command_preview'
  if (path.includes('/operations/')) return 'pms_command_execute'
  return 'pms_unknown'
}

/** Extract the operation id from `/operations/{id}/...`, without assuming the segment exists. */
function operationIdOf(path: string): string | undefined {
  const marker = '/operations/'
  const start = path.indexOf(marker)
  if (start < 0) return undefined
  const segment = path.slice(start + marker.length).split('/')[0]
  return segment === undefined || segment === '' ? undefined : decodeURIComponent(segment)
}
