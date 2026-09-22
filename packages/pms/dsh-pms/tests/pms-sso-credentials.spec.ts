import { describe, expect, it, vi } from 'vitest'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { PmsCredentialStore } from '../src/auth/pms-credential-store.ts'
import { PmsSsoCredentials } from '../src/auth/pms-sso-credentials.ts'

/** Minimal in-memory credential seam: only the three methods the store uses. */
function fakeCredentials(): CredentialProvider & { readonly records: Map<string, CredentialRecord> } {
  const records = new Map<string, CredentialRecord>()
  return {
    records,
    readRecord: (key: unknown) => Promise.resolve(records.get(String(key))),
    modifyRecord: (key: unknown, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      const id = String(key)
      return Promise.resolve(mutate(records.get(id))).then((next) => {
        if (next === undefined) return records.get(id)
        records.set(id, next)
        return next
      })
    },
    deleteRecord: (key: unknown) => {
      records.delete(String(key))
      return Promise.resolve()
    },
  } as unknown as CredentialProvider & { readonly records: Map<string, CredentialRecord> }
}

function pmsResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: status === 200 ? 200 : 401, msg: 'ok', data }), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

const loginPayload = {
  accessToken: 'pms-access',
  refreshToken: 'pms-refresh',
  expiresIn: 1800,
  user: { id: 2, email: 'admin@pms.com' },
}

describe('PmsCredentialStore', () => {
  it('round-trips a grant record and clears it', async () => {
    const credentials = fakeCredentials()
    const store = new PmsCredentialStore(credentials)

    await store.write(() => ({
      version: 1, accessToken: 'a', refreshToken: 'r', expiresAt: 1, subject: 'sub-1',
    }))

    expect(credentials.records.size).toBe(1)
    expect(await store.read()).toMatchObject({ accessToken: 'a', subject: 'sub-1' })
    await store.clear()
    expect(await store.read()).toBeUndefined()
    expect(credentials.records.size).toBe(0)
  })

  it('ignores a record written in another format or version', async () => {
    const credentials = fakeCredentials()
    const store = new PmsCredentialStore(credentials)
    credentials.records.set('dsh-pms/sso-session', { kind: 'grant', payload: { version: 99 } })

    expect(await store.read()).toBeUndefined()
  })

  it('degrades to "no persistence" when the host has no credential seam', async () => {
    const store = new PmsCredentialStore(undefined)

    expect(store.available).toBe(false)
    expect(await store.read()).toBeUndefined()
    expect(await store.write(() => undefined)).toBeUndefined()
    await store.clear()
  })
})

describe('PmsSsoCredentials', () => {
  const options = {
    baseUrl: 'http://pms.test',
    apiPrefix: '/api',
    serviceKey: 'service-key',
  }

  it('acquires a PMS session from the verified SSO token and persists it', async () => {
    const credentials = fakeCredentials()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(pmsResponse(loginPayload))
    const sso = new PmsSsoCredentials({
      ...options,
      credentials,
      identity: { idToken: () => 'id-token', identity: () => ({ subject: 'sub-1', email: 'admin@pms.com' }) },
      fetchImpl,
    })

    expect(await sso.accessToken()).toBe('pms-access')
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('http://pms.test/api/integration/dsh/v1/sso-session')
    expect((fetchImpl.mock.calls[0]![1]?.headers as Record<string, string>)['X-DSH-Service-Key'])
      .toBe('service-key')
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({ idToken: 'id-token' })
    // Persisted: a second read needs no network call.
    expect(await sso.accessToken()).toBe('pms-access')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rotates the held session when it expired', async () => {
    const credentials = fakeCredentials()
    const store = new PmsCredentialStore(credentials)
    await store.write(() => ({
      version: 1, accessToken: 'old', refreshToken: 'old-refresh', expiresAt: Date.now() - 1000, subject: 'sub-1',
    }))
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(pmsResponse({ accessToken: 'new', refreshToken: 'new-refresh' }))
    const sso = new PmsSsoCredentials({
      ...options,
      credentials,
      identity: { idToken: () => 'id-token', identity: () => ({ subject: 'sub-1' }) },
      fetchImpl,
    })

    expect(await sso.accessToken()).toBe('new')
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('http://pms.test/api/auth/refresh')
  })

  it('never hands one person’s session to a different SSO subject', async () => {
    const credentials = fakeCredentials()
    const store = new PmsCredentialStore(credentials)
    await store.write(() => ({
      version: 1, accessToken: 'other-person', refreshToken: 'r', expiresAt: Date.now() + 60000, subject: 'sub-old',
    }))
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(pmsResponse({ accessToken: 'mine', refreshToken: 'mine-refresh' }))
    const sso = new PmsSsoCredentials({
      ...options,
      credentials,
      identity: { idToken: () => 'id-token', identity: () => ({ subject: 'sub-new' }) },
      fetchImpl,
    })

    expect(await sso.accessToken()).toBe('mine')
    // The previous person's session is forgotten locally, never revoked by us.
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('http://pms.test/api/integration/dsh/v1/sso-session')
    expect(await store.read()).toMatchObject({ subject: 'sub-new', accessToken: 'mine' })
  })

  it('reports an unusable session when DSH has no SSO identity', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const sso = new PmsSsoCredentials({ ...options, credentials: fakeCredentials(), fetchImpl })

    expect(await sso.accessToken()).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stays signed out after PMS revoked the session instead of minting a new one', async () => {
    const credentials = fakeCredentials()
    const store = new PmsCredentialStore(credentials)
    await store.write(() => ({
      version: 1, accessToken: 'revoked', refreshToken: 'revoked-refresh', expiresAt: Date.now() - 1000, subject: 'sub-1',
    }))
    let idToken = 'id-token'
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(pmsResponse({}, 401))
    const sso = new PmsSsoCredentials({
      ...options,
      credentials,
      identity: { idToken: () => idToken, identity: () => ({ subject: 'sub-1' }) },
      fetchImpl,
    })

    // Same SSO login: the revoked state must hold, with no replacement session.
    expect(await sso.accessToken()).toBeUndefined()
    expect(await sso.accessToken()).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await store.read()).toBeUndefined()

    // A new SSO login may sign in again.
    idToken = 'id-token-after-relogin'
    fetchImpl.mockResolvedValueOnce(pmsResponse({ accessToken: 'fresh', refreshToken: 'fresh-refresh' }))
    expect(await sso.accessToken()).toBe('fresh')
    expect(String(fetchImpl.mock.calls[1]![0])).toBe('http://pms.test/api/integration/dsh/v1/sso-session')
  })

  it('revokes and forgets the session on clear', async () => {
    const credentials = fakeCredentials()
    const store = new PmsCredentialStore(credentials)
    await store.write(() => ({
      version: 1, accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60000, subject: 'sub-1',
    }))
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(pmsResponse({}))
    const sso = new PmsSsoCredentials({
      ...options,
      credentials,
      identity: { idToken: () => 'id-token', identity: () => ({ subject: 'sub-1' }) },
      fetchImpl,
    })

    await sso.clear()

    expect(String(fetchImpl.mock.calls[0]![0])).toBe('http://pms.test/api/auth/logout')
    expect(await store.read()).toBeUndefined()
  })
})
