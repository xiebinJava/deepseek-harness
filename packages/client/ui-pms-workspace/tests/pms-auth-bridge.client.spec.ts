import { describe, expect, it } from 'vitest'
import {
  DSH_AUTH_MESSAGE_SOURCE,
  DSH_AUTH_MESSAGE_VERSION,
  DSH_AUTH_REQUEST_MESSAGE,
  PMS_AUTH_MESSAGE_SOURCE,
  PMS_AUTH_RENEWAL_INTERVAL_MS,
  PMS_AUTH_SYNC_MESSAGE,
  createDshAuthRequest,
  createPmsAuthCodeRecord,
  parsePmsAuthMessage,
} from '../src/client/pms-auth-bridge.ts'

describe('PMS auth bridge', () => {
  it('renews the one-time code before the PMS-issued code expires', () => {
    expect(PMS_AUTH_RENEWAL_INTERVAL_MS).toBeGreaterThan(0)
    expect(PMS_AUTH_RENEWAL_INTERVAL_MS).toBeLessThan(90_000)
  })

  it('creates a versioned request bound to a DSH session', () => {
    expect(createDshAuthRequest('request-1', 'session-1')).toEqual({
      source: DSH_AUTH_MESSAGE_SOURCE,
      type: DSH_AUTH_REQUEST_MESSAGE,
      version: DSH_AUTH_MESSAGE_VERSION,
      requestId: 'request-1',
      dshSessionId: 'session-1',
      agentId: 'project_assistant',
      scopes: [
        'pms:project:read', 'pms:task:read', 'pms:query:read',
        'pms:task:write', 'pms:command:preview', 'pms:command:execute',
        'pms:workflow:write',
        'pms:project:write',
        'pms:workspace:embed',
      ],
    })
  })

  it('accepts only the matching PMS response and rejects replayable or unsafe shapes', () => {
    const valid = {
      source: PMS_AUTH_MESSAGE_SOURCE,
      type: PMS_AUTH_SYNC_MESSAGE,
      version: DSH_AUTH_MESSAGE_VERSION,
      requestId: 'request-1',
      authorizationCode: 'one-time-code',
      expiresInSeconds: 90,
      agentId: 'project_assistant',
      scopes: ['pms:project:read'],
    }
    expect(parsePmsAuthMessage(valid, 'request-1')).toEqual({
      authorizationCode: 'one-time-code',
      expiresInSeconds: 90,
      agentId: 'project_assistant',
      scopes: ['pms:project:read'],
    })
    expect(parsePmsAuthMessage({ ...valid, requestId: 'old-request' }, 'request-1')).toBeUndefined()
    expect(parsePmsAuthMessage({ ...valid, source: 'other' }, 'request-1')).toBeUndefined()
    expect(parsePmsAuthMessage({ ...valid, authorizationCode: '' }, 'request-1')).toBeUndefined()
    expect(parsePmsAuthMessage({ ...valid, expiresInSeconds: 301 }, 'request-1')).toBeUndefined()
  })

  it('strips transport-only expiry metadata before calling the host remote bridge', () => {
    expect(createPmsAuthCodeRecord({
      authorizationCode: 'one-time-code',
      expiresInSeconds: 90,
      agentId: 'project_assistant',
      scopes: ['pms:project:write'],
    }, 123)).toEqual({
      authorizationCode: 'one-time-code',
      agentId: 'project_assistant',
      scopes: ['pms:project:write'],
      receivedAt: 123,
    })
  })
})
