/**
 * `ctx.sidebarSystems`: the business applications this deployment is wired to
 * (PMS, OMS, ...). Each entry contributes a label, an icon and an action; the
 * sidebar renders the row, so a new system never re-implements shell styling
 * and cross-plugin value imports stay out of the client bundle.
 */
import type { ReactNode } from 'react'

/** One system launcher contributed by a client plugin. */
export interface SidebarSystemEntry {
  /** Stable id, unique per system. */
  id: string
  /** Row label, shown wide and used as the rail tooltip. */
  label: string
  /** Ascending row order; ties retain registration order. */
  order?: number
  /** Rail/wide glyph; receives the shell's requested icon size. */
  icon: (props: { size: number }) => ReactNode
  /** Opens the system (for example the PMS business workspace panel). */
  onSelect: () => void
}

/** Registry over the contributed system launchers, in row order. */
export class SidebarSystemsRegistry {
  private readonly entries = new Map<string, SidebarSystemEntry>()
  private readonly listeners = new Set<() => void>()
  private cached: readonly SidebarSystemEntry[] = []

  register(entry: SidebarSystemEntry): () => void {
    if (this.entries.has(entry.id)) throw new Error(`sidebar: system "${entry.id}" is already registered`)
    this.entries.set(entry.id, entry)
    this.publish()
    return () => {
      if (this.entries.get(entry.id) !== entry) return
      this.entries.delete(entry.id)
      this.publish()
    }
  }

  /** Current rows: sorted by order, then registration sequence. */
  list(): readonly SidebarSystemEntry[] {
    return this.cached
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(): void {
    this.cached = [...this.entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    for (const listener of [...this.listeners]) listener()
  }
}
