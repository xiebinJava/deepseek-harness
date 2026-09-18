import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { SessionId, type SessionId as SessionIdValue } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { resolvePmsWorkspaceUrl } from './workspace-url.ts'
import {
  PMS_CONTEXT_MESSAGE_SOURCE,
  PMS_CONTEXT_MESSAGE_VERSION,
  PMS_CONTEXT_REQUEST_MESSAGE,
  parsePmsContextMessage,
  createPmsWorkspaceLocator,
  resolvePmsWorkspaceOrigin,
  type PmsContextLocator,
} from './pms-context-bridge.ts'
import {
  createDshAuthRequest,
  createDshAuthRequestId,
  createPmsAuthCodeRecord,
  PMS_AUTH_RENEWAL_INTERVAL_MS,
  parsePmsAuthMessage,
  type PmsAuthCodeRecord,
} from './pms-auth-bridge.ts'
import { createPmsRefreshRequest, type PmsRefreshSignal } from './pms-refresh-bridge.ts'
import css from './PmsWorkspace.module.css'

export type PmsWorkspaceProps = PropsRuntime<'sidebar.right.pane.tab'>
export interface PmsContextBridge {
  set(sessionId: SessionIdValue, locator: PmsContextLocator): Promise<unknown> | void
  clear(sessionId: SessionIdValue): Promise<unknown> | void
  setAuthCode(sessionId: SessionIdValue, authCode: PmsAuthCodeRecord): Promise<unknown> | void
  clearAuthCode(sessionId: SessionIdValue): Promise<unknown> | void
  getRefresh(sessionId: SessionIdValue, sinceRevision: number): Promise<unknown> | unknown
}

/** Real PMS frontend embedded in DSH; no PMS token is placed in the URL. */
export function PmsWorkspace({ useTabInfo, sessionId, bridge }: PmsWorkspaceProps & { bridge: PmsContextBridge }): ReactNode {
  const { tab } = useTabInfo()
  const src = resolvePmsWorkspaceUrl()
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const frame = frameRef.current
    const expectedOrigin = resolvePmsWorkspaceOrigin(src)
    const initialLocator = createPmsWorkspaceLocator(src)
    let authRequestId = ''
    let authReceived = false
    let frameReady = false
    let lastRefreshRevision = 0
    let pendingRefresh: PmsRefreshSignal | undefined
    const authRetryTimers: number[] = []
    let refreshTimer: number | undefined
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frame?.contentWindow || expectedOrigin === '' || event.origin !== expectedOrigin) return
      const locator = parsePmsContextMessage(event.data)
      if (locator !== undefined) {
        void settleRemoteCall(bridge.set(SessionId(sessionId), locator), 'pmsContext/set')
        return
      }
      const authCode = parsePmsAuthMessage(event.data, authRequestId)
      if (authCode === undefined) return
      authReceived = true
      for (const timer of authRetryTimers) window.clearTimeout(timer)
      void settleRemoteCall(
        bridge.setAuthCode(SessionId(sessionId), createPmsAuthCodeRecord(authCode, Date.now())),
        'pmsContext/setAuthCode',
      )
    }
    const requestContext = (): void => {
      frame?.contentWindow?.postMessage({
        source: PMS_CONTEXT_MESSAGE_SOURCE,
        type: PMS_CONTEXT_REQUEST_MESSAGE,
        version: PMS_CONTEXT_MESSAGE_VERSION,
      }, expectedOrigin || '*')
    }
    const requestAuth = (): void => {
      authRequestId = createDshAuthRequestId()
      frame?.contentWindow?.postMessage(createDshAuthRequest(authRequestId, SessionId(sessionId)), expectedOrigin)
    }
    const sendRefresh = (signal: PmsRefreshSignal): void => {
      if (!frameReady) {
        pendingRefresh = signal
        return
      }
      frame?.contentWindow?.postMessage(
        createPmsRefreshRequest(signal.requestId, signal.scopes),
        expectedOrigin || '*',
      )
      lastRefreshRevision = signal.revision
      pendingRefresh = undefined
    }
    const pollRefresh = async (): Promise<void> => {
      try {
        const result = await bridge.getRefresh(SessionId(sessionId), lastRefreshRevision)
        const signal = readRefreshSignal(result)
        if (signal !== undefined && signal.revision > lastRefreshRevision) sendRefresh(signal)
      } catch (error) {
        console.error(`[ui-pms-workspace] pmsContext/getRefresh threw: ${error instanceof Error ? error.message : 'unknown error'}`)
      } finally {
        refreshTimer = window.setTimeout(() => { void pollRefresh() }, 500)
      }
    }
    const onFrameLoad = (): void => {
      frameReady = true
      requestContext()
      requestAuth()
      if (pendingRefresh !== undefined) sendRefresh(pendingRefresh)
    }
    const requestInitialAuthRetry = (): void => {
      if (!authReceived) requestAuth()
    }
    window.addEventListener('message', onMessage)
    frame?.addEventListener('load', onFrameLoad)
    // `authReceived` only controls the short first-load retries. Renewal must
    // continue after the first code arrives, otherwise the one-time code can
    // expire while the PMS panel stays open and the next tool call fails.
    const authTimer = window.setInterval(requestAuth, PMS_AUTH_RENEWAL_INTERVAL_MS)
    void settleRemoteCall(bridge.set(SessionId(sessionId), initialLocator), 'pmsContext/set')
    requestContext()
    requestAuth()
    void pollRefresh()
    for (const delay of [250, 1_000]) {
      authRetryTimers.push(window.setTimeout(requestInitialAuthRetry, delay))
    }
    return () => {
      window.removeEventListener('message', onMessage)
      frame?.removeEventListener('load', onFrameLoad)
      window.clearInterval(authTimer)
      for (const timer of authRetryTimers) window.clearTimeout(timer)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      // Closing or collapsing the PMS pane only unmounts the view. Keep the
      // locator on the DSH session so the next turn remains PMS-associated;
      // an explicit session reset is responsible for removing that binding.
      void settleRemoteCall(bridge.clearAuthCode(SessionId(sessionId)), 'pmsContext/clearAuthCode')
    }
  }, [bridge, sessionId, src])

  return (
    <div className={css.root} data-pms-workspace data-pms-tab={tab.id}>
      <iframe
        ref={frameRef}
        className={css.frame}
        src={src}
        title="PMS 业务工作区"
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin"
        data-pms-workspace-frame
      />
    </div>
  )
}

