export const DEFAULT_PMS_WORKSPACE_URL = 'http://127.0.0.1:5173/projects'

/**
 * Resolve the browser-only PMS URL without ever accepting credentials or a
 * javascript/data URL. Production can replace this with a same-origin
 * `/pms-workspace/` route; local development points at the real PMS frontend.
 * The URL is intentionally returned unchanged so the embedded PMS keeps its
 * complete application shell and navigation. Any compact mode must be an
 * explicit PMS route decision, not an implicit consequence of being framed.
 */
export function resolvePmsWorkspaceUrl(
  value: string | undefined = process.env.DSH_CLIENT_PMS_WORKSPACE_URL,
  allowedOrigins: string | undefined = process.env.DSH_CLIENT_PMS_WORKSPACE_ORIGINS,
): string {
  const raw = value?.trim() || DEFAULT_PMS_WORKSPACE_URL
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw
  if (raw.startsWith('//')) throw new Error('dsh-pms-workspace: protocol-relative URLs are not allowed; use an absolute URL')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('dsh-pms-workspace: PMS workspace URL is invalid')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') {
    throw new Error('dsh-pms-workspace: PMS workspace URL must be an http(s) URL without credentials')
  }
  const origins = parseAllowedOrigins(allowedOrigins)
  if (!origins.includes(parsed.origin)) {
    throw new Error(`dsh-pms-workspace: PMS workspace origin is not on the allowlist (${parsed.origin})`)
  }
  return parsed.toString()
}

function parseAllowedOrigins(value: string | undefined): readonly string[] {
  const configured = value?.split(',').map(origin => origin.trim()).filter(Boolean) ?? []
  return configured.length > 0 ? configured : [new URL(DEFAULT_PMS_WORKSPACE_URL).origin]
}
