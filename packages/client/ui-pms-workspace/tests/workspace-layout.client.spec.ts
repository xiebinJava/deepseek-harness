import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/client/PmsWorkspace.module.css', import.meta.url), 'utf8')

describe('PMS workspace layout', () => {
  it('gives the embedded workspace a definite height so its iframe fills the dock pane', () => {
    expect(styles).toMatch(/\.root\s*\{[^}]*position:\s*absolute/s)
    expect(styles).toMatch(/\.root\s*\{[^}]*inset:\s*0/s)
  })
})

describe('ui-pms-workspace launcher wiring', () => {
  it('injects the sidebar systems service it registers into', async () => {
    const { inject } = await import('../src/client/index.ts')
    // Cordis resolves an injected service by name; forgetting this entry makes
    // the whole client entry fail to activate, so the guard is a real regression
    // test rather than a style preference.
    expect(inject).toContain('sidebarSystems')
  })
})
