export const DSH_AUTH_MESSAGE_SOURCE = 'dsh'
export const PMS_AUTH_MESSAGE_SOURCE = 'pms'
export const DSH_AUTH_REQUEST_MESSAGE = 'pms.dsh.auth.request'
export const PMS_AUTH_SYNC_MESSAGE = 'pms.dsh.auth.sync'
export const DSH_AUTH_MESSAGE_VERSION = 1
export const DSH_AUTH_AGENT_ID = 'project_assistant'
export const DSH_AUTH_SCOPES = [
  'pms:project:read', 'pms:task:read', 'pms:query:read',
  'pms:task:write', 'pms:command:preview', 'pms:command:execute',
  'pms:workflow:write',
  'pms:project:write',
  'pms:workspace:embed',
] as const
/** Keep the browser-issued one-time code fresh before its 90-second TTL. */
export const PMS_AUTH_RENEWAL_INTERVAL_MS = 60_000

export interface PmsAuthCodePayload {
  readonly authorizationCode: string
  readonly expiresInSeconds: number
  readonly agentId: string
  readonly scopes: string[]
}

export interface PmsAuthCodeRecord {
  readonly authorizationCode: string
  readonly agentId: string
  readonly scopes: string[]
  readonly receivedAt: number
}

/** Keep transport-only expiry metadata out of the strict host remote payload. */
export function createPmsAuthCodeRecord(payload: PmsAuthCodePayload, receivedAt: number): PmsAuthCodeRecord {
  return {
    authorizationCode: payload.authorizationCode,
    agentId: payload.agentId,
    scopes: [...payload.scopes],
    receivedAt,
  }
}

export function createDshAuthRequest(requestId: string, dshSessionId: string): Record<string, unknown> {
  return {
    source: DSH_AUTH_MESSAGE_SOURCE,
    type: DSH_AUTH_REQUEST_MESSAGE,
    version: DSH_AUTH_MESSAGE_VERSION,
    requestId,
    dshSessionId,
    agentId: DSH_AUTH_AGENT_ID,
    scopes: [...DSH_AUTH_SCOPES],
  }
}

export function parsePmsAuthMessage(value: unknown, expectedRequestId: string): PmsAuthCodePayload | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const message = value as Record<string, unknown>
  if (message.source !== PMS_AUTH_MESSAGE_SOURCE
    || message.type !== PMS_AUTH_SYNC_MESSAGE
    || message.version !== DSH_AUTH_MESSAGE_VERSION
    || message.requestId !== expectedRequestId) return undefined
  if (typeof message.authorizationCode !== 'string'
    || message.authorizationCode.trim() === ''
    || message.authorizationCode.length > 512) return undefined
  if (typeof message.expiresInSeconds !== 'number'
    || !Number.isInteger(message.expiresInSeconds)
    || message.expiresInSeconds < 1
    || message.expiresInSeconds > 300) return undefined
  if (typeof message.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(message.agentId)) return undefined
  if (!Array.isArray(message.scopes) || message.scopes.length === 0) return undefined
  const scopes = message.scopes.filter((scope): scope is string => typeof scope === 'string' && scope.length <= 128)
  if (scopes.length !== message.scopes.length) return undefined
  return {
    authorizationCode: message.authorizationCode,
    expiresInSeconds: message.expiresInSeconds,
    agentId: message.agentId,
    scopes,
  }
}

export function createDshAuthRequestId(): string {
  return `pms-auth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
