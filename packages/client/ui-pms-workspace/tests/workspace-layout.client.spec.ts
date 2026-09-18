import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/client/PmsWorkspace.module.css', import.meta.url), 'utf8')

describe('PMS workspace layout', () => {
  it('gives the embedded workspace a definite height so its iframe fills the dock pane', () => {
    expect(styles).toMatch(/\.root\s*\{[^}]*position:\s*absolute/s)
    expect(styles).toMatch(/\.root\s*\{[^}]*inset:\s*0/s)
  })
})
