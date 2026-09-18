export const PMS_CONTEXT_MESSAGE_SOURCE = 'pms'
export const PMS_CONTEXT_SYNC_MESSAGE = 'pms.context.sync'
export const PMS_CONTEXT_REQUEST_MESSAGE = 'pms.context.request'
export const PMS_CONTEXT_MESSAGE_VERSION = 1

export interface PmsContextLocator {
  readonly pageType: string
  readonly route: string
  readonly projectId?: number
  readonly nodeId?: number
  readonly contextVersion?: string
}

export interface PmsContextSyncMessage {
  readonly source: typeof PMS_CONTEXT_MESSAGE_SOURCE
  readonly type: typeof PMS_CONTEXT_SYNC_MESSAGE
  readonly version: typeof PMS_CONTEXT_MESSAGE_VERSION
  readonly context: PmsContextLocator
}

/**
 * Establish a safe locator immediately when the PMS workspace opens. The PMS
 * page can later replace it with a more precise locator through postMessage.
 */
export function createPmsWorkspaceLocator(src: string): PmsContextLocator {
  const parsed = new URL(src, typeof window === 'undefined' ? 'http://localhost/' : window.location.href)
  const pathname = normalizePathname(parsed.pathname)
  const route = `${parsed.pathname || '/'}${parsed.search}${parsed.hash}`
  const detailMatch = pathname.match(/\/projects\/(\d+)$/)
  if (detailMatch !== null) {
    return { pageType: 'project-detail', route, projectId: Number(detailMatch[1]) }
  }
  if (pathname === '/projects/dashboard') return { pageType: 'project-dashboard', route }
  if (pathname === '/projects') return { pageType: 'project-list', route }
  return { pageType: 'pms-workspace', route }
}

export function parsePmsContextMessage(value: unknown): PmsContextLocator | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const message = value as Record<string, unknown>
  if (message.source !== PMS_CONTEXT_MESSAGE_SOURCE
    || message.type !== PMS_CONTEXT_SYNC_MESSAGE
    || message.version !== PMS_CONTEXT_MESSAGE_VERSION) return undefined
  const context = message.context
  if (context === null || typeof context !== 'object') return undefined
  const candidate = context as Record<string, unknown>
  if (typeof candidate.pageType !== 'string' || candidate.pageType.trim() === '') return undefined
  if (typeof candidate.route !== 'string' || candidate.route.trim() === '') return undefined
  if (!optionalInteger(candidate.projectId) || !optionalInteger(candidate.nodeId)) return undefined
  if (!optionalString(candidate.contextVersion)) return undefined
  return {
    pageType: candidate.pageType,
    route: candidate.route,
    ...(candidate.projectId === undefined ? {} : { projectId: candidate.projectId as number }),
    ...(candidate.nodeId === undefined ? {} : { nodeId: candidate.nodeId as number }),
    ...(candidate.contextVersion === undefined ? {} : { contextVersion: candidate.contextVersion as string }),
  }
}

export function resolvePmsWorkspaceOrigin(src: string): string {
  try {
    return new URL(src, typeof window === 'undefined' ? 'http://localhost/' : window.location.href).origin
  } catch {
    return ''
  }
}

function optionalInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function optionalString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= 128)
}

function normalizePathname(value: string): string {
  if (value === '/') return value
  return value.replace(/\/+$/, '')
}
