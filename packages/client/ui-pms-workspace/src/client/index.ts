import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { PmsWorkspace, type PmsContextBridge, type PmsWorkspaceProps } from './PmsWorkspace.tsx'
import type { PmsAuthCodeRecord } from './pms-auth-bridge.ts'
import { resolvePmsWorkspaceUrl } from './workspace-url.ts'

export const PMS_WORKSPACE_KIND = 'pms'
export const PMS_WORKSPACE_ID = '@deepseek-ai/dsh-client-ui-pms-workspace'
export const inject = [
  'slots', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.pmsContext',
  // Provided by the sidebar shell: the 系统 group this plugin registers its
  // launcher into. Cordis only resolves an injected service by name.
  'sidebarSystems',
]

export function pmsWorkspaceDefinition(): SidebarRightTabDefinition {
  return {
    id: PMS_WORKSPACE_ID,
    kind: PMS_WORKSPACE_KIND,
    title: () => 'PMS 业务工作区',
    guide: [{
      id: 'pms-workspace',
      order: 10,
      title: () => 'PMS 业务工作区',
      description: () => '在右侧查看真实 PMS 页面',
      icon: IconBrowseOutline16,
    }],
  }
}

export function apply(ctx: ClientContext): void {
  // Resolve once during plugin boot so an unsafe deployment URL fails loudly
  // instead of producing a blank iframe after a user clicks the button.
  resolvePmsWorkspaceUrl()
  ctx.effect(() => ctx.sidebarRightTabs.register(pmsWorkspaceDefinition()), 'ui-pms-workspace: tab type')
  const bridge: PmsContextBridge = {
    set: (sessionId, locator) => ctx.remote.pmsContext.set(sessionId, locator),
    clear: sessionId => ctx.remote.pmsContext.clear(sessionId),
    setAuthCode: (sessionId, authCode: PmsAuthCodeRecord) => (
      ctx.remote.pmsContext.setAuthCode(sessionId, authCode)
    ),
    clearAuthCode: sessionId => ctx.remote.pmsContext.clearAuthCode(sessionId),
    getRefresh: (sessionId, sinceRevision) => ctx.remote.pmsContext.getRefresh(sessionId, sinceRevision),
  }
  const PmsWorkspaceWithBridge = (props: PmsWorkspaceProps): ReactNode => PmsWorkspace({ ...props, bridge })
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PMS_WORKSPACE_ID,
  }, PmsWorkspaceWithBridge)), 'ui-pms-workspace: body')
  // The launcher lives in the sidebar's 系统 group (below 插件), not in the
  // conversation header: a system is a deployment-wide entry, not a session
  // control. Another business app (OMS, ...) registers the same way.
  ctx.effect(() => {
    // Defensive: a shell built before the systems seam simply shows no launcher
    // instead of failing this plugin's activation.
    const systems = ctx.sidebarSystems
    if (systems === undefined) return () => undefined
    return systems.register({
      id: PMS_WORKSPACE_KIND,
      label: 'PMS',
      order: 10,
      icon: ({ size }) => createElement(IconBrowseOutline16, { size }),
      onSelect: () => { ctx.sidebarRight.openTab(PMS_WORKSPACE_KIND) },
    })
  }, 'ui-pms-workspace: sidebar system entry')
}
