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
import { PmsSsoCredentials } from '../src/auth/pms-sso-credentials.ts'
import { PmsIntegrationClient } from '../src/client/PmsIntegrationClient.ts'
import type { PmsCommandPreview, PmsCommandResult, PmsJsonObject } from '../src/types.ts'

const baseUrl = (process.env.PMS_E2E_BASE_URL ?? '').trim().replace(/\/+$/u, '')
const serviceKey = (process.env.PMS_E2E_SERVICE_KEY ?? '').trim()
const userEmail = (process.env.PMS_E2E_USER_EMAIL ?? '').trim()
const userPassword = process.env.PMS_E2E_USER_PASSWORD ?? ''
/**
 * A real Keycloak ID token for the DSH client, when the runner can mint one.
 * Enables the Plan-A path: DSH exchanges its SSO identity for a PMS session
 * instead of bridging a one-time code out of an embedded PMS page.
 */
const ssoIdToken = (process.env.PMS_E2E_ID_TOKEN ?? '').trim()
const ssoSubject = (process.env.PMS_E2E_ID_SUBJECT ?? '').trim()
const ssoExpectEmail = (process.env.PMS_E2E_ID_EMAIL ?? '').trim()
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
  let currentUserId = 0
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
    currentUserId = Number(loginData.user?.id ?? 0)
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

  it('creates the requested project from a session that has no PMS page open', async () => {
    // The launcher case the user hit: no page context, so the entry-node contract
    // must apply and the acting account must be resolvable without asking.
    const capabilities = await client.capabilities(undefined, sessionId)
    const today = capabilities.today ?? ''
    expect(capabilities.viewer?.id).toBe(currentUserId)
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const preview = await callTool<PmsCommandPreview>('pms_command_preview', {
      command: 'project.create',
      arguments: { name: 'AI赋能企业', priority: 3, startDate: today, endDate: '2026-10-31' },
    })
    expect(preview.command).toBe('project.create')

    const executed = await callTool<PmsCommandResult>('pms_command_execute', { operationId: preview.operationId })
    expect(executed.status).toBe('SUCCEEDED')
    const project = executed.data?.project as PmsJsonObject | undefined
    const requestedProjectId = Number(project?.id)
    expect(project?.name).toBe('AI赋能企业')
    expect(Number(project?.priority)).toBe(3)
    expect(project?.startDate).toBe(today)
    expect(project?.endDate).toBe('2026-10-31')
    // "负责人是我": a new project always belongs to the acting account.
    expect(Number(project?.ownerId)).toBe(currentUserId)
    expect(Number(project?.projectManagerId ?? 0)).toBe(0)

    const verified = await callTool<{ data: { project?: PmsJsonObject; currentNode?: PmsJsonObject } }>(
      'pms_project_get', { projectId: requestedProjectId })
    expect(verified.data.currentNode?.nodeKey).toBe('kickoff')
    record('write.project-create-from-launcher', {
      operationId: preview.operationId,
      viewerId: capabilities.viewer?.id,
      today,
      projectId: requestedProjectId,
      projectCode: project?.code,
      ownerId: project?.ownerId,
      priority: project?.priority,
      startDate: project?.startDate,
      endDate: project?.endDate,
    })
  }, 90_000)

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
    expect(text).toContain('契约版本：1.2.0')
    expect(text).toContain('当前节点：kickoff')
    expect(text).toContain('project.create')
    expect(text).toContain('node.complete')
    expect(text).toContain('确认策略')
    expect(text).toContain('终止条件')

    const state = contextStore.getContract()
    expect(state?.status).toBe('ready')
    expect(state?.contract?.writeCommands).toContain('project.create')

    // Every built-in workflow node must publish its own contract, otherwise the
    // Agent can read a node but never write on it.
    const capabilities = await client.capabilities(undefined, sessionId)
    const coveredNodes = (capabilities.agentContracts ?? [])
      .flatMap(contract => contract.workflowNodeKeys)
    expect(coveredNodes).toEqual(expect.arrayContaining([
      'kickoff', 'requirement', 'design', 'plan', 'develop',
      'acceptance', 'release', 'review', 'knowledge',
    ]))

    record('contract.injected', {
      sectionName: contractSection?.name,
      sectionLength: text.length,
      contractId: state?.contract?.contractId,
      contractVersion: state?.contract?.contractVersion,
      contentSha256: state?.contract?.contentSha256,
      loadedAt: state?.loadedAt,
      currentNodeKey: 'kickoff',
      writeCommands: state?.contract?.writeCommands,
      coveredWorkflowNodes: coveredNodes,
      contractSectionPreview: text.split('\n').slice(0, 6),
    })

    // Second assembly must reuse the same contract text (no per-turn refetch churn).
    const second = await ctx.systemPrompt.assemble({ signal: new AbortController().signal })
    expect(second.sections.find(section => section.name === 'pms:agent-contract')?.text).toBe(text)
  }, 60_000)

  it('reloads the node contract on demand instead of blocking the write', async () => {
    // A write tool must not depend on the system prompt having been assembled:
    // clearing the contract state used to block every write with "契约未加载".
    contextStore.clearContract()
    expect(contextStore.getContract()).toBeUndefined()

    const preview = await callTool<PmsCommandPreview>('pms_command_preview', {
      command: 'project.create',
      arguments: { name: '联调-契约按需自愈' },
    })
    expect(preview.operationId).toBeTruthy()
    expect(contextStore.getContract()?.status).toBe('ready')
    record('contract.self-heal-preview', {
      operationId: preview.operationId,
      contractVersion: contextStore.getContract()?.contract?.contractVersion,
      reloaded: true,
    })

    // The reloaded contract still drives the prompt section on the next turn.
    const assembly = await ctx.systemPrompt.assemble({ signal: new AbortController().signal })
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

    // Writes run straight through the tool now: the caller holds the account's
    // own write authority, so no approval channel and no extra confirmation.
    const executed = await callTool<PmsCommandResult>('pms_command_execute', { operationId: preview.operationId })
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

  it('fills the kickoff person fields on the new project through the assistant commands', async () => {
    contextStore.set({
      pageType: 'project-detail',
      route: `/projects/${createdProjectId}`,
      projectId: createdProjectId,
      currentNodeKey: 'kickoff',
      contextVersion: 'v1',
    })

    const people = await callTool<{ id: number; displayName?: string }[]>('pms_people_list', {
      keyword: userEmail,
      limit: 20,
    })
    expect(people.length).toBeGreaterThan(0)
    const assigneeId = Number(people[0]?.id ?? 0)
    expect(assigneeId).toBeGreaterThan(0)
    expect(people.map(person => Number(person.id))).toContain(currentUserId)
    record('read.people-list', { keyword: userEmail, returned: people.length, assigneeId })

    const managerPreview = await callTool<PmsCommandPreview>('pms_command_preview', {
      command: 'project.update',
      arguments: { projectId: createdProjectId, projectManagerId: assigneeId },
    })
    const managerResult = await callTool<PmsCommandResult>('pms_command_execute', {
      operationId: managerPreview.operationId,
    })
    expect(managerResult.status).toBe('SUCCEEDED')

    const withManager = await callTool<{ data: { project?: PmsJsonObject } }>('pms_project_get', {
      projectId: createdProjectId,
    })
    expect(Number(withManager.data.project?.projectManagerId)).toBe(assigneeId)
    record('write.project-manager', {
      operationId: managerPreview.operationId,
      assigneeId,
      projectManagerId: withManager.data.project?.projectManagerId,
      projectManagerName: withManager.data.project?.projectManagerName,
    })

    const followerAdd = await callTool<PmsCommandPreview>('pms_command_preview', {
      command: 'follower.add',
      arguments: { projectId: createdProjectId, userId: assigneeId },
    })
    expect((await callTool<PmsCommandResult>('pms_command_execute', {
      operationId: followerAdd.operationId,
    })).status).toBe('SUCCEEDED')

    const withFollower = await callTool<{ data: { followers?: { id?: number }[] } }>('pms_project_get', {
      projectId: createdProjectId,
    })
    expect((withFollower.data.followers ?? []).map(item => Number(item.id))).toContain(assigneeId)
    record('write.follower-add', { operationId: followerAdd.operationId, assigneeId })

    const followerRemove = await callTool<PmsCommandPreview>('pms_command_preview', {
      command: 'follower.remove',
      arguments: { projectId: createdProjectId, userId: assigneeId },
    })
    expect((await callTool<PmsCommandResult>('pms_command_execute', {
      operationId: followerRemove.operationId,
    })).status).toBe('SUCCEEDED')

    const withoutFollower = await callTool<{ data: { followers?: { id?: number }[] } }>('pms_project_get', {
      projectId: createdProjectId,
    })
    expect((withoutFollower.data.followers ?? []).map(item => Number(item.id))).not.toContain(assigneeId)
    record('write.follower-remove', { operationId: followerRemove.operationId, assigneeId })
  }, 90_000)

  it('writes a node workbench field through one command', async () => {
    const detail = await callTool<{ data: { currentNode?: PmsJsonObject; nodes?: PmsJsonObject[] } }>(
      'pms_project_get', { projectId: createdProjectId })
    const releaseNode = (detail.data.nodes ?? []).find(node => node.nodeKey === 'release')
    expect(releaseNode).toBeDefined()
    const releaseNodeId = Number(releaseNode?.id)

    const preview = await callTool<PmsCommandPreview>('pms_command_preview', {
      command: 'node.field.update',
      arguments: {
        projectId: createdProjectId,
        nodeId: releaseNodeId,
        workbench: 'release-handover',
        fields: { releaseVersion: 'v9.9.9', handoverNotes: 'E2E 运维交接说明' },
      },
    })
    expect(preview.command).toBe('node.field.update')
    expect(JSON.stringify(preview.changes)).toContain('交接说明')

    const executed = await callTool<PmsCommandResult>('pms_command_execute', { operationId: preview.operationId })
    expect(executed.status).toBe('SUCCEEDED')
    const document = executed.data?.document as PmsJsonObject | undefined
    expect(document?.releaseVersion).toBe('v9.9.9')
    expect(document?.handoverNotes).toBe('E2E 运维交接说明')

    // Independent verification through the ordinary PMS REST endpoint.
    const stored = await pmsJson(`/api/projects/${createdProjectId}/nodes/${releaseNodeId}/release`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    const storedData = stored.data as { releaseVersion?: string; handoverNotes?: string }
    expect(storedData.releaseVersion).toBe('v9.9.9')
    expect(storedData.handoverNotes).toBe('E2E 运维交接说明')
    record('write.node-field', {
      operationId: preview.operationId,
      releaseNodeId,
      releaseVersion: storedData.releaseVersion,
      handoverNotes: storedData.handoverNotes,
    })

    // A nested workbench document (方案设计) must merge field by field: patching
    // one field may not clear the sibling field it cannot read back.
    const designNode = (detail.data.nodes ?? []).find(node => node.nodeKey === 'design')
    expect(designNode).toBeDefined()
    const designNodeId = Number(designNode?.id)
    const writeDesign = async (fields: PmsJsonObject): Promise<PmsCommandResult> => {
      const designPreview = await callTool<PmsCommandPreview>('pms_command_preview', {
        command: 'node.field.update',
        arguments: { projectId: createdProjectId, nodeId: designNodeId, workbench: 'solution-design', fields },
      })
      return callTool<PmsCommandResult>('pms_command_execute', { operationId: designPreview.operationId })
    }
    await writeDesign({ productSolution: 'E2E 产品方案', technicalSolution: 'E2E 技术方案' })
    const patched = await writeDesign({ productSolution: 'E2E 产品方案 v2' })
    const designDocument = patched.data?.document as PmsJsonObject | undefined
    const patchedPackage = designDocument?.solutionPackage as { technicalSolution?: string } | undefined
    expect(patchedPackage?.technicalSolution).toBe('E2E 技术方案')

    const storedDesign = await pmsJson(`/api/projects/${createdProjectId}/nodes/${designNodeId}/solution-design`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    const storedPackage = (storedDesign.data as { solutionPackage?: { productSolution?: string; technicalSolution?: string } })
      .solutionPackage
    expect(storedPackage?.productSolution).toBe('E2E 产品方案 v2')
    expect(storedPackage?.technicalSolution).toBe('E2E 技术方案')
    record('write.node-field-nested', {
      designNodeId,
      productSolution: storedPackage?.productSolution,
      technicalSolution: storedPackage?.technicalSolution,
    })
  }, 90_000)

  it('batch-creates several tasks in one preview and one execution', async () => {
    const detail = await callTool<{ data: { currentNode?: PmsJsonObject } }>('pms_project_get', {
      projectId: createdProjectId,
    })
    const kickoffNodeId = Number(detail.data.currentNode?.id)
    expect(kickoffNodeId).toBeGreaterThan(0)

    const titles = ['E2E 批量任务 A', 'E2E 批量任务 B', 'E2E 批量任务 C']
    const preview = await callTool<PmsCommandPreview>('pms_command_preview', {
      command: 'batch.write',
      arguments: {
        operations: titles.map(title => ({
          command: 'task.create',
          arguments: { projectId: createdProjectId, nodeId: kickoffNodeId, title },
        })),
      },
    })
    expect(preview.command).toBe('batch.write')
    const batchChange = (preview.changes ?? [])[0] as PmsJsonObject
    expect(batchChange.itemCount).toBe(titles.length)

    const executed = await callTool<PmsCommandResult>('pms_command_execute', { operationId: preview.operationId })
    expect(executed.status).toBe('SUCCEEDED')
    expect(Number(executed.data?.itemCount)).toBe(titles.length)

    const tasks = await callTool<{ total?: number; tasks?: PmsJsonObject[] }>(
      'pms_task_list', { projectId: createdProjectId, pageSize: 100 })
    const created = (tasks.tasks ?? []).filter(task => titles.includes(String(task.title)))
    expect(created).toHaveLength(titles.length)
    record('write.batch-create', {
      operationId: preview.operationId,
      requested: titles.length,
      created: created.length,
      taskIds: created.map(task => task.id),
    })
  }, 120_000)

  it.skipIf(ssoIdToken === '')('signs in through SSO without the browser bridge', async () => {
    const credentials = new PmsSsoCredentials({
      baseUrl,
      apiPrefix: '/api',
      serviceKey,
      identity: {
        idToken: () => ssoIdToken,
        identity: () => ({ subject: ssoSubject === '' ? 'unknown' : ssoSubject, email: ssoExpectEmail }),
      },
    })

    const ssoClient = new PmsIntegrationClient({
      baseUrl,
      apiPrefix: '/api',
      serviceKey,
      dshSessionId: `${sessionId}-sso`,
      agentId: 'project_assistant',
      workspaceType: 'pms',
      requestTimeoutMs: 20_000,
      credentials,
    })

    const list = await ssoClient.projects({ pageSize: 5 })
    expect(list.pageType).toBe('project-list')
    const accessToken = await credentials.accessToken()
    expect(accessToken).toBeTruthy()

    // The very same token must resolve to the SSO person on PMS itself.
    const identity = await pmsJson('/api/auth/me', {
      headers: { Authorization: `Bearer ${accessToken ?? ''}` },
    })
    const me = identity.data as { email?: string; username?: string }
    expect(me.email).toBe(ssoExpectEmail)
    record('sso.session', {
      subject: ssoSubject,
      email: me.email,
      username: me.username,
      persistent: credentials.persistent,
      accessTokenLength: (accessToken ?? '').length,
    })

    // Logging out of PMS must invalidate the held session, and the assistant
    // must stay signed out instead of silently minting a replacement.
    await pmsJson('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken ?? ''}` },
    })
    await expect(ssoClient.projects({ pageSize: 5 })).rejects.toThrow(/登录态|授权/)
    await expect(credentials.accessToken()).resolves.toBeUndefined()
    record('sso.logout-invalidates', { invalidated: true, replacementBlocked: true })
  }, 60_000)

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
