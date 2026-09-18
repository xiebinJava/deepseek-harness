import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PMS_CONTEXT_MESSAGE_SOURCE,
  PMS_CONTEXT_MESSAGE_VERSION,
  PMS_CONTEXT_SYNC_MESSAGE,
  createPmsWorkspaceLocator,
  parsePmsContextMessage,
  resolvePmsWorkspaceOrigin,
} from '../src/client/pms-context-bridge.ts'

const workspaceSource = readFileSync(new URL('../src/client/PmsWorkspace.tsx', import.meta.url), 'utf8')

describe('PMS context bridge', () => {
  it('accepts only the versioned PMS locator message shape', () => {
    expect(parsePmsContextMessage({
      source: PMS_CONTEXT_MESSAGE_SOURCE,
      type: PMS_CONTEXT_SYNC_MESSAGE,
      version: PMS_CONTEXT_MESSAGE_VERSION,
      context: { pageType: 'project-detail', route: '/projects/22', projectId: 22, nodeId: 7 },
    })).toEqual({ pageType: 'project-detail', route: '/projects/22', projectId: 22, nodeId: 7 })
    expect(parsePmsContextMessage({ source: 'other', type: PMS_CONTEXT_SYNC_MESSAGE, version: 1, context: {} })).toBeUndefined()
    expect(parsePmsContextMessage({
      source: PMS_CONTEXT_MESSAGE_SOURCE,
      type: PMS_CONTEXT_SYNC_MESSAGE,
      version: PMS_CONTEXT_MESSAGE_VERSION,
      context: { pageType: 'project-detail', route: '/projects/22', projectId: -1 },
    })).toBeUndefined()
  })

  it('resolves relative and absolute workspace origins', () => {
    expect(resolvePmsWorkspaceOrigin('/projects?embed=1')).toBe('http://localhost')
    expect(resolvePmsWorkspaceOrigin('https://pms.example.com/projects')).toBe('https://pms.example.com')
  })

  it('creates an initial PMS locator as soon as the workspace opens', () => {
    expect(createPmsWorkspaceLocator('http://127.0.0.1:5174/projects')).toEqual({
      pageType: 'project-list',
      route: '/projects',
    })
    expect(createPmsWorkspaceLocator('/pms-workspace/projects/22')).toEqual({
      pageType: 'project-detail',
      route: '/pms-workspace/projects/22',
      projectId: 22,
    })
  })

  it('keeps the PMS session association when the right workspace is unmounted', () => {
    expect(workspaceSource).toMatch(/bridge\.clearAuthCode\(SessionId\(sessionId\)\)/)
    expect(workspaceSource).not.toMatch(/bridge\.clear\(SessionId\(sessionId\)\)/)
  })

  it('polls host refresh signals and posts them only after the PMS frame is ready', () => {
    expect(workspaceSource).toMatch(/bridge\.getRefresh\(SessionId\(sessionId\), lastRefreshRevision\)/)
    expect(workspaceSource).toMatch(/createPmsRefreshRequest\(signal\.requestId, signal\.scopes\)/)
    expect(workspaceSource).toMatch(/if \(!frameReady\)/)
    expect(workspaceSource).toMatch(/readRefreshSignal\(result\)/)
  })
})
