import z from '@deepseek-ai/schemastery'

export const DEFAULT_PMS_BASE_URL = 'http://127.0.0.1:8080'
export const DEFAULT_PMS_API_PREFIX = '/api'
export const DEFAULT_PMS_TIMEOUT_MS = 10_000

/** Where the plugin participates in the DSH composition. */
export type PmsRuntimeMode = 'full' | 'host' | 'agent'

export interface Config {
  /**
   * `host` keeps the shared context/auth bridge only, `agent` contributes
   * PMS tools and prompt text to one mounted Agent, and `full` preserves the
   * legacy all-in-one behavior for existing deployments.
   */
  mode?: PmsRuntimeMode
  /** PMS origin, without the `/api` application context. */
  baseUrl?: string
  /** PMS application context, normally `/api`. */
  apiPrefix?: string
  /** Short-lived PMS delegation token. Never put a long-lived admin token here. */
  accessToken?: string
  /** PMS user access token used only by the server-side DSH token exchange. */
  pmsUserToken?: string
  /** Server-to-server key shared by DSH and PMS. Never expose this to the browser. */
  serviceKey?: string
  /** DSH session identifier sent to PMS for audit and token binding. */
  dshSessionId?: string
  /** Agent identifier sent to PMS for audit and policy decisions. */
  agentId?: string
  /** Tool names this Agent is allowed to mount; omitted only for legacy full mode. */
  tools?: string[]
  /** Allow the explicitly configured legacy server-side user-token exchange. */
  allowLegacyUserTokenExchange?: boolean
  /** Immutable composition identity sent to PMS for audit correlation. */
  agentVersion?: string
  /** Active business workspace sent to PMS for audit correlation. */
  workspaceType?: string
  /** Cooperative deadline for one PMS request. */
  requestTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  mode: z.union(['full', 'host', 'agent'] as const).default('full'),
  baseUrl: z.string().default(DEFAULT_PMS_BASE_URL),
  apiPrefix: z.string().default(DEFAULT_PMS_API_PREFIX),
  accessToken: z.string().default(''),
  pmsUserToken: z.string().default(''),
  serviceKey: z.string().default(''),
  dshSessionId: z.string().default(''),
  agentId: z.string().default('project_assistant'),
  tools: z.array(z.string()).default([]),
  allowLegacyUserTokenExchange: z.boolean().default(false),
  agentVersion: z.string().default(''),
  workspaceType: z.string().default('pms'),
  requestTimeoutMs: z.number().default(DEFAULT_PMS_TIMEOUT_MS),
})

export type ResolvedConfig = Required<Config>

export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = {
    mode: config.mode ?? 'full' as PmsRuntimeMode,
    baseUrl: config.baseUrl ?? DEFAULT_PMS_BASE_URL,
    apiPrefix: config.apiPrefix ?? DEFAULT_PMS_API_PREFIX,
    accessToken: config.accessToken ?? '',
    pmsUserToken: config.pmsUserToken ?? '',
    serviceKey: config.serviceKey ?? '',
    dshSessionId: config.dshSessionId ?? '',
    agentId: config.agentId ?? 'project_assistant',
    tools: config.tools ?? [],
    allowLegacyUserTokenExchange: config.allowLegacyUserTokenExchange ?? false,
    agentVersion: config.agentVersion ?? '',
    workspaceType: config.workspaceType ?? 'pms',
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_PMS_TIMEOUT_MS,
  }
  if (resolved.baseUrl.trim() === '') throw new Error('dsh-pms: baseUrl must not be blank')
  if (!resolved.apiPrefix.startsWith('/')) throw new Error('dsh-pms: apiPrefix must start with /')
  if (resolved.accessToken.trim() === '' && resolved.pmsUserToken.trim() !== '' && resolved.serviceKey.trim() === '') {
    throw new Error('dsh-pms: serviceKey is required when pmsUserToken is configured')
  }
  if (resolved.accessToken.trim() === '' && resolved.pmsUserToken.trim() !== '' && resolved.dshSessionId.trim() === '') {
    throw new Error('dsh-pms: dshSessionId is required when pmsUserToken is configured')
  }
  if (resolved.accessToken.trim() === '' && resolved.pmsUserToken.trim() !== '' && resolved.agentId.trim() === '') {
    throw new Error('dsh-pms: agentId must not be blank when pmsUserToken is configured')
  }
  if (!Number.isInteger(resolved.requestTimeoutMs) || resolved.requestTimeoutMs < 1) {
    throw new Error('dsh-pms: requestTimeoutMs must be a positive integer')
  }
  return resolved
}
