/**
 * Live PMS kickoff-contract end-to-end run.
 *
 * This spec talks to a real PMS backend: real login, real DSH delegation token,
 * real contract fetch, real reads, real preview/execute writes. It is skipped
 * unless a live target is configured, so the default suite is unaffected:
 *
 *   PMS_E2E_BASE_URL=http://127.0.0.1:8080 \
 *   PMS_E2E_SERVICE_KEY=... PMS_E2E_USER_EMAIL=... PMS_E2E_USER_PASSWORD=... \
 *   PMS_E2E_RECORD_PATH=/tmp/pms-kickoff-e2e/evidence.json \
 *   ./node_modules/.bin/vitest run packages/pms/dsh-pms/tests/pms-kickoff-contract.live.spec.ts
 */
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as DshPms from '@deepseek-ai/dsh-pms'
import { PmsAuthStore } from '../src/auth/pms-auth-store.ts'
import { PmsContextStore } from '../src/context/pms-context-store.ts'
import { executePmsOperation } from '../src/tools/command.ts'
import type { PmsIntegrationClient } from '../src/client/PmsIntegrationClient.ts'
import type { PmsCommandPreview, PmsJsonObject } from '../src/types.ts'

const baseUrl = (process.env.PMS_E2E_BASE_URL ?? '').trim().replace(/\/+$/u, '')
const serviceKey = (process.env.PMS_E2E_SERVICE_KEY ?? '').trim()
const userEmail = (process.env.PMS_E2E_USER_EMAIL ?? '').trim()
const userPassword = process.env.PMS_E2E_USER_PASSWORD ?? ''
const sessionId = (process.env.PMS_E2E_SESSION_ID ?? '').trim() || 'pms-kickoff-e2e'
const recordPath = (process.env.PMS_E2E_RECORD_PATH ?? '').trim()

const live = baseUrl !== '' && serviceKey !== '' && userEmail !== '' && userPassword !== ''
const describeLive = live ? describe : describe.skip

interface PmsEnvelope<T> {
  code: number
  msg?: string
  data?: T
  requestId?: string
}

interface IssuedAuthCode {
  authorizationCode: string
  expiresInSeconds: number
  scopes: string[]
}

