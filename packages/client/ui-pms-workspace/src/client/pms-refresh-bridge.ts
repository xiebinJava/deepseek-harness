export const PMS_REFRESH_MESSAGE_SOURCE = 'dsh'
export const PMS_REFRESH_REQUEST_MESSAGE = 'pms.refresh.request'
export const PMS_REFRESH_MESSAGE_VERSION = 1

export interface PmsRefreshSignal {
  readonly revision: number
  readonly requestId: string
  readonly scopes: string[]
  readonly requestedAt: number
}

export interface PmsRefreshRequest {
  readonly source: typeof PMS_REFRESH_MESSAGE_SOURCE
  readonly type: typeof PMS_REFRESH_REQUEST_MESSAGE
  readonly version: typeof PMS_REFRESH_MESSAGE_VERSION
  readonly requestId: string
  readonly scopes: string[]
}

export function createPmsRefreshRequest(requestId: string, scopes: readonly string[]): PmsRefreshRequest {
  return {
    source: PMS_REFRESH_MESSAGE_SOURCE,
    type: PMS_REFRESH_REQUEST_MESSAGE,
    version: PMS_REFRESH_MESSAGE_VERSION,
    requestId,
    scopes: normalizeScopes(scopes),
  }
}

export function parsePmsRefreshMessage(value: unknown): PmsRefreshRequest | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const message = value as Record<string, unknown>
  if (message.source !== PMS_REFRESH_MESSAGE_SOURCE
    || message.type !== PMS_REFRESH_REQUEST_MESSAGE
    || message.version !== PMS_REFRESH_MESSAGE_VERSION
    || typeof message.requestId !== 'string'
    || message.requestId.length === 0
    || message.requestId.length > 128
    || !Array.isArray(message.scopes)
    || message.scopes.length > 32) return undefined
  if (!message.scopes.every(scope => typeof scope === 'string' && scope.length > 0 && scope.length <= 128)) return undefined
  return {
    source: PMS_REFRESH_MESSAGE_SOURCE,
    type: PMS_REFRESH_REQUEST_MESSAGE,
    version: PMS_REFRESH_MESSAGE_VERSION,
    requestId: message.requestId,
    scopes: [...message.scopes] as string[],
  }
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes
    .filter(scope => typeof scope === 'string')
    .map(scope => scope.trim())
    .filter(Boolean))].slice(0, 32)
}