/**
 * Remote calls fold transport and Host failures into `{ ok: false }` instead
 * of rejecting. Surface those failures so a broken PMS bridge is diagnosable;
 * the message never includes the authorization code itself.
 */
async function settleRemoteCall(value: Promise<unknown> | void, endpoint: string): Promise<void> {
  try {
    const result = await value
    if (isFailedRemoteResult(result)) {
      const message = result.error instanceof Error ? result.error.message : 'remote failure'
      console.error(`[ui-pms-workspace] ${endpoint} failed: ${message}`)
    }
  } catch (error) {
    console.error(`[ui-pms-workspace] ${endpoint} threw: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

function isFailedRemoteResult(value: unknown): value is { readonly ok: false; readonly error?: unknown } {
  return value !== null && typeof value === 'object' && 'ok' in value && (value as { ok?: unknown }).ok === false
}

function readRefreshSignal(value: unknown): PmsRefreshSignal | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  if ('ok' in value) {
    const result = value as { ok?: unknown; value?: unknown }
    return result.ok === true ? readRefreshSignal(result.value) : undefined
  }
  const signal = value as Partial<PmsRefreshSignal>
  if (typeof signal.revision !== 'number'
    || !Number.isSafeInteger(signal.revision)
    || signal.revision < 1
    || typeof signal.requestId !== 'string'
    || signal.requestId.length === 0
    || !Array.isArray(signal.scopes)
    || !signal.scopes.every(scope => typeof scope === 'string')
    || typeof signal.requestedAt !== 'number') return undefined
  return {
    revision: signal.revision,
    requestId: signal.requestId,
    scopes: [...signal.scopes],
    requestedAt: signal.requestedAt,
  }
}
