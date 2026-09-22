import type { PmsSsoCredential } from './pms-credential-store.ts'

/** A PMS login response as returned by `/auth/login`, `/auth/refresh` and the SSO exchange. */
interface PmsLoginPayload {
  accessToken?: string
  token?: string
  refreshToken?: string
  expiresIn?: number
  user?: { id?: number; email?: string; username?: string }
}

/** A PMS call that failed with an HTTP status we can act on (401/403 means revoked). */
export class PmsSsoError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'PmsSsoError'
  }
}

export interface PmsSsoSessionOptions {
  baseUrl: string
  apiPrefix: string
  serviceKey: string
  fetchImpl?: typeof fetch
}

/**
 * Exchanges the SSO ID token DSH verified for a normal PMS session, so the PMS
 * assistant acts as the same person without the embedded browser bridge.
 */
export async function exchangePmsSsoSession(
  options: PmsSsoSessionOptions,
  idToken: string,
  subject: string,
): Promise<PmsSsoCredential> {
  const payload = await post<PmsLoginPayload>(options, '/integration/dsh/v1/sso-session', { idToken }, {
    'X-DSH-Service-Key': options.serviceKey,
  })
  return toCredential(payload, subject, 'PMS SSO 登录未返回令牌')
}

/** Rotates the held PMS session; the refresh token is single-use and serialized by the caller. */
export async function refreshPmsSsoSession(
  options: PmsSsoSessionOptions,
  credential: PmsSsoCredential,
): Promise<PmsSsoCredential> {
  const payload = await post<PmsLoginPayload>(options, '/auth/refresh', {
    refreshToken: credential.refreshToken,
  })
  return toCredential(payload, credential.subject, 'PMS 刷新登录态失败')
}

/** Best-effort server-side revocation when DSH drops the binding. */
export async function revokePmsSsoSession(
  options: PmsSsoSessionOptions,
  credential: PmsSsoCredential,
): Promise<void> {
  const response = await request(options, '/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential.accessToken}` },
  })
  // A session PMS already revoked or expired is a successful logout for us.
  if (response !== undefined && !response.ok && response.status !== 401) {
    throw new Error(`PMS 退出登录失败（HTTP ${String(response.status)}）`)
  }
}

function toCredential(payload: PmsLoginPayload, subject: string, failure: string): PmsSsoCredential {
  const accessToken = payload.accessToken ?? payload.token ?? ''
  const refreshToken = payload.refreshToken ?? ''
  if (accessToken === '' || refreshToken === '') throw new Error(failure)
  return {
    version: 1,
    accessToken,
    refreshToken,
    // Refresh a little early so a call never starts on an expired token. The PMS
    // access token carries its own expiry, so prefer that over a guess.
    expiresAt: accessTokenExpiry(accessToken)
      ?? (typeof payload.expiresIn === 'number' && payload.expiresIn > 0
        ? Date.now() + Math.max(0, payload.expiresIn - 60) * 1000
        : Date.now() + 29 * 60 * 1000),
    subject,
    ...(typeof payload.user?.id === 'number' ? { userId: payload.user.id } : {}),
    ...(typeof payload.user?.email === 'string' ? { email: payload.user.email } : {}),
  }
}

/** Reads `exp` from the PMS access token so refresh happens at PMS's own schedule. */
function accessTokenExpiry(accessToken: string): number | undefined {
  const payloadPart = accessToken.split('.')[1]
  if (payloadPart === undefined) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as { exp?: unknown }
    if (typeof claims.exp !== 'number') return undefined
    return claims.exp * 1000 - 60 * 1000
  } catch {
    return undefined
  }
}

async function post<T>(
  options: PmsSsoSessionOptions,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await request(options, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const envelope = await readEnvelope<T>(response, path)
  return envelope
}

async function request(
  options: PmsSsoSessionOptions,
  path: string,
  init: RequestInit,
): Promise<Response | undefined> {
  const url = new URL(`${options.apiPrefix.replace(/\/+$/u, '')}${path}`, `${options.baseUrl.replace(/\/+$/u, '')}/`)
  try {
    return await (options.fetchImpl ?? fetch)(url, init)
  } catch (error) {
    throw new Error(`PMS 连接失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readEnvelope<T>(response: Response | undefined, path: string): Promise<T> {
  if (response === undefined) throw new Error(`PMS ${path} 无响应`)
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    throw new Error(`PMS ${path} 返回了非 JSON 响应`)
  }
  const envelope = body as { code?: number; msg?: string; data?: T } | undefined
  if (!response.ok || envelope?.code !== 200 || envelope.data === undefined) {
    throw new PmsSsoError(envelope?.msg ?? `PMS ${path} 失败（HTTP ${String(response.status)}）`, response.status)
  }
  return envelope.data
}
