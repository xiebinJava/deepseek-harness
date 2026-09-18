/** Browser-session authentication for the Host Connection carrier. */

import {
  createHash,
  createHmac,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const TOKEN_QUERY = 'token'
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const PROCESS_LAUNCH_TOKENS = new WeakMap<object, string>()

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

/** Public PKCE client settings used by DSH's local browser host. */
export interface BrowserAuthOidcConfig {
  readonly issuer: string
  readonly clientId: string
  readonly redirectUri: string
  readonly authorizationUri?: string
  readonly tokenUri?: string
  readonly jwksUri?: string
}

interface PendingOidcLogin {
  readonly codeVerifier: string
  readonly nonce: string
  readonly expiresAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function processLaunchToken(owner: object): string {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
  return created
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Canonical request authority used as the cookie name and signed audience. */
function requestAuthority(headers: ConnectionTrustRequest['headers']): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined
  return decoded
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error('client-connection: browser-session credential record has an unsupported format')
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record has an invalid secret')
  }
  return secret
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(name: string, value: string, expiresAt: number, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: BrowserCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): BrowserCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string'
    || !Number.isSafeInteger(decoded.issuedAt)
    || !Number.isSafeInteger(decoded.expiresAt)) return undefined
  return decoded as unknown as BrowserCookiePayload
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record was not created')
  }
  return secret
}

/**
 * Process launch-token exchange and persistent signed-cookie verification.
 * Connection loads the credential provider's signing secret during activation
 * and retains it for synchronous request authentication.
 */
export class BrowserAuth {
  private readonly launchToken: string
  private readonly maxAgeMilliseconds: number
  private readonly pendingOidc = new Map<string, PendingOidcLogin>()

  private constructor(
    processOwner: object,
    private readonly secret: Buffer,
    maxAgeDays: number,
    private readonly oidc: BrowserAuthOidcConfig | undefined,
  ) {
    this.launchToken = processLaunchToken(processOwner)
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(this.maxAgeMilliseconds)
      || !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
  }

  /**
   * Initialize browser authentication and create its durable signing secret
   * when this Harness home has none.
   * @param processOwner - root application context retaining one token across Connection reloads.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @returns initialized authentication owner with the process owner's launch token.
   */
  static async create(
    processOwner: object,
    credentials: CredentialProvider,
    maxAgeDays: number,
    oidc: BrowserAuthOidcConfig | undefined = resolveBrowserAuthOidcConfig(),
  ): Promise<BrowserAuth> {
    return new BrowserAuth(processOwner, await initializeSecret(credentials), maxAgeDays, oidc)
  }

  /**
   * Add this process's launch token to the ordinary application root URL.
   * @param baseUrl - canonical browser origin without credentials.
   * @returns root URL carrying the process token as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    if (this.oidc !== undefined) return url.href
    url.searchParams.set(TOKEN_QUERY, this.launchToken)
    return url.href
  }

  /**
   * Authenticate an index request. A valid root query token mints the cookie
   * and redirects to clean `/`; a valid cookie lets the caller serve the
   * index; every other request receives the same minimal 401 response.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): boolean {
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    if (tokens.length > 0) {
      const authority = requestAuthority(req.headers)
      if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1
        && authority !== undefined && tokenMatches(tokens.join(''), this.launchToken)) {
        const issuedAt = Date.now()
        const expiresAt = issuedAt + this.maxAgeMilliseconds
        const value = encodeCookie({
          version: COOKIE_PAYLOAD_VERSION,
          authority,
          issuedAt,
          expiresAt,
        }, this.secret)
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': '/',
          'referrer-policy': 'no-referrer',
          'set-cookie': sessionCookie(
            cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000),
          ),
        })
        res.end()
        return false
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req)) {
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': '/',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        return false
      }
      this.writeUnauthorized(req, res)
      return false
    }
    if (this.isAuthenticated(req)) return true
    if (this.oidc !== undefined && req.method === 'GET' && url.pathname === '/') {
      this.redirectToOidc(req, res)
      return false
    }
    this.writeUnauthorized(req, res)
    return false
  }

  /** Handle the OIDC callback route registered by the Connection host. */
  async handleOidcCallback(req: ConnectionIndexRequest, res: ConnectionIndexResponse): Promise<void> {
    if (this.oidc === undefined) {
      res.writeHead(404, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const error = url.searchParams.get('error')
    if (error !== null) {
      this.writeOidcError(res, `OIDC 登录失败: ${error}`)
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code === null || state === null) {
      this.writeOidcError(res, 'OIDC 回调缺少 code 或 state')
      return
    }
    const pending = this.pendingOidc.get(state)
    this.pendingOidc.delete(state)
    if (pending === undefined || pending.expiresAt <= Date.now()) {
      this.writeOidcError(res, 'OIDC 登录状态已失效，请重新打开 DSH')
      return
    }
    try {
      const response = await fetch(this.tokenUri(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: this.oidc.clientId,
          redirect_uri: this.oidc.redirectUri,
          code_verifier: pending.codeVerifier,
        }),
      })
      if (!response.ok) throw new Error('OIDC token endpoint rejected the code')
      const body: unknown = await response.json()
      if (!isRecord(body) || typeof body.id_token !== 'string') {
        throw new Error('OIDC token response has no id_token')
      }
      await this.validateIdToken(body.id_token, pending.nonce)
      this.issueCookie(req, res)
    } catch (cause) {
      this.writeOidcError(res, cause instanceof Error ? cause.message : 'OIDC 登录失败')
    }
  }

