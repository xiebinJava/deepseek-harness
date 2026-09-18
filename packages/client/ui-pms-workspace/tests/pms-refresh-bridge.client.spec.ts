import { describe, expect, it } from 'vitest'
import {
  PMS_REFRESH_MESSAGE_SOURCE,
  PMS_REFRESH_MESSAGE_VERSION,
  PMS_REFRESH_REQUEST_MESSAGE,
  createPmsRefreshRequest,
  parsePmsRefreshMessage,
} from '../src/client/pms-refresh-bridge.ts'

describe('PMS refresh bridge', () => {
  it('creates and parses a versioned refresh request', () => {
    const request = createPmsRefreshRequest('refresh-1', ['project-list'])

    expect(request).toEqual({
      source: PMS_REFRESH_MESSAGE_SOURCE,
      type: PMS_REFRESH_REQUEST_MESSAGE,
      version: PMS_REFRESH_MESSAGE_VERSION,
      requestId: 'refresh-1',
      scopes: ['project-list'],
    })
    expect(parsePmsRefreshMessage(request)).toEqual(request)
  })

  it('rejects malformed, replayable, or unbounded refresh messages', () => {
    expect(parsePmsRefreshMessage({
      source: 'other',
      type: PMS_REFRESH_REQUEST_MESSAGE,
      version: PMS_REFRESH_MESSAGE_VERSION,
      requestId: 'refresh-1',
      scopes: [],
    })).toBeUndefined()
    expect(parsePmsRefreshMessage({
      source: PMS_REFRESH_MESSAGE_SOURCE,
      type: PMS_REFRESH_REQUEST_MESSAGE,
      version: PMS_REFRESH_MESSAGE_VERSION,
      requestId: '',
      scopes: [],
    })).toBeUndefined()
    expect(parsePmsRefreshMessage({
      source: PMS_REFRESH_MESSAGE_SOURCE,
      type: PMS_REFRESH_REQUEST_MESSAGE,
      version: PMS_REFRESH_MESSAGE_VERSION,
      requestId: 'refresh-1',
      scopes: Array.from({ length: 33 }, () => 'project-list'),
    })).toBeUndefined()
  })
})
