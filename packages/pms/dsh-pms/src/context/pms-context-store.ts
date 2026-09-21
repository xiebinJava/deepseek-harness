import type { PmsAgentContractState, PmsContextLocator, PmsRefreshSignal } from '../types.ts'

/** Per-DSH-session PMS locator; it is not a source of business facts. */
export class PmsContextStore {
  private readonly contexts = new Map<string, PmsContextLocator>()
  private readonly refreshes = new Map<string, PmsRefreshSignal>()
  private readonly pendingRefreshes = new Map<string, PendingRefresh>()
  private readonly contracts = new Map<string, PmsAgentContractState>()

  get(sessionId?: string): PmsContextLocator | undefined {
    const current = this.contexts.get(sessionKey(sessionId))
    return current === undefined ? undefined : { ...current }
  }

  set(locator: PmsContextLocator): void
  set(sessionId: string, locator: PmsContextLocator): void
  set(sessionIdOrLocator: string | PmsContextLocator, locator?: PmsContextLocator): void {
    const sessionId = typeof sessionIdOrLocator === 'string' ? sessionIdOrLocator : undefined
    const value = typeof sessionIdOrLocator === 'string' ? locator : sessionIdOrLocator
    if (value === undefined) throw new Error('dsh-pms: PMS context locator is required')
    this.contexts.set(sessionKey(sessionId), { ...value })
  }

  clear(sessionId?: string): void {
    const key = sessionKey(sessionId)
    this.contexts.delete(key)
    this.refreshes.delete(key)
    this.pendingRefreshes.delete(key)
    this.contracts.delete(key)
  }

  getContract(sessionId?: string): PmsAgentContractState | undefined {
    return this.contracts.get(sessionKey(sessionId))
  }

  setContract(sessionId: string | undefined, state: PmsAgentContractState): void {
    this.contracts.set(sessionKey(sessionId), state)
  }

  clearContract(sessionId?: string): void {
    this.contracts.delete(sessionKey(sessionId))
  }

  /** Queue a successful write until the current Agent turn is ready to close. */
  queueRefresh(sessionId: string | undefined, scopes: readonly string[], requestId: string): void {
    const key = sessionKey(sessionId)
    const previous = this.pendingRefreshes.get(key)
    const mergedScopes = new Set(previous?.scopes ?? [])
    for (const scope of scopes) {
      const normalized = scope.trim()
      if (normalized !== '') mergedScopes.add(normalized)
    }
    const requestIds = previous === undefined ? [] : previous.requestIds
    requestIds.push(requestId)
    this.pendingRefreshes.set(key, {
      scopes: [...mergedScopes].slice(0, 32),
      requestIds,
    })
  }

  /** Publish one refresh signal for all successful writes in the current batch. */
  flushRefresh(sessionId?: string): PmsRefreshSignal | undefined {
    const key = sessionKey(sessionId)
    const pending = this.pendingRefreshes.get(key)
    if (pending === undefined) return undefined
    this.pendingRefreshes.delete(key)
    const requestId = pending.requestIds.length === 1
      ? pending.requestIds[0] ?? `pms-refresh-batch-${Date.now()}`
      : `pms-refresh-batch-${Date.now()}`
    return this.requestRefresh(sessionId, pending.scopes, requestId)
  }

  requestRefresh(sessionId: string | undefined, scopes: readonly string[], requestId: string = `pms-refresh-${Date.now()}`): PmsRefreshSignal {
    const key = sessionKey(sessionId)
    const previous = this.refreshes.get(key)
    const signal: PmsRefreshSignal = {
      revision: (previous?.revision ?? 0) + 1,
      requestId,
      scopes: [...new Set(scopes.map(scope => scope.trim()).filter(Boolean))].slice(0, 32),
      requestedAt: Date.now(),
    }
    this.refreshes.set(key, signal)
    return { ...signal, scopes: [...signal.scopes] }
  }

  getRefresh(sessionId?: string, sinceRevision: number = 0): PmsRefreshSignal | undefined {
    const signal = this.refreshes.get(sessionKey(sessionId))
    if (signal === undefined || signal.revision <= sinceRevision) return undefined
    return { ...signal, scopes: [...signal.scopes] }
  }
}

interface PendingRefresh {
  scopes: string[]
  requestIds: string[]
}

const DEFAULT_SESSION_KEY = '__default__'

function sessionKey(sessionId?: string): string {
  const normalized = sessionId?.trim()
  return normalized === undefined || normalized === '' ? DEFAULT_SESSION_KEY : normalized
}
