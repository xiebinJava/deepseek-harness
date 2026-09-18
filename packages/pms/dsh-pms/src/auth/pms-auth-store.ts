import type { PmsAuthCode } from '../types.ts'

export type { PmsAuthCode } from '../types.ts'

export interface PmsAuthCodeWaitOptions {
  timeoutMs: number
  signal?: AbortSignal
}

/** In-memory, per-DSH-session holder for the latest PMS one-time auth code. */
export class PmsAuthStore {
  private readonly authCodes = new Map<string, PmsAuthCode>()
  private readonly listeners = new Map<string, Set<(value: PmsAuthCode) => void>>()

  get(sessionId?: string): PmsAuthCode | undefined {
    const value = this.authCodes.get(sessionKey(sessionId))
    return value === undefined ? undefined : { ...value, scopes: [...value.scopes] }
  }

  /** Return a defensive copy of the scopes granted to one DSH session. */
  scopes(sessionId?: string): string[] | undefined {
    const value = this.get(sessionId)
    return value === undefined ? undefined : [...value.scopes]
  }

  /** Check a scope without exposing the stored authorization-code record. */
  hasScope(sessionId: string | undefined, scope: string): boolean {
    return this.scopes(sessionId)?.includes(scope) ?? false
  }

  set(sessionId: string, value: PmsAuthCode): void {
    const normalizedSessionId = sessionKey(sessionId)
    if (normalizedSessionId === DEFAULT_SESSION_KEY) throw new Error('dsh-pms: auth sessionId is required')
    if (value.authorizationCode.trim() === '') throw new Error('dsh-pms: authorizationCode is required')
    const normalizedValue = { ...value, scopes: [...value.scopes] }
    this.authCodes.set(normalizedSessionId, normalizedValue)
    for (const listener of this.listeners.get(normalizedSessionId) ?? []) listener({ ...normalizedValue, scopes: [...normalizedValue.scopes] })
  }

  clear(sessionId?: string): void {
    this.authCodes.delete(sessionKey(sessionId))
  }

  /** Wait for the browser bridge to publish a newer one-time code. */
  waitForNewer(
    sessionId: string,
    receivedAt: number,
    options: PmsAuthCodeWaitOptions,
  ): Promise<PmsAuthCode | undefined> {
    const normalizedSessionId = sessionKey(sessionId)
    if (normalizedSessionId === DEFAULT_SESSION_KEY) return Promise.resolve(undefined)
    const current = this.get(normalizedSessionId)
    if (current !== undefined && current.receivedAt > receivedAt) return Promise.resolve(current)
    if (options.signal?.aborted) return Promise.resolve(undefined)

    return new Promise((resolve) => {
      let settled = false
      const listeners = this.listeners.get(normalizedSessionId) ?? new Set<(value: PmsAuthCode) => void>()
      this.listeners.set(normalizedSessionId, listeners)
      const finish = (value: PmsAuthCode | undefined): void => {
        if (settled) return
        settled = true
        listeners.delete(onValue)
        if (listeners.size === 0) this.listeners.delete(normalizedSessionId)
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        resolve(value === undefined ? undefined : { ...value, scopes: [...value.scopes] })
      }
      const onValue = (value: PmsAuthCode): void => {
        if (value.receivedAt > receivedAt) finish(value)
      }
      const onAbort = (): void => finish(undefined)
      const timer = setTimeout(() => finish(undefined), Math.max(0, options.timeoutMs))
      listeners.add(onValue)
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

const DEFAULT_SESSION_KEY = '__default__'

function sessionKey(sessionId?: string): string {
  const normalized = sessionId?.trim()
  return normalized === undefined || normalized === '' ? DEFAULT_SESSION_KEY : normalized
}
