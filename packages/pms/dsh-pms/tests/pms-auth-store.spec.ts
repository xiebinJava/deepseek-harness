import { describe, expect, it } from 'vitest'
import { PmsAuthStore } from '../src/auth/pms-auth-store.ts'

describe('PmsAuthStore', () => {
  it('isolates and replaces one-time authorization codes by DSH session', () => {
    const store = new PmsAuthStore()
    store.set('session-a', {
      authorizationCode: 'code-a',
      agentId: 'project_assistant',
      scopes: ['pms:project:read'],
      receivedAt: 100,
    })
    store.set('session-b', {
      authorizationCode: 'code-b',
      agentId: 'project_assistant',
      scopes: ['pms:task:read'],
      receivedAt: 200,
    })

    expect(store.get('session-a')).toEqual({
      authorizationCode: 'code-a',
      agentId: 'project_assistant',
      scopes: ['pms:project:read'],
      receivedAt: 100,
    })
    store.set('session-a', {
      authorizationCode: 'code-a-2',
      agentId: 'project_assistant',
      scopes: ['pms:project:read', 'pms:task:read'],
      receivedAt: 300,
    })
    expect(store.get('session-a')?.authorizationCode).toBe('code-a-2')
    expect(store.get('session-b')?.authorizationCode).toBe('code-b')

    store.clear('session-a')
    expect(store.get('session-a')).toBeUndefined()
    expect(store.get('session-b')?.authorizationCode).toBe('code-b')
  })

  it('answers the delegated scopes without exposing mutable store state', () => {
    const store = new PmsAuthStore()
    store.set('session-a', {
      authorizationCode: 'code-a',
      agentId: 'project_assistant',
      scopes: ['pms:project:read', 'pms:command:preview'],
      receivedAt: 100,
    })

    expect(store.scopes('session-a')).toEqual(['pms:project:read', 'pms:command:preview'])
    expect(store.hasScope('session-a', 'pms:command:preview')).toBe(true)
    expect(store.hasScope('session-a', 'pms:command:execute')).toBe(false)
    const scopes = store.scopes('session-a')!
    scopes.push('pms:command:execute')
    expect(store.hasScope('session-a', 'pms:command:execute')).toBe(false)
  })
})