interface EvidenceEntry {
  step: string
  at: string
  detail: Record<string, unknown>
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

describeLive('live PMS kickoff contract E2E', () => {
  const evidence: EvidenceEntry[] = []
  let ctx: Context
  let authStore: PmsAuthStore
  let contextStore: PmsContextStore
  let client: PmsIntegrationClient
  let userToken = ''
  let projectId = 0
  let nodeId = 0
  let createdProjectId = 0

  function record(step: string, detail: Record<string, unknown>): void {
    evidence.push({ step, at: new Date().toISOString(), detail })
  }

  async function pmsJson(path: string, init: RequestInit = {}): Promise<{ data: unknown; requestId?: string }> {
    const response = await fetch(new URL(path, baseUrl), init)
    const body = await response.json() as PmsEnvelope<unknown>
    if (!response.ok || body.code !== 200 || body.data === undefined) {
      throw new Error(`PMS ${path} failed: HTTP ${response.status} ${body.msg ?? ''} ${body.requestId ?? ''}`)
    }
    return body.requestId === undefined ? { data: body.data } : { data: body.data, requestId: body.requestId }
  }

  async function pmsError(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; code: number | undefined; msg: string; requestId?: string }> {
    const response = await fetch(new URL(path, baseUrl), init)
    const body = await response.json() as PmsEnvelope<unknown>
    const failure: { status: number; code: number | undefined; msg: string; requestId?: string } = {
      status: response.status,
      code: body.code,
      msg: body.msg ?? '',
    }
    if (body.requestId !== undefined) failure.requestId = body.requestId
    return failure
  }

  /** Issue one fresh one-time PMS authorization code for this DSH session. */
  async function refreshAuthCode(): Promise<void> {
    const issued = await pmsJson('/api/integration/dsh/v1/authorization-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ dshSessionId: sessionId, agentId: 'project_assistant' }),
    })
    const issuedCode = issued.data as IssuedAuthCode
    authStore.set(sessionId, {
      authorizationCode: issuedCode.authorizationCode,
      agentId: 'project_assistant',
      scopes: issuedCode.scopes,
      receivedAt: Date.now(),
    })
    record('auth.authorization-code', {
      dshSessionId: sessionId,
      expiresInSeconds: issuedCode.expiresInSeconds,
      scopes: issuedCode.scopes,
      authorizationCodeLength: issuedCode.authorizationCode.length,
    })
  }

  interface ToolCallOutcome<T> {
    isError: boolean
    text: string
    value: T | undefined
  }

  async function callToolRaw<T>(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome<T>> {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`${name}-${evidence.length}-${Date.now()}`),
      name,
      arguments: args,
    })
    const text = result.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    return {
      isError: result.isError,
      text,
      value: result.isError || text === '' ? undefined : JSON.parse(text) as T,
    }
  }

  async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const outcome = await callToolRaw<T>(name, args)
    if (outcome.isError || outcome.value === undefined) throw new Error(`${name} failed: ${outcome.text}`)
    return outcome.value
  }

  async function callToolError(name: string, args: Record<string, unknown>): Promise<string> {
    const outcome = await callToolRaw<unknown>(name, args)
    expect(outcome.isError).toBe(true)
    return outcome.text
  }

  beforeAll(async () => {
    const login = await pmsJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userEmail, password: userPassword }),
    })
    const loginData = login.data as { accessToken: string; user?: { id?: number } }
    userToken = loginData.accessToken
    record('auth.login', { email: userEmail, userId: loginData.user?.id, requestId: login.requestId })

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DshPms, {
      mode: 'full',
      baseUrl,
      apiPrefix: '/api',
      serviceKey,
      dshSessionId: sessionId,
      agentId: 'project_assistant',
      workspaceType: 'pms',
      requestTimeoutMs: 20_000,
    })
    authStore = ctx.get('pmsAuthStore') as PmsAuthStore
    contextStore = ctx.get('pmsContextStore') as PmsContextStore
    client = ctx.get('pmsIntegrationClient') as PmsIntegrationClient
    await refreshAuthCode()
  }, 60_000)

  afterAll(async () => {
    if (recordPath !== '') writeFileSync(recordPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    if (ctx !== undefined) await ctx.fiber.dispose()
  })

  it('reads the authoritative project, node, members and tasks through the live tools', async () => {
    const list = await callTool<{ data: { projects?: PmsJsonObject[]; total?: number } }>('pms_project_list', { pageSize: 100 })
    const projects = list.data.projects ?? []
    expect(projects.length).toBeGreaterThan(0)

    const kickoff = projects.filter(project => project.currentNodeKey === 'kickoff')
    expect(kickoff.length).toBeGreaterThan(0)
    const target = kickoff[0]!
    projectId = Number(target.id)
    record('read.project-list', {
      total: list.data.total ?? projects.length,
      kickoffCount: kickoff.length,
      targetProjectId: projectId,
      targetProjectName: target.name,
    })

    const detail = await callTool<{
      pageType?: string
      projectId?: number
      nodeId?: number
      data: { currentNode?: PmsJsonObject; nodes?: PmsJsonObject[]; members?: unknown[] }
    }>('pms_project_get', { projectId })
    expect(detail.pageType).toBe('project-detail')
    expect(detail.data.currentNode?.nodeKey).toBe('kickoff')
    nodeId = Number(detail.data.currentNode?.id)
    record('read.project-detail', {
      pageType: detail.pageType,
      projectId: detail.projectId,
      resolvedNodeId: detail.nodeId,
      currentNodeKey: detail.data.currentNode?.nodeKey,
      currentNodeId: nodeId,
      nodeCount: detail.data.nodes?.length ?? 0,
      memberCount: detail.data.members?.length ?? 0,
    })

    const tasks = await callTool<{ total?: number; tasks?: PmsJsonObject[] }>('pms_task_list', { projectId, pageSize: 100 })
    record('read.task-list', { projectId, total: tasks.total ?? 0, returned: (tasks.tasks ?? []).length })

    // Bind the live page context (project + node) the way the PMS browser bridge does.
    contextStore.set({
      pageType: 'project-detail',
      route: `/projects/${projectId}`,
      projectId,
      nodeId,
      contextVersion: textValue(detail.data.currentNode?.version) ?? 'v1',
    })
  }, 60_000)

  it('injects the live kickoff contract as a tracked system-prompt section', async () => {
    const assembly = await ctx.systemPrompt.assemble({ signal: new AbortController().signal })
    const contractSection = assembly.sections.find(section => section.name === 'pms:agent-contract')
    expect(contractSection).toBeDefined()
    const text = contractSection?.text ?? ''

    expect(text).toContain('pms-project-assistant/project-kickoff')
    expect(text).toContain('契约版本：1.0.0')
    expect(text).toContain('当前节点：kickoff')
    expect(text).toContain('project.create')
    expect(text).toContain('node.complete')
    expect(text).toContain('确认策略')
    expect(text).toContain('终止条件')

    const state = contextStore.getContract()
    expect(state?.status).toBe('ready')
    expect(state?.contract?.writeCommands).toContain('project.create')

    record('contract.injected', {
      sectionName: contractSection?.name,
      sectionLength: text.length,
      contractId: state?.contract?.contractId,
      contractVersion: state?.contract?.contractVersion,
      contentSha256: state?.contract?.contentSha256,
      loadedAt: state?.loadedAt,
      currentNodeKey: 'kickoff',
      writeCommands: state?.contract?.writeCommands,
      contractSectionPreview: text.split('\n').slice(0, 6),
    })

    // Second assembly must reuse the same contract text (no per-turn refetch churn).
    const second = await ctx.systemPrompt.assemble({ signal: new AbortController().signal })
    expect(second.sections.find(section => section.name === 'pms:agent-contract')?.text).toBe(text)
  }, 60_000)

  it('fails closed when the node contract is not loaded yet', async () => {
    contextStore.clearContract()
    const message = await callToolError('pms_command_preview', {
      command: 'project.create',
      arguments: { name: '联调-契约未加载-不应执行' },
    })
    expect(message).toContain('契约')
    record('contract.fail-closed-preview', { blocked: true, message })

    const assembly = await ctx.systemPrompt.assemble({ signal: new AbortController().signal })
    expect(contextStore.getContract()?.status).toBe('ready')
    expect(assembly.sections.some(section => section.name === 'pms:agent-contract')).toBe(true)
  }, 60_000)

  it('previews, executes and verifies an idempotent write with one refresh signal', async () => {
    const projectName = `立项联调-${new Date().toISOString()}`
    const preview = await callTool<PmsCommandPreview>('pms_command_preview', {
      command: 'project.create',
      arguments: { name: projectName, priority: 1 },
    })
    expect(preview.operationId).toBeTruthy()
    expect(preview.command).toBe('project.create')
    record('write.preview', {
      operationId: preview.operationId,
      command: preview.command,
      warnings: preview.warnings,
      changes: preview.changes,
      expiresAt: preview.expiresAt,
    })

    // The execute tool is gated by the DSH approval channel by design; without a
    // composed approval provider the call is refused before any HTTP request.
    const blocked = await callToolError('pms_command_execute', { operationId: preview.operationId })
    record('write.execute-gate-without-approval', { blocked: true, message: blocked })

    // Execute through the same code path the tool uses after approval.
    const executed = await executePmsOperation(client, contextStore, { operationId: preview.operationId }, {
      signal: new AbortController().signal,
    })
    expect(executed.status).toBe('SUCCEEDED')
    const project = executed.data?.project as PmsJsonObject | undefined
    createdProjectId = Number(project?.id)
    expect(createdProjectId).toBeGreaterThan(0)
    record('write.executed', {
      operationId: preview.operationId,
      status: executed.status,
      message: executed.message,
      createdProjectId,
      createdProjectName: project?.name,
      refreshScopes: executed.refreshScopes,
    })

    // Idempotent retry with the derived key must not create a second project.
    const retried = await executePmsOperation(client, contextStore, { operationId: preview.operationId }, {
      signal: new AbortController().signal,
    })
    expect(retried.status).toBe('SUCCEEDED')
    record('write.idempotent-retry', { operationId: preview.operationId, status: retried.status, message: retried.message })

    const verified = await callTool<{ data: { project?: PmsJsonObject; currentNode?: PmsJsonObject } }>('pms_project_get', {
      projectId: createdProjectId,
    })
    expect(verified.data.project?.name).toBe(projectName)
    record('write.verified', {
      createdProjectId,
      projectName: verified.data.project?.name,
      projectCode: verified.data.project?.code,
      currentNodeKey: verified.data.currentNode?.nodeKey,
    })

    expect(contextStore.getRefresh(sessionId, 0)).toBeUndefined()
    expect(contextStore.getRefresh(undefined, 0)).toBeUndefined()
    const refresh = contextStore.flushRefresh(undefined)
    expect(refresh).toBeDefined()
    record('refresh.batch', {
      revision: refresh?.revision,
      scopes: refresh?.scopes,
      requestId: refresh?.requestId,
      pendingBatchesFlushed: 1,
    })
    expect(contextStore.getRefresh(undefined, refresh?.revision ?? 0)).toBeUndefined()
  }, 90_000)

  it('surfaces PMS validation failures without writing', async () => {
    const invalid = await callToolError('pms_command_preview', {
      command: 'project.create',
      arguments: { name: '联调-非法参数不应写入', unexpectedField: true },
    })
    record('failure.invalid-preview', { blocked: true, message: invalid })

    let unknownOperation: Record<string, unknown> = { blocked: false }
    try {
      const result = await executePmsOperation(client, contextStore, { operationId: 'e2e-not-a-real-operation' }, {
        signal: new AbortController().signal,
      })
      unknownOperation = { blocked: false, status: result.status, message: result.message }
    } catch (error) {
      const failure = error as { message?: string; code?: string | number; status?: number; requestId?: string }
      unknownOperation = {
        blocked: true,
        message: failure.message,
        code: failure.code,
        status: failure.status,
        requestId: failure.requestId,
      }
    }
    expect(unknownOperation.blocked).toBe(true)
    record('failure.unknown-operation', unknownOperation)

    const unauthenticated = await pmsError('/api/integration/dsh/v1/agent-contracts/project_assistant/project-kickoff', {
      headers: { 'X-PMS-AI-Delegation': 'not-a-valid-delegation-token' },
    })
    expect(unauthenticated.status).toBe(401)
    record('failure.unauthenticated-contract', unauthenticated)
  }, 60_000)

  it('requires the PMS completion judgement before completing the kickoff node', async () => {
    // Drop the previous node binding first so the snapshot resolves the new
    // project's own current node instead of the project read in step 1.
    contextStore.set({ pageType: 'project-detail', route: `/projects/${createdProjectId}`, projectId: createdProjectId })
    const detail = await callTool<{ data: { currentNode?: PmsJsonObject } }>('pms_project_get', { projectId: createdProjectId })
    const currentNodeId = Number(detail.data.currentNode?.id)
    expect(detail.data.currentNode?.nodeKey).toBe('kickoff')

    // Move the live PMS page context onto the project created in this run so the
    // completion preview is judged against that project's real node data.
    contextStore.set({
      pageType: 'project-detail',
      route: `/projects/${createdProjectId}`,
      projectId: createdProjectId,
      nodeId: currentNodeId,
      currentNodeKey: 'kickoff',
      contextVersion: 'v1',
    })
    await ctx.systemPrompt.assemble({ signal: new AbortController().signal })

    const outcome = await callToolRaw<PmsCommandPreview>('pms_command_preview', {
      command: 'node.complete',
      arguments: { projectId: createdProjectId, nodeId: currentNodeId },
    })
    const changes = (outcome.value?.changes ?? []) as PmsJsonObject[]
    record('completion.preview', {
      blocked: outcome.isError,
      message: outcome.text,
      changes,
    })

    // Either PMS rejects the completion (criteria unmet) or it returns a real
    // completion preview that a human must still confirm.
    expect(outcome.isError || changes.some(change => change.action === 'complete')).toBe(true)

    // A node that is not the project's current node must never be completable.
    const otherNode = ((await callTool<{ data: { nodes?: PmsJsonObject[] } }>('pms_project_get', {
      projectId: createdProjectId,
    })).data.nodes ?? []).find(node => node.id !== currentNodeId)
    if (otherNode !== undefined) {
      const rejected = await callToolRaw<PmsCommandPreview>('pms_command_preview', {
        command: 'node.complete',
        arguments: { projectId: createdProjectId, nodeId: Number(otherNode.id) },
      })
      record('completion.rejected-other-node', {
        blocked: rejected.isError,
        nodeId: otherNode.id,
        nodeKey: otherNode.nodeKey,
        message: rejected.text,
      })
      expect(rejected.isError).toBe(true)
    }
  }, 60_000)

  it('updates the project description and overall schedule without touching members', async () => {
    const before = await callTool<{ data: { members?: unknown[] } }>('pms_project_get', { projectId: createdProjectId })
    const memberCountBefore = (before.data.members ?? []).length

    const preview = await callTool<PmsCommandPreview>('pms_command_preview', {
      command: 'project.update',
      arguments: {
        projectId: createdProjectId,
        description: '基于当前达模型进行调整',
        endDate: '2026-10-30',
      },
    })
    expect(preview.command).toBe('project.update')
    const change = (preview.changes ?? [])[0] as PmsJsonObject | undefined
    record('project-update.preview', {
      operationId: preview.operationId,
      command: preview.command,
      warnings: preview.warnings,
      changes: preview.changes,
      expiresAt: preview.expiresAt,
    })
    expect(change?.toDescription).toBe('基于当前达模型进行调整')
    expect(change?.toEndDate).toBe('2026-10-30')

    const executed = await executePmsOperation(client, contextStore, { operationId: preview.operationId }, {
      signal: new AbortController().signal,
    })
    expect(executed.status).toBe('SUCCEEDED')

    const verified = await callTool<{
      data: { project?: PmsJsonObject; members?: unknown[] }
    }>('pms_project_get', { projectId: createdProjectId })
    expect(verified.data.project?.description).toBe('基于当前达模型进行调整')
    expect(textValue(verified.data.project?.endDate)).toBe('2026-10-30')
    expect((verified.data.members ?? []).length).toBe(memberCountBefore)
    record('project-update.verified', {
      operationId: preview.operationId,
      status: executed.status,
      message: executed.message,
      description: verified.data.project?.description,
      endDate: verified.data.project?.endDate,
      startDate: verified.data.project?.startDate,
      memberCountBefore,
      memberCountAfter: (verified.data.members ?? []).length,
      refreshScopes: executed.refreshScopes,
    })
  }, 60_000)
})
