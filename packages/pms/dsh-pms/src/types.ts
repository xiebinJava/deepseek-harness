/** Stable PMS integration envelope returned by the PMS backend. */
export interface PmsApiEnvelope<T> {
  code: number
  msg?: string
  message?: string
  data?: T
  requestId?: string
}

export interface PmsCapabilities {
  version: string
  tools: string[]
  scopes: string[]
  pageTypes: string[]
  queries?: PmsQueryCapability[]
  commands?: PmsCommandCapability[]
  agentContracts?: PmsAgentContractCapability[]
  /** The account this delegation acts as, published so "我" needs no lookup. */
  viewer?: PmsViewer
  /** PMS business date (yyyy-MM-dd), so "今天/本月底" do not rely on the host clock. */
  today?: string
}

export interface PmsViewer {
  id: number
  displayName?: string
  username?: string
  email?: string
}

export interface PmsAgentContractCapability {
  agentId: string
  contractKey: string
  workflowNodeKeys: string[]
  contractVersion: string
  endpoint: string
  scope: string
  required: boolean
}

export interface PmsAgentContract extends PmsJsonObject {
  contractId: string
  agentId: string
  contractKey: string
  workflowNodeKeys: string[]
  contractVersion: string
  required: boolean
  locale: string
  principalRole: string
  specializedAgents: string[]
  readCapabilities: string[]
  readToolBindings: PmsJsonObject
  writeCommands: string[]
  confirmationPolicies: PmsJsonObject
  entryConditions: string[]
  inputs: string[]
  missingInputRules: string[]
  executionSteps: string[]
  completionCriteria: string[]
  failureStrategies: string[]
  terminationConditions: string[]
  contentSha256: string
}

export interface PmsQueryCapability {
  resource: string
  description: string
  fields: string[]
  filters: string[]
  scopes: string[]
  maxPageSize: number
}

export interface PmsCommandCapability {
  name: string
  description: string
  access: 'read' | 'write'
  risk: 'low' | 'medium' | 'high'
  requiresConfirmation: boolean
  scopes: string[]
  parameters: PmsJsonObject
  supportsPreview: boolean
  supportsExecute: boolean
  refreshScopes: string[]
}

export interface PmsCommandPreviewRequest {
  name: string
  arguments: PmsJsonObject
  contextId: string
  contextVersion: string
  contractId?: string
  contractVersion?: string
}

export interface PmsCommandPreview extends PmsJsonObject {
  operationId: string
  command: string
  expiresAt?: string
  contextVersion?: string
  warnings?: PmsJson[]
  changes?: PmsJson[]
  refreshScopes?: PmsJson[]
}

export interface PmsCommandResult extends PmsJsonObject {
  operationId: string
  status: string
  message?: string
  data?: PmsJsonObject
  refreshScopes?: PmsJson[]
}

export interface PmsOperationBinding {
  contextId: string
  contextVersion: string
  contractId: string
  contractVersion: string
}

/** Host-side signal consumed by the DSH PMS iframe after a successful write. */
export interface PmsRefreshSignal {
  revision: number
  requestId: string
  scopes: string[]
  requestedAt: number
}

export interface PmsQueryRequest {
  resource: 'projects' | 'tasks' | string
  filters?: PmsJsonObject
  fields?: string[]
  page?: number
  pageSize?: number
}

export interface PmsQueryResult extends PmsJsonObject {
  resource: string
  authoritative: boolean
  capturedAt?: string
  data: PmsJsonObject
  pagination?: PmsJsonObject
}

export interface PmsContextSnapshot extends PmsJsonObject {
  contextId: string
  pageType: string
  route: string
  projectId?: number | null
  nodeId?: number | null
  capturedAt: string
  version: string
  data: PmsJsonObject
}

export interface PmsProjectListQuery {
  page?: number
  pageSize?: number
  keyword?: string
  status?: number
  view?: string
  orgUnitId?: number
  projectManagerId?: number
  projectLevel?: number
  priority?: number
  attention?: string
  currentNodeKey?: string
}

export interface PmsTaskListQuery {
  projectId?: number
  nodeId?: number
  due?: string
  status?: string
  page?: number
  pageSize?: number
}

/** Directory lookup used to turn a person's name into the account id a write needs. */
export interface PmsPeopleQuery {
  keyword?: string | undefined
  limit?: number | undefined
}

export interface PmsContextLocator {
  pageType: string
  route?: string
  projectId?: number
  nodeId?: number
  currentNodeKey?: string
  contextVersion?: string
}

export interface PmsAgentContractState {
  status: 'ready' | 'unavailable'
  contract?: PmsAgentContract
  loadedAt?: string
  errorCode?: string
  errorMessage?: string
}

export type PmsJson = null | boolean | number | string | PmsJson[] | PmsJsonObject
export type PmsJsonObject = { [key: string]: PmsJson }

/** Browser-issued, one-time PMS authorization code held by one DSH session. */
export interface PmsAuthCode {
  authorizationCode: string
  agentId: string
  scopes: string[]
  receivedAt: number
}
