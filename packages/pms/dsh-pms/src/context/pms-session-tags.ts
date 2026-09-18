import type { PmsContextLocator } from '../types.ts'

/** Stable tags for a DSH session; project/node are tags, never session keys. */
export function pmsSessionTags(locator: PmsContextLocator | undefined): string[] {
  if (locator === undefined) return []
  return [
    `pms:page:${locator.pageType}`,
    ...locator.projectId === undefined ? [] : [`pms:project:${locator.projectId}`],
    ...locator.nodeId === undefined ? [] : [`pms:node:${locator.nodeId}`],
  ]
}
