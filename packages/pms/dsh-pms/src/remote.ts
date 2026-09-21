import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PmsAuthCode, PmsContextLocator, PmsRefreshSignal } from './types.ts'
import { PmsContextStore } from './context/pms-context-store.ts'
import { PmsAuthStore } from './auth/pms-auth-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pmsContextStore: PmsContextStore
    pmsContextController: PmsContextController
    pmsAuthStore: PmsAuthStore
  }
}

/** Host Remote owner for the PMS page-context bridge. */
export class PmsContextController extends TypertRemoteService {
  static inject = ['typert']

  private readonly store: PmsContextStore
  private readonly authStore: PmsAuthStore

  constructor(ctx: Context) {
    super(ctx, 'pmsContextController', { namespace: 'pmsContext' })
    const store = ctx.get('pmsContextStore')
    const authStore = ctx.get('pmsAuthStore')
    if (!store || !authStore) throw new Error('dsh-pms: PMS stores are not available')
    this.store = store
    this.authStore = authStore
  }

  /** Replace the current PMS locator for one DSH conversation session. */
  @Remote('set')
  set(sessionId: SessionId, locator: PmsContextLocator): void {
    this.store.set(sessionId, normalizeLocator(locator))
  }

  /** Remove the PMS locator only for an explicit session/context reset. */
  @Remote('clear')
  clear(sessionId: SessionId): void {
    this.store.clear(sessionId)
  }

  /** Return the newest successful-write signal after the caller's revision. */
  @Remote('getRefresh')
  getRefresh(sessionId: SessionId, sinceRevision: number): PmsRefreshSignal | undefined {
    return this.store.getRefresh(sessionId, sinceRevision)
  }

  /** Replace the latest browser-issued PMS auth code for one DSH session. */
  @Remote('setAuthCode')
  setAuthCode(sessionId: SessionId, authCode: PmsAuthCode): void {
    this.authStore.set(sessionId, normalizeAuthCode(authCode))
  }

  /** Remove the browser-issued PMS auth code when the iframe session changes. */
  @Remote('clearAuthCode')
  clearAuthCode(sessionId: SessionId): void {
    this.authStore.clear(sessionId)
  }
}

function normalizeLocator(locator: PmsContextLocator): PmsContextLocator {
  if (typeof locator !== 'object') throw new Error('dsh-pms: invalid PMS context locator')
  if (typeof locator.pageType !== 'string' || locator.pageType.trim() === '') {
    throw new Error('dsh-pms: PMS context pageType is required')
  }
  if (typeof locator.route !== 'string' || locator.route.trim() === '') {
    throw new Error('dsh-pms: PMS context route is required')
  }
  return {
    pageType: locator.pageType,
    route: locator.route,
    ...(locator.projectId === undefined ? {} : { projectId: locator.projectId }),
    ...(locator.nodeId === undefined ? {} : { nodeId: locator.nodeId }),
    ...(locator.currentNodeKey === undefined ? {} : { currentNodeKey: locator.currentNodeKey }),
    ...(locator.contextVersion === undefined ? {} : { contextVersion: locator.contextVersion }),
  }
}

function normalizeAuthCode(authCode: PmsAuthCode): PmsAuthCode {
  if (typeof authCode !== 'object'
      || typeof authCode.authorizationCode !== 'string'
      || typeof authCode.agentId !== 'string'
      || !Array.isArray(authCode.scopes)
      || typeof authCode.receivedAt !== 'number') {
    throw new Error('dsh-pms: invalid PMS auth code')
  }
  return {
    authorizationCode: authCode.authorizationCode,
    agentId: authCode.agentId,
    scopes: [...authCode.scopes],
    receivedAt: authCode.receivedAt,
  }
}

export default PmsContextController
