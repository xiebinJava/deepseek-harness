/**
 * The session header's agent-preset label.
 *
 * Read-only by construction: a session's composition is fixed once its
 * conversation starts, and a header is only worth reading after that. Offering
 * a control here would promise a switch the host refuses; naming what the
 * session runs is the honest affordance, and the choice itself lives on the
 * new-session screen ({@link AgentPresetSeat}).
 */

import { useEffect } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconAgentPresetOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type { AgentPresetSettingsState } from './settings-store.ts'
import { presetDisplayText } from './locales.ts'
import css from './AgentPresetLabel.module.css'

/** Registration-side business face for the header label. */
export interface AgentPresetLabelInjected {
  hooks: {
    /** Roster snapshot bound by the renderer as useAgentPresets. */
    agentPresets: SnapshotStore<AgentPresetSettingsState>
  }
  /** Read the roster, so the label can show a name rather than an id. */
  load: () => Promise<void>
  /**
   * Start a new session under this same preset. The session's own composition
   * can never be switched, so this is the follow-up action the label offers.
   */
  startWithPreset?: (id: string) => void
}

/** Full component props. */
export type AgentPresetLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetLabelInjected>

/**
 * Render this session's agent-preset name beside its title.
 * @param props - composed slot props.
 * @returns the label, or null when the session records no preset.
 */
export function AgentPresetLabel({
  sessionId, useSessions, useAgentPresets, load, startWithPreset, t,
}: AgentPresetLabelProps) {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const options = useAgentPresets(state => state.options)

  useEffect(() => {
    // Deployments that compose no presets never label anything, so the roster
    // is only worth a request once a session reports one.
    if (preset !== undefined) void load()
  }, [preset, load])

  if (preset === undefined) return null

  const option = options.find(entry => entry.id === preset)
  const text = option === undefined ? undefined : presetDisplayText(option, t)
  // The tooltip always names both the display name and the preset id: the id is
  // what presets are addressed by, and it is the only identity available while
  // the roster is still loading.
  const shown = text?.name ?? preset
  const title = [
    shown === preset ? preset : `${shown}（${preset}）`,
    text?.description,
  ].filter((part): part is string => part !== undefined && part !== '').join('\n')
    || t('headerHint')
  if (startWithPreset !== undefined) {
    return (
      <button
        type="button"
        className={css.label}
        title={`${title}\n${t('labelNewSessionWithPreset')}`}
        data-agent-preset={preset}
        data-agent-preset-action="new-session"
        onClick={() => { startWithPreset(preset) }}
      >
        <IconAgentPresetOutline16 size={14} className={css.icon} />
        {shown}
      </button>
    )
  }
  return (
    <span className={css.label} title={title} data-agent-preset={preset}>
      <IconAgentPresetOutline16 size={14} className={css.icon} />
      {shown}
    </span>
  )
}
