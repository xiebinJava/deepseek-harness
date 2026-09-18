import { describe, expect, it } from 'vitest'
import { DEFAULT_PMS_WORKSPACE_URL, resolvePmsWorkspaceUrl } from '../src/client/workspace-url.ts'

describe('PMS workspace URL', () => {
  it('uses the local PMS frontend port used by the development server', () => {
    expect(DEFAULT_PMS_WORKSPACE_URL).toBe('http://127.0.0.1:5173/projects')
  })

  it('defaults to the local real PMS project page without changing its chrome mode', () => {
    expect(resolvePmsWorkspaceUrl()).toBe(DEFAULT_PMS_WORKSPACE_URL)
  })

  it('supports same-origin deployment routes', () => {
    expect(resolvePmsWorkspaceUrl('/pms-workspace/')).toBe('/pms-workspace/')
  })

  it('rejects unsafe URLs and credentials', () => {
    expect(() => resolvePmsWorkspaceUrl('javascript:alert(1)')).toThrow('http(s)')
    expect(() => resolvePmsWorkspaceUrl('https://user:pass@example.com/pms')).toThrow('credentials')
    expect(() => resolvePmsWorkspaceUrl('//example.com/pms')).toThrow('absolute')
    expect(() => resolvePmsWorkspaceUrl('https://example.com/pms')).toThrow('allowlist')
  })
})