  /**
   * Verify the authority-bound browser cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @returns true only for an unexpired cookie signed by this activation's loaded secret.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    const authority = requestAuthority(request.headers)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return false
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return false
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return false
    const now = Date.now()
    return payload.issuedAt <= now
      && payload.expiresAt > now
      && payload.expiresAt > payload.issuedAt
      && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
  }

  private redirectToOidc(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    if (this.oidc === undefined) return this.writeUnauthorized(req, res)
    const state = encodeBase64Url(randomBytes(32))
    const codeVerifier = encodeBase64Url(randomBytes(48))
    const nonce = encodeBase64Url(randomBytes(32))
    this.pendingOidc.set(state, {
      codeVerifier,
      nonce,
      expiresAt: Date.now() + 10 * 60 * 1000,
    })
    const url = new URL(this.authorizationUri())
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.oidc.clientId,
      redirect_uri: this.oidc.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: encodeBase64Url(createHash('sha256').update(codeVerifier).digest()),
      code_challenge_method: 'S256',
    }).toString()
    res.writeHead(303, { 'cache-control': 'no-store', location: url.href })
    res.end()
  }

  private issueCookie(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    const authority = requestAuthority(req.headers)
    if (authority === undefined) {
      this.writeOidcError(res, 'DSH 请求缺少合法 Host')
      return
    }
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const value = encodeCookie({
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
    }, this.secret)
    res.writeHead(303, {
      'cache-control': 'no-store',
      location: '/',
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(cookieName(authority), value, expiresAt,
        Math.floor(this.maxAgeMilliseconds / 1000)),
    })
    res.end()
  }

  private async validateIdToken(idToken: string, nonce: string): Promise<void> {
    if (this.oidc === undefined) return
    const parts = idToken.split('.')
    if (parts.length !== 3) throw new Error('OIDC id_token 格式无效')
    const headerPart = parts[0]
    const payloadPart = parts[1]
    const signaturePart = parts[2]
    if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
      throw new Error('OIDC id_token 格式无效')
    }
    const header = parseJsonPart(headerPart)
    const claims = parseJsonPart(payloadPart)
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw new Error('OIDC id_token 签名算法不受支持')
    }
    const jwksResponse = await fetch(this.jwksUri())
    if (!jwksResponse.ok) throw new Error('无法读取 OIDC 签名密钥')
    const jwks: unknown = await jwksResponse.json()
    if (!isRecord(jwks) || !Array.isArray(jwks.keys)) throw new Error('OIDC JWKS 格式无效')
    const key = jwks.keys.find(value => isRecord(value) && value.kid === header.kid)
    if (!isRecord(key) || key.kty !== 'RSA' || typeof key.n !== 'string' || typeof key.e !== 'string') {
      throw new Error('找不到 OIDC id_token 签名密钥')
    }
    const publicKey = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' })
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${headerPart}.${payloadPart}`)
    verifier.end()
    if (!verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url'))) {
      throw new Error('OIDC id_token 签名无效')
    }
    if (claims.iss !== this.oidc.issuer
      || !audienceContains(claims.aud, this.oidc.clientId)
      || claims.nonce !== nonce
      || typeof claims.sub !== 'string'
      || typeof claims.exp !== 'number'
      || claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error('OIDC id_token 声明无效')
    }
  }

  private authorizationUri(): string {
    if (this.oidc?.authorizationUri !== undefined && this.oidc.authorizationUri !== '') {
      return this.oidc.authorizationUri
    }
    return `${trimSlash(this.oidc?.issuer ?? '')}/protocol/openid-connect/auth`
  }

  private tokenUri(): string {
    if (this.oidc?.tokenUri !== undefined && this.oidc.tokenUri !== '') return this.oidc.tokenUri
    return `${trimSlash(this.oidc?.issuer ?? '')}/protocol/openid-connect/token`
  }

  private jwksUri(): string {
    if (this.oidc?.jwksUri !== undefined && this.oidc.jwksUri !== '') return this.oidc.jwksUri
    return `${trimSlash(this.oidc?.issuer ?? '')}/protocol/openid-connect/certs`
  }

  private writeOidcError(res: ConnectionIndexResponse, message: string): void {
    res.writeHead(502, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    res.end(message)
  }
}

export function resolveBrowserAuthOidcConfig(): BrowserAuthOidcConfig | undefined {
  if (process.env.DSH_OIDC_ENABLED !== 'true') return undefined
  const issuer = process.env.DSH_OIDC_ISSUER?.trim() ?? ''
  const clientId = process.env.DSH_OIDC_CLIENT_ID?.trim() ?? ''
  if (issuer === '' || clientId === '') {
    throw new Error('DSH_OIDC_ISSUER and DSH_OIDC_CLIENT_ID are required when DSH_OIDC_ENABLED=true')
  }
  const config = {
    issuer: trimSlash(issuer),
    clientId,
    redirectUri: process.env.DSH_OIDC_REDIRECT_URI?.trim()
      || 'http://127.0.0.1:5173/auth/oidc/callback',
  }
  const authorizationUri = process.env.DSH_OIDC_AUTHORIZATION_URI?.trim()
  const tokenUri = process.env.DSH_OIDC_TOKEN_URI?.trim()
  const jwksUri = process.env.DSH_OIDC_JWKS_URI?.trim()
  return {
    ...config,
    ...(authorizationUri === undefined || authorizationUri === '' ? {} : { authorizationUri }),
    ...(tokenUri === undefined || tokenUri === '' ? {} : { tokenUri }),
    ...(jwksUri === undefined || jwksUri === '' ? {} : { jwksUri }),
  }
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function parseJsonPart(value: string): Record<string, any> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!isRecord(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new Error('OIDC id_token JSON 无效')
  }
}

function audienceContains(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.includes(expected))
}
